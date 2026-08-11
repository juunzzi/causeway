/**
 * Markdown → Slack mrkdwn 변환 — 순수 함수만 (EG-05).
 *
 * 선행 구현의 markdown→mrkdwn 변환 이식 + 두 가지 보강:
 * - 코드펜스 내부는 변환하지 않는다 (코드 안 ** 가 굵게로 깨지는 것 방지).
 * - 리포트 전체를 ```로 감싼 입력은 벗겨낸다 — inline snippet 으로 접혀 안 읽히는
 *   실사고(팀 메모리 feedback_slack_no_triple_backtick_wrap)의 코드 레벨 방어.
 */

const BOLD_RE = /\*\*(.+?)\*\*/g;
// 제약: 해시 뒤 공백 필수 — "#태그", "#1 이슈" 같은 비헤딩 라인의 오변환 방지 (선행 구현에서 보강)
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function convertProse(text: string): string {
  let t = text.replace(BOLD_RE, "*$1*");
  t = t.replace(HEADING_RE, "*$1*");
  t = t.replace(LINK_RE, "<$2|$1>");
  return t;
}

/**
 * 전체가 단일 ``` 펜스로 감싸진 입력이면 내용만 반환.
 * 제약: 내부에 또 다른 ``` 가 있으면 "전체 감싸기"가 아니므로 손대지 않는다.
 */
export function unwrapFullCodeBlock(text: string): string {
  const trimmed = text.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (!m) return text;
  const inner = m[1] ?? "";
  if (inner.includes("```")) return text;
  return inner;
}

export function mdToMrkdwn(text: string): string {
  const unwrapped = unwrapFullCodeBlock(text);
  // 짝수 인덱스 = 펜스 밖 산문, 홀수 인덱스 = 펜스 안 코드 (홀수 개 펜스면 마지막은 코드 취급)
  return unwrapped
    .split("```")
    .map((seg, i) => (i % 2 === 0 ? convertProse(seg) : seg))
    .join("```");
}
