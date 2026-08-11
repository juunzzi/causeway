import type {
  NonNullableUsage,
  Options,
  PreToolUseHookInput,
  SDKMessage,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildAuxProfile, buildReadonlyProfile } from "./profiles.js";
import { runSession, summarizeToolUse } from "./runner.js";

/**
 * runner 는 SDK mock 으로 타임아웃·abort·onProgress 전달만 검증한다 (RS-08 [계약]).
 * 실제 SDK 통합 동작은 chat 잡 PR 의 통합 테스트 몫.
 */

const BASE_ENV = { PATH: "/usr/bin", HOME: "/Users/bot" };
const USAGE = { input_tokens: 10, output_tokens: 5 } as unknown as NonNullableUsage;

function initMessage(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function assistantToolUse(name: string, input: unknown): SDKMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tu_1", name, input }] },
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

function resultSuccess(text: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: text,
    is_error: false,
    usage: USAGE,
    session_id: "sess-1",
  } as unknown as SDKMessage;
}

type QueryFn = Parameters<typeof runSession>[0]["queryFn"];

/** 주어진 메시지를 순서대로 흘리는 SDK 심 — 마지막 인자로 전달 옵션을 캡처한다. */
function fakeQuery(messages: SDKMessage[], captured?: { options?: Options }): QueryFn {
  return ((params: { prompt: string; options?: Options }) => {
    if (captured) captured.options = params.options;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as QueryFn;
}

/** 아무것도 내보내지 않고 영원히 매달리는 SDK 심 — hang 시나리오. */
function hangingQuery(): QueryFn {
  return (() =>
    (async function* (): AsyncGenerator<SDKMessage> {
      await new Promise(() => {});
    })()) as unknown as QueryFn;
}

describe("summarizeToolUse", () => {
  it("대표 입력 필드를 한 줄로 요약한다", () => {
    expect(summarizeToolUse("Bash", { command: "pnpm test" })).toBe("Bash: pnpm test");
    expect(summarizeToolUse("Read", { file_path: "/repo/a.ts" })).toBe("Read: /repo/a.ts");
    expect(summarizeToolUse("Glob", {})).toBe("Glob");
    expect(summarizeToolUse("Bash", null)).toBe("Bash");
  });

  it("개행 압축 + 길이 truncate", () => {
    const summary = summarizeToolUse("Bash", { command: `echo a\n${"x".repeat(300)}` });
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual("Bash: ".length + 121);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("runSession", () => {
  const profile = () => buildReadonlyProfile("/srv/workspace", BASE_ENV);

  it("스트림에서 text/sessionId/usage 를 수집해 반환한다", async () => {
    const result = await runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: fakeQuery([
        initMessage("sess-1"),
        assistantToolUse("Bash", { command: "git log" }),
        resultSuccess("최종 답변"),
      ]),
    });
    expect(result).toEqual({
      text: "최종 답변",
      sessionId: "sess-1",
      usage: USAGE,
      timedOut: null,
      aborted: false,
      isError: false,
    });
  });

  it("tool_use 를 onProgress 한 줄 요약으로 전달하고 maskSecrets 를 통과시킨다", async () => {
    const lines: string[] = [];
    await runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: fakeQuery([
        initMessage("sess-1"),
        assistantToolUse("Bash", { command: "curl -H 'Authorization: xoxb-123'" }),
        assistantToolUse("Read", { file_path: "/repo/a.ts" }),
        resultSuccess("ok"),
      ]),
      onProgress: (line) => lines.push(line),
      maskSecrets: (text) => text.replaceAll("xoxb-123", "[MASKED]"),
    });
    expect(lines).toEqual(["Bash: curl -H 'Authorization: [MASKED]'", "Read: /repo/a.ts"]);
  });

  it("프로파일 옵션 + hooks + resume 이 query 옵션으로 전달된다", async () => {
    const captured: { options?: Options } = {};
    const callerMatcher = { matcher: "WebFetch", hooks: [] };
    await runSession({
      prompt: "질문",
      profile: profile(),
      resumeSessionId: "sess-prev",
      hooks: { PreToolUse: [callerMatcher] },
      queryFn: fakeQuery([resultSuccess("ok")], captured),
    });
    expect(captured.options?.cwd).toBe("/srv/workspace");
    expect(captured.options?.permissionMode).toBe("dontAsk");
    expect(captured.options?.resume).toBe("sess-prev");
    // effort 미지정이면 옵션에 넣지 않는다 — SDK 기본(adaptive) 유지(대화형 품질 불변)
    expect(captured.options && "effort" in captured.options).toBe(false);
    // 호출자 훅은 강제 부착된 가드(secretPathGuard, backgroundAgentGuard) 뒤에 그대로 보존된다
    const preToolUse = captured.options?.hooks?.PreToolUse ?? [];
    expect(preToolUse.map((m) => m.matcher)).toEqual([
      "Read|Glob|Grep|Bash",
      undefined, // backgroundAgentGuard — 도구 무관 매처
      "WebFetch",
    ]);
    expect(preToolUse[2]).toBe(callerMatcher);
    expect(captured.options?.abortController).toBeInstanceOf(AbortController);
  });

  it("effort 를 넘기면 SDK options.effort 로 전달된다 (자동화 잡 thinking 하향)", async () => {
    const captured: { options?: Options } = {};
    await runSession({
      prompt: "집계해줘",
      profile: profile(),
      effort: "medium",
      queryFn: fakeQuery([resultSuccess("ok")], captured),
    });
    expect(captured.options?.effort).toBe("medium");
  });

  it("hooks 를 안 넘겨도 잔존 가드(secretPath·backgroundAgent)가 무조건 부착된다", async () => {
    const captured: { options?: Options } = {};
    await runSession({
      prompt: "알람 고쳐줘",
      profile: buildReadonlyProfile("/srv/workspace", BASE_ENV),
      queryFn: fakeQuery([resultSuccess("ok")], captured),
    });
    const preToolUse = captured.options?.hooks?.PreToolUse ?? [];
    expect(preToolUse.map((m) => m.matcher)).toEqual([
      "Read|Glob|Grep|Bash",
      // 백그라운드 Agent 가드는 도구명으로 좁히지 않는다(matcher 없음) — 위임 도구 이름이
      // SDK 버전에 따라 갈려도 판정 함수 한 곳만 고치면 되게
      undefined,
    ]);

    // 매처 문자열만으로는 가짜 훅도 통과한다 — 부착된 콜백이 실제 판정을 하는지 확인한다.
    // secretPathGuard: 세션이 어떤 도구를 갖든 credential 경로는 못 읽는다(개방과 무관한 층).
    const secretHook = preToolUse[0]?.hooks[0];
    expect(secretHook).toBeDefined();
    const readInput: PreToolUseHookInput = {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/srv/workspace/.env" },
      tool_use_id: "tu_1",
      session_id: "s_1",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/srv/workspace",
    };
    const secretOut = (await secretHook?.(readInput, "tu_1", {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;
    expect(secretOut.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });

    // 스코프 안의 평범한 파일은 통과한다 — 이 가드는 credential 경로만 막는다.
    const inScopeInput: PreToolUseHookInput = { ...readInput };
    inScopeInput.tool_input = { file_path: "/srv/workspace/src/index.ts" };
    expect(
      await secretHook?.(inScopeInput, "tu_1", { signal: new AbortController().signal }),
    ).toEqual({ continue: true });

    // 백그라운드 Agent 가드도 실제 판정을 수행한다 — 부재(=SDK 기본 백그라운드)는 deny,
    // 명시적 동기 실행은 allow
    const bgHook = preToolUse[1]?.hooks[0];
    const bgInput: PreToolUseHookInput = { ...readInput, tool_name: "Agent" };
    bgInput.tool_input = { prompt: "훑어봐", subagent_type: "general-purpose" };
    const bgOut = (await bgHook?.(bgInput, "tu_1", {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;
    expect(bgOut.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });

    const syncInput: PreToolUseHookInput = { ...readInput, tool_name: "Agent" };
    syncInput.tool_input = { prompt: "훑어봐", run_in_background: false };
    expect(await bgHook?.(syncInput, "tu_1", { signal: new AbortController().signal })).toEqual({
      continue: true,
    });
  });

  it("resume 금지 프로파일(AUX)에 resumeSessionId 를 넘기면 throw (SEC-02)", async () => {
    await expect(
      runSession({
        prompt: "분류",
        profile: buildAuxProfile(BASE_ENV),
        resumeSessionId: "sess-prev",
        queryFn: fakeQuery([resultSuccess("ok")]),
      }),
    ).rejects.toThrow(/resume 금지/);
  });

  it("무이벤트 스트림은 idle 타임아웃으로 끊는다", async () => {
    const result = await runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: hangingQuery(),
      idleTimeoutMs: 20,
      hardTimeoutMs: 10_000,
    });
    expect(result.timedOut).toBe("idle");
    expect(result.aborted).toBe(false);
    expect(result.text).toBeNull();
  });

  it("이벤트가 계속 흘러도 hard cap 은 독립적으로 발동한다 (RS-08 2단 독립)", async () => {
    // 10ms 간격으로 계속 tool_use 를 흘려 idle(50ms)은 절대 안 걸리게 한다
    const busyQuery = (() =>
      (async function* (): AsyncGenerator<SDKMessage> {
        for (let i = 0; i < 1_000; i++) {
          await new Promise((r) => setTimeout(r, 10));
          yield assistantToolUse("Bash", { command: `step ${i}` });
        }
      })()) as unknown as QueryFn;
    const result = await runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: busyQuery,
      idleTimeoutMs: 50,
      hardTimeoutMs: 80,
    });
    expect(result.timedOut).toBe("hard");
  });

  it("외부 AbortSignal 로 끊기면 aborted=true, timedOut=null (취소/실패 분기 근거)", async () => {
    const controller = new AbortController();
    const pending = runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: hangingQuery(),
      signal: controller.signal,
      idleTimeoutMs: 10_000,
      hardTimeoutMs: 10_000,
    });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeNull();
  });

  it("이미 abort 된 signal 이면 즉시 종료한다", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runSession({
      prompt: "질문",
      profile: profile(),
      queryFn: hangingQuery(),
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });
});
