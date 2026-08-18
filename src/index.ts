/**
 * causeway 엔트리포인트 — 실제 부팅 시퀀스.
 *
 * env → db 마이그레이션 → recoverInflight(스레드 안내) → dispatcher 시작 →
 * bolt Socket Mode 시작 → SIGTERM graceful(디스패처 정지 → 진행 중 스레드 안내, 5s 예산).
 * 강제 킬(kill -9)의 뒷정리는 다음 부팅의 recoverInflight 몫이다 (JQ-05) — 프로세스는
 * 언제 죽어도 된다는 전제가 이 파일의 설계 기준이다.
 *
 * Ingress 생산자는 **Slack 리스너와 스케줄러 둘**이다(채널 워처·PR 워처 없음). 트리거는
 * 사람의 멘션/DM 과 예약 발화뿐이고, 나머지는 전부 그 대화 안에서 도구로 처리된다.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { App } from "@slack/bolt";
import { loadEnv } from "./config/env.js";
import { loadConfig } from "./config/loader.js";
import { createAppContext, SHUTDOWN_NOTICE } from "./context.js";
import { CONTRACT } from "./core/constants.js";
import { withDeadline } from "./core/deadline.js";
import type { Poster } from "./egress/poster.js";
import { classifyReplayKind } from "./ingress/slackListeners.js";
import type { RunningChatTaskInfo } from "./jobs/chat/runningTasks.js";
import { createEventTracker } from "./resilience/eventTracker.js";
import { createFileFrictionSink, createFrictionLog } from "./resilience/friction.js";
import { createResilience, type SocketReconnector } from "./resilience/wiring.js";
import { createTicker } from "./schedule/scheduler.js";
import { createSlackHistoryPort, createSlackPort } from "./slack/slackPort.js";

const log = (msg: string): void => console.error(`[causeway] ${msg}`);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** PM2 kill_timeout(8s) 안에서 배분하는 종료 예산 — 디스패처 정지 후 안내까지 총 5s (RS-07). */
const SHUTDOWN_DISPATCHER_BUDGET_MS = 3_500;
const SHUTDOWN_NOTIFY_BUDGET_MS = 1_500;

async function notifyShutdown(poster: Poster, task: RunningChatTaskInfo): Promise<void> {
  // 진행 카드가 있으면 그 자리를 교체, 없으면 스레드 새 답글
  await poster.postFinal(SHUTDOWN_NOTICE, {
    channel: task.channel,
    threadTs: task.threadTs,
    ...(task.progressTs !== null ? { replaceTs: task.progressTs } : {}),
  });
}

/** bolt 소켓 리시버의 client 를 disconnect→start 로 재연결하는 어댑터 (RS-03).
 *
 * app.receiver 는 private 이라 구조적 최소 형태로 좁혀 접근한다 — 이 좁힘이 깨지면
 * 재연결이 no-op 이 되므로 receiver.client 부재를 명시 로그로 남긴다. */
function createBoltReconnector(app: App, log: (msg: string) => void): SocketReconnector {
  interface SocketClientLike {
    disconnect(): Promise<unknown>;
    start(): Promise<unknown>;
  }
  const receiver = (app as unknown as { receiver?: { client?: SocketClientLike } }).receiver;
  return {
    async reconnect(reason) {
      const client = receiver?.client;
      if (!client || typeof client.disconnect !== "function") {
        log(`재연결 불가 — Socket Mode client 접근 실패 (${reason})`);
        return false;
      }
      try {
        log(`Socket Mode 강제 재연결 시도 (${reason})`);
        await client.disconnect();
        await client.start();
        log(`Socket Mode 재연결 완료 (${reason})`);
        return true;
      } catch (err) {
        log(`Socket Mode 재연결 실패 (${reason}): ${String(err)}`);
        return false;
      }
    },
  };
}

async function main(): Promise<void> {
  // .env 는 명시 호출로만 로드 — env.ts 는 순수 로더로 유지 (SEC-20)
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const env = loadEnv(process.env);

  // 파일 DB·워크스페이스 디렉토리는 부팅이 보장한다 — 첫 구동 실패 원인 1순위 제거
  if (env.dbPath !== ":memory:") mkdirSync(dirname(env.dbPath), { recursive: true });
  mkdirSync(env.workspaceDir, { recursive: true });

  const app = new App({
    token: env.slackBotToken,
    appToken: env.slackAppToken,
    socketMode: true,
    // WebClient 기본값 timeout=0(무제한)을 덮는다 — 소켓이 멎으면 호출자가 영영 매달린다.
    // 재시도 정책은 기본값(10회/약 30분) 그대로 두어 런타임 게시의 회복력은 유지한다.
    clientOptions: { timeout: CONTRACT.SLACK_REQUEST_TIMEOUT_MS },
  });

  // 부팅 경로에서 첫 로그가 나오기 전의 유일한 블로킹 I/O 가 아래 auth.test 다. 여기서 멈추면
  // 프로세스는 online 인데 로그가 0줄이라, 재시작 판정(scripts/restart.sh)이 원인을 못 남기고
  // '부팅 실패'로만 처리한다. 진입을 먼저 찍어 침묵 구간을 없앤다.
  //
  // ⚠️ 이 문구에 `auth.test` 를 넣지 말 것. restart.sh 의 실패 정규식이 그 문자열을 부팅 실패
  // 신호로 삼기 때문에, 진행 로그에 넣으면 **정상 부팅이 매번 실패로 판정**된다. 실패 쪽은
  // 반대로 DeadlineError 메시지가 `Slack auth.test …` 라 그 정규식에 정확히 걸린다.
  log("Slack 워크스페이스 인증 확인 중…");

  // 자기 식별 — 멘션 토큰 제거(botUserId)·봇 발신 판별(botId)·plan 스트림 recipient_team_id(teamId)의 근거 (SC-05/06)
  // 재시도 포함 전체 마감을 건다. 부팅 판정 창보다 짧게 끊어, 무음 초과 대신 에러를 남기고 죽는다.
  const auth = (await withDeadline(
    app.client.auth.test(),
    CONTRACT.BOOT_AUTH_DEADLINE_MS,
    "Slack auth.test",
  )) as {
    user_id?: string;
    bot_id?: string;
    team_id?: string;
  };
  if (!auth.user_id) {
    throw new Error("auth.test 에서 user_id 를 얻지 못했다 — 토큰 권한을 확인하라");
  }
  const botUserId = auth.user_id;

  const slack = createSlackPort(app.client, { log });

  // 선언 config — 지금은 채널 논리명 표(channels.yaml)와 access.json 뿐이다.
  const config = loadConfig(env.configDir, (p) => readFileSync(p, "utf8"));

  // 팀 메모리 프리플라이트 — 데몬이 죽었으면 한 번 되살리고, 그래도 안 되면 배선을 뺀다.
  // 여기서 하는 이유: 부팅 로그 한 줄로 "이번 실행은 기억이 있나"가 결정되고 드러나야 한다.
  // 실패해도 봇은 뜬다 — 메모리는 답의 질을 좌우하지만 봇의 생존 조건은 아니다.

  const ctx = createAppContext({
    env,
    slack,
    botUserId,
    botId: auth.bot_id ?? null,
    botTeamId: auth.team_id ?? null,
    log,
  });

  // 부팅 복구: 중단 잡 pending 전환 + 스레드 "재시작으로 중단되어 다시 시도" 안내 (JQ-05, OPS-05)
  const recovered = await ctx.recoverAndNotify();
  if (recovered.requeued.length > 0 || recovered.exhausted.length > 0) {
    log(
      `recoverInflight: 재시도 ${recovered.requeued.length}건, 소진 종결 ${recovered.exhausted.length}건`,
    );
  }

  ctx.dispatcher.start();

  // ── 복원력 배선 (socketHealth·wakeDetector·watchdog) ──────────────────────
  // 매 인바운드 이벤트에서 markEvent → idle 타이머·probe 기준선을 갱신한다 (RS-01/03).
  const eventTracker = createEventTracker();
  const markEvent = (event: Record<string, unknown>): void => {
    const channel = typeof event.channel === "string" ? event.channel : undefined;
    const ts = typeof event.ts === "string" ? event.ts : undefined;
    eventTracker.markEvent(channel, ts);
  };

  // 유실 메시지 replay = 실시간과 동일한 normalize→enqueue 경로 (RS-02).
  // dedup_key UNIQUE 가 재주입 안전을 보장한다. kind 는 원본 이벤트(멘션 토큰/DM)로 실시간과
  // 동일하게 정한다 — 멘션 없는 채널 메시지는 message 로 넣어 im 게이트가 버린다.
  const enqueueEvent = async (event: Record<string, unknown>): Promise<void> => {
    const kind = classifyReplayKind(event, botUserId);
    await ctx.listeners.handleEvent(kind, event);
  };

  // 운영 통보 목적지 — ops-notify role 채널(없으면 log-only, RS-06/OPS-10).
  const opsNotify = config.resolver.byRole("ops-notify")[0] ?? null;
  const notify = async (text: string): Promise<void> => {
    if (!opsNotify) {
      log(`ops-notify 채널 미설정 — 통보 로그만: ${text.split("\n")[0]}`);
      return;
    }
    await ctx.poster.postFinal(text, { channel: opsNotify.id });
  };

  // friction 로그 sink — var/ 아래 jsonl append (RS-09).
  const frictionPath =
    ctx.env.dbPath === ":memory:"
      ? join(ctx.env.workspaceDir, "friction_log.jsonl")
      : join(dirname(ctx.env.dbPath), "friction_log.jsonl");
  const friction = createFrictionLog({
    sink: createFileFrictionSink(frictionPath, { appendFileSync, readFileSync, existsSync }),
  });

  const resilience = createResilience({
    clock: { now: () => Date.now() },
    eventTracker,
    history: createSlackHistoryPort(app.client, { log }),
    reconnector: createBoltReconnector(app, log),
    enqueueEvent,
    listRecentThreads: (secs) => ctx.sessions.listRecentThreads(secs),
    // 워처 채널이 없다 — probe 대상은 최근 관여 스레드뿐이다(RS-04). 자동 트리거 채널을 두는
    // 봇이 아니므로 빈 배열이 정상이고, 나중에 워처를 들이면 여기에 채널이 실린다.
    autoTriggerChannels: [],
    listRunning: () => ctx.runningTasks.list(),
    notify,
    fetchPermalink: (channel, ts) => slack.fetchPermalink({ channel, ts }).catch(() => null),
    friction,
    wakeDetectorEnv: process.env.CAUSEWAY_WAKE_DETECTOR,
    log,
  });

  app.event("app_mention", async ({ event }) => {
    const e = event as unknown as Record<string, unknown>;
    markEvent(e);
    await ctx.listeners.handleEvent("app_mention", e);
  });
  app.event("message", async ({ event }) => {
    const e = event as unknown as Record<string, unknown>;
    markEvent(e);
    // 채널 메시지는 chat 리스너의 im 게이트가 버린다 — DM 만 대화로 이어진다.
    await ctx.listeners.handleEvent("message", e);
  });
  app.event("reaction_added", async ({ event }) => {
    // 좌표(channel/ts)는 넘기지 않는다 — 리액션의 item.ts 는 **과거 메시지**의 ts 라
    // socketHealth 의 "마지막으로 본 메시지" 기준선으로 쓰면 안 된다(RS-01). idle 타이머만 리셋한다.
    eventTracker.markEvent();
    await ctx.reactionListener.handleReactionAdded(event as unknown as Record<string, unknown>);
  });

  await app.start();
  resilience.start();

  // 스케줄 발화기 — 1분 tick. 타이머를 정각에 맞추지 않는 이유는 머신이 자면 정각 타이머가
  // 통째로 사라지기 때문이다. 매 분 "지난 발화가 있나"를 계산하는 쪽이 슬립에 강하다
  // (schedule/cron.ts lastFireAt).
  //
  // **타이머에는 `tick` 이 아니라 `createTicker` 를 건다.** dedup_key 는 잡의 중복만 막고
  // **이미 게시된 루트 메시지**는 되돌리지 못한다 — 슬랙이 안 닿아 postRoot 가 몇 분씩 붙들리면
  // 그동안 던져진 tick 들이 모두 "아직 잡이 없다"를 보고 각자 게시한다. 재진입 가드가 그
  // 겹침 자체를 없앤다(scheduler.ts createTicker 주석).
  if (ctx.schedules.length > 0) {
    const ticker = createTicker({
      schedules: ctx.schedules,
      jobs: ctx.store,
      postRoot: async ({ channel, text }) => {
        const res = await slack.postMessage({ channel, text });
        if (!res.ts) throw new Error("postMessage 가 ts 를 안 줬다");
        return res.ts;
      },
      log,
    });
    const runTick = () => ticker().catch((err) => log(`schedule tick 실패: ${String(err)}`));
    setInterval(runTick, 60_000).unref();
    void runTick(); // 부팅 직후 1회 — 꺼져 있는 동안 지나간 발화를 즉시 따라잡는다
  }
  log(`Socket Mode 시작 — bot=${auth.user_id}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} 수신 — graceful shutdown 시작`);

    // 안내 대상 스냅샷은 정지 전에 — stop() 이 작업을 끝내면 레지스트리에서 사라진다
    const running = ctx.runningTasks.list();
    // 복원력 루프부터 정지 — 종료 중 좀비 probe/재연결이 끼어들지 않게
    await resilience.stop();
    await Promise.race([ctx.dispatcher.stop(), sleep(SHUTDOWN_DISPATCHER_BUDGET_MS)]);

    if (running.length > 0) {
      log(`진행 중 작업 ${running.length}건 중단 안내`);
      await Promise.race([
        Promise.allSettled(running.map((task) => notifyShutdown(ctx.poster, task))),
        sleep(SHUTDOWN_NOTIFY_BUDGET_MS),
      ]);
    }

    try {
      await app.stop();
    } catch (err) {
      log(`bolt 정지 실패(무시): ${String(err)}`);
    }
    ctx.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// 직접 실행일 때만 부팅 — 테스트가 이 모듈의 상수/함수를 import 해도 부작용이 없다
const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    log(`부팅 실패: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
