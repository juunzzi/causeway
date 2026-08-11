/**
 * AppContext 조립 — env → db → stores → ports → dispatcher (OPS-07).
 *
 * 부작용 객체 생성은 전부 여기로 모으고, 각 모듈은 인터페이스 주입만 받는다.
 * 테스트는 db(:memory:)와 slack(가짜 포트)을 주입해 부팅 시퀀스를 그대로 검증한다.
 *
 * 잡이 chat 하나뿐이라 이 파일이 하는 일은 사실상 **어떤 도구를 어떤 요청자에게 조립할
 * 것인가** 하나로 수렴한다.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { CommandExecutor } from "./commands/index.js";
import { createCommandExecutor } from "./commands/index.js";
import type { AppEnv } from "./config/env.js";
import { ALLOW_ALL, loadAccessConfig } from "./config/loader.js";
import type { Clock } from "./core/clock.js";
import { openDatabase } from "./core/db/connection.js";
import { migrate } from "./core/db/migrations.js";
import { Dispatcher } from "./core/queue/dispatcher.js";
import { JobStore, type RecoverResult } from "./core/queue/jobStore.js";
import { LeaseManager } from "./core/queue/lease.js";
import type { AnyJobHandler } from "./core/queue/types.js";
import { buildRegistry } from "./core/registry.js";
import { createPoster, type Poster } from "./egress/poster.js";
import { createReactionManager, type ReactionManager } from "./egress/reactions.js";
import { createIngressDedup } from "./ingress/ingressDedup.js";
import { createReactionListener, type ReactionListener } from "./ingress/reactionListener.js";
import { createSlackListeners, type SlackListeners } from "./ingress/slackListeners.js";
import type { SkillNote } from "./jobs/chat/context.js";
import { CHAT_JOB_TYPE, type ChatToolRequest, chatPayloadSchema } from "./jobs/chat/handler.js";
import { type ChatTaskRegistry, createChatTaskRegistry } from "./jobs/chat/runningTasks.js";
import { buildJobHandlers } from "./jobs/index.js";
import { buildMcpRegistry, type McpToolEntry } from "./mcp/registry.js";
import type { runSession } from "./runner/runner.js";
import { type LoadedSchedule, validateSchedules } from "./schedule/scheduler.js";
import { type Acl, createAcl } from "./security/acl.js";
import { createSessionStore, type SessionStore } from "./sessions/sessionStore.js";
import { createThreadLocks, type ThreadLocks } from "./sessions/threadLock.js";
import type { ChatSlackPort } from "./slack/slackPort.js";
import { createUserDirectory } from "./slack/userDirectory.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 안내문 상수 (RS-12: 유실 시 재멘션 문구 유지)
// ────────────────────────────────────────────────────────────────────

export const RESTART_RETRY_NOTICE =
  "⚠️ 봇 재시작으로 작업이 중단되어 다시 시도합니다. " +
  "복구 전 발송된 멘션은 소급되지 않으니, 응답이 없으면 다시 멘션해 주세요.";

export const RESTART_EXHAUSTED_NOTICE =
  "❌ 봇 재시작으로 중단된 작업이 재시도 상한을 초과해 종결됐습니다. 다시 멘션해 주세요.";

export const SHUTDOWN_NOTICE =
  "⚠️ 봇 재시작으로 작업이 중단됐습니다. 같은 스레드에서 다시 멘션하면 세션이 이어집니다.";

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────

export interface AppContextDeps {
  env: AppEnv;
  slack: ChatSlackPort;
  botUserId: string;
  /** 봇 자신의 bot_id — 컨텍스트 봇 발신 판별 (SC-05). auth.test 미제공 시 null. */
  botId: string | null;
  /** 부팅 auth.test 의 team_id — 채널 plan 카드 스트리밍의 recipient_team_id. 미제공 시 null. */
  botTeamId: string | null;
  /** 테스트 주입용 — 생략 시 env.dbPath 로 파일 DB 를 연다. */
  db?: DatabaseSync;
  runSessionFn?: typeof runSession;
  clock?: Clock;
  /** access.json fs.watch 핫리로드 — 테스트는 false. */
  aclWatch?: boolean;
  baseEnv?: Record<string, string | undefined>;
  /** repo 내 skills/ 절대 경로 — 잡이 SKILL.md 를 Read 로 읽는다(SK-01). 생략 시 모듈 기준 자동 해석. */
  skillsDir?: string;
  log?: (msg: string) => void;
}

/**
 * skills/ 디렉토리 기본 경로 — 이 모듈(src/context.ts 또는 dist/context.js)에서 한 단계 위가
 * repo 루트이고 그 아래 skills/ 가 있다. env 없이 배포 위치에 강건하게 해석한다(SK-01).
 */
export function defaultSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

export interface AppContext {
  env: AppEnv;
  /** 검증을 통과한 스케줄. 빈 배열이면 발화기는 아무것도 안 한다. */
  schedules: readonly LoadedSchedule[];
  db: DatabaseSync;
  store: JobStore;
  sessions: SessionStore;
  locks: ThreadLocks;
  acl: Acl;
  poster: Poster;
  reactions: ReactionManager;
  runningTasks: ChatTaskRegistry;
  registry: ReadonlyMap<string, AnyJobHandler>;
  dispatcher: Dispatcher;
  commands: CommandExecutor;
  listeners: SlackListeners;
  /** 🛑 리액션 취소 트리거 (SC-09) — index.ts 의 reaction_added 배선이 유일한 호출자다. */
  reactionListener: ReactionListener;
  /** 부팅 시 1회: inflight 복구 + 해당 chat 스레드에 안내 (JQ-05, OPS-05). */
  recoverAndNotify(): Promise<RecoverResult>;
  close(): void;
}

/** access.json allowed 추가 — 스키마 검증 후 원자적 재작성. acl 핫리로드가 반영을 맡는다 (SEC-19). */
export function appendAllowedUser(accessPath: string, userId: string): void {
  const config = loadAccessConfig(accessPath);
  // 전원 허용(와일드카드) 중에는 개별 추가가 무의미하다 — 파일을 건드리지 않는다
  if (config.allowed.includes(ALLOW_ALL)) return;
  if (config.allowed.includes(userId) || config.admins.includes(userId)) return;
  const next = { ...config, allowed: [...config.allowed, userId] };
  writeFileSync(accessPath, `${JSON.stringify(next, null, 2)}\n`);
}

export function createAppContext(deps: AppContextDeps): AppContext {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const env = deps.env;
  const baseEnv = deps.baseEnv ?? process.env;

  const db = deps.db ?? openDatabase(env.dbPath);
  migrate(db);

  const store = new JobStore(db, deps.clock);
  const lease = new LeaseManager(db, { clock: deps.clock });
  const ingressDedup = createIngressDedup(db);
  const sessions = createSessionStore(db);
  const locks = createThreadLocks();
  const runningTasks = createChatTaskRegistry();

  const accessPath = join(env.configDir, "access.json");
  const acl = createAcl({
    path: accessPath,
    watch: deps.aclWatch,
    logger: { info: log, error: log },
  });

  const poster = createPoster(deps.slack, { log });
  const reactions = createReactionManager({ slack: deps.slack, log });

  // ID→표시명 디렉토리 (EG-08) — 프로세스 수명 동안 캐시를 공유해 매 턴 users.info 를 반복하지 않는다.
  const users = createUserDirectory({
    fetchUserName: (userId) => deps.slack.fetchUserName(userId),
    ...(deps.clock ? { clock: deps.clock } : {}),
    log,
  });

  const skillsDir = deps.skillsDir ?? defaultSkillsDir();

  // 세션이 Read/Grep 할 수 있는 로컬 체크아웃 — **절대경로**로 굳힌다(SDK additionalDirectories
  // 계약이고, 상대경로는 봇 프로세스 cwd 기준으로 조용히 어긋난다). 존재하지 않는 경로는
  // 선언에서 뺀다 — 없는 디렉토리를 선언하면 "읽을 수 있다"는 오해만 남는다.
  const referenceDirs = env.referenceDirs
    .map((dir) => resolve(dir))
    .filter((dir) => existsSync(dir));
  const missingReferenceDirs = env.referenceDirs
    .map((dir) => resolve(dir))
    .filter((dir) => !existsSync(dir));
  if (missingReferenceDirs.length > 0) {
    log(`참조 체크아웃 미배선(경로 없음) — ${missingReferenceDirs.join(", ")}`);
  }

  // ── 도구 게이트 판정 ────────────────────────────────────────────────────
  // 전부 **부팅 시 1회** 판정하고 결과를 로그로 남긴다. "도구가 왜 안 붙었나"는 운영에서 가장
  // 자주 묻는 질문이고, 답이 로그에 없으면 세션이 "도구가 없다"고 답한 이유를 아무도 모른다.

  // 스킬 안내 — 잡이 세션 프롬프트에 실을 "언제 무엇을 읽어라" 목록. 도구를 붙였다면
  // 대개 그 절차를 적은 SKILL.md 도 함께 실어야 세션이 일관되게 쓴다.
  const chatSkillNotes: SkillNote[] = [];

  /**
   * 요청자별 chat 도구 조립.
   *
   * **세션마다 호출된다**(부팅 때 한 번이 아니다). 이유가 둘이다:
   * ① acl 은 핫리로드되므로 조립 시점 판정이 곧 최신 명단이다(부팅 시점 캐시가 아니다).
   * ② in-process 인스턴스는 세션당 하나여야 한다(McpToolEntry 주석) — run 마다 호출되는 이
   *    함수가 그 계약을 자동으로 만족시킨다.
   *
   * 요청자에 따라 도구 구성을 달리하고 싶으면(예: 관리자에게만 쓰기 도구) 그 분기를 여기에 둔다.
   */
  const chatMcpToolsFor = (req: ChatToolRequest): McpToolEntry[] =>
    buildMcpRegistry({
      // Slack 메시지 링크 조회 — 사람은 링크만 붙여놓고 "이거 봐줘"라고 한다. 범위는 봇 멤버십
      // 게이트가 전부다(requester 는 payload 유래라 남의 DM 을 지목할 수단이 없다).
      slackRead: {
        requester: req,
        fetchChannelInfo: (channel: string) => deps.slack.fetchChannelInfo(channel),
        isChannelMember: (input: { channel: string; userId: string }) =>
          deps.slack.isChannelMember(input),
        fetchThreadMessages: (input: { channel: string; threadTs: string; limit?: number }) =>
          deps.slack.fetchThreadMessages(input),
        resolveNames: (userIds: readonly string[]) => users.namesFor(userIds),
        log,
      },
    });

  const handlers = buildJobHandlers({
    chat: {
      slack: deps.slack,
      threads: deps.slack,
      users,
      // 요청자와 무관한 정적 도구를 붙일 자리(외부 stdio·원격 HTTP 서버 등).
      // in-process 도구는 여기 말고 mcpToolsFor 로 — 세션당 인스턴스 계약 때문이다.
      mcpTools: () => [],
      poster,
      reactions,
      sessions,
      locks,
      runningTasks,
      workspaceDir: env.workspaceDir,
      ...(referenceDirs.length > 0 ? { readonlyDirs: referenceDirs } : {}),
      selfBotId: deps.botId,
      botTeamId: deps.botTeamId,
      mcpToolsFor: chatMcpToolsFor,
      ...(chatSkillNotes.length > 0 ? { skillNotes: chatSkillNotes } : {}),
      runSessionFn: deps.runSessionFn,
      baseEnv: deps.baseEnv,
      clock: deps.clock,
      log,
    },
  });

  // 스케줄 적재 — **조용히 안 울리는 스케줄이 최악**이라 문제를 부팅 로그에 전부 드러낸다.
  // 파일이 없으면 스케줄 기능이 꺼진 것으로 본다(에러 아님).
  const schedulesPath = join(env.configDir, "schedules.json");
  let schedules: LoadedSchedule[] = [];
  if (existsSync(schedulesPath)) {
    const repoRoot = join(skillsDir, "..");
    const parsed = validateSchedules(JSON.parse(readFileSync(schedulesPath, "utf8")), (file) => {
      const abs = join(repoRoot, file);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    });
    schedules = parsed.schedules;
    for (const err of parsed.errors) log(`schedule 설정 오류 — ${err}`);
    log(
      schedules.length > 0
        ? `schedule 배선 — ${schedules.map((s) => `${s.id}(${s.cron})`).join(", ")}`
        : "schedule 미배선 — 활성 스케줄 없음",
    );
  } else {
    log("schedule 미배선 — config/schedules.json 없음");
  }

  const registry = buildRegistry(handlers);

  const dispatcher = new Dispatcher({
    store,
    registry,
    lease,
    clock: deps.clock,
    onError: (err, job) => log(`dispatcher error job=${job?.id ?? "?"}: ${String(err)}`),
  });

  const commands = createCommandExecutor({
    isAdmin: (userId) => acl.isAdmin(userId),
    getSession: (threadKey) => {
      const record = sessions.get(threadKey);
      return record
        ? { sessionId: record.sessionId, cwd: record.cwd, lastSeenTs: record.lastSeenTs }
        : null;
    },
    countJobs: () => store.countByStatus(),
    cancelThread: (threadKey) => runningTasks.cancel(threadKey),
    allowUser: (userId) => appendAllowedUser(accessPath, userId),
    reply: async (ctx, text) => {
      await poster.postFinal(text, { channel: ctx.channel, threadTs: ctx.threadTs });
    },
  });

  const listeners = createSlackListeners({
    botUserId: deps.botUserId,
    botTeamId: deps.botTeamId,
    acl,
    store,
    commands,
    dedup: ingressDedup,
    poster,
    log,
  });

  // 🛑 리액션 → 진행 중 작업 중단. `/cancel` 과 같은 종착지(runningTasks)를 쓴다 — 트리거만
  // 둘이고 중단의 의미는 하나다. ingressDedup 은 태우지 않는다: 취소는 멱등하고(대상이 이미
  // 사라졌으면 no-op), 같은 메시지에 두 번 🛑 를 다는 것은 막을 이유가 없다.
  const reactionListener = createReactionListener({
    botUserId: deps.botUserId,
    botTeamId: deps.botTeamId,
    acl,
    cancelByMessage: (item) => runningTasks.cancelByMessage(item),
    log,
  });

  return {
    env,
    schedules,
    db,
    store,
    sessions,
    locks,
    acl,
    poster,
    reactions,
    runningTasks,
    registry,
    dispatcher,
    commands,
    listeners,
    reactionListener,

    async recoverAndNotify() {
      const result = store.recoverInflight();
      for (const job of result.requeued) {
        await notifyRecoveredJob(job.type, job.payload, RESTART_RETRY_NOTICE, null);
      }
      for (const job of result.exhausted) {
        await notifyRecoveredJob(job.type, job.payload, RESTART_EXHAUSTED_NOTICE, "fail");
      }
      return result;

      async function notifyRecoveredJob(
        type: string,
        payload: unknown,
        notice: string,
        reaction: "fail" | null,
      ): Promise<void> {
        if (type !== CHAT_JOB_TYPE) {
          log(`recoverInflight: chat 외 잡 복구 — type=${type} (스레드 안내 없음)`);
          return;
        }
        const parsed = chatPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          log(`recoverInflight: chat payload 해석 불가 — 안내 생략`);
          return;
        }
        const p = parsed.data;
        try {
          await poster.postFinal(notice, { channel: p.channel, threadTs: p.threadTs });
          if (reaction === "fail") await reactions.fail(p.channel, p.ts);
        } catch (err) {
          // 안내 실패가 부팅을 막으면 안 된다 — 복구 자체(pending 전환)는 이미 완료됐다
          log(`recoverInflight 안내 실패 thread=${p.threadKey}: ${String(err)}`);
        }
      }
    },

    close() {
      acl.close();
      db.close();
    },
  };
}
