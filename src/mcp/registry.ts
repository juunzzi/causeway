/**
 * 세션에 붙일 MCP 도구 조립 — **명시 등록 배열이 곧 노출 경계다.**
 *
 * glob 자동발견을 쓰지 않는 이유: 파일을 하나 추가했다는 이유만으로 세션 권한이 넓어지면,
 * 그 변경이 diff 에서 "새 파일 하나"로만 보인다. 여기 한 줄을 더하게 만들면 리뷰어가
 * **무엇이 열렸는지** 를 반드시 보게 된다.
 *
 * ── 도구를 붙이는 세 가지 방식 ────────────────────────────────────────────────
 * 1. **in-process** (`createSdkMcpServer`) — 이 프로세스 안에서 도는 도구. 자격증명이 세션
 *    env 에 노출되지 않아야 할 때 이걸 쓴다(`profiles.ts` 의 `SENSITIVE_ENV_PATTERNS` 가 세션
 *    env 를 스크럽하므로, 세션은 키를 볼 수 없고 도구가 대신 호출해 **요약만** 돌려준다).
 * 2. **stdio** — 외부 CLI 를 MCP 서버로 띄운다. 명령 경로를 절대경로로 고정하는 편이 안전하다
 *    (PATH 는 PM2/셸에 따라 달라진다).
 * 3. **원격 HTTP** — 외부 MCP 엔드포인트. 인증은 보통 호스트 OAuth 에 위임된다.
 *
 * 어느 방식이든 `allowedTools` 에 `mcp__<서버명>__<도구명>` 을 정확히 넣어야 세션이 부를 수
 * 있다. 서버만 붙이고 allowedTools 를 빠뜨리면 **도구가 조용히 없는 상태**가 된다.
 */

import {
  createSdkMcpServer,
  type McpServerConfig,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { createSlackReadTool, SLACK_READ_TOOL_NAME, type SlackReadToolDeps } from "./slackRead.js";

/**
 * Slack 메시지 링크 조회 — **읽기 전용**. 서버 이름을 `slack` 으로 두는 것은 의도적이다:
 * `DISALLOWED_SLACK_WRITE_TOOLS`(profiles.ts)가 이미 `mcp__slack__slack_send_message` 계열을
 * 봉인하고 있고, disallow 가 allow 보다 우선하므로(SDK 계약) 이 서버에 쓰기 도구가 실수로
 * 얹히더라도 세션은 부를 수 없다. 게시는 계속 egress 일원화다.
 */
export const SLACK_MCP_SERVER_NAME = "slack";

/** 세션 allowedTools 에 넣을 완전한 도구 식별자. SDK 규약: `mcp__<서버명>__<도구명>`. */
export const SLACK_READ_ALLOWED_TOOL = `mcp__${SLACK_MCP_SERVER_NAME}__${SLACK_READ_TOOL_NAME}`;

/**
 * 한 서버의 배선 한 벌.
 *
 * ⚠️ **config 는 팩토리가 세션마다 새로 만든다.** 부팅 때 만든 in-process 인스턴스 하나를
 * 여러 세션이 공유하면, 세션이 겹치는 순간(스레드 두 개가 동시에 도는 것은 일상이다) 나중
 * 세션의 connect 가 `Already connected to a transport` 로 실패한다. 그리고 SDK 는 그 실패를
 * debug 로그로 삼킨 채 **그 서버만 조용히 뺀다** — 세션은 에러 없이 도구를 잃는다.
 */
export interface McpToolEntry {
  serverName: string;
  allowedTools: string[];
  config: ReturnType<typeof createSdkMcpServer>;
}

/**
 * 세션 1개분 manifest 를 **그 자리에서 새로 조립하는** 팩토리 — 잡 deps 가 배열 대신 이걸 받는다.
 * 이유는 McpToolEntry 주석의 `Already connected` 그대로다.
 */
export type McpToolFactory = () => readonly McpToolEntry[];

export interface McpToolDeps {
  /** 붙여넣은 Slack 링크 읽기. 봇이 멤버인 대화만 보인다 — 그 초대가 곧 범위 선언이다. */
  slackRead?: SlackReadToolDeps;
}

/**
 * 요청 맥락에 맞는 도구 묶음을 조립한다.
 *
 * **세션마다 호출한다**(부팅 때 한 번이 아니다) — 위 `McpToolEntry` 주석의 이유. 그리고
 * 요청자에 따라 도구 구성을 달리하고 싶을 때(예: 관리자에게만 쓰기 도구) 그 분기가 자연스럽게
 * 여기 들어온다.
 */
export function buildMcpRegistry(deps: McpToolDeps): McpToolEntry[] {
  const entries: McpToolEntry[] = [];

  if (deps.slackRead) {
    entries.push({
      serverName: SLACK_MCP_SERVER_NAME,
      allowedTools: [SLACK_READ_ALLOWED_TOOL],
      config: createSdkMcpServer({
        name: SLACK_MCP_SERVER_NAME,
        version: "1.0.0",
        tools: [createSlackReadTool(deps.slackRead)],
      }),
    });
  }

  // 새 도구는 여기에 블록을 하나 더한다:
  //   1. `src/mcp/<도구>.ts` 에 `create<도구>Tool` + `<도구>ToolDeps` 를 만들고
  //   2. 위 `McpToolDeps` 에 선택 필드를 추가한 뒤
  //   3. 여기에 `if (deps.<도구>) entries.push({ … })` 를 더한다.
  // 배선 조건(env 유무 등)은 `context.ts` 가 판단해 deps 를 채울지 말지로 표현한다 —
  // **부팅 로그에 배선/미배선이 한 줄씩 남는 것이 그 판단의 유일한 증거**다.

  return entries;
}

/** manifest → query() mcpServers 레코드(서버명 → config). 세션 프로파일 배선에 쓴다. */
export function toMcpServersOption(entries: readonly McpToolEntry[]): Options["mcpServers"] {
  const record: Record<string, McpServerConfig> = {};
  for (const entry of entries) {
    record[entry.serverName] = entry.config;
  }
  return record;
}

/** manifest → allowedTools 배열(중복 제거 없이 그대로 이어붙인다 — 서버명이 다르면 충돌 없다). */
export function toAllowedTools(entries: readonly McpToolEntry[]): string[] {
  return entries.flatMap((e) => [...e.allowedTools]);
}
