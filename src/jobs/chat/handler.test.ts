import { describe, expect, it } from "vitest";
import { openDatabase } from "../../core/db/connection.js";
import type { Job, JobContext } from "../../core/queue/types.js";
import { createPoster } from "../../egress/poster.js";
import { createReactionManager } from "../../egress/reactions.js";
import { callsOf, makeFakeSlack, mustGet } from "../../egress/testSupport.js";
import { buildMcpRegistry, type McpToolEntry } from "../../mcp/registry.js";
import type { RunResult, RunSessionParams, runSession } from "../../runner/runner.js";
import { createSessionStore } from "../../sessions/sessionStore.js";
import { createThreadLocks } from "../../sessions/threadLock.js";
import type { ThreadMessageRecord } from "../../slack/slackPort.js";
import { FIRST_CONTEXT_HEADER, RESUME_CONTEXT_HEADER } from "./context.js";
import {
  CHAT_CANCELLED_TEXT,
  CHAT_RETRY_NOTICE,
  type ChatHandlerDeps,
  type ChatPayload,
  type ChatToolRequest,
  createChatHandler,
  formatUsageLog,
  isSessionExpired,
  REWRITE_HARD_TIMEOUT_MS,
  REWRITE_IDLE_TIMEOUT_MS,
  splitProgressLine,
  sumUsage,
} from "./handler.js";
import { createChatTaskRegistry } from "./runningTasks.js";
import { CHAT_MAX_CHARS } from "./styleLint.js";

const SELF_BOT = "B0SELF";
const FAKE_MEMORY_CMD = { command: "/usr/local/bin/memory", args: ["mcp"], resolved: true };

const WORKSPACE = "/ws";
const TEAM_ID = "T0TEAM";

function ok(text: string, sessionId = "sess-1"): RunResult {
  return { text, sessionId, usage: null, timedOut: null, aborted: false, isError: false };
}

function reply(
  ts: string,
  text: string,
  opts: { user?: string; botId?: string } = {},
): ThreadMessageRecord {
  return {
    ts,
    text,
    user: opts.user ?? null,
    botId: opts.botId ?? null,
    subtype: opts.botId ? "bot_message" : null,
  };
}

function makePayload(overrides: Partial<ChatPayload> = {}): ChatPayload {
  return {
    schema_version: 1,
    channel: "C1",
    ts: "100.5",
    threadTs: "100.1",
    threadKey: "C1:100.1",
    userId: "U1",
    text: "왜 500 이 나요?",
    files: [],
    ...overrides,
  };
}

function makeJob(
  payload: ChatPayload,
  overrides: Partial<Pick<Job<ChatPayload>, "attempts" | "maxAttempts" | "error" | "id">> = {},
): Job<ChatPayload> {
  return {
    id: overrides.id ?? 1,
    type: "chat",
    dedupKey: `slack:${payload.channel}:${payload.ts}`,
    lane: "interactive",
    laneKey: payload.threadKey,
    payload,
    status: "inflight",
    attempts: overrides.attempts ?? 1,
    maxAttempts: overrides.maxAttempts ?? 2,
    leaseId: null,
    leaseExpiresAt: null,
    executionStartedAt: null,
    notBefore: null,
    result: null,
    error: overrides.error ?? null,
    createdAt: 0,
    updatedAt: 0,
  };
}

interface SetupOptions {
  thread?: ThreadMessageRecord[];
  /** 세션에 노출할 MCP manifest — 미지정이면 도구 없음. */
  mcpTools?: McpToolEntry[];
  /** 요청자별 도구 조립 — 미지정이면 없음. */
  mcpToolsFor?: ChatHandlerDeps["mcpToolsFor"];
  /** userDirectory 해석 결과 — 미지정이면 전원 미상(ID 폴백). */
  names?: ReadonlyMap<string, string>;
  /** cwd 밖 읽기 전용 확장 경로 — 미지정이면 확장 없음. */
  readonlyDirs?: string[];
  results?: Array<RunResult | Error>;
  runImpl?: (params: RunSessionParams) => Promise<RunResult>;
}

function setup(opts: SetupOptions = {}) {
  const db = openDatabase(":memory:");
  const sessions = createSessionStore(db);
  const fake = makeFakeSlack();
  const poster = createPoster(fake.slack);
  const reactions = createReactionManager({ slack: fake.slack });
  const runningTasks = createChatTaskRegistry({ now: () => 1_000 });
  const runCalls: RunSessionParams[] = [];
  const logs: string[] = [];
  const results = [...(opts.results ?? [ok("답변입니다")])];

  const runSessionFn = (async (params: RunSessionParams): Promise<RunResult> => {
    runCalls.push(params);
    if (opts.runImpl) return opts.runImpl(params);
    const next = results.shift();
    if (next === undefined) throw new Error("예상 밖의 runSession 호출");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof runSession;

  const handler = createChatHandler({
    slack: fake.slack,
    threads: { fetchThreadMessages: async () => opts.thread ?? [] },
    users: { namesFor: async () => opts.names ?? new Map() },
    ...(opts.mcpTools ? { mcpTools: () => opts.mcpTools ?? [] } : {}),
    ...(opts.mcpToolsFor ? { mcpToolsFor: opts.mcpToolsFor } : {}),
    poster,
    reactions,
    sessions,
    locks: createThreadLocks(),
    runningTasks,
    workspaceDir: WORKSPACE,
    ...(opts.readonlyDirs ? { readonlyDirs: opts.readonlyDirs } : {}),
    selfBotId: SELF_BOT,
    botTeamId: TEAM_ID,
    runSessionFn,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/bot" },
    clock: { now: () => 2_000 },
    log: (line: string) => {
      logs.push(line);
    },
  });

  const ctxAbort = new AbortController();
  const ctx: JobContext = { signal: ctxAbort.signal };
  return { handler, sessions, fake, reactions, runningTasks, runCalls, ctx, ctxAbort, logs };
}

describe("chat handler — 첫 호출", () => {
  it("전체 스레드 컨텍스트 + 신규 세션 실행 → upsert·last_seen·✅", async () => {
    const s = setup({
      thread: [
        reply("100.1", "첫 질문", { user: "U1" }),
        reply("100.3", "코멘트", { user: "U2" }),
        reply("100.5", "현재 트리거", { user: "U1" }),
      ],
      results: [ok("분석 결과입니다")],
    });
    const payload = makePayload();
    const verdict = await s.handler.run(makeJob(payload), s.ctx);

    expect(verdict).toBe("done");
    const call = mustGet(s.runCalls, 0);
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.profile.kind).toBe("READONLY");
    expect(call.profile.options.cwd).toBe(WORKSPACE);
    expect(call.prompt).toContain(FIRST_CONTEXT_HEADER);
    expect(call.prompt).toContain("첫 질문");
    expect(call.prompt).toContain("## 현재 요청\n왜 500 이 나요?");
    // 트리거 메시지는 컨텍스트에서 제외 — 현재 요청으로만 들어간다
    expect(call.prompt).not.toContain("현재 트리거");

    const record = s.sessions.get("C1:100.1");
    expect(record?.sessionId).toBe("sess-1");
    expect(record?.cwd).toBe(WORKSPACE);
    expect(record?.lastSeenTs).toBe("100.5");

    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");
    // plan 카드(기본 경로)가 최종 답변으로 종결됐다 (appendText → stop)
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("분석 결과입니다");
  });

  it("readonlyDirs 가 세션 프로파일의 additionalDirectories 로 실제 배선된다", async () => {
    // 목킹된 runSession 만으로는 "배선했다고 믿었지만 안 간" 갭이 가려진다 — 세션이 받은
    // 옵션을 단언한다. 이 배선이 끊기면 소스 폴백이 조용히 "카탈로그에 없다"로 되돌아간다.
    const src = "/srv/your-repo";
    const s = setup({ readonlyDirs: [src] });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    const call = mustGet(s.runCalls, 0);
    expect(call.profile.options.additionalDirectories).toEqual([src]);
    // cwd 는 그대로 workspace — 확장이지 이동이 아니다
    expect(call.profile.options.cwd).toBe(WORKSPACE);
  });

  it("readonlyDirs 미배선이면 확장 경로가 아예 없다 (기본은 workspace 만)", async () => {
    const s = setup();
    await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(mustGet(s.runCalls, 0).profile.options.additionalDirectories).toBeUndefined();
  });

  it("표시명이 프롬프트 맥락·요청자 표기·최종 답변 모두에 반영된다 (EG-08)", async () => {
    const s = setup({
      thread: [
        reply("100.1", "첫 질문", { user: "U0DDDDDDDDD" }),
        reply("100.3", "코멘트", { user: "U2" }),
      ],
      names: new Map([
        ["U0DDDDDDDDD", "홍길동"],
        ["U2", "장owner"],
      ]),
      // 모델이 맥락의 ID 를 그대로 옮겨 적은 상황 — egress 가 이름으로 교정해야 한다
      results: [ok("@U0DDDDDDDDD님 요청하신 내용 확인했습니다")],
    });

    await s.handler.run(makeJob(makePayload({ userId: "U0DDDDDDDDD" })), s.ctx);

    const call = mustGet(s.runCalls, 0);
    expect(call.prompt).toContain("요청자: 홍길동");
    expect(call.prompt).toContain("[100.1] 홍길동: 첫 질문");
    expect(call.prompt).toContain("[100.3] 장owner: 코멘트");

    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("@홍길동님 요청하신 내용");
    expect(texts.at(-1)?.text).not.toContain("@U0DDDDDDDDD");
  });

  it("표시명을 모르면 기존대로 ID 폴백 — 이름 해석 실패가 답변을 막지 않는다", async () => {
    const s = setup({
      thread: [reply("100.1", "첫 질문", { user: "U1" })],
      results: [ok("확인했습니다")],
    });

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(verdict).toBe("done");
    const call = mustGet(s.runCalls, 0);
    expect(call.prompt).toContain("[100.1] U1: 첫 질문");
    expect(call.prompt).not.toContain("요청자:");
  });

  it("폴백 진행 카드: createStream 실패 시 onProgress 라인이 addTool 로 카드에 반영된다 (EG-02)", async () => {
    const s = setup({
      runImpl: async (params) => {
        params.onProgress?.("Bash: pnpm test");
        params.onProgress?.("Read: /repo/a.ts");
        return ok("done");
      },
    });
    s.fake.failStream.value = "create"; // plan 불가 → 진행 카드로 폴백
    await s.handler.run(makeJob(makePayload()), s.ctx);
    const updates = callsOf(s.fake, "update");
    // 첫 flush 는 즉시 발생 — 카테고리 롤업 표기가 실린다
    expect(updates.some((u) => u.text?.includes("⚙ 실행"))).toBe(true);
  });
});

describe("chat handler — resume 흐름", () => {
  it("기존 세션이면 resume + 증분 컨텍스트(last_seen 이후·봇 발신 제외)", async () => {
    const s = setup({
      thread: [
        reply("100.1", "첫 질문", { user: "U1" }),
        reply("100.2", "이전 봇 답변", { botId: SELF_BOT }),
        reply("100.3", "새 후속 질문", { user: "U2" }),
        reply("100.5", "현재 트리거", { user: "U1" }),
      ],
      results: [ok("이어서 답변", "sess-1")],
    });
    s.sessions.upsert({ threadKey: "C1:100.1", sessionId: "sess-1", cwd: "/stored-cwd" });
    s.sessions.setLastSeenTs("C1:100.1", "100.2");

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    const call = mustGet(s.runCalls, 0);
    expect(call.resumeSessionId).toBe("sess-1");
    expect(call.profile.options.cwd).toBe("/stored-cwd");
    expect(call.prompt).toContain(RESUME_CONTEXT_HEADER);
    expect(call.prompt).toContain("새 후속 질문");
    expect(call.prompt).not.toContain("첫 질문");
    expect(call.prompt).not.toContain("이전 봇 답변");

    expect(s.sessions.get("C1:100.1")?.lastSeenTs).toBe("100.5");
  });

  it("세션 만료(No conversation found)는 drop 후 신규 세션 1회 재시도 (SC-04)", async () => {
    const s = setup({
      thread: [reply("100.1", "첫 질문", { user: "U1" })],
      results: [
        {
          text: "No conversation found with session ID sess-old",
          sessionId: null,
          usage: null,
          timedOut: null,
          aborted: false,
          isError: true,
        },
        ok("새 세션으로 답변", "sess-new"),
      ],
    });
    s.sessions.upsert({ threadKey: "C1:100.1", sessionId: "sess-old", cwd: "/stored-cwd" });
    s.sessions.setLastSeenTs("C1:100.1", "100.4");

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");
    expect(s.runCalls).toHaveLength(2);

    const first = mustGet(s.runCalls, 0);
    const second = mustGet(s.runCalls, 1);
    expect(first.resumeSessionId).toBe("sess-old");
    expect(second.resumeSessionId).toBeUndefined();
    // 신규 세션은 워크스페이스 cwd + 전체 컨텍스트로 재구성된다
    expect(second.profile.options.cwd).toBe(WORKSPACE);
    expect(second.prompt).toContain(FIRST_CONTEXT_HEADER);
    expect(second.prompt).toContain("첫 질문");

    expect(s.sessions.get("C1:100.1")?.sessionId).toBe("sess-new");
    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");
  });

  it("신규 세션까지 만료 문구를 돌려주면 더 재시도하지 않고 실패로 종결한다", async () => {
    const expired: RunResult = {
      text: "No conversation found",
      sessionId: null,
      usage: null,
      timedOut: null,
      aborted: false,
      isError: true,
    };
    const s = setup({ results: [expired, expired] });
    s.sessions.upsert({ threadKey: "C1:100.1", sessionId: "sess-old", cwd: "/stored-cwd" });

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("failed");
    expect(s.runCalls).toHaveLength(2);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("failure");
  });
});

describe("chat handler — 종결·리액션 상태 (EG-06, SC-09)", () => {
  it("isError 결과는 ❌ + failed — 에러 본문은 스레드에 게시된다", async () => {
    const s = setup({
      results: [
        {
          text: "API Error: 500",
          sessionId: null,
          usage: null,
          timedOut: null,
          aborted: false,
          isError: true,
        },
      ],
    });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("failed");
    expect(s.reactions.stateOf("C1", "100.5")).toBe("failure");
    // 에러 본문도 plan 카드 최종 답변으로 게시된다 (isError 여도 finish 는 답변을 남긴다)
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("API Error: 500");
  });

  it("타임아웃은 실패 취급 + 안내 문구", async () => {
    const s = setup({
      results: [
        {
          text: "부분 응답",
          sessionId: "sess-1",
          usage: null,
          timedOut: "idle",
          aborted: false,
          isError: false,
        },
      ],
    });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("failed");
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("idle 타임아웃");
  });

  it("/cancel 경유 취소: 🚫 + 취소 안내 + cancelled", async () => {
    const s = setup({
      runImpl: (params) =>
        new Promise<RunResult>((resolve) => {
          const done = (): void =>
            resolve({
              text: null,
              sessionId: null,
              usage: null,
              timedOut: null,
              aborted: true,
              isError: false,
            });
          if (params.signal?.aborted) done();
          else params.signal?.addEventListener("abort", done, { once: true });
        }),
    });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    // 실행이 카드 게시까지 진행되도록 양보 후 취소
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.runningTasks.cancel("C1:100.1")).toBe(true);

    const verdict = await running;
    expect(verdict).toBe("cancelled");
    expect(s.reactions.stateOf("C1", "100.5")).toBe("cancelled");
    // 취소 안내는 plan 카드 최종 텍스트로 종결된다
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain(CHAT_CANCELLED_TEXT);
  });

  it("shutdown abort(ctx.signal)는 취소 안내 없이 cancelled — 안내는 부팅/종료 시퀀스 몫", async () => {
    const s = setup({
      runImpl: (params) =>
        new Promise<RunResult>((resolve) => {
          const done = (): void =>
            resolve({
              text: null,
              sessionId: null,
              usage: null,
              timedOut: null,
              aborted: true,
              isError: false,
            });
          if (params.signal?.aborted) done();
          else params.signal?.addEventListener("abort", done, { once: true });
        }),
    });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    s.ctxAbort.abort();

    const verdict = await running;
    expect(verdict).toBe("cancelled");
    expect(s.reactions.stateOf("C1", "100.5")).toBe("cancelled");
    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.text?.includes(CHAT_CANCELLED_TEXT))).toBe(false);
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.some((c) => c.text?.includes(CHAT_CANCELLED_TEXT))).toBe(false);
    // 안내 문구는 없어도 plan 스트림은 stop 으로 종결 — 미마감 카드로 방치하지 않는다
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
  });

  it("재시도 남은 throw: 재시도 안내가 게시되고 ⏳ 는 유지된다 (plan 경로는 새 답글)", async () => {
    const s = setup({ results: [new Error("일시 네트워크 오류")] });
    await expect(s.handler.run(makeJob(makePayload(), { attempts: 1 }), s.ctx)).rejects.toThrow(
      "일시 네트워크 오류",
    );
    expect(s.reactions.stateOf("C1", "100.5")).toBe("pending");
    // plan 경로엔 progressTs 가 없어 재시도 안내는 새 답글로 게시된다. plan 스트림은 stop 된다.
    const posts = callsOf(s.fake, "post");
    expect(posts.at(-1)?.text).toContain(CHAT_RETRY_NOTICE);
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
  });

  it("폴백 카드 경로의 재시도 throw 는 카드 자리를 안내로 교체한다", async () => {
    const s = setup({ results: [new Error("일시 네트워크 오류")] });
    s.fake.failStream.value = "create"; // 진행 카드 경로
    await expect(s.handler.run(makeJob(makePayload(), { attempts: 1 }), s.ctx)).rejects.toThrow(
      "일시 네트워크 오류",
    );
    const updates = callsOf(s.fake, "update");
    expect(updates.at(-1)?.text).toContain(CHAT_RETRY_NOTICE);
  });

  it("마지막 시도 throw 는 재시도 안내 없이 전파 — onExhausted 가 ❌+통보를 맡는다 (JQ-06)", async () => {
    const s = setup({ results: [new Error("계속 실패")] });
    const job = makeJob(makePayload(), { attempts: 2, error: "계속 실패" });
    await expect(s.handler.run(job, s.ctx)).rejects.toThrow("계속 실패");
    expect(callsOf(s.fake, "update").some((u) => u.text?.includes(CHAT_RETRY_NOTICE))).toBe(false);

    await s.handler.onExhausted?.(job, s.ctx);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("failure");
    const posts = callsOf(s.fake, "post");
    expect(posts.at(-1)?.text).toContain("재시도 소진");
    expect(posts.at(-1)?.text).toContain("계속 실패");
  });
});

function assistantToolUse(id: string, name: string, input: unknown): unknown {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}
function userToolResult(toolUseId: string, isError = false): unknown {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  };
}

describe("chat handler — plan 카드 경로 (Agent 모드)", () => {
  it("createStream 성공 시 tool_use/tool_result 가 plan chunk 로 흐르고 최종답변 append+stop", async () => {
    const s = setup({
      runImpl: async (params) => {
        params.onStreamEvent?.(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
        params.onStreamEvent?.(userToolResult("tu-A"));
        return ok("최종 분석 결과");
      },
    });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    // 스트림 생성 시 recipient_* 전달
    const created = s.fake.calls.find((c) => c.kind === "streamCreate");
    expect(created?.createArgs?.recipientUserId).toBe("U1");
    expect(created?.createArgs?.recipientTeamId).toBe(TEAM_ID);

    // plan 앵커 + in_progress → complete chunk 가 흘렀다
    const chunkBatches = s.fake.calls.filter((c) => c.kind === "streamChunks");
    const allChunks = chunkBatches.flatMap((c) => c.chunks ?? []);
    expect(allChunks.some((c) => c.type === "plan_update")).toBe(true);
    expect(allChunks.some((c) => c.type === "task_update" && c.status === "in_progress")).toBe(
      true,
    );
    expect(allChunks.some((c) => c.type === "task_update" && c.status === "complete")).toBe(true);

    // 최종 답변은 appendText → stop 으로 종결. chat.update(진행 카드)는 쓰지 않는다.
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("최종 분석 결과");
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
    expect(callsOf(s.fake, "update")).toHaveLength(0);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");
  });

  it("plan 경로에서도 lastStep 이 갱신된다 — 워치독 입력이 폴백 카드에만 배선되면 안 된다", async () => {
    let stepDuringRun: string | null = null;
    const s = setup({
      runImpl: async (params) => {
        params.onProgress?.("Read: src/foo.ts");
        stepDuringRun = s.runningTasks.list()[0]?.lastStep ?? null;
        return ok("답변");
      },
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);
    // 폴백 강등 없이(plan 경로) 스텝이 레지스트리에 반영돼야 한다
    expect(stepDuringRun).toBe("📖 탐색 src/foo.ts");
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });

  it("createStream 예외 시 진행 카드(chat.update)로 폴백", async () => {
    const s = setup({
      runImpl: async (params) => {
        params.onProgress?.("Bash: pnpm test");
        return ok("폴백 답변");
      },
    });
    s.fake.failStream.value = "create";

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    // 폴백: 진행 카드가 chat.update 로 그려지고 최종 답변으로 교체된다
    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.text?.includes("⚙ 실행"))).toBe(true);
    expect(updates.at(-1)?.text).toContain("폴백 답변");
    // 스트림 append 는 일어나지 않는다
    expect(s.fake.calls.some((c) => c.kind === "streamChunks")).toBe(false);
  });

  it("첫 append 예외 시 진행 카드로 강등하고 이후 onProgress 로 카드를 채운다", async () => {
    const s = setup({
      runImpl: async (params) => {
        // 첫 tool_use → 첫 appendChunks 가 throw → 폴백 강등
        params.onStreamEvent?.(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
        // 강등 후 후속 도구는 onProgress 로 카드에 반영
        params.onProgress?.("Bash: pnpm build");
        return ok("강등 후 답변");
      },
    });
    s.fake.failStream.value = "append";

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    const updates = callsOf(s.fake, "update");
    // 폴백 카드가 최종 답변으로 교체됐다
    expect(updates.at(-1)?.text).toContain("강등 후 답변");
    expect(s.fake.calls.some((c) => c.kind === "streamCreate")).toBe(true);
    // 스트림 도중 강등돼도 드라이버 생성 때 띄운 assistant 상태(≠"")는 종결 시 clear 된다
    const statuses = callsOf(s.fake, "setStatus");
    expect(statuses.some((c) => c.status !== "")).toBe(true);
    expect(statuses.at(-1)?.status).toBe("");
  });

  it("appendText 성공 후 stop 실패는 폴백 재게시 없이 종결 — 최종 답변 중복 게시 금지", async () => {
    const s = setup({ results: [ok("유일한 최종 답변")] });
    s.fake.failStreamStop.value = true; // appendText 성공, stop 만 throw

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    // 답변은 이미 게시됐으므로 성공 종결 흐름을 유지한다
    expect(verdict).toBe("done");

    // 최종 답변은 plan 스트림 appendText 로 정확히 한 번만 게시된다
    const finalTexts = s.fake.calls.filter(
      (c) => c.kind === "streamText" && c.text?.includes("유일한 최종 답변"),
    );
    expect(finalTexts).toHaveLength(1);
    // stop 실패로 폴백 카드(chat.update)를 열어 답변을 재게시하지 않는다
    expect(callsOf(s.fake, "update")).toHaveLength(0);
    // 새 답글(post)로도 재게시하지 않는다
    const dupPosts = callsOf(s.fake, "post").filter((p) => p.text?.includes("유일한 최종 답변"));
    expect(dupPosts).toHaveLength(0);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");
    // stop 실패 경로에서도 assistant 상태는 반드시 clear 된다 — 안 그러면 "분석 중…" 이 영구히 남는다
    const statuses = callsOf(s.fake, "setStatus");
    expect(statuses.at(-1)?.status).toBe("");
  });

  it("죽은 plan 스트림(message_not_in_streaming_state)의 finish: 얼어붙은 카드 ts 를 chat.update 로 정리·교체 + 답변 게시", async () => {
    // 3분+ 세션에서 스트리밍 창이 만료돼 최종 답변 append 가 거절되는 실사고(2026-07-22).
    const s = setup({
      runImpl: async (params) => {
        // 도구 1건이 먼저 흘러 plan 카드가 뜬다(handle.ts 정의) → 이후 최종 답변 append 가 죽은 스트림에 실패
        params.onStreamEvent?.(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
        params.onStreamEvent?.(userToolResult("tu-A"));
        return ok("최종 답변 본문");
      },
    });
    s.fake.failStreamAppendText.value = "dead"; // appendText → message_not_in_streaming_state

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    // 답변이 게시됐으므로 성공 종결
    expect(verdict).toBe("done");
    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");

    // plan 카드가 먼저 떴다(chunk flush → ts 정의)
    const created = s.fake.calls.find((c) => c.kind === "streamChunks");
    const planCardTs = "9001.000"; // fake 가 첫 chunk flush 때 부여하는 ts
    expect(created).toBeDefined();

    // 얼어붙은 plan 카드 ts 로 chat.update 정리가 일어났다 — 프리즌 카드가 안 남는다
    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.ts === planCardTs)).toBe(true);
    // 그리고 그 자리(같은 ts)가 최종 답변으로 교체됐다
    expect(updates.some((u) => u.ts === planCardTs && u.text?.includes("최종 답변 본문"))).toBe(
      true,
    );
    // 죽은 스트림이므로 stop 은 시도하지 않는다(스트림 API 로는 못 닫는다)
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(false);
    // 답변 중복 게시 금지 — 새 답글(post)로 재게시하지 않는다
    expect(callsOf(s.fake, "post").some((p) => p.text?.includes("최종 답변 본문"))).toBe(false);
  });

  it("정상 종료 경로는 chat.update 정리 없이 stop 으로 마감한다 (회귀 금지)", async () => {
    const s = setup({
      runImpl: async (params) => {
        params.onStreamEvent?.(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
        params.onStreamEvent?.(userToolResult("tu-A"));
        return ok("정상 답변");
      },
    });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");
    // 살아있는 스트림은 appendText → stop 으로 마감 — 프리즌 정리용 chat.update 는 없다
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("정상 답변");
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });

  it("죽은 스트림에서 재시도 throw: 얼어붙은 plan 카드를 chat.update 로 정리하고 재시도 안내가 그 자리를 교체한다", async () => {
    const s = setup({
      results: [new Error("일시 네트워크 오류")],
      runImpl: async (params) => {
        // 도구 1건 flush 로 plan 카드를 띄운 뒤 throw — 카드가 얼어붙는다
        params.onStreamEvent?.(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
        params.onStreamEvent?.(userToolResult("tu-A"));
        throw new Error("일시 네트워크 오류");
      },
    });
    s.fake.failStreamStopDead.value = true; // abortStream 의 stop 이 죽은 스트림으로 실패

    await expect(s.handler.run(makeJob(makePayload(), { attempts: 1 }), s.ctx)).rejects.toThrow(
      "일시 네트워크 오류",
    );
    expect(s.reactions.stateOf("C1", "100.5")).toBe("pending");
    // 죽은 스트림 stop 실패 → 얼어붙은 카드를 chat.update 로 교체, 재시도 안내가 그 ts 를 replaceTs 로 교체
    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.ts === "9001.000")).toBe(true);
    expect(updates.some((u) => u.text?.includes(CHAT_RETRY_NOTICE))).toBe(true);
  });

  it('plan 경로: 드라이버 생성 직후 assistant 상태(≠"") 1회 + finish 시 clear("")', async () => {
    const s = setup({ results: [ok("최종 답변")] });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    const statuses = callsOf(s.fake, "setStatus");
    // 정확히 2회: 처리 중 표시(≠"") 1회 + 종결 clear("") 1회
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.status).not.toBe("");
    expect(statuses[0]?.status?.length).toBeGreaterThan(0);
    // fresh 풀 문구 + sonnet 접미사 (기본 모델)
    expect(statuses[0]?.status).toContain("opus");
    expect(statuses[0]?.channel).toBe("C1");
    expect(statuses[0]?.threadTs).toBe("100.1");
    // clear 는 종결 순서상 상태 표시 뒤에 온다
    expect(statuses[1]?.status).toBe("");
  });

  it('폴백 카드 경로(createStream 실패): 처리 중 상태(≠"")를 띄우지 않는다', async () => {
    const s = setup({
      runImpl: async (params) => {
        params.onProgress?.("Bash: pnpm test");
        return ok("폴백 답변");
      },
    });
    s.fake.failStream.value = "create"; // plan 불가 → 진행 카드로 폴백

    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);
    expect(verdict).toBe("done");

    // 강등 경로에선 처리 중 상태(≠"")를 띄우지 않는다 (카드 headerFn 이 회전 문구를 보여줌).
    const statuses = callsOf(s.fake, "setStatus");
    expect(statuses.some((c) => c.status !== "")).toBe(false);
  });

  it("plan 경로 최종 답변에도 (응답 없음) 규칙이 유지되고, 토큰 사용량은 안 붙는다", async () => {
    const s = setup({
      results: [
        {
          text: null,
          sessionId: "sess-1",
          usage: { input_tokens: 10, output_tokens: 5 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain("(응답 없음)");
    expect(texts.at(-1)?.text).not.toContain("토큰");
  });
});

/**
 * 토큰 장부는 게시물이 아니라 로그에 남는다(2026-08-07 꼬리 제거). 완료 경로만 찍으면
 * 취소분·만료 폐기분이 증발해 합계가 실제 지출보다 적게 나오므로, 종결 경로마다 한 줄을 요구한다.
 */
describe("토큰 장부 로그", () => {
  const usageLines = (s: ReturnType<typeof setup>): string[] =>
    s.logs.filter((l) => l.includes("chat: 토큰"));

  it("만료 재시도는 폐기한 attempt 0 의 지출도 남긴다 — 안 그러면 장부에서 통째로 증발한다", async () => {
    const s = setup({
      results: [
        {
          text: "No conversation found with session ID sess-old",
          sessionId: null,
          usage: { input_tokens: 900, output_tokens: 40 } as never,
          timedOut: null,
          aborted: false,
          isError: true,
        },
        {
          text: "새 세션으로 답변",
          sessionId: "sess-new",
          usage: { input_tokens: 12, output_tokens: 7 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    s.sessions.upsert({ threadKey: "C1:100.1", sessionId: "sess-old", cwd: "/stored-cwd" });

    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(usageLines(s)).toEqual([
      "chat: 토큰 thread=C1:100.1 phase=만료폐기 in=900 out=40",
      "chat: 토큰 thread=C1:100.1 phase=완료 in=12 out=7",
    ]);
  });

  it("취소 종결도 한 줄 남긴다 — 중단 전까지 쓴 토큰은 이미 쓴 돈이다", async () => {
    const s = setup({
      runImpl: (params) =>
        new Promise<RunResult>((resolve) => {
          const done = (): void =>
            resolve({
              text: null,
              sessionId: null,
              usage: { input_tokens: 500, output_tokens: 3 } as never,
              timedOut: null,
              aborted: true,
              isError: false,
            });
          if (params.signal?.aborted) done();
          else params.signal?.addEventListener("abort", done, { once: true });
        }),
    });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.runningTasks.cancel("C1:100.1")).toBe(true);

    expect(await running).toBe("cancelled");
    expect(usageLines(s)).toEqual(["chat: 토큰 thread=C1:100.1 phase=취소 in=500 out=3"]);
  });

  it("평범한 완료는 정확히 한 줄 — 경로마다 중복해서 찍지 않는다", async () => {
    const s = setup({ results: [ok("답변입니다")] });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(usageLines(s)).toEqual(["chat: 토큰 thread=C1:100.1 phase=완료 usage=없음"]);
  });
});

describe("runningTasks 레지스트리", () => {
  it("진행 중이 아니면 cancel 은 false, list 는 스냅샷", () => {
    const registry = createChatTaskRegistry({ now: () => 5 });
    expect(registry.cancel("C1:1.0")).toBe(false);

    const handle = registry.start({
      threadKey: "C1:1.0",
      channel: "C1",
      threadTs: "1.0",
      ts: "1.0",
      abort: () => {},
    });
    handle.setProgressTs("2.0");
    const snapshot = registry.list();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.progressTs).toBe("2.0");

    handle.finish();
    expect(registry.list()).toHaveLength(0);
  });

  it("cancelByMessage: 트리거·스레드부모·진행카드 어느 좌표로도 같은 작업을 취소한다", () => {
    // 리액션은 item.{channel,ts} 만 싣고 thread_ts 를 안 준다 — 사람이 🛑 를 다는 세 자리
    // (자기 요청·스레드 머리·봇 진행 카드)가 전부 같은 작업으로 수렴해야 취소가 성립한다.
    const coords = ["9.1", "1.0", "2.0"];
    for (const ts of coords) {
      const aborted: string[] = [];
      const registry = createChatTaskRegistry({ now: () => 5 });
      const handle = registry.start({
        threadKey: "C1:1.0",
        channel: "C1",
        threadTs: "1.0",
        ts: "9.1",
        abort: () => aborted.push("x"),
      });
      handle.setProgressTs("2.0");

      expect(registry.cancelByMessage({ channel: "C1", ts })).toBe("C1:1.0");
      expect(aborted).toHaveLength(1);
      // /cancel 과 같은 마킹이어야 핸들러가 "사용자 취소" 안내를 낸다(shutdown abort 와 구분).
      expect(registry.list()[0]?.userCancelled).toBe(true);
    }
  });

  it("cancelByMessage: 다른 채널·무관한 ts 는 null 이고 작업을 건드리지 않는다", () => {
    const aborted: string[] = [];
    const registry = createChatTaskRegistry({ now: () => 5 });
    registry.start({
      threadKey: "C1:1.0",
      channel: "C1",
      threadTs: "1.0",
      ts: "9.1",
      abort: () => aborted.push("x"),
    });

    expect(registry.cancelByMessage({ channel: "C2", ts: "1.0" })).toBeNull();
    expect(registry.cancelByMessage({ channel: "C1", ts: "7.7" })).toBeNull();
    expect(aborted).toHaveLength(0);
    expect(registry.list()[0]?.userCancelled).toBe(false);
  });
});

describe("순수 헬퍼", () => {
  it("splitProgressLine — 'Tool: summary' 분해", () => {
    expect(splitProgressLine("Bash: pnpm test")).toEqual({ tool: "Bash", summary: "pnpm test" });
    expect(splitProgressLine("Glob")).toEqual({ tool: "Glob" });
  });

  it("isSessionExpired — 대소문자 무시 매칭", () => {
    expect(isSessionExpired({ text: "No conversation found with ID x" })).toBe(true);
    expect(isSessionExpired({ text: "정상 답변" })).toBe(false);
    expect(isSessionExpired({ text: null })).toBe(false);
  });

  it("sumUsage — 재작성 비용이 장부에서 사라지지 않는다", () => {
    const a = { input_tokens: 10, output_tokens: 5 } as never;
    const b = { input_tokens: 3, output_tokens: 2 } as never;
    expect(sumUsage(a, b)).toMatchObject({ input_tokens: 13, output_tokens: 7 });
    expect(sumUsage(null, b)).toBe(b);
    expect(sumUsage(a, null)).toBe(a);
    expect(sumUsage(null, null)).toBeNull();
  });

  it("formatUsageLog — usage 없으면 없음 표기", () => {
    expect(formatUsageLog(null)).toBe("usage=없음");
    expect(formatUsageLog({ input_tokens: 10, output_tokens: 5 } as never)).toBe("in=10 out=5");
  });
});

describe("스타일 린트 재작성 (chat 장황함 억제)", () => {
  const wall = ["- 1", "- 2", "- 3", "- 4", "- 5", "- 6"].join("\n");
  const lastPosted = (s: ReturnType<typeof setup>) =>
    s.fake.calls.filter((c) => c.kind === "streamText").at(-1)?.text ?? "";

  it("린트를 통과한 답은 재작성 없이 1회 런으로 끝난다", async () => {
    const s = setup({ results: [ok("v2.14.3 입니다.")] });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(verdict).toBe("done");
    expect(s.runCalls).toHaveLength(1);
  });

  it("위반이면 같은 세션 resume 으로 재작성 1회 — 재작성 결과가 게시된다", async () => {
    const s = setup({ results: [ok(wall, "sess-1"), ok("여섯 건 있어요.", "sess-1")] });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(s.runCalls).toHaveLength(2);
    const rewrite = mustGet(s.runCalls, 1);
    expect(rewrite.resumeSessionId).toBe("sess-1");
    expect(rewrite.prompt).toContain("다시 써라");
    expect(rewrite.prompt).toContain("한 목록에 항목은");
    expect(lastPosted(s)).toContain("여섯 건 있어요");
    expect(lastPosted(s)).not.toContain("- 6");
  });

  it("재작성 런은 원 런과 다른, 짧은 타임아웃 예산을 쓴다 — 무도구 짧은 턴에 30분 상한을 물려주지 않는다", async () => {
    const s = setup({ results: [ok(wall, "sess-1"), ok("여섯 건 있어요.", "sess-1")] });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    const original = mustGet(s.runCalls, 0);
    const rewrite = mustGet(s.runCalls, 1);
    // 원 런은 지정하지 않는다 — runner 의 기본값(idle 10분/hard 30분)을 그대로 쓴다.
    expect(original.idleTimeoutMs).toBeUndefined();
    expect(original.hardTimeoutMs).toBeUndefined();
    // 리터럴로 고정한다 — 상수 import 가 깨져도(undefined) rewrite 필드와 함께 undefined 로
    // 뭉개져 통과해버리는 요행을 막는다. 상수 자체도 같은 리터럴을 가리키는지 별도로 확인한다.
    expect(rewrite.idleTimeoutMs).toBe(90_000);
    expect(rewrite.hardTimeoutMs).toBe(3 * 60_000);
    expect(REWRITE_IDLE_TIMEOUT_MS).toBe(90_000);
    expect(REWRITE_HARD_TIMEOUT_MS).toBe(3 * 60_000);
  });

  it("재작성 결과도 위반이면 그대로 게시한다 — 3회째 런은 없다", async () => {
    const s = setup({ results: [ok(wall), ok(wall)] });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(s.runCalls).toHaveLength(2);
    expect(lastPosted(s)).toContain("- 6");
  });

  it("재작성 런이 실패하면 원문을 게시한다", async () => {
    const failed: RunResult = {
      text: null,
      sessionId: "sess-1",
      usage: null,
      timedOut: null,
      aborted: false,
      isError: true,
    };
    const s = setup({ results: [ok(wall), failed] });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(verdict).toBe("done");
    expect(lastPosted(s)).toContain("- 6");
  });

  it("재작성 런이 예외를 던져도 이미 얻은 답은 살아남는다", async () => {
    const s = setup({ results: [ok(wall), new Error("SDK 폭발")] });
    const verdict = await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(verdict).toBe("done");
    expect(lastPosted(s)).toContain("- 6");
  });

  it("세션 ID 가 없으면 재작성하지 않는다 — resume 이 불가하다", async () => {
    const s = setup({
      results: [
        {
          text: wall,
          sessionId: null,
          usage: null,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(s.runCalls).toHaveLength(1);
  });

  /**
   * "코드가 붙인 꼬리를 모델 탓으로 잡지 않는다"를 두 조각으로 못박는다. 토큰 꼬리를 걷어낸 뒤
   * 남은 꼬리는 타임아웃 문구뿐이고, 타임아웃 답은 `rewritable` 이 false 라 린트를 안 탄다 —
   * 즉 계약은 "재작성 대상 답변에는 꼬리가 아예 안 붙는다"로 지켜지는 중이다. 아래 두 테스트가
   * 그 불변식을 지킨다: 꼬리를 하나 더 붙이는 순간 A 가, 린트를 꼬리 뒤로 옮기면 A 가 함께 깨진다.
   */
  it("A. 재작성 대상 답변에는 코드 꼬리가 하나도 안 붙는다 — 상한 정각 답이 그대로 나간다", async () => {
    const atLimit = "가".repeat(CHAT_MAX_CHARS);
    const s = setup({
      results: [
        {
          text: atLimit,
          sessionId: "sess-1",
          usage: { input_tokens: 10, output_tokens: 5 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    // toBe 라서 꼬리가 1글자만 붙어도 깨진다 — 붙으면 상한을 넘겨 재작성까지 유발한다.
    expect(lastPosted(s)).toBe(atLimit);
    expect(s.runCalls).toHaveLength(1);
  });

  it("B. 꼬리가 붙는 답변(타임아웃)은 애초에 재작성 대상이 아니다", async () => {
    const s = setup({
      results: [
        {
          text: wall,
          sessionId: "sess-1",
          usage: { input_tokens: 10, output_tokens: 5 } as never,
          timedOut: "idle",
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(s.runCalls).toHaveLength(1);
    expect(lastPosted(s)).toContain("타임아웃으로 중단됨");
  });

  it("재작성이 돌아도 게시물에는 토큰 사용량이 섞이지 않는다 — 장부는 로그 몫", async () => {
    const s = setup({
      results: [
        {
          text: wall,
          sessionId: "sess-1",
          usage: { input_tokens: 10, output_tokens: 5 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
        {
          text: "여섯 건 있어요.",
          sessionId: "sess-1",
          usage: { input_tokens: 3, output_tokens: 2 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(lastPosted(s)).toBe("여섯 건 있어요.");
  });

  /** 원 런은 즉시 위반 텍스트로 끝나고, 재작성 런(2번째 호출)만 abort 신호를 기다리며 매달린다. */
  function pendingRewriteAfterViolatingFirstRun(): (
    params: RunSessionParams,
  ) => Promise<RunResult> {
    let call = 0;
    return (params: RunSessionParams) => {
      call += 1;
      if (call === 1) return Promise.resolve(ok(wall, "sess-1"));
      return new Promise<RunResult>((resolve) => {
        const done = (): void =>
          resolve({
            text: null,
            sessionId: null,
            usage: null,
            timedOut: null,
            aborted: true,
            isError: false,
          });
        if (params.signal?.aborted) done();
        else params.signal?.addEventListener("abort", done, { once: true });
      });
    };
  }

  it("재작성 런 도중 /cancel — 취소 안내 게시·cancelled·원문 미게시 (재작성도 원 런과 같은 취소 계약을 따른다)", async () => {
    const s = setup({ runImpl: pendingRewriteAfterViolatingFirstRun() });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    // 재작성 런(2번째 호출)이 시작되도록 양보 후 취소
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.runningTasks.cancel("C1:100.1")).toBe(true);

    const verdict = await running;
    expect(verdict).toBe("cancelled");
    expect(s.runCalls).toHaveLength(2);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("cancelled");
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    expect(texts.at(-1)?.text).toContain(CHAT_CANCELLED_TEXT);
    // 이미 얻은 원 런 답(위반 텍스트)이 취소 안내 대신 게시되면 안 된다
    expect(texts.at(-1)?.text).not.toContain("- 6");
  });

  it("재작성 런 도중 취소돼도 장부는 원 런 + 재작성 합계다 — 원 런은 이미 쓴 돈이다", async () => {
    let call = 0;
    const s = setup({
      runImpl: (params) => {
        call += 1;
        if (call === 1) {
          return Promise.resolve({
            text: wall,
            sessionId: "sess-1",
            usage: { input_tokens: 100, output_tokens: 60 } as never,
            timedOut: null,
            aborted: false,
            isError: false,
          });
        }
        return new Promise<RunResult>((resolve) => {
          const done = (): void =>
            resolve({
              text: null,
              sessionId: null,
              usage: { input_tokens: 8, output_tokens: 1 } as never,
              timedOut: null,
              aborted: true,
              isError: false,
            });
          if (params.signal?.aborted) done();
          else params.signal?.addEventListener("abort", done, { once: true });
        });
      },
    });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(s.runningTasks.cancel("C1:100.1")).toBe(true);

    expect(await running).toBe("cancelled");
    expect(s.logs.filter((l) => l.includes("chat: 토큰"))).toEqual([
      "chat: 토큰 thread=C1:100.1 phase=취소 in=108 out=61",
    ]);
  });

  it("재작성 답을 버려도 그 런의 지출은 장부에 남는다 — 빈 결과여도 돈은 나갔다", async () => {
    const s = setup({
      results: [
        {
          text: wall,
          sessionId: "sess-1",
          usage: { input_tokens: 100, output_tokens: 60 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
        // 빈 결과 — 원문을 그대로 게시하는 분기. 답은 버리지만 토큰은 이미 썼다.
        {
          text: "   ",
          sessionId: "sess-1",
          usage: { input_tokens: 8, output_tokens: 1 } as never,
          timedOut: null,
          aborted: false,
          isError: false,
        },
      ],
    });
    await s.handler.run(makeJob(makePayload()), s.ctx);

    expect(lastPosted(s)).toBe(wall);
    expect(s.logs.filter((l) => l.includes("chat: 토큰"))).toEqual([
      "chat: 토큰 thread=C1:100.1 phase=완료 in=108 out=61",
    ]);
  });

  it("재작성 런 도중 shutdown abort(ctx.signal) — 취소가 아니므로 이미 얻은 원문을 그대로 게시한다", async () => {
    // 취소와 다르다: 아무도 멈추라고 하지 않았고, 사용자에게 "취소했다"고 말한 적도 없다.
    // 이미 완성된 원 런의 답을 버리면 순수 손실이다 — 스타일은 배달을 막지 않는다는 원칙 그대로.
    const s = setup({ runImpl: pendingRewriteAfterViolatingFirstRun() });
    const running = s.handler.run(makeJob(makePayload()), s.ctx);
    await new Promise((resolve) => setTimeout(resolve, 10));
    s.ctxAbort.abort();

    const verdict = await running;
    expect(verdict).toBe("done");
    expect(s.runCalls).toHaveLength(2);
    expect(s.reactions.stateOf("C1", "100.5")).toBe("success");
    const texts = s.fake.calls.filter((c) => c.kind === "streamText");
    // 취소 안내 문구는 없다 — 취소가 아니다
    expect(texts.at(-1)?.text).not.toContain(CHAT_CANCELLED_TEXT);
    // 원 런에서 이미 얻은 답(위반 텍스트라도)이 그대로 게시된다
    expect(texts.at(-1)?.text).toContain("- 6");
  });
});
