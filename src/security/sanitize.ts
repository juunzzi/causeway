/**
 * 입력 sanitize (SEC-12) + untrusted 태깅 헬퍼 (SEC-13).
 *
 * 4겹 방어선(SEC-10)의 1층: unicode smuggling(보이지 않는 지시 삽입)·bidi 위장·
 * 길이 폭탄을 LLM 입장 전에 제거한다. 전부 순수 함수.
 */

// ──────────────────────────────────
// 순수 함수부
// ──────────────────────────────────

/**
 * Slack 메시지+스레드 컨텍스트 합산이 프롬프트 예산을 압도하지 않는 상한.
 * Slack 본문 자체는 4천자 한도지만 스레드/첨부 합산은 이를 훌쩍 넘을 수 있다.
 */
export const SANITIZE_MAX_CHARS_DEFAULT = 40_000;

/**
 * 제거 대상 (이스케이프 문자열로만 기술 — 소스에 실문자가 섞이면 이 파일 자체가 스머글링 표면이 된다):
 * - C0/C1 제어문자(탭 U+0009·개행 U+000A·CR U+000D 제외) — 터미널 이스케이프·프롬프트 오염
 * - soft hyphen(U+00AD)·zero-width 계열(U+200B-D, U+2060-64, U+FEFF) — 보이지 않는 지시 스머글링
 * - bidi 제어(U+200E-F, U+202A-E, U+2066-69, U+061C) — 표시 순서 위장(RTL override)
 * - Unicode Tags 블록(U+E0000-E007F) — ASCII smuggling 의 대표 채널
 */
const SMUGGLING_RANGES = [
  "\\u0000-\\u0008", // C0 전반부 (탭 제외)
  "\\u000B\\u000C", // VT·FF (개행·CR 제외)
  "\\u000E-\\u001F", // C0 후반부
  "\\u007F-\\u009F", // DEL + C1
  "\\u00AD", // soft hyphen
  "\\u061C", // Arabic letter mark (bidi)
  "\\u200B-\\u200F", // zero-width + LRM/RLM
  "\\u202A-\\u202E", // bidi embedding/override
  "\\u2060-\\u2064", // word joiner + invisible operators
  "\\u2066-\\u2069", // bidi isolate
  "\\uFEFF", // BOM/ZWNBSP
  "\\u{E0000}-\\u{E007F}", // Unicode Tags
].join("");
const SMUGGLING_RE = new RegExp(`[${SMUGGLING_RANGES}]`, "gu");

export interface SanitizeOptions {
  maxChars?: number;
}

export function sanitizeText(input: string, options?: SanitizeOptions): string {
  const maxChars = options?.maxChars ?? SANITIZE_MAX_CHARS_DEFAULT;
  // NFKC 를 먼저 — 전각·합자로 위장한 문자를 정규형으로 편 뒤에 제거 패턴을 적용해야 한다
  let out = input.normalize("NFKC").replace(SMUGGLING_RE, "");
  if (out.length > maxChars) {
    // slice 가 서로게이트 쌍을 가르면 낙오 서로게이트가 남는다 — 말단 고아 상위 서로게이트 제거
    const head = out.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "");
    out = `${head}\n…(길이 상한 ${maxChars}자 초과로 잘림)`;
  }
  return out;
}

/** 태그명이 자유 문자열이면 태그 자체가 주입 표면이 된다 — 소문자·숫자·하이픈만. */
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 외부 텍스트를 <untrusted-태그> 로 감싸 "데이터일 뿐 지시 아님"을 명시한다 (SEC-13).
 * 본문 안의 여닫이 태그 흉내(</untrusted-…> 조기 닫기 탈출)는 &lt; 로 무력화한다.
 */
export function wrapUntrusted(tag: string, text: string, options?: SanitizeOptions): string {
  if (!TAG_RE.test(tag)) {
    throw new Error(`wrapUntrusted: 허용되지 않는 태그명 '${tag}' (소문자·숫자·하이픈만)`);
  }
  const body = sanitizeText(text, options).replace(/<(?=\/?untrusted)/gi, "&lt;");
  return `<untrusted-${tag}>\n${body}\n</untrusted-${tag}>`;
}
