/**
 * chat 잡 핸들러 — 멘션/DM 대화의 실행부 (SC-01~04, SC-09, EG-02/06).
 *
 * 흐름: ⏳ 리액션 → threadLock 안에서 진행 카드 → resume 판단 → 증분 컨텍스트 →
 * runner READONLY 실행(onProgress→카드) → egress finish → 세션 upsert → ✅/❌/🚫.
 * 세션 만료('No conversation found')는 drop 후 신규 세션 1회 재시도 (SC-04).
 */

import type { NonNullableUsage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Job, JobContext, JobHandler, JobResult } from "../../core/queue/types.js";
import type { SlackPort } from "../../egress/ports.js";
import type { Poster } from "../../egress/poster.js";
import { splitProgressLine } from "../../egress/progress.js";
import { createProgressDriver } from "../../egress/progressDriver.js";
import type { ReactionManager } from "../../egress/reactions.js";
import { createStatusPicker, pickPlainStatus } from "../../egress/statusPool.js";
import {
  type McpToolEntry,
  type McpToolFactory,
  SLACK_MCP_SERVER_NAME,
} from "../../mcp/registry.js";
import { buildReadonlyProfile, DEFAULT_MODEL } from "../../runner/profiles.js";
import type { RunResult, runSession } from "../../runner/runner.js";
import { runSession as realRunSession } from "../../runner/runner.js";
import { maskSecrets } from "../../security/maskSecrets.js";
import type { SessionStore } from "../../sessions/sessionStore.js";
import type { ThreadLocks } from "../../sessions/threadLock.js";
import type { ThreadReader } from "../../slack/slackPort.js";
import type { UserDirectory } from "../../slack/userDirectory.js";
import {
  buildChatPrompt,
  formatThreadContext,
  maxSeenTs,
  type SkillNote,
  selectContextMessages,
} from "./context.js";
import type { ChatTaskHandle, ChatTaskRegistry } from "./runningTasks.js";
import { lintChatStyle } from "./styleLint.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 계약 상수·스키마·판정
// ────────────────────────────────────────────────────────────────────

export const CHAT_JOB_TYPE = "chat";
/** 이벤트 재전송·일시 오류 1회 재시도까지 — 대화는 세 번 조르면 스팸이다. */
export const CHAT_MAX_ATTEMPTS = 2;

/**
 * 요청자별 MCP 도구 조립 입력 — userId(권한 판정) + 출처 스레드(피드백 노트의 provenance).
 * remember_feedback 이 저장하는 author·출처가 payload 에서 오므로 모델이 위조할 수 없다(SEC-07).
 */
export interface ChatToolRequest {
  userId: string;
  channel: string;
  threadTs: string;
  /**
   * 트리거 메시지 ts — 요청 1건을 식별한다. request_pr 의 dedup_key 근거이자(threadTs 를 쓰면
   * 한 스레드에 PR 이 영원히 1개다) 후속 잡이 리액션을 달 대상이다.
   */
  ts: string;
}

export const chatPayloadSchema = z.object({
  schema_version: z.literal(1),
  channel: z.string().min(1),
  /** 트리거 메시지 ts — 리액션 대상. */
  ts: z.string().min(1),
  threadTs: z.string().min(1),
  threadKey: z.string().min(1),
  userId: z.string().min(1),
  /** ingress 에서 정규화(멘션 제거)+sanitize 완료된 본문. */
  text: z.string(),
  files: z.array(z.object({ id: z.string(), name: z.string(), mimetype: z.string() })).default([]),
});
export type ChatPayload = z.infer<typeof chatPayloadSchema>;

export const CHAT_CANCELLED_TEXT = "🛑 사용자 요청으로 취소됨";
export const CHAT_RETRY_NOTICE = "⚠️ 일시 오류로 중단 — 잠시 후 자동 재시도합니다";
/**
 * 죽은 plan 스트림 정리 문구 — 스트림이 만료돼 stop 으로 못 닫고 재시도/종료로 떠날 때, 얼어붙은
 * "interactive elements" 카드를 이 짧은 종결 상태로 chat.update 교체한다(A 버그). 답변 본문은
 * 폴백 경로가 별도로 게시한다.
 */
export const CHAT_STREAM_CLOSED_NOTICE = "⚠️ 스트림이 종료됐습니다 — 아래 답변을 참조하세요";

/** plan 카드 헤더 — 진행 중임을 알리는 기본 제목. */
export const CHAT_PLAN_TITLE = "작업 진행 중";

/**
 * plan 카드에 task 로 노출하지 않을 도구 — TodoWrite/ExitPlanMode 는 진행 상황이 아니라
 * 모델 내부 계획 표시라 카드에 나오면 노이즈다. 폴백 진행 카드는 별도 카테고리 롤업을 쓴다.
 */
export const CHAT_HIDDEN_PLAN_TOOLS: ReadonlySet<string> = new Set(["TodoWrite", "ExitPlanMode"]);

/** 선행 구현 계약 — resume 실패는 이 문구가 결과 텍스트로 돌아온다. */
export const SESSION_EXPIRED_RE = /no conversation found/i;

export function isSessionExpired(result: Pick<RunResult, "text">): boolean {
  return result.text !== null && SESSION_EXPIRED_RE.test(result.text);
}

// splitProgressLine 은 egress/progress 로 이전됨(자동화 잡과 공유) — 하위호환 re-export.
export { splitProgressLine };

/**
 * 토큰 사용량은 답변에 싣지 않고 로그로만 남긴다 — 읽는 사람에게는 답과 무관한 노이즈이고,
 * `input_tokens` 는 캐시 적중분을 빼고 세서(`in 2` 같은 값이 흔하다) 비용으로 읽으면 오히려
 * 틀린 인상을 준다. 비용 장부는 운영자 몫이라 로그가 제자리다.
 */
export function formatUsageLog(usage: NonNullableUsage | null): string {
  if (!usage) return "usage=없음";
  return `in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0}`;
}

/**
 * 재작성 런 전용 타임아웃 — 원 런의 기본값(idle 10분/hard 30분, runner.ts)을 그대로 물려받으면
 * 이미 메모리에 있는 답을 다듬는 짧은 무도구 턴 하나에 최대 30분을 기다리게 된다. 도구를 안 쓰니
 * onProgress 가 안 돌아 lastStep 이 안 갱신되고, 그동안 워치독의 "스텝 없음" 오탐까지 겹친다.
 */
export const REWRITE_IDLE_TIMEOUT_MS = 90_000;
export const REWRITE_HARD_TIMEOUT_MS = 3 * 60_000;

/**
 * 스타일 재작성 프롬프트 — 위반 목록만 싣는다. 린트가 돌려준 문자열이 이미 지시문이라
 * 여기서 다시 풀어 쓰지 않는다.
 */
export function buildRewritePrompt(issues: readonly string[]): string {
  return [
    "방금 작성한 답변을 다시 써라.",
    `문제: ${issues.join("; ")}.`,
    "내용은 유지하되 문서가 아니라 짧은 메시지로 작성하고, 수정한 답변만 반환해라.",
  ].join(" ");
}

/**
 * 원 런 + 재작성 런의 토큰 합 — footer 가 실제로 찍는 두 필드만 더한다.
 * 원 런 값만 보이면 재작성 비용이 장부에서 사라진다.
 */
export function sumUsage(
  a: NonNullableUsage | null,
  b: NonNullableUsage | null,
): NonNullableUsage | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    ...a,
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
  };
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────

export interface ChatHandlerDeps {
  /** 진행 카드(egress) 구성용 — 이 핸들러가 Slack 을 직접 쓰는 경로는 없다 (EG-01). */
  slack: SlackPort;
  threads: ThreadReader;
  /** ID→표시명 해석 (EG-08) — 프롬프트 맥락·최종 답변 양쪽의 사람 이름 표기 근거. */
  users: UserDirectory;
  /**
   * 세션에 노출할 MCP 도구 manifest **팩토리** — chat 은 memory 팀 메모리(읽기) + datadog_query +
   * github_query·git_query + (배선됐다면) Analytics 커넥터를 받는다. 전부 조회 전용이다. 민감 키를
   * 만지는 도구는 in-process MCP 라 세션은 결과만 보고 키 자체는 봇 프로세스에만 남는다.
   *
   * 배열이 아니라 팩토리다 — 부팅 때 만든 in-process 인스턴스를 세션들이 공유하면, 다른 세션과
   * 겹치는 순간 그 도구들이 **에러 없이** 세션에서 빠진다(McpToolEntry 주석의 `Already connected`).
   * 알람 분석·다른 스레드 chat 과 겹치는 건 예외가 아니라 일상이다.
   */
  mcpTools?: McpToolFactory;
  poster: Poster;
  reactions: ReactionManager;
  sessions: SessionStore;
  locks: ThreadLocks;
  runningTasks: ChatTaskRegistry;
  /** READONLY 세션 cwd — 신규 세션의 기본. resume 은 저장된 cwd 를 따른다. */
  workspaceDir: string;
  /**
   * cwd 밖 읽기 전용 확장 경로(**절대경로**) — 현재는 your-repo 체크아웃 하나다.
   * 카탈로그(JSONL)에 없는 이벤트를 세션이 소스에서 직접 확인할 수 있어야 "카탈로그에 없다"와
   * "코드에 없다"를 구분해 답한다(2026-07-30: 스냅샷 수집 사각지대로 둘이 갈렸다).
   * 미지정이면 확장 없음 — 세션은 workspace 만 본다(기존 동작).
   */
  readonlyDirs?: readonly string[];
  /** 봇 자신의 bot_id — 컨텍스트에서 봇 발신 판별 (SC-05). */
  selfBotId: string | null;
  /**
   * 부팅 auth.test 의 team_id — 채널 plan 카드 스트리밍의 recipient_team_id(필수). null 이면
   * recipient_team_id 를 못 넘겨 채널 스트리밍이 거절될 수 있고, 그때는 진행 카드로 폴백한다.
   */
  botTeamId: string | null;
  /**
   * 요청자별 in-process MCP 도구 조립 — mytool_admin·remember_feedback 등. 요청자(Slack
   * userId)에 따라 노출 도구·쓰기 허용이 달라지고(관리자만 assign/revoke), 피드백 노트의
   * author·출처 스레드가 이 요청 정보로 고정되므로 run 시점에 조립한다. 미주입이면 도구 없음.
   */
  mcpToolsFor?: (req: ChatToolRequest) => readonly McpToolEntry[];
  /** 프롬프트에 노출할 절차 스킬 안내(fresh 턴 전용) — mytool-admin 등 SKILL.md 라우팅. */
  skillNotes?: readonly SkillNote[];
  runSessionFn?: typeof runSession;
  baseEnv?: Record<string, string | undefined>;
  clock?: { now(): number };
  log?: (msg: string) => void;
}

export function createChatHandler(deps: ChatHandlerDeps): JobHandler<ChatPayload> {
  const runSessionFn = deps.runSessionFn ?? realRunSession;
  const log = deps.log ?? (() => {});

  async function runInThread(
    payload: ChatPayload,
    signal: AbortSignal,
    task: ChatTaskHandle,
  ): Promise<JobResult> {
    // 세션·모델 결정을 카드 생성보다 먼저 — 진행 카드 상태 문구가 resume/모델을 반영해야 한다.
    // 모델 override 는 세션이 drop 돼도 살아남도록 store 에서 직접 읽는다(/model 선행 스레드).
    let session = deps.sessions.get(payload.threadKey);
    let cwd = session?.cwd ? session.cwd : deps.workspaceDir;
    const effectiveModel = deps.sessions.getModelOverride(payload.threadKey) ?? DEFAULT_MODEL;

    // 카드 문구의 resume/fresh 선택은 mutable — 세션 만료로 fresh 재시도 전환 시 함께 뒤집어
    // "이어가는 중…" 문구가 신규 세션에 잘못 붙는 것을 막는다(리뷰 반영).
    let cardIsResume = session?.sessionId !== undefined;
    // ChatTaskHandle 메서드를 순수 콜백으로 매핑해 추출된 createProgressDriver 에 넘긴다
    // (setStep→onStep, setProgressTs→onCardTs). 이 매핑이 chat 회귀 방지 계약의 접합면이다.
    const driver = await createProgressDriver(
      { slack: deps.slack, poster: deps.poster, ...(deps.clock ? { clock: deps.clock } : {}), log },
      {
        channel: payload.channel,
        threadTs: payload.threadTs,
        threadKey: payload.threadKey,
        recipientUserId: payload.userId,
        recipientTeamId: deps.botTeamId,
        planTitle: CHAT_PLAN_TITLE,
        hiddenTools: CHAT_HIDDEN_PLAN_TOOLS,
        maskSecrets,
        headerFn: createStatusPicker({
          isResume: () => cardIsResume,
          model: effectiveModel,
        }),
        // plan assistant 상태 문구(평문 1건) — 드라이버 생성 시점의 resume/모델 스냅샷.
        statusText: pickPlainStatus({ isResume: cardIsResume, model: effectiveModel }),
        streamClosedNotice: CHAT_STREAM_CLOSED_NOTICE,
        onStep: (step) => task.setStep(step),
        onCardTs: (ts) => task.setProgressTs(ts),
      },
    );

    const thread = await deps.threads.fetchThreadMessages({
      channel: payload.channel,
      threadTs: payload.threadTs,
    });
    const maxTs = maxSeenTs(
      thread.map((m) => m.ts),
      payload.ts,
    );

    // 스레드 참여자 표시명 (EG-08) — 프롬프트 맥락과 최종 답변 egress 가 같은 맵을 쓴다.
    // 맥락에만 넣으면 모델이 옮겨 적은 raw ID 가 그대로 게시되고, egress 에만 넣으면 모델이
    // 애초에 ID 로 사람을 부른다. 재시도 루프 밖에서 1회 — 캐시가 있어도 호출을 줄인다.
    const nameByUserId = await deps.users.namesFor([
      payload.userId,
      ...thread.flatMap((m) => (m.user === null ? [] : [m.user])),
    ]);

    // 세션 MCP 도구 = 공통 manifest(memory 팀 메모리·datadog·github·git) + 요청자별 조립
    // (mytool — 관리자 여부, remember_feedback — 요청자·출처 스레드가 저장 게이트).
    // **attempt 마다 새로 조립한다** — in-process 인스턴스는 세션 1개당 1개이고(McpToolEntry 주석),
    // 재시도는 앞 attempt 의 세션이 죽은 뒤라 그 인스턴스를 물려 쓰면 조용히 도구가 빠질 수 있다.
    const buildSessionMcpTools = (): readonly McpToolEntry[] => [
      ...(deps.mcpTools?.() ?? []),
      ...(deps.mcpToolsFor?.({
        userId: payload.userId,
        channel: payload.channel,
        threadTs: payload.threadTs,
        ts: payload.ts,
      }) ?? []),
    ];
    // lessons 는 run 시점마다 읽는다 — 회고 잡이 런타임에 갱신하므로 부팅 캐시가 곧 스테일이다.

    /**
     * 토큰 장부 — 종결 경로마다 반드시 한 줄. 완료 경로에만 찍으면 취소분·만료 폐기분이
     * 장부에서 사라져 합계가 실제 지출보다 적게 나온다(특히 만료 재시도는 attempt 0 이
     * 끝까지 돌고 통째로 버려진다). phase 로 어느 경로의 지출인지 구분한다.
     */
    const logUsage = (usage: NonNullableUsage | null, phase: string): void => {
      log(`chat: 토큰 thread=${payload.threadKey} phase=${phase} ${formatUsageLog(usage)}`);
    };

    // 취소 종결 — 원 런/재작성 런 어느 쪽이 중단돼도 동일하게 처리한다: 사용자 취소면 안내 문구,
    // shutdown 이면 문구 없이 스트림만 정리, 어느 쪽이든 🚫 + verdict "cancelled". 두 런이 각자
    // 다르게 처리하면 "취소했다"는 사용자 안내와 실제 게시물이 어긋난다.
    async function finishCancelled(usage: NonNullableUsage | null): Promise<JobResult> {
      logUsage(usage, "취소");
      if (task.info.userCancelled) {
        // 사용자 취소는 명시 피드백(finish 가 append+stop 으로 plan 스트림도 종결) — shutdown abort 는
        // 안내를 부팅/종료 시퀀스에 맡기되, plan 스트림은 여기서 stop 해 미마감으로 방치하지 않는다 (SC-09).
        await driver.finish(CHAT_CANCELLED_TEXT);
      } else {
        // shutdown/시스템 abort — 안내 문구는 없지만 plan 스트림은 반드시 stop 한다(미마감 방지).
        await driver.abortStream();
      }
      await deps.reactions.cancel(payload.channel, payload.ts);
      return "cancelled";
    }

    // 세션 만료 시 1회만 신규 세션 재시도 (SC-04) — attempt 0: resume, attempt 1: fresh
    for (let attempt = 0; ; attempt++) {
      const resumeId = session?.sessionId;
      const isResume = resumeId !== undefined;
      const mcpTools = buildSessionMcpTools();
      // 가이드는 도구가 실제로 배선됐을 때만 — 없는 도구를 가리키는 안내가 거짓 결론을 만든다.
      const slackReadToolAvailable = mcpTools.some((e) => e.serverName === SLACK_MCP_SERVER_NAME);
      const selected = selectContextMessages(thread, {
        excludeTs: payload.ts,
        isResume,
        lastSeenTs: session?.lastSeenTs ?? "",
        selfBotId: deps.selfBotId,
      });
      const prompt = buildChatPrompt({
        isResume,
        channel: payload.channel,
        threadTs: payload.threadTs,
        requesterName: nameByUserId.get(payload.userId) ?? null,
        contextBlock: formatThreadContext(selected, { selfBotId: deps.selfBotId, nameByUserId }),
        requestText: payload.text,
        files: payload.files,
        ...(deps.skillNotes ? { skillNotes: deps.skillNotes } : {}),
        slackReadToolAvailable,
      });

      // 원 런과 재작성 런이 같은 프로파일·가드를 써야 한다 — 인라인으로 두면 두 곳이 갈린다.
      const profile = buildReadonlyProfile(
        cwd,
        deps.baseEnv ?? process.env,
        effectiveModel,
        mcpTools,
        deps.readonlyDirs ?? [],
      );

      let result: RunResult;
      try {
        result = await runSessionFn({
          prompt,
          profile,
          ...(isResume ? { resumeSessionId: resumeId } : {}),
          signal,
          maskSecrets,
          onProgress: (line) => driver.onProgress(line),
          onStreamEvent: (message) => driver.onStreamEvent(message),
        });
      } catch (err) {
        // 재시도 대상 예외 — plan 스트림을 stop 해 동결/에러 카드를 남기지 않고, 재시도 안내는
        // run() 이 게시한다. 폴백 카드 경로에선 abortStream 이 no-op(카드 교체는 run() 몫).
        await driver.abortStream();
        throw err;
      }

      if (isResume && attempt === 0 && isSessionExpired(result)) {
        // 만료 세션 drop → 신규 세션으로 전체 컨텍스트 재구성 후 1회 재시도
        deps.sessions.drop(payload.threadKey);
        session = null;
        cwd = deps.workspaceDir;
        cardIsResume = false; // 카드 문구도 fresh 로 — 실제 실행과 일치
        log(`chat: 세션 만료 감지 — 신규 세션 재시도 thread=${payload.threadKey}`);
        // 폐기하는 attempt 0 도 실제로 토큰을 썼다 — 여기서 안 찍으면 장부에서 통째로 증발한다.
        logUsage(result.usage, "만료폐기");
        continue;
      }

      if (result.aborted) {
        return await finishCancelled(result.usage);
      }

      if (result.sessionId) {
        deps.sessions.upsert({ threadKey: payload.threadKey, sessionId: result.sessionId, cwd });
        deps.sessions.setLastSeenTs(payload.threadKey, maxTs);
      }

      // 스타일 린트 → 재작성 1회. 린트는 타임아웃 문구를 붙이기 **전** 모델 원문에만
      // 건다 — 코드가 붙인 꼬리를 모델 탓으로 잡으면 안 된다.
      let answerText = (result.text ?? "").trim();
      let answerUsage = result.usage;
      // 세션이 없으면 resume 이 불가해 "방금 쓴 답변"이라는 지시가 성립하지 않고,
      // 실패·타임아웃 답은 이미 부분 결과라 다듬을 대상이 아니다.
      const rewritable =
        answerText !== "" &&
        result.sessionId !== null &&
        !result.isError &&
        result.timedOut === null;
      const styleIssues = rewritable ? lintChatStyle(answerText) : [];
      if (styleIssues.length > 0 && result.sessionId !== null) {
        log(`chat: 스타일 위반 — 재작성 thread=${payload.threadKey}: ${styleIssues.join("; ")}`);
        try {
          const rewritten = await runSessionFn({
            prompt: buildRewritePrompt(styleIssues),
            profile,
            resumeSessionId: result.sessionId,
            idleTimeoutMs: REWRITE_IDLE_TIMEOUT_MS,
            hardTimeoutMs: REWRITE_HARD_TIMEOUT_MS,
            signal,
            maskSecrets,
            onProgress: (line) => driver.onProgress(line),
            onStreamEvent: (message) => driver.onStreamEvent(message),
          });
          // 합산은 **결과를 쓰기 전에** 한 번만. 성공 분기에서만 더하면 중단·빈 결과·실패로
          // 재작성 답을 버리는 경우 그 런의 지출이 장부에서 사라진다 — 답을 버려도 돈은 나갔다.
          answerUsage = sumUsage(result.usage, rewritten.usage);
          if (rewritten.aborted && task.info.userCancelled) {
            // 사용자가 명시적으로 /cancel 했다 — "취소 요청 보냄" 안내를 이미 받았으므로, 여기서
            // 원문을 ✅ 로 게시하면 안내와 실제 게시물이 어긋난다. 원 런과 같은 취소 경로로 보낸다.
            return await finishCancelled(answerUsage);
          }
          if (rewritten.aborted) {
            // shutdown/시스템 abort — 아무도 멈추라고 하지 않았고 반박할 안내도 없다. 이미 얻은
            // 원 런의 답은 완성돼 있으니 버리지 않고 원문 그대로 게시한다(스타일은 배달을 막지 않는다).
            log(`chat: 재작성 런 중 shutdown abort — 원문 그대로 게시 thread=${payload.threadKey}`);
          } else {
            const next = (rewritten.text ?? "").trim();
            if (!rewritten.isError && next !== "") {
              // 원본·재작성 길이와 유발 위반을 남긴다 — "짧게 다시 써라"가 빈 인사치레로 새는
              // 회귀(예: "네, 짧게 줄였습니다.")를 grep 한 줄로 잡을 수 있어야 한다.
              log(
                `chat: 재작성 적용 thread=${payload.threadKey} 원본=${answerText.length}자 ` +
                  `재작성=${next.length}자 위반: ${styleIssues.join("; ")}`,
              );
              answerText = next;
              if (rewritten.sessionId) {
                deps.sessions.upsert({
                  threadKey: payload.threadKey,
                  sessionId: rewritten.sessionId,
                  cwd,
                });
              }
              // 재작성해도 어긋나면 그대로 보낸다 — 스타일은 취향 게이트고 배달을 막지 않는다.
              const left = lintChatStyle(answerText);
              if (left.length > 0) {
                log(`chat: 재작성 후에도 스타일 위반 — 그대로 게시: ${left.join("; ")}`);
              }
            } else {
              log("chat: 재작성 런이 빈 결과/실패 — 원문 그대로 게시");
            }
          }
        } catch (err) {
          // 재작성은 부가 품질이다 — 실패가 이미 얻은 답을 뒤집으면 안 된다.
          log(`chat: 재작성 런 예외 — 원문 그대로 게시: ${String(err)}`);
        }
      }

      let finalText = answerText || "(응답 없음)";
      if (result.timedOut !== null) {
        finalText += `\n\n⏱ ${result.timedOut} 타임아웃으로 중단됨`;
      }
      logUsage(answerUsage, "완료");

      await driver.finish(finalText, { allowedMentionUserIds: [payload.userId], nameByUserId });

      const ok = !result.isError && result.timedOut === null;
      if (ok) {
        await deps.reactions.succeed(payload.channel, payload.ts);
        return "done";
      }
      await deps.reactions.fail(payload.channel, payload.ts);
      return "failed";
    }
  }

  return {
    type: CHAT_JOB_TYPE,
    lane: "interactive",
    maxAttempts: CHAT_MAX_ATTEMPTS,
    payloadSchema: chatPayloadSchema,

    async run(job: Job<ChatPayload>, ctx: JobContext): Promise<JobResult> {
      const payload = job.payload;
      await deps.reactions.start(payload.channel, payload.ts);

      const abort = new AbortController();
      const onCtxAbort = (): void => abort.abort();
      if (ctx.signal.aborted) abort.abort();
      else ctx.signal.addEventListener("abort", onCtxAbort, { once: true });

      const task = deps.runningTasks.start({
        threadKey: payload.threadKey,
        channel: payload.channel,
        threadTs: payload.threadTs,
        // 리액션 취소가 겨냥할 좌표 — ⏳/🛑 가 달린 그 메시지다(runningTasks.matchesCancelTarget).
        ts: payload.ts,
        abort: () => abort.abort(),
      });

      try {
        // dispatcher lane_key 직렬화의 2차 방어선 — resume 원자성 (SC-03)
        return await deps.locks.runExclusive(payload.threadKey, () =>
          runInThread(payload, abort.signal, task),
        );
      } catch (err) {
        if (job.attempts < job.maxAttempts) {
          // 재시도 예정 — 진행 카드를 동결 상태로 두지 않는다 (마지막 시도 실패는 onExhausted 몫).
          // 폴백 카드 경로(progressTs 있음)는 그 자리를 교체하고, plan 경로(progressTs 없음)는
          // 스트림이 이미 abortStream 으로 종결됐으므로 새 답글로 안내한다.
          try {
            await deps.poster.postFinal(CHAT_RETRY_NOTICE, {
              channel: payload.channel,
              threadTs: payload.threadTs,
              ...(task.info.progressTs !== null ? { replaceTs: task.info.progressTs } : {}),
            });
          } catch (noticeErr) {
            log(`chat: 재시도 안내 게시 실패 thread=${payload.threadKey}: ${String(noticeErr)}`);
          }
        }
        throw err;
      } finally {
        ctx.signal.removeEventListener("abort", onCtxAbort);
        task.finish();
      }
    },

    /** silent cap 금지 (JQ-06) — 재시도 소진·스키마 불일치를 스레드에 직접 통보한다. */
    async onExhausted(job: Job<ChatPayload>): Promise<void> {
      const parsed = chatPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        log(`chat onExhausted: payload 해석 불가 — job=${job.id}`);
        return;
      }
      const payload = parsed.data;
      await deps.reactions.fail(payload.channel, payload.ts);
      await deps.poster.postFinal(
        `❌ 처리 실패 (재시도 소진) — ${job.error ?? "원인 미상"}\n다시 멘션하면 새로 시도합니다.`,
        { channel: payload.channel, threadTs: payload.threadTs },
      );
    },
  };
}
