/**
 * example_lookup — **도구 템플릿.** 동작하는 코드지만 registry 에 등록돼 있지 않아서
 * 세션에는 보이지 않는다. 복사해서 당신 조직의 도구로 고쳐 쓰라고 둔 파일이다.
 *
 * 등록하지 않은 채 두는 것이 의도다 — `registry.ts` 의 배열이 곧 노출 경계라(그 파일 주석),
 * 예시를 켜둔 채 배포하면 "예시가 들어 있는 봇"이 아니라 **쓸모없는 도구가 하나 열린 봇**이
 * 된다. 켜는 방법은 이 파일 맨 아래 주석에 세 줄로 적혀 있다.
 *
 * ── 이 파일이 보여주는 것 ────────────────────────────────────────────────────
 * ① **순수부/부작용부를 파일 안에서 물리적으로 가른다.** 가드·요청 조립·요약은 전부 순수
 *    함수여야 테스트가 계약을 붙잡는다. 부작용은 맨 아래 한 곳에만 있다.
 * ② **경계는 프롬프트가 아니라 입력 스키마다.** 이 도구에는 `method` 도 `body` 도 없다.
 *    "쓰기 하지 마"라고 적어두고 모델의 순응도에 맡기는 대신, 쓰기를 **표현할 수 없게** 만든다.
 * ③ **자격증명은 세션에 넘어가지 않는다.** 토큰은 deps 로 받아 이 프로세스 안에 머물고,
 *    세션은 결과 요약만 본다(`profiles.ts` 의 `SENSITIVE_ENV_PATTERNS` 가 세션 env 를
 *    스크럽하므로 세션이 같은 키를 직접 읽을 방법도 없다).
 * ④ **자른 것은 자랐다고 말한다.** 상한에 걸려 잘린 결과를 조용히 돌려주면, 세션은 그게
 *    전부인 줄 알고 단정적으로 답한다 — 침묵하는 절단이 틀린 답의 흔한 원인이다.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { maskSecrets } from "../security/maskSecrets.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 상수·스키마·요청 조립·요약
// ────────────────────────────────────────────────────────────────────

export const EXAMPLE_TOOL_NAME = "example_lookup";

/** 결과 본문 상한. 넘으면 잘라내되 **잘랐다는 사실을 결과에 적는다.** */
export const EXAMPLE_MAX_CHARS = 8_000;

/** 한 번에 가져올 최대 건수 — 상한을 스키마에 박아 모델이 넘길 수 없게 한다. */
export const EXAMPLE_MAX_LIMIT = 50;

export const exampleInputShape = {
  query: z.string().min(1).describe("찾을 대상 — 사용자가 말한 표현을 그대로 옮긴다"),
  limit: z
    .number()
    .int()
    .positive()
    .max(EXAMPLE_MAX_LIMIT)
    .optional()
    .describe(`가져올 건수 — 기본 10, 최대 ${EXAMPLE_MAX_LIMIT}`),
} as const;

export const exampleInputSchema = z.object(exampleInputShape);
export type ExampleInput = z.infer<typeof exampleInputSchema>;

/**
 * 조회 URL 조립 — **순수 함수라 테스트가 붙잡는다.**
 *
 * 쿼리를 문자열 이어붙이기로 만들지 않는 것은 취향이 아니다. 사용자가 말한 표현이 그대로
 * 들어오는 자리라 `&`·`=` 같은 글자가 섞이면 파라미터 경계가 밀린다.
 */
export function buildExampleUrl(baseUrl: string, input: ExampleInput): string {
  const url = new URL("/v1/search", baseUrl);
  url.searchParams.set("q", input.query);
  url.searchParams.set("limit", String(input.limit ?? 10));
  return url.toString();
}

/** 이 도구가 다루는 응답 모양. 실제 API 에 맞춰 갈아끼우는 자리다. */
export interface ExampleRecord {
  id: string;
  title: string;
  updatedAt: string;
}

/**
 * 응답 → 세션이 읽을 텍스트.
 *
 * 원본 JSON 을 그대로 넘기지 않는 것도 경계다. 외부 응답에는 세션이 알 이유가 없는 필드가
 * 섞여 오고, 그게 컨텍스트에 쌓이면 마스킹 대상이 늘기만 한다. **필요한 열만 요약한다.**
 */
export function formatExampleResult(
  records: readonly ExampleRecord[],
  input: ExampleInput,
): string {
  if (records.length === 0) return `\`${input.query}\` 에 해당하는 항목이 없습니다.`;

  const lines = records.map((r) => `- \`${r.id}\` ${r.title} (${r.updatedAt})`);
  const body = lines.join("\n");
  if (body.length <= EXAMPLE_MAX_CHARS) return body;

  const cut = body.slice(0, EXAMPLE_MAX_CHARS);
  return `${cut}\n\n…결과가 ${EXAMPLE_MAX_CHARS}자를 넘어 잘렸습니다. 조건을 좁혀 다시 물어보세요.`;
}

// ────────────────────────────────────────────────────────────────────
// 부작용부 — 여기서만 밖으로 나간다
// ────────────────────────────────────────────────────────────────────

export interface ExampleToolDeps {
  /** 외부 API 주소. */
  baseUrl: string;
  /** 자격증명 — **이 프로세스 밖으로 나가지 않는다.** */
  token: string;
  /** 테스트 주입용. 생략하면 전역 fetch. */
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

export function createExampleTool(deps: ExampleToolDeps) {
  const doFetch = deps.fetchFn ?? fetch;
  const log = deps.log ?? (() => {});

  return tool(
    EXAMPLE_TOOL_NAME,
    "조회 전용 — 외부 시스템에서 항목을 찾는다. 쓰기·삭제는 이 도구로 할 수 없다.",
    exampleInputShape,
    async (input: ExampleInput) => {
      try {
        const res = await doFetch(buildExampleUrl(deps.baseUrl, input), {
          headers: { authorization: `Bearer ${deps.token}` },
        });
        if (!res.ok) {
          // 상태 코드는 남기되 본문은 넘기지 않는다 — 에러 본문에 토큰이 되비치는 API 가 있다.
          log(`${EXAMPLE_TOOL_NAME} 실패 — HTTP ${res.status}`);
          return {
            content: [{ type: "text" as const, text: `조회 실패 — HTTP ${res.status}` }],
            isError: true,
          };
        }
        const records = (await res.json()) as ExampleRecord[];
        // 남의 시스템에서 온 문자열이라 마스킹을 통과시킨다 — 이 경로로 키가 실려오는 일이 실제로 있다.
        const text = maskSecrets(formatExampleResult(records, input));
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        log(`${EXAMPLE_TOOL_NAME} 예외 — ${String(err)}`);
        return {
          content: [{ type: "text" as const, text: "조회 중 오류가 발생했습니다." }],
          isError: true,
        };
      }
    },
  );
}

// ────────────────────────────────────────────────────────────────────
// 켜는 법 — 세 곳을 고친다 (docs/EXTENDING.md 참고)
// ────────────────────────────────────────────────────────────────────
//
// 1. `src/mcp/registry.ts`
//      import { createExampleTool, EXAMPLE_TOOL_NAME, type ExampleToolDeps } from "./example.js";
//      export const EXAMPLE_MCP_SERVER_NAME = "example";
//      export const EXAMPLE_ALLOWED_TOOL = `mcp__${EXAMPLE_MCP_SERVER_NAME}__${EXAMPLE_TOOL_NAME}`;
//      // McpToolDeps 에 `example?: ExampleToolDeps;` 추가하고 buildMcpRegistry 에:
//      if (deps.example) {
//        entries.push({
//          serverName: EXAMPLE_MCP_SERVER_NAME,
//          allowedTools: [EXAMPLE_ALLOWED_TOOL],
//          config: createSdkMcpServer({
//            name: EXAMPLE_MCP_SERVER_NAME,
//            version: "1.0.0",
//            tools: [createExampleTool(deps.example)],
//          }),
//        });
//      }
//
// 2. `src/context.ts` 의 `chatMcpToolsFor` 에 배선 조건을 넣는다. env 가 없으면 **도구를 빼고**
//    그 사실을 부팅 로그에 남긴다 — "도구가 왜 안 붙었나"의 답이 로그에 없으면 아무도 모른다:
//      const exampleToken = baseEnv.EXAMPLE_API_TOKEN;
//      log(exampleToken ? "example 배선" : "example 미배선 — EXAMPLE_API_TOKEN 없음");
//      // …buildMcpRegistry 인자에:
//      ...(exampleToken ? { example: { baseUrl: "https://api.example.com", token: exampleToken } } : {}),
//
// 3. `.env.example` 에 `EXAMPLE_API_TOKEN=` 을 문서와 함께 추가한다.
//
// `allowedTools` 를 빠뜨리면 서버는 붙는데 세션은 도구를 못 부른다 — **조용히 없는 상태**가
// 되므로, 배선을 바꾼 뒤에는 부팅 로그에서 그 줄을 눈으로 확인한다.
