/**
 * 긴 텍스트의 Slack 메시지 분할 — 순수 함수만 (EG-03).
 *
 * 선행 구현의 slack 분할 이식. 잘린 코드펜스가 다음 chunk 전체를 코드로
 * 만드는 사고 방지가 핵심 — 펜스 안에서 잘리면 닫고(```), 다음 chunk 를 ```로 다시 연다.
 */

import { CONTRACT } from "../core/constants.js";

/** 제약: limit 이내에서 빈 줄 → 줄 → 공백 순으로만 끊는다 — 단어/문장 중간 절단 최소화. */
function findCut(text: string, limit: number): number {
  if (text.length <= limit) return text.length;
  const half = Math.floor(limit / 2);
  const para = text.lastIndexOf("\n\n", limit - 2);
  if (para >= half) return para + 2;
  const line = text.lastIndexOf("\n", limit - 1);
  if (line >= half) return line + 1;
  const space = text.lastIndexOf(" ", limit - 1);
  if (space >= half) return space + 1;
  // 하드 컷 폴백이 백틱 런(``` 등) 중간을 절단하면 countFences 가 잘린 파편을
  // 못 세어 펜스 보전이 깨진다 — 런 시작으로 후퇴해 토큰을 통째로 넘긴다.
  // (런이 텍스트 선두까지 이어지는 퇴행 입력만 진행 보장을 위해 그대로 자른다)
  if (text[limit] === "`" && text[limit - 1] === "`") {
    let runStart = limit - 1;
    while (runStart > 0 && text[runStart - 1] === "`") runStart -= 1;
    if (runStart > 0) return runStart;
  }
  return limit;
}

function countFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}

/**
 * 제약: chunkSize 기본값은 수치 계약(MESSAGE_CHUNK_CHARS=2800) — Slack 본문 한도(4000)
 * 대비 mrkdwn 팽창·펜스 닫기(+4자) 여유를 둔 실운영 검증값이라 인자로만 바꾼다.
 */
export function splitForSlack(
  text: string,
  chunkSize: number = CONTRACT.MESSAGE_CHUNK_CHARS,
): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let rem = text;
  // rem 시작 지점이 (원본 기준) 코드블록 안인지 — carry 로 다시 연 펜스는 세지 않는다
  let proseInCode: boolean = false;
  let carryPrefix = "";

  for (;;) {
    let available = chunkSize - carryPrefix.length;
    if (available <= 0) available = chunkSize;
    if (rem.length <= available) break;

    const cut = findCut(rem, available);
    const body = rem.slice(0, cut);
    const endsInCode: boolean = proseInCode !== (countFences(body) % 2 === 1);

    let chunkText = carryPrefix + body;
    if (endsInCode) {
      if (!chunkText.endsWith("\n")) chunkText += "\n";
      chunkText += "```";
      carryPrefix = "```\n";
    } else {
      carryPrefix = "";
    }
    chunks.push(chunkText.trimEnd());
    rem = rem.slice(cut);
    proseInCode = endsInCode;
  }

  const tail = carryPrefix + rem;
  if (tail) chunks.push(tail.trimEnd());
  return chunks;
}
