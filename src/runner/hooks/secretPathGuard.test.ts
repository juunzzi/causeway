import type { PreToolUseHookInput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  createSecretPathGuardHook,
  decideSecretPath,
  extractPathTokens,
  isSecretLexicalPath,
  normalizeLexicalPath,
  type SecretPathGuardFrictionEvent,
  secretPathGuardMatcher,
} from "./secretPathGuard.js";

/** SEC-09 [단위] — lexical 우회 시도 + symlink(realpath) 우회 픽스처. */

const HOME = "/Users/bot";
// 존재하지 않는 경로 취급 — realpath 층을 통과시키고 lexical 층만 검증
const noRealpath = () => null;

describe("normalizeLexicalPath", () => {
  it("~ 확장 + .. 정규화", () => {
    expect(normalizeLexicalPath("~/.ssh/id_rsa", HOME)).toBe("/Users/bot/.ssh/id_rsa");
    expect(normalizeLexicalPath("/repo/sub/../.env", HOME)).toBe("/repo/.env");
    expect(normalizeLexicalPath("~", HOME)).toBe("/Users/bot");
  });
});

describe("isSecretLexicalPath", () => {
  const SECRET = [
    "/repo/.env",
    "/repo/.env.local",
    "/repo/.env.production",
    "/Users/bot/.ssh/id_rsa",
    "/Users/bot/.ssh",
    "/Users/bot/.aws/credentials",
    "/Users/bot/.netrc",
    "/Users/bot/.databrickscfg",
    "/Users/bot/.config/gh/hosts.yml",
    "/srv/bridge/config/allowlist.json",
  ];
  const SAFE = [
    "/repo/.env.example",
    "/repo/.env.sample",
    "/repo/src/index.ts",
    "/repo/environment.ts",
    "/repo/docs/ssh-guide.md",
    "/repo/aws-utils/index.ts",
  ];

  it.each(SECRET.map((p) => [p]))("secret: %s", (p) => {
    expect(isSecretLexicalPath(p)).toBe(true);
  });
  it.each(SAFE.map((p) => [p]))("safe: %s", (p) => {
    expect(isSecretLexicalPath(p)).toBe(false);
  });
});

describe("decideSecretPath — 이중 검사", () => {
  it("lexical 우회 시도(.. 경유)를 정규화가 잡는다", () => {
    const decision = decideSecretPath("/repo/src/../../repo/.env", {
      home: HOME,
      realpath: noRealpath,
    });
    expect(decision.action).toBe("deny");
  });

  it("무해한 lexical 경로라도 realpath 실체가 시크릿이면 deny (symlink 탈출 차단)", () => {
    const decision = decideSecretPath("/tmp/innocent.txt", {
      home: HOME,
      realpath: () => "/Users/bot/.ssh/id_rsa",
    });
    expect(decision.action).toBe("deny");
  });

  it("realpath 가 무해하면 allow", () => {
    const decision = decideSecretPath("/repo/src/index.ts", {
      home: HOME,
      realpath: () => "/repo/src/index.ts",
    });
    expect(decision.action).toBe("allow");
  });

  it("봇 private 데이터 prefix (DB/WAL 등) 접근 deny", () => {
    const deps = {
      home: HOME,
      realpath: noRealpath,
      extraDenyPrefixes: ["/srv/mybot/data"],
    };
    expect(decideSecretPath("/srv/mybot/data/mybot.db", deps).action).toBe("deny");
    expect(decideSecretPath("/srv/mybot/data/mybot.db-wal", deps).action).toBe("deny");
    // prefix 이름만 비슷한 형제 디렉토리는 통과해야 한다 (startsWith 문자열 비교의 함정)
    expect(decideSecretPath("/srv/mybot/data-public/readme.md", deps).action).toBe("allow");
  });

  it("symlink 로 private prefix 를 빠져나가려는 시도도 realpath 층이 잡는다", () => {
    const decision = decideSecretPath("/tmp/link.db", {
      home: HOME,
      realpath: () => "/srv/mybot/data/mybot.db",
      extraDenyPrefixes: ["/srv/mybot/data"],
    });
    expect(decision.action).toBe("deny");
  });
});

describe("extractPathTokens", () => {
  it("경로형 토큰만 추출한다 (플래그·일반 단어 제외)", () => {
    expect(extractPathTokens("cat -n ~/.ssh/id_rsa && echo done")).toEqual(["~/.ssh/id_rsa"]);
    expect(extractPathTokens('grep "x" src/index.ts | head')).toEqual(["src/index.ts"]);
    expect(extractPathTokens("cat .env")).toEqual([".env"]);
  });
});

function preToolUseInput(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "tu_1",
    session_id: "s_1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
  };
}

const HOOK_OPTS = { signal: new AbortController().signal };

describe("createSecretPathGuardHook 어댑터", () => {
  const deps = { home: HOME, realpath: noRealpath };

  it("Read 의 file_path 시크릿 접근을 deny 한다", async () => {
    const hook = createSecretPathGuardHook(deps);
    const out = (await hook(
      preToolUseInput("Read", { file_path: "/repo/.env" }),
      "tu_1",
      HOOK_OPTS,
    )) as SyncHookJSONOutput;
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  });

  it("Grep/Glob 의 path 시크릿 접근을 deny 한다 — matcher 가 Read|Bash 뿐이던 갭의 회귀 방지", async () => {
    const hook = createSecretPathGuardHook(deps);
    const grepOut = (await hook(
      preToolUseInput("Grep", { pattern: "password", path: "/repo/.env" }),
      "tu_1",
      HOOK_OPTS,
    )) as SyncHookJSONOutput;
    expect(grepOut.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });

    const globOut = (await hook(
      preToolUseInput("Glob", { pattern: "*", path: "/Users/bot/.ssh" }),
      "tu_1",
      HOOK_OPTS,
    )) as SyncHookJSONOutput;
    expect(globOut.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  });

  it("Grep/Glob 의 path 생략(cwd 검색)은 통과한다", async () => {
    const hook = createSecretPathGuardHook(deps);
    expect(await hook(preToolUseInput("Grep", { pattern: "TODO" }), "tu_1", HOOK_OPTS)).toEqual({
      continue: true,
    });
    expect(await hook(preToolUseInput("Glob", { pattern: "**/*.ts" }), "tu_1", HOOK_OPTS)).toEqual({
      continue: true,
    });
  });

  it("Bash 명령 안의 시크릿 경로 토큰을 deny 한다", async () => {
    const hook = createSecretPathGuardHook(deps);
    const out = (await hook(
      preToolUseInput("Bash", { command: "head -3 ~/.aws/credentials" }),
      "tu_1",
      HOOK_OPTS,
    )) as SyncHookJSONOutput;
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
  });

  it("무해한 Read/Bash 는 통과한다", async () => {
    const hook = createSecretPathGuardHook(deps);
    expect(
      await hook(preToolUseInput("Read", { file_path: "/repo/src/index.ts" }), "tu_1", HOOK_OPTS),
    ).toEqual({ continue: true });
    expect(
      await hook(preToolUseInput("Bash", { command: "pnpm test" }), "tu_1", HOOK_OPTS),
    ).toEqual({ continue: true });
  });

  it("훅 내부 예외 시 allow (fail-open) + friction 기록", async () => {
    const friction: SecretPathGuardFrictionEvent[] = [];
    const hook = createSecretPathGuardHook({
      home: HOME,
      realpath: () => {
        throw new Error("fs exploded");
      },
      onFriction: (event) => friction.push(event),
    });
    const out = (await hook(
      preToolUseInput("Read", { file_path: "/repo/src/index.ts" }),
      "tu_1",
      HOOK_OPTS,
    )) as SyncHookJSONOutput;
    expect(out).toEqual({ continue: true });
    expect(friction).toHaveLength(1);
    expect(friction[0]?.kind).toBe("secret-path-guard-error");
  });
});

describe("secretPathGuardMatcher", () => {
  it("Read|Glob|Grep|Bash 를 매칭 — Grep 이 사거리 밖이던 갭의 회귀 방지", () => {
    expect(secretPathGuardMatcher().matcher).toBe("Read|Glob|Grep|Bash");
  });
});
