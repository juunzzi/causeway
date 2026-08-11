/**
 * 백그라운드 서브에이전트 금지 가드 — in-process MCP 도구를 살려두기 위한 구조적 방어.
 *
 * **왜 막는가 (2026-08-03 재현 완료)**
 *
 * 봇은 `runSession(prompt: string)` 로 문자열 프롬프트를 넘긴다. SDK(0.3.207)는 이걸 단일
 * 턴으로 보고(`isSingleUserTurn = typeof prompt === "string"`) **첫 result 에서 stdin 을 닫는다**
 * (`transport.endInput()`). 평소엔 무해하다 — 다음 Slack 메시지는 resume 으로 새 프로세스를
 * 띄우므로 stdin 도 새것이다.
 *
 * 그런데 백그라운드 자식의 완료 알림(task-notification)은 **같은 CLI 프로세스에서 2턴을 재개**
 * 시킨다. in-process MCP 호출은 CLI→SDK(stdout) 요청에 SDK→CLI(stdin) 응답으로 완성되는데,
 * 그 stdin 이 이미 닫혀 있어 응답이 조용히 버려진다(SDK: "Dropping write to ended stdin
 * stream"). CLI 쪽은 `Stream closed` 로 끝난다.
 *
 * 실측: 사고 세션(8분 30초 대기)과 의도적 재현 세션(11초 대기) 모두 재개 후 첫 datadog_query
 * 가 `Stream closed`. 대기 시간과 무관하고 조건은 "알림으로 턴이 재개됐다" 하나다. 전체 세션
 * 226개 코퍼스에서 이 경로를 밟은 호출은 3/3 실패, 밟지 않은 in-process 호출 104건은 전무 실패.
 *
 * 영향은 datadog 만이 아니다 — github_query·git_query·mytool_admin·remember_feedback 이
 * 같은 배선이라 함께 죽는다. 원격 커넥터(analytics)와 stdio 플러그인(memory)은 CLI 가 직접
 * 연결하므로 무관하다.
 *
 * **왜 이 방식인가**
 *
 * 프롬프트를 async iterable 로 바꾸면 stdin 이 안 닫히지만, 그러면 스트림이 스스로 끝나지 않아
 * runner 루프(`done` 대기)가 idle 타임아웃까지 매달린다 — 종료 판정을 봇이 재구현해야 해서
 * 위험 대비 이득이 없다. 모델에게 "in-process 조회를 먼저 끝내라"고 지시하는 방식은 준수에
 * 기대는 방어라 조용히 깨진다. 여기서는 **원인이 되는 백그라운드 스폰 자체**를 막는다.
 *
 * 동기 실행(run_in_background:false)은 그대로 허용하므로 위임 능력을 잃지 않는다 — 잃는 것은
 * 병렬 팬아웃뿐이고, 전체 코퍼스에서 Agent 호출은 5건(백그라운드 4·동기 1)에 불과하다.
 * 덤으로 부모가 자식을 기다리며 스텝이 멎는 구간이 사라져 워치독 오탐(RS-06)도 원천 차단된다.
 *
 * SDK 가 고쳐지면 이 파일을 지우면 된다 — 그때까지의 한시적 방어다.
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

/** 자식 작업을 띄우는 도구 — SDK 버전에 따라 이름이 갈린다. */
export const DELEGATION_TOOL_NAMES: readonly string[] = ["Agent", "Task"];

export const BACKGROUND_AGENT_DENY_REASON =
  "백그라운드 서브에이전트는 이 세션에서 사용할 수 없습니다. " +
  "완료 알림으로 턴이 재개되면 in-process 조회 도구(datadog_query·github_query·git_query·" +
  "mytool_admin·remember_feedback)가 전부 `Stream closed` 로 실패하기 때문입니다. " +
  "같은 Agent 호출에 run_in_background: false 를 넣어 동기로 다시 실행하세요 — " +
  "결과를 기다렸다가 이어서 진행하면 됩니다.";

export type BackgroundAgentDecision = { action: "allow" } | { action: "deny"; reason: string };

/**
 * 이 도구 호출이 백그라운드 스폰인지 판정 — 순수 함수.
 *
 * `run_in_background` 가 **없으면 백그라운드**다(SDK 기본값). 사고 세션이 정확히 이 경우였다:
 * 필드를 아예 안 넣어 기본값으로 백그라운드가 됐다. 부재를 allow 로 처리하면 가드가 실제
 * 사고 케이스를 놓친다.
 */
export function decideBackgroundAgent(
  toolName: string,
  toolInput: unknown,
): BackgroundAgentDecision {
  if (!DELEGATION_TOOL_NAMES.includes(toolName)) return { action: "allow" };
  const raw = (toolInput as { run_in_background?: unknown } | null)?.run_in_background;
  // 명시적 false 만 통과 — undefined·null·true·기타 값은 전부 백그라운드로 본다
  if (raw === false) return { action: "allow" };
  return { action: "deny", reason: BACKGROUND_AGENT_DENY_REASON };
}

const ALLOW: HookJSONOutput = { continue: true };

function denyOutput(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export interface BackgroundAgentGuardDeps {
  /** deny 판정 관측점 — friction 기록 등에 쓴다. 실패해도 세션을 막지 않는다. */
  onDeny?: (toolName: string) => void;
}

/** 훅 내부 예외는 allow (fail-open) — 가드 버그로 세션 전체를 죽이지 않는다(bashGuard 와 동일 계약). */
export function createBackgroundAgentGuardHook(deps: BackgroundAgentGuardDeps = {}): HookCallback {
  return async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse") return ALLOW;
      const decision = decideBackgroundAgent(input.tool_name, input.tool_input);
      if (decision.action === "deny") {
        try {
          deps.onDeny?.(input.tool_name);
        } catch {
          // 관측 실패가 판정을 바꾸지 않는다
        }
        return denyOutput(decision.reason);
      }
      return ALLOW;
    } catch {
      return ALLOW;
    }
  };
}

/**
 * matcher 를 도구명으로 좁히지 않고 전체에 건다 — SDK 가 위임 도구 이름을 바꾸거나 추가해도
 * decideBackgroundAgent 한 곳만 고치면 되게. 다른 도구엔 즉시 allow 라 비용이 없다.
 */
export function backgroundAgentGuardMatcher(
  deps: BackgroundAgentGuardDeps = {},
): HookCallbackMatcher {
  return { hooks: [createBackgroundAgentGuardHook(deps)] };
}
