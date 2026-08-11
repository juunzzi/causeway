import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "./config/env.js";
import {
  appendAllowedUser,
  createAppContext,
  RESTART_EXHAUSTED_NOTICE,
  RESTART_RETRY_NOTICE,
} from "./context.js";
import { openDatabase } from "./core/db/connection.js";
import { callsOf, makeFakeSlack } from "./egress/testSupport.js";
import { CHAT_JOB_TYPE, type ChatPayload } from "./jobs/chat/handler.js";
import { SLACK_MCP_SERVER_NAME, SLACK_READ_ALLOWED_TOOL } from "./mcp/registry.js";
import { DISALLOWED_SLACK_WRITE_TOOLS } from "./runner/profiles.js";
import type { RunSessionParams, runSession } from "./runner/runner.js";
import type { ChatSlackPort } from "./slack/slackPort.js";

function makeEnv(configDir = "/nonexistent-config"): AppEnv {
  return {
    slackBotToken: "xoxb-test",
    slackAppToken: "xapp-test",
    dbPath: ":memory:",
    workspaceDir: "/ws",
    configDir,
    referenceDirs: [],
  };
}

/**
 * 도구 게이트는 **봇 프로세스 env**(baseEnv)가 정한다 — AppEnv 가 아니다. 각 도구 모듈이
 * 자기 자격증명을 직접 읽고, 없으면 그 도구만 조용히 빠진다(env.ts 헤더의 게이트 단일화).
 */
/** mytool_query 게이트는 mysql 클라이언트 실재 여부다 — 테스트는 확실히 존재하는 실행 파일을 가리킨다. */
const DB_ENV = { CAUSEWAY_MYSQL_PATH: process.execPath };

function makeChatPort(fake: ReturnType<typeof makeFakeSlack>): ChatSlackPort {
  return {
    ...fake.slack,
    fetchThreadMessages: async () => [],
    fetchUserName: async () => null,
    fetchChannelInfo: async () => null,
    isChannelMember: async () => false,
  };
}

function chatPayload(overrides: Partial<ChatPayload> = {}): ChatPayload {
  return {
    schema_version: 1,
    channel: "C1",
    ts: "100.5",
    threadTs: "100.1",
    threadKey: "C1:100.1",
    userId: "U1",
    text: "질문",
    files: [],
    ...overrides,
  };
}

function setup(
  baseEnv: Record<string, string | undefined> = {},
  envOverrides: Partial<AppEnv> = {},
) {
  const db = openDatabase(":memory:");
  const fake = makeFakeSlack();
  const logs: string[] = [];
  const ctx = createAppContext({
    env: { ...makeEnv(), ...envOverrides },
    slack: makeChatPort(fake),
    botUserId: "U0BOT",
    botId: "B0SELF",
    botTeamId: "T0TEAM",
    db,
    aclWatch: false,
    baseEnv,
    log: (msg) => logs.push(msg),
  });
  return { ctx, fake, logs };
}

describe("createAppContext 조립", () => {
  it("chat 핸들러 하나만 registry 에 등록된다 (JQ-09)", () => {
    const { ctx } = setup();
    expect(ctx.registry.has(CHAT_JOB_TYPE)).toBe(true);
    expect(ctx.registry.size).toBe(1);
  });

  it("access.json 부재는 fail-closed — 아무도 허용되지 않는다 (SEC-19)", () => {
    const { ctx } = setup();
    expect(ctx.acl.isAllowed("U1")).toBe(false);
    expect(ctx.acl.isAdmin("U1")).toBe(false);
  });

  /**
   * 4대 도구가 **세션 옵션까지** 실제로 도달하는지 단언한다. deps 조립만 확인하면 "배선했다고
   * 믿었지만 안 간" 갭이 그대로 통과한다 — 도구 집합은 spread 로 조립되므로 새 도구를 더하다
   * 기존 항목을 떨어뜨리기 쉽다(추가는 항상 기존 배선 유지까지 함께 검증한다).
   */

  it("slack 서버가 붙어도 Slack 쓰기 도구는 여전히 disallow 다 (EG-01)", async () => {
    const calls = await runChatCapturing({});
    const disallowed = calls[0]?.profile.options.disallowedTools ?? [];
    expect(disallowed).toEqual(expect.arrayContaining([...DISALLOWED_SLACK_WRITE_TOOLS]));
    expect(calls[0]?.profile.options.allowedTools ?? []).not.toEqual(
      expect.arrayContaining(["mcp__slack__slack_send_message"]),
    );
  });

  it("존재하지 않는 참조 경로는 선언에서 빠진다 — '읽을 수 있다'는 오해를 남기지 않는다", async () => {
    const calls = await runChatCapturing({}, ["100.1"], { referenceDirs: ["/nonexistent/repo"] });
    expect(calls[0]?.profile.options.additionalDirectories).toBeUndefined();
    expect(
      setup({}, { referenceDirs: ["/nonexistent/repo"] }).logs.some((l) =>
        l.includes("참조 체크아웃 미배선"),
      ),
    ).toBe(true);
  });

  it("실재하는 참조 경로는 절대경로로 additionalDirectories 에 실린다", async () => {
    // 상대경로를 그대로 흘리면 SDK 계약(절대경로) 위반이라 확장이 조용히 안 먹는다.
    const dir = mkdtempSync(join(tmpdir(), "causeway-ref-"));
    const calls = await runChatCapturing({}, ["100.1"], { referenceDirs: [dir] });
    expect(calls[0]?.profile.options.additionalDirectories).toEqual([dir]);
    // cwd 는 그대로 workspace — 확장이지 이동이 아니다
    expect(calls[0]?.profile.options.cwd).toBe("/ws");
  });

  it("warehouse CLI 가 없으면 스킬 안내를 넣지 않고 사유를 로그에 남긴다", async () => {
    const calls = await runChatCapturing({});
    expect(calls[0]?.prompt).not.toContain("skills/warehouse/SKILL.md");
  });

  /**
   * in-process 서버 인스턴스는 **세션당 하나**여야 한다. 부팅 때 굳힌 인스턴스를 공유하면 세션이
   * 겹치는 순간 나중 세션의 connect 가 `Already connected` 로 실패하고, SDK 는 그걸 debug 로그로
   * 삼킨 채 그 서버만 조용히 뺀다 — 세션은 에러 없이 도구를 잃는다(registry.ts McpToolEntry).
   */
});

/**
 * chat 잡을 실제로 굴려 세션이 받은 profile 을 포착한다. `threads` 를 2개 이상 주면 **한 부팅
 * (같은 AppContext)에서** 그만큼 연속 실행한다 — 부팅 때 굳힌 MCP 인스턴스가 세션 간에 공유되는지
 * 보려면 ctx 를 재사용해야만 한다.
 */
async function runChatCapturing(
  baseEnv: Record<string, string | undefined>,
  threads: readonly string[] = ["100.1"],
  envOverrides: Partial<AppEnv> = {},
): Promise<RunSessionParams[]> {
  const calls: RunSessionParams[] = [];
  const fake = makeFakeSlack();
  const ctx = createAppContext({
    env: { ...makeEnv(), ...envOverrides },
    slack: makeChatPort(fake),
    botUserId: "U0BOT",
    botId: "B0SELF",
    botTeamId: "T0TEAM",
    db: openDatabase(":memory:"),
    aclWatch: false,
    baseEnv,
    log: () => {},
    runSessionFn: (async (params: RunSessionParams) => {
      calls.push(params);
      return {
        text: "답변",
        sessionId: "sess-1",
        usage: null,
        timedOut: null,
        aborted: false,
        isError: false,
      };
    }) as unknown as typeof runSession,
  });
  const handler = ctx.registry.get(CHAT_JOB_TYPE);
  if (!handler) throw new Error("chat 핸들러 미등록");
  for (const threadTs of threads) {
    await handler.run(
      {
        id: 1,
        type: CHAT_JOB_TYPE,
        dedupKey: `slack:C1:${threadTs}`,
        lane: "interactive",
        laneKey: `C1:${threadTs}`,
        payload: chatPayload({ threadTs, threadKey: `C1:${threadTs}` }),
        status: "inflight",
        attempts: 1,
        maxAttempts: 2,
        leaseId: null,
        leaseExpiresAt: null,
        executionStartedAt: null,
        notBefore: null,
        result: null,
        error: null,
        createdAt: 0,
        updatedAt: 0,
      },
      { signal: new AbortController().signal },
    );
  }
  return calls;
}

describe("부팅 recoverInflight 시나리오 (JQ-05, OPS-05)", () => {
  it("inflight chat 잡 → 부팅 → pending 복구 + 스레드에 '재시작' 안내", async () => {
    const { ctx, fake } = setup();
    // 크래시 시뮬레이션: enqueue → claim(inflight) 상태로 프로세스가 죽었다고 가정
    ctx.store.enqueue({
      type: CHAT_JOB_TYPE,
      dedupKey: "slack:C1:100.5",
      lane: "interactive",
      laneKey: "C1:100.1",
      maxAttempts: 2,
      payload: chatPayload(),
    });
    const claimed = ctx.store.claimNext("interactive");
    expect(claimed?.status).toBe("inflight");

    const result = await ctx.recoverAndNotify();

    expect(result.requeued).toHaveLength(1);
    expect(result.exhausted).toHaveLength(0);
    expect(ctx.store.getByDedupKey("slack:C1:100.5")?.status).toBe("pending");

    const posts = callsOf(fake, "post");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C1");
    expect(posts[0]?.threadTs).toBe("100.1");
    expect(posts[0]?.text).toContain(RESTART_RETRY_NOTICE);
  });

  it("재시도 상한 소진 잡은 failed 종결 + 종결 안내 + ❌", async () => {
    const { ctx, fake } = setup();
    ctx.store.enqueue({
      type: CHAT_JOB_TYPE,
      dedupKey: "slack:C2:200.5",
      lane: "interactive",
      laneKey: "C2:200.1",
      maxAttempts: 1,
      payload: chatPayload({
        channel: "C2",
        ts: "200.5",
        threadTs: "200.1",
        threadKey: "C2:200.1",
      }),
    });
    ctx.store.claimNext("interactive"); // attempts=1 == maxAttempts

    const result = await ctx.recoverAndNotify();

    expect(result.requeued).toHaveLength(0);
    expect(result.exhausted).toHaveLength(1);
    expect(ctx.store.getByDedupKey("slack:C2:200.5")?.status).toBe("failed");

    const posts = callsOf(fake, "post");
    expect(posts[0]?.text).toContain(RESTART_EXHAUSTED_NOTICE);
    const adds = callsOf(fake, "addReaction");
    expect(adds.some((c) => c.name === "x" && c.ts === "200.5")).toBe(true);
  });

  it("안내 게시 실패는 복구를 막지 않는다 — pending 전환은 유지", async () => {
    const { ctx, fake, logs } = setup();
    fake.failPost.value = true;
    ctx.store.enqueue({
      type: CHAT_JOB_TYPE,
      dedupKey: "slack:C1:100.5",
      lane: "interactive",
      laneKey: "C1:100.1",
      maxAttempts: 2,
      payload: chatPayload(),
    });
    ctx.store.claimNext("interactive");

    const result = await ctx.recoverAndNotify();
    expect(result.requeued).toHaveLength(1);
    expect(ctx.store.getByDedupKey("slack:C1:100.5")?.status).toBe("pending");
    expect(logs.some((l) => l.includes("안내 실패"))).toBe(true);
  });

  it("chat 외 타입·payload 손상 잡은 안내 없이 로그만 남긴다", async () => {
    const { ctx, fake, logs } = setup();
    ctx.store.enqueue({
      type: CHAT_JOB_TYPE,
      dedupKey: "slack:C1:broken",
      lane: "interactive",
      maxAttempts: 2,
      payload: { schema_version: 99 },
    });
    ctx.store.claimNext("interactive");

    const result = await ctx.recoverAndNotify();
    expect(result.requeued).toHaveLength(1);
    expect(callsOf(fake, "post")).toHaveLength(0);
    expect(logs.some((l) => l.includes("payload 해석 불가"))).toBe(true);
  });

  it("복구된 pending 은 dispatcher.start() 가 즉시 집어간다 — 끝-끝 재실행", async () => {
    const db = openDatabase(":memory:");
    const fake = makeFakeSlack();
    const ctx = createAppContext({
      env: makeEnv(),
      slack: makeChatPort(fake),
      botUserId: "U0BOT",
      botId: "B0SELF",
      botTeamId: "T0TEAM",
      db,
      aclWatch: false,
      log: () => {},
      // 가짜 runner — 실제 SDK 없이 성공 결과를 돌려준다
      runSessionFn: (async () => ({
        text: "복구 후 답변",
        sessionId: "sess-r",
        usage: null,
        timedOut: null,
        aborted: false,
        isError: false,
      })) as unknown as typeof runSession,
    });
    ctx.store.enqueue({
      type: CHAT_JOB_TYPE,
      dedupKey: "slack:C1:100.5",
      lane: "interactive",
      laneKey: "C1:100.1",
      maxAttempts: 2,
      payload: chatPayload(),
    });
    ctx.store.claimNext("interactive");

    await ctx.recoverAndNotify();
    ctx.dispatcher.start();
    // 이벤트 없는 부팅 복구 경로 — start() 의 즉시 wakeAll 이 pending 을 집는다
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.dispatcher.stop();

    expect(ctx.store.getByDedupKey("slack:C1:100.5")?.status).toBe("done");
    expect(ctx.sessions.get("C1:100.1")?.sessionId).toBe("sess-r");
  });
});

describe("appendAllowedUser (SEC-19 /allow 경로)", () => {
  it("allowed 에 추가하고 중복은 no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "causeway-acl-"));
    const path = join(dir, "access.json");
    writeFileSync(path, JSON.stringify({ allowed: ["U1"], admins: ["UA"] }));

    appendAllowedUser(path, "U2");
    appendAllowedUser(path, "U2");
    appendAllowedUser(path, "UA"); // admin 은 이미 함의 — 추가 안 함

    const saved = JSON.parse(readFileSync(path, "utf8")) as { allowed: string[] };
    expect(saved.allowed).toEqual(["U1", "U2"]);
  });

  it("전원 허용('*') 중에는 개별 추가가 no-op — 파일을 건드리지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "causeway-acl-"));
    const path = join(dir, "access.json");
    const original = JSON.stringify({ allowed: ["*"], admins: ["UA"] });
    writeFileSync(path, original);

    appendAllowedUser(path, "U2");

    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("손상된 파일이면 throw — 조용한 초기화 금지", () => {
    const dir = mkdtempSync(join(tmpdir(), "causeway-acl-"));
    const path = join(dir, "access.json");
    writeFileSync(path, "{broken");
    expect(() => appendAllowedUser(path, "U2")).toThrow();
  });
});
