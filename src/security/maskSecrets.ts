/**
 * 시크릿 마스킹 — 순수 함수만, 부작용 없음 (SEC-11).
 *
 * 선행 구현 패턴 이식 + 확장(xapp/AWS/webhook/PEM/github_pat).
 * egress 와 모든 영속화 지점(잡 result·로그·메모리 노트)에 저장 전 일관 적용이 계약이다.
 */

/**
 * 제약: 과소 마스킹(유출)이 과잉 마스킹보다 치명적이므로 키워드 매칭은 대소문자
 * 무시로 넓게 잡는다. 적용 순서 의존 — Bearer 를 KEY=value 보다 먼저 돌려야
 * "Authorization: Bearer x" 에서 키워드 규칙이 "Bearer" 단어만 소비하고 토큰을
 * 남기는 구멍이 안 생긴다.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private key 블록 전체
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "***"],
  // Bearer / Token 헤더 — KEY=value 보다 반드시 먼저 (위 주석의 순서 제약)
  [/((?:Bearer|Token)\s+)([A-Za-z0-9._+/=-]{8,})/gi, "$1***"],
  // KEY=value / KEY: value (env 할당·curl 헤더·yaml 등)
  // 접두가 옵션이어야 "TOKEN=x" 같은 키워드 단독 키도 잡힌다 (선행 구현의 갭 보강)
  // 키워드 뒤 옵셔널 따옴표는 JSON 형태("token": "...")의 닫는 따옴표 — 없으면
  // 따옴표로 감싼 키가 [:=] 매치를 막아 JSON 응답의 시크릿이 통째로 유출된다
  [
    /((?:[A-Za-z_][\w-]*)?(?:API|SECRET|TOKEN|KEY|PASSWORD|PASSWD|AUTH|CREDENTIAL)[\w-]*["']?\s*[:=]\s*["']?)([^\s"'&;|]+)/gi,
    "$1***",
  ],
  // Slack incoming webhook — 경로 자체가 시크릿
  [/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/g, "$1***"],
  // Slack 토큰 (xoxb/xoxp/xoxa/xoxe/xoxr/xoxs) + app-level(xapp)
  [/\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, "***"],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, "***"],
  // GitHub 토큰 (classic + fine-grained)
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "***"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***"],
  // Anthropic/OpenAI 계열 sk- 키
  [/\bsk[-_][A-Za-z0-9_-]{16,}/g, "***"],
  // Datadog app key
  [/\bddapp_[A-Za-z0-9]{6,}/g, "***"],
  // AWS Access Key ID (secret 쪽은 KEY=value 규칙이 커버)
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, "***"],
];

export function maskSecrets(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const [re, sub] of PATTERNS) {
    out = out.replace(re, sub);
  }
  return out;
}
