/**
 * chat 최종 답변의 장황함 린트 — 순수 함수.
 * 설계: docs/adr/0004-chat-verbosity-lint.md
 *
 * **기계적으로 확실한 술어만** 담는다. "과정 서사" 같은 장황함 판정은 여기 넣지 않는다 —
 * 오탐만 늘고, 그 판단은 context.ts 의 OUTPUT_FORMAT_GUIDE ✗/✓ 예시가 맡는다.
 *
 * 반환 문자열은 그대로 재작성 프롬프트에 실린다 — 진단이 아니라 지시문으로 쓴다.
 */

/** 전체 길이 상한 — **코드블록 포함**. 빼고 재면 긴 코드 인용이 통과해 "짧게"의 의도가 샌다. */
export const CHAT_MAX_CHARS = 1_500;
/** 한 목록의 최상위 항목 수 상한. */
export const CHAT_MAX_LIST_ITEMS = 5;
/** 불릿 한 줄의 표시 길이 상한(링크는 표시 텍스트로 환산). */
export const CHAT_MAX_BULLET_CHARS = 80;
/** 이 행 수 미만의 파이프 표는 문장으로 쓴다. */
export const CHAT_MIN_TABLE_ROWS = 4;

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const BULLET_RE = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+(.*)$/;
const TABLE_DIVIDER_RE = /^\s*\|[-:\s|]+\|\s*$/;
/** GFM 링크 → 표시 텍스트. URL 길이가 불릿 길이 판정을 오염시키면 안 된다. */
const LINK_RE = /\[([^\]\n]+)\]\([^)\s]*\)/g;

export function lintChatStyle(text: string): string[] {
  const issues: string[] = [];

  if (text.length > CHAT_MAX_CHARS) {
    issues.push(`${CHAT_MAX_CHARS}자 안으로 핵심만 줄인다`);
  }

  // 코드 안의 `-` 나 `|` 는 불릿·표가 아니다.
  const lines = text.replace(FENCE_RE, "").replace(INLINE_CODE_RE, "").split("\n");

  let deep = false;
  let wide = false;
  let run = 0;
  let longestList = 0;
  for (const line of lines) {
    const match = line.match(BULLET_RE);
    if (!match) {
      // 불릿 아닌 줄이 목록 구간을 끊는다.
      run = 0;
      continue;
    }
    const indent = (match[1] ?? "").replaceAll("\t", "  ").length;
    const visible = (match[2] ?? "").replace(LINK_RE, "$1");
    if (indent >= 4) deep = true;
    if (visible.length > CHAT_MAX_BULLET_CHARS) wide = true;
    // 하위 불릿은 구간을 끊지도, 개수에 세지도 않는다 — 그건 deep 이 본다.
    if (indent === 0) longestList = Math.max(longestList, ++run);
  }

  if (longestList > CHAT_MAX_LIST_ITEMS) {
    issues.push(
      `한 목록에 항목은 ${CHAT_MAX_LIST_ITEMS}개까지 — 중요한 것만 남기고 나머지는 '외 N건'으로 줄인다`,
    );
  }
  if (wide) {
    issues.push("불릿 한 줄에는 핵심만 — 길면 줄이거나 아래 계층으로 쪼갠다");
  }
  if (deep) {
    issues.push("불릿은 2단계까지만 쓴다");
  }

  // 열 수는 일부러 보지 않는다 — 2열 표(키-값)가 정당한 경우가 흔해 오탐이 크다.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !TABLE_DIVIDER_RE.test(line)) continue;
    let rows = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next === undefined || !next.trimStart().startsWith("|")) break;
      rows++;
    }
    if (rows >= 1 && rows < CHAT_MIN_TABLE_ROWS) {
      issues.push(`데이터 ${CHAT_MIN_TABLE_ROWS}행 미만은 표가 아니라 문장으로 쓴다`);
      break;
    }
    i += rows;
  }

  return issues;
}
