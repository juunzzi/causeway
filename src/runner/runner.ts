/**
 * Agent SDK 세션 스폰의 유일한 지점 (SC-08, RS-08).
 *
 * in-process SDK 단일 경로 — CLI spawn fallback 을 도입하는 순간 stderr drain hang과
 * readline 64KB 잘림 지뢰 처리가 필수로 부활한다(선행 구현의 기록). 금지.
 *
 * 이 파일은 SDK 타입에 맞춘 얇은 래퍼다: 프로파일 적용, 가드 훅(SEC-08/09) 강제 부착,
 * idle/hard 2단 타임아웃, AbortSignal 전파, 스트림 → onProgress 요약만 책임진다.
 * 통합 동작 검증은 chat PR 몫.
 */

import type {
  HookCallbackMatcher,
  HookEvent,
  NonNullableUsage,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import {
  type BackgroundAgentGuardDeps,
  backgroundAgentGuardMatcher,
} from "./hooks/backgroundAgentGuard.js";
import { type SecretPathGuardHookDeps, secretPathGuardMatcher } from "./hooks/secretPathGuard.js";
import type { RunnerProfile } from "./profiles.js";

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────────────

/** 진행 카드 한 줄이 길어지면 PROGRESS_TRUNCATE 예산을 잡아먹는다 — 요약 단계에서 먼저 자른다. */
const TOOL_SUMMARY_MAX_CHARS = 120;

/** 도구별로 사람이 진행 상황을 유추할 수 있는 대표 입력 필드 우선순위. */
const SUMMARY_FIELD_ORDER = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;

export function summarizeToolUse(name: string, input: unknown): string {
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const field of SUMMARY_FIELD_ORDER) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        const flat = value.replace(/\s+/g, " ").trim();
        const clipped =
          flat.length > TOOL_SUMMARY_MAX_CHARS ? `${flat.slice(0, TOOL_SUMMARY_MAX_CHARS)}…` : flat;
        return `${name}: ${clipped}`;
      }
    }
  }
  return name;
}

export interface SessionGuardDeps {
  secretPath?: SecretPathGuardHookDeps;
  /** 백그라운드 서브에이전트 차단(in-process MCP 보호) — deny 관측점만 주입한다. */
  backgroundAgent?: BackgroundAgentGuardDeps;
}

/**
 * 가드 훅은 호출자 선택이 아니다 — runSession 이 모든 세션에 무조건 선두로 부착한다.
 * optional hooks 파라미터에 맡기면 호출자가 빠뜨리는 순간 컴파일 에러도 경고도 없이 무방비
 * 세션이 되기 때문이다. 호출자 hooks 는 가드 뒤에 그대로 보존된다.
 *
 * **무엇을 남기고 무엇을 걷어냈는지가 이 함수의 핵심이다.**
 *
 * 걷어낸 것 — 세션 능력을 Claude Code 와 같게 맞추면서 함께 빠졌다:
 * - `bashGuard`: `gh` mutation·`curl`·전역 `find` 등을 명령 문자열로 막던 층. Bash 가 전면
 *   허용된 지금 이 훅만 남기면 "허용해 놓고 훅으로 막는" 모순이 된다.
 * - `cwdScopeGuard`: Read/Glob/Grep 을 세션 cwd 밖에서 거부하던 층. cwd 는 빈 workspace 인데
 *   사람이 묻는 대상은 호스트의 레포·문서라, 남겨 두면 대부분의 질문에 답할 수 없다.
 *
 * 남긴 것 — 능력이 아니라 **되돌릴 수 없는 사고**를 막는 층이라 개방과 무관하게 유지한다:
 * - `secretPathGuard`: `.env`·`.ssh`·`.aws` 등 credential 경로 차단(lexical + realpath 이중
 *   검사). 슬랙은 사람이 읽는 곳이고, 봇이 자격증명을 읽어 스레드에 붙이면 되돌릴 수 없다.
 *   이 봇 자신의 `.env`(슬랙 토큰·외부 인증 서비스 시크릿)도 여기에 걸린다.
 * - `backgroundAgentGuard`: 백그라운드 에이전트 위임 차단. 세션이 끝난 뒤에도 도는 작업은
 *   잡 큐가 추적하지 못해 취소·재시도·감사 어디에도 안 잡힌다.
 */
export function withGuardHooks(
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  guardDeps: SessionGuardDeps = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    ...hooks,
    PreToolUse: [
      secretPathGuardMatcher(guardDeps.secretPath),
      backgroundAgentGuardMatcher(guardDeps.backgroundAgent),
      ...(hooks?.PreToolUse ?? []),
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────────────

export type TimeoutKind = "idle" | "hard";

export interface RunResult {
  text: string | null;
  sessionId: string | null;
  usage: NonNullableUsage | null;
  /** 어느 타임아웃이 세션을 끊었는지 — null 이면 정상 종료 또는 외부 abort. */
  timedOut: TimeoutKind | null;
  /** 외부 AbortSignal(사용자 /cancel)로 끊겼는지 — 실패와 취소의 리액션 분기(SC-09) 근거. */
  aborted: boolean;
  isError: boolean;
}

export interface RunnerTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** thinking 깊이 가이드(SDK Options.effort) — 잡별 지연/품질 튜닝에 쓴다. */
export type Effort = Options["effort"];

export interface RunSessionParams {
  prompt: string;
  profile: RunnerProfile;
  /** profile.allowResume=false 인데 넘기면 throw — 격리 계약(SEC-02) 위반을 침묵 통과시키지 않는다. */
  resumeSessionId?: string;
  /**
   * idle: 스트림 무이벤트 상한(긴 정상 작업은 도구 이벤트가 계속 흘러 안 걸린다).
   * hard: 총 실행 상한. 두 타임아웃이 독립이어야 '긴 정상 작업'과 'hang'을 구분한다(RS-08).
   */
  idleTimeoutMs?: number;
  hardTimeoutMs?: number;
  signal?: AbortSignal;
  /** 도구 한 줄 요약 수신 — egress 진행 카드(폴백 텍스트 카드)가 소비한다. */
  onProgress?: (line: string) => void;
  /**
   * 매 raw SDK 메시지(assistant·user·result 전부)를 그대로 전달 — egress plan 카드가
   * agentStream 으로 tool_use/tool_result 를 소비한다. onProgress(요약 라인)와 독립이며,
   * plan 카드 경로/폴백 카드 경로 판정은 소비자 몫이다.
   */
  onStreamEvent?: (message: unknown) => void;
  /** 진행 요약에 시크릿이 섞이는 것 방지(SEC-11) — security/maskSecrets 를 주입한다. */
  maskSecrets?: (text: string) => string;
  /**
   * thinking 깊이(adaptive 가이드) — 자동화 잡(alert/daily)이 기계적 수집·집계 단계의
   * 지연을 줄이려 낮춘다. 미지정이면 SDK 기본(adaptive)이라 대화형 세션 품질은 그대로다.
   * 프로파일이 아니라 여기서 주입하는 이유: buildReadonlyProfile 은 chat 과 공유(스냅샷=보안
   * 트립와이어)이므로 프로파일을 건드리지 않고 잡별로만 조절한다.
   */
  effort?: Effort;
  /**
   * 추가 훅 — SEC-08/09 가드 매처는 이 값과 무관하게 runSession 이 항상 선두에
   * 부착하므로(withGuardHooks) 여기엔 가드 이외의 훅만 넘기면 된다.
   */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** 강제 부착되는 가드 훅의 의존성(friction 기록, secret 경로 주입 등). */
  guardDeps?: SessionGuardDeps;
  /** 테스트 주입용 SDK 심. */
  queryFn?: typeof sdkQuery;
  /** 주입 클록 — 테스트가 타임아웃을 실시간 대기 없이 구동한다. */
  timers?: RunnerTimers;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HARD_TIMEOUT_MS = 30 * 60_000;

const REAL_TIMERS: RunnerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export async function runSession(params: RunSessionParams): Promise<RunResult> {
  const {
    prompt,
    profile,
    resumeSessionId,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS,
    signal,
    onProgress,
    onStreamEvent,
    maskSecrets = (text: string) => text,
    effort,
    hooks,
    guardDeps = {},
    queryFn = sdkQuery,
    timers = REAL_TIMERS,
  } = params;

  if (resumeSessionId !== undefined && !profile.allowResume) {
    throw new Error(`profile ${profile.kind} 은 resume 금지 계약이다 (SEC-02)`);
  }

  const abortController = new AbortController();
  let timedOut: TimeoutKind | null = null;
  let externalAborted = false;

  const abortFromOutside = () => {
    externalAborted = true;
    abortController.abort();
  };
  if (signal !== undefined) {
    if (signal.aborted) abortFromOutside();
    else signal.addEventListener("abort", abortFromOutside, { once: true });
  }

  const options: Options = {
    ...profile.options,
    ...(effort !== undefined ? { effort } : {}),
    abortController,
    hooks: withGuardHooks(hooks, guardDeps),
    ...(resumeSessionId !== undefined ? { resume: resumeSessionId } : {}),
  };

  const stream = queryFn({ prompt, options });

  let sessionId: string | null = null;
  let text: string | null = null;
  let usage: NonNullableUsage | null = null;
  let isError = false;

  const abortPromise = new Promise<"aborted">((resolve) => {
    if (abortController.signal.aborted) resolve("aborted");
    else abortController.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  let idleHandle: unknown = null;
  const resetIdle = () => {
    if (idleHandle !== null) timers.clearTimeout(idleHandle);
    idleHandle = timers.setTimeout(() => {
      timedOut = "idle";
      abortController.abort();
    }, idleTimeoutMs);
  };
  const hardHandle = timers.setTimeout(() => {
    timedOut = "hard";
    abortController.abort();
  }, hardTimeoutMs);

  const handleMessage = (message: SDKMessage) => {
    if (onStreamEvent !== undefined) {
      // egress plan 카드 소비 — 소비자 예외가 스트림 루프를 끊지 않게 격리한다.
      try {
        onStreamEvent(message);
      } catch {
        // plan 카드 갱신 실패는 세션 결과에 영향 없음
      }
    }
    if (message.type === "system" && message.subtype === "init") {
      sessionId = message.session_id;
      return;
    }
    if (message.type === "assistant") {
      const content: unknown = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        const b = block as { type?: unknown; name?: unknown; input?: unknown };
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        onProgress?.(maskSecrets(summarizeToolUse(b.name, b.input)));
      }
      return;
    }
    if (message.type === "result") {
      sessionId = message.session_id;
      usage = message.usage;
      isError = message.is_error;
      text =
        message.subtype === "success"
          ? message.result
          : message.errors.length > 0
            ? message.errors.join("\n")
            : message.subtype;
    }
  };

  const iterator = stream[Symbol.asyncIterator]();
  try {
    resetIdle();
    while (true) {
      const nextPromise = iterator.next();
      // 레이스 패배 후 늦게 거절되는 next() 가 unhandledrejection 이 되지 않게 선제 흡수
      nextPromise.catch(() => {});
      const winner = await Promise.race([
        nextPromise.then((r) => ({ kind: "message" as const, r })),
        abortPromise.then(() => ({ kind: "aborted" as const })),
      ]);
      if (winner.kind === "aborted") break;
      if (winner.r.done) break;
      resetIdle();
      handleMessage(winner.r.value);
    }
  } catch (error) {
    // 우리가 유발한 abort(타임아웃/취소)의 후속 예외는 정상 경로 — 그 외는 전파
    if (timedOut === null && !externalAborted) throw error;
  } finally {
    if (idleHandle !== null) timers.clearTimeout(idleHandle);
    timers.clearTimeout(hardHandle);
    if (signal !== undefined) signal.removeEventListener("abort", abortFromOutside);
    const closable = stream as { close?: () => void };
    if (typeof closable.close === "function") {
      try {
        closable.close();
      } catch {
        // 종료 정리 실패는 결과에 영향 없음
      }
    } else {
      try {
        // await 금지: 제너레이터가 내부에서 블록돼 있으면 return() 이 영원히 안 끝난다 — fire-and-forget
        const returned = iterator.return?.(undefined);
        if (returned !== undefined) Promise.resolve(returned).catch(() => {});
      } catch {
        // 종료 정리 실패는 결과에 영향 없음
      }
    }
  }

  return { text, sessionId, usage, timedOut, aborted: externalAborted, isError };
}
