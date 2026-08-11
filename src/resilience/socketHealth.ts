/**
 * 좀비 소켓 다층 복구 — probe → replay → 소프트 재연결 → strike → fast-exit (RS-01~04).
 *
 * 실사고(팀 메모리 project_slack_event_pause 케이스B): macOS 절전 후 "session 은 붙는데
 * 이벤트가 안 오는" 좀비 소켓. 재전송이 없으므로 놓친 메시지는 REST probe 로만 복구된다.
 *
 * 흐름:
 *   1) ZOMBIE_PROBE_IDLE_MS 무이벤트 → conversations.history(top-level) +
 *      conversations.replies(최근 관여 스레드) 능동 probe 로 '실제 유실' 여부를 확인한다.
 *      history 는 스레드 답글을 누락하므로 replies 스캔이 사각지대를 메운다(RS-04).
 *   2) 유실 확인 시:
 *      - 놓친 메시지를 slackListeners 와 동일한 normalize→enqueue 경로로 재주입(replay).
 *        dedup_key UNIQUE 가 replay 안전을 구조적으로 보장하므로 재판단이 필요 없다(RS-02).
 *        replay 는 markEvent(수신 헬스 신호)를 부르지 않는다 — REST 메시지는 파이프 건강의
 *        증거가 아니다(원칙 항목).
 *      - 이어서 소프트 재연결.
 *   3) strike≥ZOMBIE_STRIKE_LIMIT 면 fast-exit — 프로세스 매니저가 새 세션으로 재기동한다.
 *      재시작 우선 기조: in-process 재연결은 실측(example-sustain-bot)에서 4/4 복구 무효였다(RS-03).
 *   4) 재연결 직후엔 idle 을 기다리지 않고 RECONNECT_RECHECK_MS 뒤 1회 빠르게 재확인한다.
 *      성공 판정은 '재연결 완료' 로그가 아니라 "실제 이벤트 유입"이다(RS-03).
 *   5) 유실이 없으면(단지 조용함) 아무 것도 하지 않는다 — 불필요 churn 금지(RS-01).
 *
 * 부작용(시간·probe·재주입·재연결·exit·통보)은 전부 주입 — 테스트는 가짜 clock·port 로
 * idle→probe→replay dedup no-op→재연결→45s 재확인→strike 누적→exit 를 결정론 검증한다.
 */

import { CONTRACT } from "../core/constants.js";
import type { LastSeen } from "./eventTracker.js";
import { tsGreater } from "./eventTracker.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — probe 대상 채널·유실 판정
// ────────────────────────────────────────────────────────────────────

/** probe(REST) 최소 간격(ms) — 조용한 채널을 계속 두드리지 않게. */
export const PROBE_MIN_INTERVAL_MS = 150_000;
/** 최근 관여 스레드 조회 창(초) — 오래된 스레드 전수조사 방지(RS-04). */
export const MISSED_THREAD_LOOKBACK_SEC = 2 * 60 * 60;
/** 한 번의 probe 에서 확인할 스레드 수 상한. */
export const MISSED_THREAD_MAX = 20;
/**
 * top-level probe 채널을 도출할 세션 조회 창(초) — 스레드 답글 창(2h)보다 훨씬 길다.
 *
 * 실사고 2026-07-28: DM 은 autoTriggerChannels(워처 채널)에 없고 lastSeen 도 알람 채널이라
 * probe 대상에서 빠져, DM 만 유실된 좀비 소켓이 '조용함'으로 오판됐다. 세션 테이블은 재시작
 * 후에도 남으므로 "최근 대화한 채널"의 안정적인 출처가 된다.
 */
export const PROBE_CHANNEL_LOOKBACK_SEC = 7 * 24 * 60 * 60;
/** 한 번의 probe 에서 history 를 두드릴 채널 수 상한 — 세션이 많아도 API 폭주 방지. */
export const PROBE_CHANNEL_MAX = 8;

/** probe 로 수집한 원시 Slack 메시지(부분) — enqueue 전 최소 형태. */
export interface ProbedMessage {
  ts: string;
  channel: string;
  /** 봇 발신 판별용 — 있으면 봇 메시지(유실 아님, 봇↔봇 왕복 차단). */
  botId: string | null;
  subtype: string | null;
  /** 원본 이벤트 전체 — replay 시 normalize 에 그대로 넘긴다. */
  raw: Record<string, unknown>;
}

/**
 * probe 채널 목록 조립: 자동 트리거 채널 + 마지막으로 본 채널 + 최근 대화 채널(중복 제거).
 *
 * 자동 트리거(알람) 채널은 이벤트 유실 비용이 가장 커서 항상 앞에 오고, lastSeen 까지는
 * 절대 잘리지 않는다. 최근 대화 채널(DM 포함)은 그 뒤에 붙어 max 까지만 채운다 — 이 꼬리가
 * 없으면 DM 만 유실된 좀비를 영영 못 본다(2026-07-28 실사고).
 */
export function buildProbeChannels(
  autoTriggerChannels: readonly string[],
  lastSeen: LastSeen | null,
  recentChannels: readonly string[] = [],
  max: number = PROBE_CHANNEL_MAX,
): string[] {
  const out: string[] = [];
  const add = (ch: string | undefined | null): void => {
    if (ch && !out.includes(ch)) out.push(ch);
  };
  // 필수 구간 — max 와 무관하게 전부 넣는다(유실 비용이 가장 큰 채널을 잘라내지 않는다).
  for (const ch of autoTriggerChannels) add(ch);
  add(lastSeen?.channel);
  // 보강 구간 — 최신순으로 상한까지만.
  for (const ch of recentChannels) {
    if (out.length >= max) break;
    add(ch);
  }
  return out;
}

/** 스레드 목록에서 채널만 순서 보존·중복 제거로 뽑는다(최신순 입력 → 최신순 출력). */
export function uniqueChannels(threads: readonly { channel: string }[]): string[] {
  const out: string[] = [];
  for (const t of threads) {
    if (t.channel && !out.includes(t.channel)) out.push(t.channel);
  }
  return out;
}

/**
 * 한 후보 메시지가 '유실'인지 판정 — seen 이후 + 봇 발신 아님 + 시스템 subtype 아님.
 * 이미 수집된 ts(seenTsSet)면 중복(브로드캐스트 답글 등)이므로 제외.
 */
export function isMissed(
  m: ProbedMessage,
  baselineTs: string,
  alreadyTs: ReadonlySet<string>,
): boolean {
  if (!m.ts || !tsGreater(m.ts, baselineTs)) return false;
  if (m.botId !== null) return false; // 봇 발신 — 유실 아님
  if (m.subtype === "channel_join" || m.subtype === "channel_leave") return false;
  if (alreadyTs.has(m.ts)) return false;
  return true;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (probe·replay·재연결·exit 는 주입)
// ────────────────────────────────────────────────────────────────────

/** Slack 읽기 포트 — probe 전용. 쓰기 포트(SlackPort)와 분리 주입. */
export interface SlackHistoryPort {
  /** 채널 top-level 조회(oldest 이후). 실패 시 null(판정 불가), 성공 시 메시지 배열. */
  conversationsHistory(args: {
    channel: string;
    oldest: string;
    limit: number;
  }): Promise<ProbedMessage[] | null>;
  /** 스레드 답글 조회(oldest 이후). 부모 ts 는 호출부가 제외한다. */
  conversationsReplies(args: {
    channel: string;
    ts: string;
    oldest: string;
    limit: number;
  }): Promise<ProbedMessage[] | null>;
}

export interface SocketHealthDeps {
  clock: { now(): number };
  /** 마지막 실제 이벤트 수신 시각(ms) — idle 계산 기준. */
  lastEventAt(): number;
  /** 마지막으로 본 메시지 좌표 — probe 기준선. null 이면 판정 불가. */
  lastSeen(): LastSeen | null;
  /** 소켓 재연결 후 기준선을 '지금'으로 당긴다(eventTracker.resetBaseline). */
  resetBaseline(): void;
  history: SlackHistoryPort;
  /** 최근 관여 스레드 — sessionStore.listRecentThreads(RS-04). */
  listRecentThreads(withinSeconds: number): Array<{ channel: string; threadTs: string }>;
  /** probe 대상 자동 트리거 채널(알람 채널 등). */
  autoTriggerChannels: readonly string[];
  /**
   * 유실 메시지 재주입 — slackListeners.handleEvent 와 동일한 normalize→enqueue 경로.
   * dedup_key UNIQUE 가 replay 안전을 보장(같은 ts 재주입은 조용히 no-op)한다(RS-02).
   */
  enqueueEvent(event: Record<string, unknown>): Promise<void>;
  /** 소프트 재연결(disconnect→connect). 결과 boolean. */
  reconnect(reason: string): Promise<boolean>;
  /** fast-exit — 프로세스 매니저가 재기동(RS-03). 테스트는 주입으로 관측한다. */
  exit(code: number): void;
  /** 운영 채널 통보(egress 경유). */
  notify(text: string): Promise<void>;
  /** stall/재연결/재시작 마찰 기록(RS-09) 자리. */
  onFriction?: (pattern: "zombie_reconnect" | "zombie_restart", detail: string) => void;
  /** tick 대기 — 취소 가능. 테스트는 즉시 resolve 하는 가짜를 주입한다. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  checkIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface SocketHealth {
  /** 단일 점검(주입 clock 기준) — 루프 없이 결정론 테스트용. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/** 점검 간격(ms). */
export const EVENT_CHECK_INTERVAL_MS = 120_000;

export function createSocketHealth(deps: SocketHealthDeps): SocketHealth {
  const checkIntervalMs = deps.checkIntervalMs ?? EVENT_CHECK_INTERVAL_MS;
  const log = deps.log ?? (() => {});

  let lastProbeAt = 0;
  let strikes = 0;
  // 재연결 직후 예약된 '빠른 재확인' 시각(ms) — null 이면 예약 없음
  let verifyAt: number | null = null;
  let controller: AbortController | null = null;
  let loopDone: Promise<void> | null = null;

  /** 세션 조회 실패가 probe 전체를 죽이지 않게 감싼다 — 실패는 '최근 스레드 없음'으로 퇴화. */
  function recentThreads(withinSeconds: number): Array<{ channel: string; threadTs: string }> {
    try {
      return deps.listRecentThreads(withinSeconds);
    } catch (err) {
      log(`probe listRecentThreads 실패(${withinSeconds}s): ${String(err)}`);
      return [];
    }
  }

  /** 소켓이 실제로 놓친 메시지 능동 수집(history + replies). null=판정불가, []=유실없음. */
  async function collectMissed(baselineTs: string): Promise<ProbedMessage[] | null> {
    const lastSeen = deps.lastSeen();
    // 최근 대화 채널(DM 포함)까지 top-level probe 대상에 넣는다 — 워처 채널만 보면
    // DM 만 유실된 좀비가 '조용함'으로 오판된다(2026-07-28 실사고).
    const channels = buildProbeChannels(
      deps.autoTriggerChannels,
      lastSeen,
      uniqueChannels(recentThreads(PROBE_CHANNEL_LOOKBACK_SEC)),
    );
    let anyOk = false;
    const missed: ProbedMessage[] = [];
    const seenTs = new Set<string>();

    const consider = (m: ProbedMessage): void => {
      if (isMissed(m, baselineTs, seenTs)) {
        missed.push(m);
        seenTs.add(m.ts);
      }
    };

    // 1) 채널 top-level 유실
    for (const ch of channels) {
      const res = await deps.history
        .conversationsHistory({ channel: ch, oldest: baselineTs, limit: 5 })
        .catch(() => null);
      if (res === null) continue;
      anyOk = true;
      for (const m of res) consider({ ...m, channel: ch });
    }

    // 2) 최근 관여 스레드 답글 유실 (history 사각지대 보완, RS-04)
    //    답글 스캔은 창을 좁게 유지한다 — 오래된 스레드 전수조사는 비용만 크다.
    const recent = recentThreads(MISSED_THREAD_LOOKBACK_SEC);
    for (const { channel: ch, threadTs } of recent.slice(0, MISSED_THREAD_MAX)) {
      const res = await deps.history
        .conversationsReplies({ channel: ch, ts: threadTs, oldest: baselineTs, limit: 20 })
        .catch(() => null);
      if (res === null) continue;
      anyOk = true;
      for (const m of res) {
        if (m.ts === threadTs) continue; // 스레드 부모 — 답글 아님
        consider({ ...m, channel: ch });
      }
    }

    if (!anyOk) return null;
    return missed;
  }

  /** 놓친 메시지를 normalize→enqueue 경로로 재주입 — dedup 이 안전 보장(RS-02). */
  async function replayMissed(missed: readonly ProbedMessage[]): Promise<void> {
    for (const m of missed) {
      try {
        log(`좀비 유실 메시지 재주입 — channel=${m.channel} ts=${m.ts}`);
        await deps.enqueueEvent({ ...m.raw, channel: m.channel });
      } catch (err) {
        log(`유실 메시지 재주입 실패 — channel=${m.channel} ts=${m.ts}: ${String(err)}`);
      }
    }
  }

  /** 소프트 재연결 + 기준선 리셋 + 45s 뒤 빠른 재확인 예약(RS-03). */
  async function softReconnect(reason: string): Promise<boolean> {
    const ok = await deps.reconnect(reason).catch(() => false);
    deps.resetBaseline();
    // 새 세션이 또 좀비일 수 있어(연속 좀비 실사고) idle 대신 45s 뒤 1회 강제 재확인
    verifyAt = deps.clock.now() + CONTRACT.RECONNECT_RECHECK_MS;
    deps.onFriction?.("zombie_reconnect", reason);
    return ok;
  }

  /** fast-exit — strike 상한 도달 시(RS-03). 유실은 재멘션 안내로 넘긴다(replay 하지 않는다). */
  async function fastExit(reason: string): Promise<void> {
    log(`좀비 소켓 자가복구 실패 → fast-exit — ${reason}`);
    deps.onFriction?.("zombie_restart", reason);
    try {
      await deps.notify(
        `:rotating_light: 좀비 소켓 자가복구 실패 → *프로세스 강제 재시작*.\n` +
          `> 사유: ${reason}\n` +
          `> 프로세스 매니저가 곧 재기동합니다. 유실 메시지는 소급되지 않으니 필요시 재멘션 해주세요. ` +
          `(런북: docs/runbook-slack-event-pause.md)`,
      );
    } catch {
      // 통보 실패가 exit 를 막지 않는다
    }
    deps.exit(1);
  }

  async function tick(): Promise<void> {
    const now = deps.clock.now();
    const idle = now - deps.lastEventAt();
    // 재연결 직후 예약된 '빠른 재확인'은 idle·probe 간격 게이트를 건너뛰고 1회 강제 실행
    const verifyDue = verifyAt !== null && now >= verifyAt;
    if (verifyDue) {
      verifyAt = null; // one-shot 소진
    } else {
      if (idle < CONTRACT.ZOMBIE_PROBE_IDLE_MS) return;
      if (now - lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
    }
    lastProbeAt = now;

    const lastSeen = deps.lastSeen();
    if (!lastSeen) {
      // 기준선 없음 → 판정 불가. probe 없이 조용히 넘긴다(과도한 재연결 금지).
      return;
    }
    const missed = await collectMissed(lastSeen.ts);

    if (missed === null) {
      // probe 전부 실패 → 판정 불가. 소프트 재연결도 하지 않는다(유실 확인 전 재연결 금지, RS-01).
      log(`probe 판정 불가(all API fail) idle=${Math.round(idle / 1000)}s`);
      return;
    }

    if (missed.length === 0) {
      // 유실 없음 = 그냥 조용함 → strike 리셋(RS-01).
      strikes = 0;
      // 단, probe 가 볼 수 있는 건 '대상 채널의 유실'뿐이다. 아직 아무도 말을 걸지 않은 좀비
      // 소켓은 조용함과 구분되지 않으므로, 무이벤트가 길어지면 예방적으로 1회 재연결한다.
      // probe 가 성공한 직후이므로 네트워크 장애 중 헛재연결이 아님이 보장된다(RS-01 사각지대).
      // strike 를 올리지 않고 verifyAt 도 예약하지 않는다 — 좀비 확증이 아니라 예방이다.
      // resetBaseline 이 idle 을 0 으로 되돌려 다음 예방 재연결까지 자연 쿨다운이 걸린다.
      if (idle >= CONTRACT.ZOMBIE_IDLE_RECONNECT_MS) {
        const reason = `idle-preventive idle=${Math.round(idle / 60000)}m`;
        log(`무이벤트 ${Math.round(idle / 60000)}분 + 유실 없음 → 예방적 소켓 재연결`);
        const ok = await deps.reconnect(reason).catch(() => false);
        deps.resetBaseline();
        deps.onFriction?.("zombie_reconnect", `${reason} ok=${ok}`);
      }
      return;
    }

    // 유실 확인 = 좀비
    strikes += 1;
    if (strikes >= CONTRACT.ZOMBIE_STRIKE_LIMIT) {
      // 강제 재시작 경로에서는 replay 하지 않는다 — os._exit 로 죽으므로. 재멘션 안내로 넘긴다.
      await fastExit(
        `좀비 소켓(유실 ${missed.length}건) — 소프트 재연결 ${strikes - 1}회 실패, ` +
          `idle=${Math.round(idle / 1000)}s`,
      );
      return;
    }

    // 1) 놓친 메시지 소급 처리(replay) — dedup 이 안전 보장
    await replayMissed(missed);
    // 2) 파이프 복구
    const reconnected = await softReconnect(
      `zombie-confirmed idle=${Math.round(idle / 1000)}s strike=${strikes}`,
    );
    try {
      await deps.notify(
        `:warning: Slack 이벤트 유실 ${missed.length}건 감지(약 ${Math.round(idle / 60000)}분 무수신) → ` +
          `놓친 메시지 소급 처리 + 소켓 ${reconnected ? "재연결" : "재연결 실패"} ` +
          `(strike ${strikes}/${CONTRACT.ZOMBIE_STRIKE_LIMIT}).\n` +
          `> ${Math.round(CONTRACT.RECONNECT_RECHECK_MS / 1000)}s 후 실제 이벤트 유입을 재확인합니다.`,
      );
    } catch (err) {
      log(`socketHealth 통보 실패: ${String(err)}`);
    }
  }

  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await deps.sleep(checkIntervalMs, signal);
      } catch {
        return;
      }
      if (signal.aborted) return;
      try {
        await tick();
      } catch (err) {
        log(`socketHealth tick 실패: ${String(err)}`);
      }
    }
  }

  return {
    tick,
    start() {
      if (controller) return;
      controller = new AbortController();
      loopDone = loop(controller.signal);
    },
    async stop() {
      if (!controller) return;
      controller.abort();
      const done = loopDone;
      controller = null;
      loopDone = null;
      if (done) await done;
    },
  };
}
