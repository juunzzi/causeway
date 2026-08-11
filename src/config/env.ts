/**
 * env 순수 로더 — import side-effect 금지 (SEC-20).
 *
 * 파일(.env) 로드는 엔트리포인트(index.ts)의 명시 호출 몫이고, 이 모듈은 주어진
 * source 객체를 검증·해석만 한다. 필수값 누락은 전부 모아 한 번에 실패한다 —
 * 재시작 반복으로 하나씩 발견하는 소모를 막는다.
 *
 * causeway 은 **조회 전용 봇**이라 필수값이 Slack 토큰 두 개뿐이다. 도구별 자격증명
 * (도구별 접두(예: `MYTOOL_`))은 각 도구 모듈이 직접 읽고, 없으면 그 도구만
 * 조용히 빠진다(기본 off). 여기서 다시 선언하지 않는 이유는 게이트가 두 곳에 갈라지면
 * "env 는 있는데 도구는 없다"가 진단 불가능해지기 때문이다.
 */

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 (이 파일 전체가 순수 함수다)
// ────────────────────────────────────────────────────────────────────

export class EnvError extends Error {}

export interface AppEnv {
  /** xoxb 봇 토큰 — xoxp 는 계약 위반(에코 필터 계열 복잡성이 부활한다, ARCHITECTURE §1). */
  slackBotToken: string;
  /** xapp app-level 토큰 — Socket Mode 연결용. */
  slackAppToken: string;
  dbPath: string;
  /** READONLY 대화 세션 cwd (SEC-17) — 봇 내부 자산과 물리 격리. */
  workspaceDir: string;
  /** access.json 등 선언 config 디렉토리. */
  configDir: string;
  /**
   * 세션이 Read/Grep 으로 참고할 수 있는 로컬 체크아웃 루트 목록(쉼표 구분, 읽기 전용).
   * chat 프로파일의 `additionalDirectories` 로 선언된다 — 값이 없으면 세션은 workspace/ 밖을
   * 못 본다. 조회 전용 봇이라 여기 넣은 경로에 쓰기가 일어나는 경로는 존재하지 않는다.
   */
  referenceDirs: readonly string[];
}

export const ENV_DEFAULTS = {
  CAUSEWAY_DB_PATH: "var/causeway.db",
  CAUSEWAY_WORKSPACE_DIR: "workspace",
  CAUSEWAY_CONFIG_DIR: "config",
} as const;

/** 쉼표 구분 경로 목록 파싱 — 빈 항목·공백은 버린다(빈 문자열이 cwd 로 해석되는 사고 방지). */
export function parsePathList(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

export function loadEnv(source: Record<string, string | undefined>): AppEnv {
  const problems: string[] = [];

  const botToken = source.SLACK_BOT_TOKEN;
  if (!botToken) problems.push("SLACK_BOT_TOKEN 누락");
  else if (!botToken.startsWith("xoxb-")) {
    problems.push("SLACK_BOT_TOKEN 은 xoxb- 봇 토큰이어야 한다 (xoxp 금지 — ARCHITECTURE §1)");
  }

  const appToken = source.SLACK_APP_TOKEN;
  if (!appToken) problems.push("SLACK_APP_TOKEN 누락");
  else if (!appToken.startsWith("xapp-")) {
    problems.push("SLACK_APP_TOKEN 은 xapp- app-level 토큰이어야 한다");
  }

  if (problems.length > 0) {
    throw new EnvError(`env 검증 실패 — ${problems.join("; ")}`);
  }

  return {
    slackBotToken: botToken as string,
    slackAppToken: appToken as string,
    dbPath: source.CAUSEWAY_DB_PATH || ENV_DEFAULTS.CAUSEWAY_DB_PATH,
    workspaceDir: source.CAUSEWAY_WORKSPACE_DIR || ENV_DEFAULTS.CAUSEWAY_WORKSPACE_DIR,
    configDir: source.CAUSEWAY_CONFIG_DIR || ENV_DEFAULTS.CAUSEWAY_CONFIG_DIR,
    referenceDirs: parsePathList(source.CAUSEWAY_REFERENCE_DIRS),
  };
}
