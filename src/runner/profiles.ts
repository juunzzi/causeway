/**
 * 세션 격리 프로파일 2종 — 순수 계약 함수 (SEC-01~04, EG-01).
 *
 * 이 파일의 반환값은 runner.ts(유일한 세션 스폰 지점)가 그대로 query() 옵션으로 쓴다.
 * 보안 경계가 리팩토링으로 침식되는 것을 profiles.test.ts 의 전체-객체 스냅샷이 막는다 —
 * 값 하나를 바꾸려면 테스트와 이 파일을 같은 PR에서 함께 고쳐야 한다(의도된 마찰).
 *
 * hooks(bashGuard/secretPathGuard)는 여기 넣지 않는다: 훅은 콜백(비직렬화)이라 스냅샷
 * 검증이 불가능해지고, friction 기록 의존성 주입이 필요하므로 runSession 이 스폰 시
 * 프로파일과 무관하게 무조건 부착한다(withGuardHooks — 호출자가 빠뜨릴 수 없다).
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { type McpToolEntry, toAllowedTools, toMcpServersOption } from "../mcp/registry.js";

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────────────

/**
 * 프로파일 2종 — causeway 은 **조회 전용 봇**이라 쓰기 세션(WRITE_PR)이 없다.
 *
 * fresh worktree 에서 코드를 고쳐 PR 을 여는 WRITE_PR(bypassPermissions + 무제한 Bash +
 * GITHUB_TOKEN 주입) 같은 프로파일은 두지 않는다 — 그 잡 자체가 없기 때문이다 — 아무도 부르지 않는 bypassPermissions 빌더가 코드에 남아 있는 것은
 * 다음 사람에게 "여기 쓰면 된다"는 초대장이다.
 */
export type ProfileKind = "READONLY" | "AUX";

/**
 * 기본 모델 — 대화·분석 세션이 명시 override 없을 때 사용한다.
 * SDK query() 의 model 옵션으로 그대로 전달된다. /model 스레드 override 는 이 값을 대체한다.
 *
 * 팀 공용 봇이라면 비용을 이유로 더 작은 모델을 기본으로 둘 수 있다. 여기서는
 * "슬랙에서 묻는 것과 Claude Code 에서 묻는 것의 답이 달라선 안 된다"가 요구사항이라
 * 사용자가 실제로 쓰는 모델(opus)에 맞춘다. 답의 질이 갈리면 사람이 결국 두 번 묻게 되고,
 * 그러면 봇을 쓰는 이유가 사라진다.
 */
export const DEFAULT_MODEL = "claude-opus-5";

export interface RunnerProfile {
  kind: ProfileKind;
  /**
   * resume 허용 여부 — runner 는 이 값이 true 인 프로파일에만 resume 옵션을 부착할 수 있다.
   * AUX 가 false 인 이유: 단발 분류/요약 run 이 과거 대화 컨텍스트를 물려받으면 격리 계약
   * (SEC-02)이 깨진다.
   */
  allowResume: boolean;
  /** query() 에 그대로 전달되는 직렬화 가능 옵션. */
  options: Options;
  /** baseEnv 에서 제거된 민감 키 목록 — 스크럽이 실제로 일어났는지 테스트가 검증할 근거. */
  scrubbedEnvKeys: readonly string[];
}

/**
 * 세션 env 에서 제거할 민감 자격증명 패턴 (SEC-04).
 * ANTHROPIC_* 은 SDK 자체 인증에 필요하므로 제거 대상이 아니다.
 * GITHUB/GH 토큰은 무조건 제거 — 이 봇에는 되살릴 쓰기 세션이 없다.
 */
export const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /^SLACK_/,
  /^AWS_/,
  /^DATADOG_/,
  /^DD_/,
  /^GITHUB_TOKEN$/,
  /^GH_TOKEN$/,
  /^GITHUB_PAT$/,
  /^NOTION_/,
  /^OPENAI_/,
  // 이 봇의 4대 도구가 만지는 자격증명 — 전부 in-process 도구가 봇 프로세스 안에서만 쓰고
  // 세션에는 결과만 준다. 세션이 키를 보면 도구를 우회해 직접 호출할 수 있으므로(그 순간
  // 도구에 박아 둔 GET 고정·SELECT 전용 가드가 전부 무의미해진다) 이름으로 걷어낸다.
  // 봇 자신의 자격증명. 접두를 `CAUSEWAY_` 로 묶는 이유는 `_API_KEY$` 만으로는
  // **ANTHROPIC_API_KEY 까지 걷어내 세션 인증이 죽기** 때문이다(CLEAN_ENV 가 그걸 보존한다).
  // 값이 아니라 이름으로 거르는 층이라, 새 비밀을 들일 때 이름을 여기에 맞추는 게 규약이다.
  /^CAUSEWAY_.*_(API_KEY|TOKEN|SECRET)$/,
];

/**
 * Slack 쓰기 도구는 어떤 프로파일에도 주지 않는다 (EG-01) — 게시는 egress 일원화.
 * 병렬 세션이 타 스레드 thread_ts 로 오발송한 실사고(선행 구현 disallow 목록)의 이식.
 * tools 축소가 1차 방어지만, MCP 서버가 붙는 경우를 대비해 disallow 로도 이중 봉인한다.
 */
export const DISALLOWED_SLACK_WRITE_TOOLS: readonly string[] = [
  "mcp__slack__slack_send_message",
  "mcp__slack__slack_send_message_draft",
  "mcp__slack__slack_schedule_message",
  "mcp__slack__slack_reply_to_thread",
  "mcp__slack__slack_post_message",
  "mcp__slack__slack_update_message",
  "mcp__slack__slack_delete_message",
  "mcp__slack__slack_create_canvas",
  "mcp__slack__slack_update_canvas",
];

/**
 * 세션 도구 화이트리스트 — **Claude Code 와 같은 폭**을 목표로 한다.
 *
 * 조회 전용 봇이라면 Read/Glob/Grep + git 조회 접두로 닫을 수도 있다. 하지만 이 봇의 요구사항은
 * "슬랙에서 묻는 것과 Claude Code 에서 묻는 것의 차이가 없어야 한다"이다. 도구가 좁으면 답이
 * 갈리고, 답이 갈리면 사람이 결국 두 번 묻게 되어 봇을 쓸 이유가 사라진다.
 *
 * 그래서 좁히는 대신 **누가 부를 수 있는가**로 경계를 옮겼다 — `config/access.json` 의 allowed 다.
 * 이 목록이 넓어지면(예: `"*"`) 워크스페이스 전원이 이 호스트에서 임의 명령을 돌릴 수 있다는
 * 뜻이므로, 도구를 여는 변경과 allowed 를 좁히는 변경은 **같은 PR 에서 함께** 간다.
 *
 * `permissionMode: "dontAsk"` 는 그대로 둔다 — headless 에서 ask 는 곧 hang 이고, 여기 나열되지
 * 않은 것은 즉시 거부된다. 즉 "무엇이 노출되는가"는 여전히 이 배열 하나로 리뷰된다.
 */
export const SESSION_ALLOWED_TOOLS: readonly string[] = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  // 접두 없는 `Bash` 는 모든 Bash 호출을 허용한다(`Bash(git log:*)` 식 접두 제한을 걸지 않는다).
  "Bash",
  // 웹 조회 — 이 봇에 반드시 있어야 하는 것으로 요구사항에 명시됐다.
  "WebSearch",
  "WebFetch",
  "Task",
  "TodoWrite",
];

/** @deprecated 이름만 남긴 별칭 — 기존 호출부 호환용. */
export const READONLY_ALLOWED_TOOLS = SESSION_ALLOWED_TOOLS;

export interface ScrubbedEnv {
  env: Record<string, string>;
  scrubbedKeys: readonly string[];
}

/**
 * SDK 의 env 옵션은 process.env 와 병합되지 않고 통째로 대체된다(sdk.d.ts 명시) —
 * PATH/HOME 등 비민감 변수는 보존하고 민감 패턴만 제거해야 세션이 살아 있으면서 격리된다.
 */
export function scrubEnv(
  baseEnv: Record<string, string | undefined>,
  preserveKeys: readonly string[] = [],
): ScrubbedEnv {
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    const sensitive = SENSITIVE_ENV_PATTERNS.some((re) => re.test(key));
    if (sensitive && !preserveKeys.includes(key)) {
      scrubbed.push(key);
      continue;
    }
    env[key] = value;
  }
  scrubbed.sort();
  return { env, scrubbedKeys: scrubbed };
}

/**
 * CHAT (기본 프로파일): 사람과의 대화 세션.
 *
 * 설계 목표는 **Claude Code 와 같은 능력**이다 — 슬랙에서 묻든 Claude Code 에서 묻든 답이
 * 같아야 한다. 그래서 조회 전용 봇이라면 걸었을 세 제약을 의도적으로 걷어냈다:
 *
 * 1. **도구 폭** — Read/Glob/Grep + git 조회 접두 매칭 → 전체 도구(Bash·Edit/Write·WebSearch·
 *    WebFetch·Task). `SESSION_ALLOWED_TOOLS` 주석 참고.
 * 2. **호스트 설정 상속** — `settingSources: []` → user/project/local 전부 상속. 이래야
 *    개인 글로벌 지침·프로젝트 CLAUDE.md·`.claude/skills` 가 세션에 실린다. 이게 없으면 봇은
 *    사용자가 Claude Code 에서 당연히 기대하는 규칙(한국어로 답하기, 컨벤션 등)을 하나도 모른다.
 *    ⚠️ 대가: 호스트 `permissions.allow` 도 함께 들어온다. 도구를 좁힌 봇에서는 이게
 *    화이트리스트를 무력화하는 통로가 되는데, 지금은 화이트리스트가 이미 전 도구를 여니 그 경로로 늘어날 권한이
 *    없다 — 경계가 도구 목록에서 **access.json 의 allowed** 로 옮겨졌기 때문이다.
 * 3. **쓰기 금지** — Edit/Write/NotebookEdit disallow 해제.
 *
 * 남겨 둔 것은 하나뿐이다: **Slack 쓰기 도구 disallow**(EG-01). 이건 능력이 아니라 배관이다 —
 * 게시는 egress 한 곳으로 모아야 병렬 세션이 남의 스레드에 오발송하지 않는다.
 *
 * - resume 허용: thread_key ↔ session_id 영속 대화(SC-01)의 전제.
 * - permissionMode 'dontAsk': headless 에선 ask 가 곧 hang — 나열되지 않은 것은 즉시 거부.
 * - mcpTools: MCP 도구 manifest(mcp/registry). in-process 도구는
 *   민감 키를 봇 프로세스 안에서만 만지고 세션엔 결과만 준다 — 세션 env 는
 *   SENSITIVE_ENV_PATTERNS 로 스크럽돼 키를 못 본다.
 * - readonlyDirs: cwd 밖 경로를 SDK 에 명시 선언한다(additionalDirectories). **절대경로만** —
 *   상대경로는 봇 프로세스 cwd 기준으로 조용히 어긋난다.
 */
export function buildReadonlyProfile(
  cwd: string,
  baseEnv: Record<string, string | undefined> = process.env,
  model: string = DEFAULT_MODEL,
  mcpTools: readonly McpToolEntry[] = [],
  readonlyDirs: readonly string[] = [],
): RunnerProfile {
  const { env, scrubbedKeys } = scrubEnv(baseEnv);
  const mcpServers = toMcpServersOption(mcpTools);
  const options: Options = {
    cwd,
    model,
    settingSources: ["user", "project", "local"],
    permissionMode: "dontAsk",
    allowedTools: [...SESSION_ALLOWED_TOOLS, ...toAllowedTools(mcpTools)],
    disallowedTools: [...DISALLOWED_SLACK_WRITE_TOOLS],
    env,
  };
  // mcpServers 는 도구가 있을 때만 실어 "도구 없음" 프로파일의 옵션 형태가 바뀌지 않게 한다
  // (스냅샷 테스트가 빈 mcpServers 레코드 유무로 흔들리지 않도록 — 명시적 부재).
  if (mcpTools.length > 0) {
    options.mcpServers = mcpServers;
  }
  // additionalDirectories 도 같은 규율 — 미지정이면 옵션 자체가 없어야 "cwd 밖 읽기를 의도하지
  // 않았다"가 스냅샷에 형태로 남는다(빈 배열을 실으면 부재와 구분이 안 된다).
  if (readonlyDirs.length > 0) {
    options.additionalDirectories = [...readonlyDirs];
  }
  return {
    kind: "READONLY",
    allowResume: true,
    scrubbedEnvKeys: scrubbedKeys,
    options,
  };
}

/**
 * AUX (단발 분류/요약): 도구가 전혀 필요 없는 텍스트-in/텍스트-out run.
 *
 * ⚠️ SDK footgun (SEC-03): 도구 봉인은 `tools: []` 만 유효하다.
 * `allowedTools: []` 는 빈 배열이면 플래그 자체가 생략되는 no-op 이라
 * bypassPermissions 와 결합하면 임의 명령 실행이 열린다 (hb aux.ts 실측).
 * 이 프로파일에서 tools 를 allowedTools 로 "리팩토링"하는 순간 봉인이 사라진다 —
 * profiles.test.ts 의 `tools: []` 단언이 그 실수를 막는 방어선이다.
 */
export function buildAuxProfile(
  baseEnv: Record<string, string | undefined> = process.env,
  model: string = DEFAULT_MODEL,
): RunnerProfile {
  const { env, scrubbedKeys } = scrubEnv(baseEnv);
  return {
    kind: "AUX",
    allowResume: false,
    scrubbedEnvKeys: scrubbedKeys,
    options: {
      tools: [],
      model,
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      permissionMode: "dontAsk",
      disallowedTools: [...DISALLOWED_SLACK_WRITE_TOOLS],
      env,
    },
  };
}
