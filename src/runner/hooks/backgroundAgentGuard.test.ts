import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_AGENT_DENY_REASON,
  createBackgroundAgentGuardHook,
  decideBackgroundAgent,
} from "./backgroundAgentGuard.js";

const pre = (toolName: string, toolInput: unknown) =>
  ({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }) as never;

describe("decideBackgroundAgent (순수 판정)", () => {
  it("run_in_background 명시 true → deny", () => {
    const d = decideBackgroundAgent("Agent", { prompt: "x", run_in_background: true });
    expect(d).toEqual({ action: "deny", reason: BACKGROUND_AGENT_DENY_REASON });
  });

  it("run_in_background 부재 → deny (SDK 기본값이 백그라운드다)", () => {
    // 2026-08-03 사고 세션이 정확히 이 형태였다 — 필드를 안 넣어 기본값으로 백그라운드가 됐다
    expect(
      decideBackgroundAgent("Agent", { prompt: "x", subagent_type: "general-purpose" }),
    ).toEqual({ action: "deny", reason: BACKGROUND_AGENT_DENY_REASON });
  });

  it("run_in_background 명시 false → allow (동기 위임은 막지 않는다)", () => {
    expect(decideBackgroundAgent("Agent", { prompt: "x", run_in_background: false })).toEqual({
      action: "allow",
    });
  });

  it("Task 라는 이름으로 와도 같은 판정 (SDK 버전차)", () => {
    expect(decideBackgroundAgent("Task", { prompt: "x" }).action).toBe("deny");
    expect(decideBackgroundAgent("Task", { prompt: "x", run_in_background: false }).action).toBe(
      "allow",
    );
  });

  it("위임 도구가 아니면 무조건 allow", () => {
    expect(decideBackgroundAgent("Bash", { command: "ls" })).toEqual({ action: "allow" });
    expect(decideBackgroundAgent("mcp__datadog__datadog_query", {})).toEqual({ action: "allow" });
  });

  it("입력이 null·비객체여도 위임 도구면 deny (기본값이 백그라운드라 안전측)", () => {
    expect(decideBackgroundAgent("Agent", null).action).toBe("deny");
    expect(decideBackgroundAgent("Agent", "문자열").action).toBe("deny");
  });
});

describe("createBackgroundAgentGuardHook", () => {
  it("deny 시 PreToolUse deny 출력 + 사유에 재시도 방법을 담는다", async () => {
    const hook = createBackgroundAgentGuardHook();
    const out = (await hook(pre("Agent", { prompt: "x" }), undefined, {} as never)) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("run_in_background: false");
  });

  it("allow 는 continue 로 통과", async () => {
    const hook = createBackgroundAgentGuardHook();
    const out = await hook(pre("Agent", { run_in_background: false }), undefined, {} as never);
    expect(out).toEqual({ continue: true });
  });

  it("PreToolUse 가 아닌 이벤트는 통과", async () => {
    const hook = createBackgroundAgentGuardHook();
    const out = await hook(
      { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: {} } as never,
      undefined,
      {} as never,
    );
    expect(out).toEqual({ continue: true });
  });

  it("onDeny 관측점이 호출되고, 그 예외는 판정을 바꾸지 않는다 (fail-open)", async () => {
    const onDeny = vi.fn(() => {
      throw new Error("friction 기록 실패");
    });
    const hook = createBackgroundAgentGuardHook({ onDeny });
    const out = (await hook(pre("Agent", {}), undefined, {} as never)) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    expect(onDeny).toHaveBeenCalledWith("Agent");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});
