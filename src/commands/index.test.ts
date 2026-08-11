import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  type CommandDeps,
  createCommandExecutor,
  HELP_TEXT,
  isCommandText,
  parseCommand,
  parseUserToken,
} from "./index.js";

describe("parseCommand (순수 파서)", () => {
  it("알려진 커맨드를 파싱한다", () => {
    expect(parseCommand("/help")).toEqual({ kind: "help" });
    expect(parseCommand("/status")).toEqual({ kind: "status" });
    expect(parseCommand("/queue")).toEqual({ kind: "queue" });
    expect(parseCommand("/cancel")).toEqual({ kind: "cancel" });
    expect(parseCommand("/allow <@U123ABC>")).toEqual({ kind: "allow", userId: "U123ABC" });
  });

  it("대소문자·공백에 관대하다", () => {
    expect(parseCommand("  /HELP  ")).toEqual({ kind: "help" });
  });

  it("인자 없는 /allow 는 null 인자로 파싱된다", () => {
    expect(parseCommand("/allow")).toEqual({ kind: "allow", userId: null });
  });

  it("미확인 '/...' 토큰은 커맨드가 아니다 — 일상 입력('/path/to/file') 보호", () => {
    expect(parseCommand("/path/to/file 봐줘")).toBeNull();
    expect(parseCommand("/stauts")).toBeNull();
    expect(parseCommand("일반 텍스트")).toBeNull();
  });

  it("isCommandText 는 '/' 시작 여부만 본다", () => {
    expect(isCommandText("  /status")).toBe(true);
    expect(isCommandText("status")).toBe(false);
  });
});

describe("parseUserToken", () => {
  it("멘션·label·생 ID 전부 허용", () => {
    expect(parseUserToken("<@U123ABC>")).toBe("U123ABC");
    expect(parseUserToken("<@W123ABC|name>")).toBe("W123ABC");
    expect(parseUserToken("U123ABC")).toBe("U123ABC");
  });

  it("그 외 형태는 null", () => {
    expect(parseUserToken("@june")).toBeNull();
    expect(parseUserToken("<#C123>")).toBeNull();
  });
});

// ── 실행기 ──────────────────────────────────────────────────────────

interface Setup {
  deps: CommandDeps;
  replies: string[];
  cancelled: string[];
  allowed: string[];
}

function setup(overrides: Partial<CommandDeps> = {}): Setup {
  const replies: string[] = [];
  const cancelled: string[] = [];
  const allowed: string[] = [];
  const deps: CommandDeps = {
    isAdmin: (userId) => userId === "UADMIN",
    getSession: () => null,
    countJobs: () => ({ pending: 1, inflight: 2, done: 3, failed: 0, cancelled: 0 }),
    cancelThread: (threadKey) => {
      cancelled.push(threadKey);
      return threadKey === "C1:100.1";
    },
    allowUser: (userId) => {
      allowed.push(userId);
    },
    reply: async (_ctx, text) => {
      replies.push(text);
    },
    ...overrides,
  };
  return { deps, replies, cancelled, allowed };
}

const CTX: CommandContext = { channel: "C1", threadTs: "100.1", userId: "UADMIN" };

describe("createCommandExecutor", () => {
  it("커맨드 아닌 텍스트는 false — 호출측이 chat 잡으로 진행한다", async () => {
    const { deps, replies } = setup();
    const exec = createCommandExecutor(deps);
    expect(await exec.handle(CTX, "그냥 질문")).toBe(false);
    expect(await exec.handle(CTX, "/path/to/file 봐줘")).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it("/help — 도움말", async () => {
    const { deps, replies } = setup();
    expect(await createCommandExecutor(deps).handle(CTX, "/help")).toBe(true);
    expect(replies[0]).toBe(HELP_TEXT);
  });

  it("/status — 세션 유무 분기", async () => {
    const { deps, replies } = setup({
      getSession: (threadKey) =>
        threadKey === "C1:100.1" ? { sessionId: "sess-1", cwd: "/ws", lastSeenTs: "99.0" } : null,
    });
    const exec = createCommandExecutor(deps);
    await exec.handle(CTX, "/status");
    expect(replies[0]).toContain("sess-1");
    expect(replies[0]).toContain("/ws");
    expect(replies[0]).toContain("99.0");

    await exec.handle({ ...CTX, threadTs: "200.0" }, "/status");
    expect(replies[1]).toBe("세션 없음");
  });

  it("/queue — 상태별 카운트", async () => {
    const { deps, replies } = setup();
    await createCommandExecutor(deps).handle(CTX, "/queue");
    expect(replies[0]).toContain("pending 1");
    expect(replies[0]).toContain("inflight 2");
    expect(replies[0]).toContain("done 3");
  });

  it("/cancel — thread_key 로 취소 라우팅", async () => {
    const { deps, replies, cancelled } = setup();
    const exec = createCommandExecutor(deps);
    await exec.handle(CTX, "/cancel");
    expect(cancelled).toEqual(["C1:100.1"]);
    expect(replies[0]).toBe("취소 요청 보냄");

    await exec.handle({ ...CTX, threadTs: "999.9" }, "/cancel");
    expect(replies[1]).toBe("진행 중인 세션 없음");
  });

  it("/allow — admin 게이트 + 대상 파싱 + 실패 통보", async () => {
    const { deps, replies, allowed } = setup();
    const exec = createCommandExecutor(deps);

    await exec.handle({ ...CTX, userId: "UPLAIN" }, "/allow <@U1>");
    expect(replies[0]).toBe("admin 전용 커맨드입니다");

    await exec.handle(CTX, "/allow not-an-id");
    expect(replies[1]).toContain("사용자 ID 필요");

    await exec.handle(CTX, "/allow <@UNEWBIE>");
    expect(allowed).toEqual(["UNEWBIE"]);
    expect(replies[2]).toContain("UNEWBIE");
  });

  it("/allow — allowUser throw 는 실패 안내로 흡수된다", async () => {
    const { deps, replies } = setup({
      allowUser: () => {
        throw new Error("access.json 손상");
      },
    });
    await createCommandExecutor(deps).handle(CTX, "/allow <@U1>");
    expect(replies[0]).toContain("허용 실패");
  });
});
