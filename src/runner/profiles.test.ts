import { describe, expect, it } from "vitest";
import {
  buildAuxProfile,
  buildReadonlyProfile,
  DISALLOWED_SLACK_WRITE_TOOLS,
  SESSION_ALLOWED_TOOLS,
  scrubEnv,
} from "./profiles.js";

/**
 * 프로파일 전체-객체 스냅샷 (SEC-01~04, EG-01 [계약]).
 *
 * 이 테스트가 깨진다면 누군가 보안 경계를 옮긴 것이다 — 그 자체가 목적이다.
 * 정당한 변경이면 docs/ARCHITECTURE.md 의 보안 계약과 이 테스트를 같은 PR에서 고쳐라.
 */

// 민감/비민감이 섞인 대표 baseEnv — process.env 의존을 끊고 결정론적으로 검증한다
const BASE_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/bot",
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  SLACK_BOT_TOKEN: "xoxb-secret",
  SLACK_APP_TOKEN: "xapp-secret",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  DATADOG_API_KEY: "dd-secret",
  DD_APP_KEY: "dd-app-secret",
  GITHUB_TOKEN: "ghp-secret",
  GH_TOKEN: "gh-secret",
  CAUSEWAY_NOTIFY_TOKEN: "notify-secret",
  CAUSEWAY_REFERENCE_DIRS: "/srv/monorepo",
  NODE_ENV: "test",
  EMPTYISH: undefined,
} satisfies Record<string, string | undefined>;

const EXPECTED_SCRUBBED = [
  "AWS_SECRET_ACCESS_KEY",
  "CAUSEWAY_NOTIFY_TOKEN",
  "DATADOG_API_KEY",
  "DD_APP_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
];

// 스크럽 후 남아야 하는 공통 env — ANTHROPIC 키는 SDK 인증에 필요해 보존된다
const CLEAN_ENV = {
  PATH: "/usr/bin",
  HOME: "/Users/bot",
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  // 봇 비밀 패턴(`^CAUSEWAY_.*_(API_KEY|TOKEN|SECRET)$`)은 이름이 비슷한 **경로** 변수까지
  // 걷어내면 안 된다 — 세션은 이 경로로 참조 레포 소스를 읽는다.
  CAUSEWAY_REFERENCE_DIRS: "/srv/monorepo",
  NODE_ENV: "test",
};

describe("scrubEnv (SEC-04)", () => {
  it("민감 패턴 제거 + undefined 제거 + 보존 목록 반환", () => {
    const { env, scrubbedKeys } = scrubEnv(BASE_ENV);
    expect(env).toEqual(CLEAN_ENV);
    expect(scrubbedKeys).toEqual(EXPECTED_SCRUBBED);
  });

  it("preserveKeys 로 지정한 키만 되살아난다", () => {
    const { env } = scrubEnv(BASE_ENV, ["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("ghp-secret");
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
  });
});

describe("READONLY 프로파일 (SEC-01)", () => {
  it("전체 옵션 스냅샷 — Edit/Write disallow 우선 + 화이트리스트 + resume 허용", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV);
    expect(profile).toEqual({
      kind: "READONLY",
      allowResume: true,
      scrubbedEnvKeys: EXPECTED_SCRUBBED,
      options: {
        cwd: "/srv/workspace",
        model: "claude-opus-5",
        // 호스트 ~/.claude 설정·프로젝트 CLAUDE.md·.claude/skills 를 **상속한다** —
        // "Claude Code 와 답이 같아야 한다"가 요구사항이고, 그 규칙들이 답을 만든다.
        settingSources: ["user", "project", "local"],
        permissionMode: "dontAsk",
        allowedTools: [
          "Read",
          "Glob",
          "Grep",
          "Edit",
          "Write",
          "NotebookEdit",
          "Bash",
          "WebSearch",
          "WebFetch",
          "Task",
          "TodoWrite",
        ],
        // 남는 disallow 는 Slack 쓰기뿐 — 능력 제한이 아니라 게시 경로 일원화다(EG-01).
        disallowedTools: [...DISALLOWED_SLACK_WRITE_TOOLS],
        env: CLEAN_ENV,
      },
    });
  });

  it("웹 조회 도구가 화이트리스트에 있다 — 요구사항에 명시된 항목이다", () => {
    expect(SESSION_ALLOWED_TOOLS).toContain("WebSearch");
    expect(SESSION_ALLOWED_TOOLS).toContain("WebFetch");
  });

  it("Bash 는 접두 제한 없이 허용된다 — git 조회만 열던 제약의 해제", () => {
    expect(SESSION_ALLOWED_TOOLS).toContain("Bash");
    expect(SESSION_ALLOWED_TOOLS.some((t) => t.startsWith("Bash("))).toBe(false);
  });

  it("호스트 설정을 상속한다 — CLAUDE.md·스킬이 없으면 Claude Code 와 답이 갈린다", () => {
    // 조회 전용 봇은 `settingSources: []` 로 상속을 끊는다. 그때는 화이트리스트가 권한 모델의
    // 본체라 호스트 permissions.allow(`Bash(*)`)의 유입이 곧 권한 상승이었기 때문이다.
    // 지금은 화이트리스트가 이미 전 도구를 열었으므로 그 경로로 늘어날 권한이 없고, 경계는
    // access.json 의 allowed(=누가 부를 수 있는가)로 옮겨졌다.
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV);
    expect(profile.options.settingSources).toEqual(["user", "project", "local"]);
  });

  it("mcpTools 미지정 시 mcpServers 옵션이 아예 없다 (도구 없음 = 명시적 부재)", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV);
    expect(profile.options.mcpServers).toBeUndefined();
    expect(profile.options.allowedTools).not.toContain("mcp__mytool__mytool_query");
  });
});

describe("READONLY 프로파일 — in-process MCP 배선 (예시 도구)", () => {
  // 결정론적 가짜 manifest — createSdkMcpServer 의 live instance 대신 구조만 검증한다
  // (instance 는 비직렬화라 toEqual 스냅샷이 불가능하므로 배선 형태를 명시 단언한다).
  const FAKE_ENTRY = {
    serverName: "mytool",
    allowedTools: ["mcp__mytool__mytool_query"],
    config: { type: "sdk" as const, name: "mytool", instance: {} as never },
  };

  it("mcpTools 를 넘기면 mcpServers 에 서버가, allowedTools 에 mcp 도구가 실린다", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [FAKE_ENTRY]);
    expect(profile.options.mcpServers).toEqual({ mytool: FAKE_ENTRY.config });
    expect(profile.options.allowedTools).toContain("mcp__mytool__mytool_query");
    // 기존 READONLY 화이트리스트는 그대로 유지된다(도구 추가지 교체가 아니다)
    expect(profile.options.allowedTools).toEqual([
      ...SESSION_ALLOWED_TOOLS,
      "mcp__mytool__mytool_query",
    ]);
  });

  it("MCP 배선이 붙어도 Slack 쓰기 봉인은 불변이다", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [FAKE_ENTRY]);
    // Edit/Write 는 이제 허용된다 — 남는 disallow 는 Slack 쓰기뿐이다.
    expect(profile.options.allowedTools).toContain("Edit");
    expect(profile.options.allowedTools).toContain("Write");
    for (const slackTool of DISALLOWED_SLACK_WRITE_TOOLS) {
      expect(profile.options.disallowedTools).toContain(slackTool);
      expect(profile.options.allowedTools).not.toContain(slackTool);
    }
    // 도구 자격증명은 여전히 세션 env 에서 스크럽된다(도구만 봇 프로세스 키를 만진다)
    expect(profile.options.env?.SLACK_BOT_TOKEN).toBeUndefined();
  });
});

describe("READONLY 프로파일 — cwd 밖 읽기 전용 확장 (additionalDirectories)", () => {
  const SRC = "/srv/your-repo";

  it("미지정이면 옵션 자체가 없다 — cwd 밖 읽기를 의도하지 않았다는 표시", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV);
    expect(profile.options.additionalDirectories).toBeUndefined();
  });

  it("빈 배열도 부재로 취급한다 (배선 게이트 off 와 형태가 같아야 한다)", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [], []);
    expect(profile.options.additionalDirectories).toBeUndefined();
  });

  it("경로를 넘기면 실리되 도구 목록은 그대로다 — 경로 확장이지 권한 확장이 아니다", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [], [SRC]);
    expect(profile.options.additionalDirectories).toEqual([SRC]);
    expect(profile.options.cwd).toBe("/srv/workspace");
    // Read/Glob/Grep + git 조회 화이트리스트가 한 항목도 늘지 않아야 한다
    expect(profile.options.allowedTools).toEqual([...SESSION_ALLOWED_TOOLS]);
  });

  it("확장 경로가 있어도 Slack 쓰기 봉인은 불변이다", () => {
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [], [SRC]);
    for (const tool of DISALLOWED_SLACK_WRITE_TOOLS) {
      expect(profile.options.disallowedTools).toContain(tool);
    }
  });

  it("호출자가 넘긴 배열을 복사한다 — 프로파일이 외부 배열 변형에 흔들리면 안 된다", () => {
    const dirs = [SRC];
    const profile = buildReadonlyProfile("/srv/workspace", BASE_ENV, "claude-opus-5", [], dirs);
    dirs.push("/etc");
    expect(profile.options.additionalDirectories).toEqual([SRC]);
  });
});

describe("AUX 프로파일 (SEC-03)", () => {
  it("전체 옵션 스냅샷 — tools:[] 실제 봉인 (allowedTools:[] 는 no-op footgun)", () => {
    const profile = buildAuxProfile(BASE_ENV);
    expect(profile).toEqual({
      kind: "AUX",
      allowResume: false,
      scrubbedEnvKeys: EXPECTED_SCRUBBED,
      options: {
        tools: [],
        model: "claude-opus-5",
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true,
        permissionMode: "dontAsk",
        disallowedTools: [...DISALLOWED_SLACK_WRITE_TOOLS],
        env: CLEAN_ENV,
      },
    });
  });

  it("봉인 수단이 tools 인지 명시 검증 — allowedTools 로 바뀌면 봉인이 사라진다", () => {
    const profile = buildAuxProfile(BASE_ENV);
    expect(profile.options.tools).toEqual([]);
    expect(profile.options.allowedTools).toBeUndefined();
  });
});

describe("공통 경계 (EG-01)", () => {
  it("어떤 프로파일에도 Slack 쓰기 도구가 허용 목록에 없고 disallow 에는 있다", () => {
    const profiles = [buildReadonlyProfile("/srv/workspace", BASE_ENV), buildAuxProfile(BASE_ENV)];
    for (const profile of profiles) {
      const allowed = profile.options.allowedTools ?? [];
      const tools = Array.isArray(profile.options.tools) ? profile.options.tools : [];
      for (const slackTool of DISALLOWED_SLACK_WRITE_TOOLS) {
        expect(allowed).not.toContain(slackTool);
        expect(tools).not.toContain(slackTool);
        expect(profile.options.disallowedTools).toContain(slackTool);
      }
    }
  });
});
