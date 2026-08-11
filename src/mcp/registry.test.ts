import { describe, expect, it } from "vitest";
import {
  buildMcpRegistry,
  SLACK_MCP_SERVER_NAME,
  SLACK_READ_ALLOWED_TOOL,
  toAllowedTools,
  toMcpServersOption,
} from "./registry.js";
import type { SlackReadToolDeps } from "./slackRead.js";

/**
 * 등록 [계약] — 이 배열이 곧 **세션 노출 경계**다. 두 가지를 고정한다:
 * ① deps 를 안 주면 그 도구는 붙지 않는다(기본 off).
 * ② config 는 호출마다 새 인스턴스다 — 공유하면 세션이 겹칠 때 SDK 가 그 서버만 조용히 뺀다.
 */

const slackReadDeps = (): SlackReadToolDeps => ({
  requester: { userId: "U1", channel: "C1", threadTs: "1.1" },
  fetchChannelInfo: async () => null,
  isChannelMember: async () => true,
  fetchThreadMessages: async () => [],
  resolveNames: async () => new Map<string, string>(),
});

describe("buildMcpRegistry", () => {
  it("deps 를 안 주면 아무 도구도 붙지 않는다 — 기본 off", () => {
    expect(buildMcpRegistry({})).toEqual([]);
  });

  it("slackRead deps 를 주면 서버 하나와 허용 도구 하나가 생긴다", () => {
    const entries = buildMcpRegistry({ slackRead: slackReadDeps() });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.serverName).toBe(SLACK_MCP_SERVER_NAME);
    expect(entries[0]?.allowedTools).toEqual([SLACK_READ_ALLOWED_TOOL]);
  });

  /**
   * 부팅 때 만든 in-process 인스턴스를 여러 세션이 공유하면, 겹치는 순간 나중 세션의 connect 가
   * `Already connected to a transport` 로 실패한다. SDK 는 그걸 debug 로그로 삼키고 **그 서버만
   * 조용히 빼므로**, 세션은 에러 없이 도구를 잃는다. 그래서 호출마다 새 인스턴스여야 한다.
   */
  it("호출마다 새 config 인스턴스를 만든다 — 세션이 겹쳐도 도구가 살아 있게", () => {
    const a = buildMcpRegistry({ slackRead: slackReadDeps() });
    const b = buildMcpRegistry({ slackRead: slackReadDeps() });
    expect(a[0]?.config).not.toBe(b[0]?.config);
  });
});

describe("toAllowedTools / toMcpServersOption", () => {
  it("허용 도구 식별자는 mcp__<서버명>__<도구명> 규약을 따른다", () => {
    expect(SLACK_READ_ALLOWED_TOOL.startsWith(`mcp__${SLACK_MCP_SERVER_NAME}__`)).toBe(true);
  });

  it("엔트리들의 allowedTools 를 평탄화한다", () => {
    const entries = buildMcpRegistry({ slackRead: slackReadDeps() });
    expect(toAllowedTools(entries)).toEqual([SLACK_READ_ALLOWED_TOOL]);
    expect(toAllowedTools([])).toEqual([]);
  });

  it("서버명 → config 레코드로 뒤집는다", () => {
    const entries = buildMcpRegistry({ slackRead: slackReadDeps() });
    const servers = toMcpServersOption(entries);
    expect(Object.keys(servers ?? {})).toEqual([SLACK_MCP_SERVER_NAME]);
  });
});
