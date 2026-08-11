/**
 * GFM markdown 블록용 분할 — 순수 함수만 (EG-10).
 *
 * Slack `markdown` 블록은 GFM(파이프 표·## 헤더·[링크]·```코드```)를 그대로 렌더한다.
 * mrkdwn 경로(chunker.ts)와 달리 **원본 GFM 을 손대지 않으므로** 분할 시에도 GFM 구조를
 * 절대 깨면 안 된다 — 표 행 중간·코드블록(```) 내부·[링크](…) 중간에서 자르면 렌더가 무너진다.
 *
 * 전략: 입력을 "블록"(코드펜스 블록 / 표 블록 / 산문 블록)으로 분해한 뒤, 블록을 상한 안에서
 * 그러모아 청크를 만든다. 한 블록이 상한을 넘으면 그 블록의 성질에 따라 안전 경계로만 쪼갠다:
 * - 코드블록: 줄 경계로 쪼개고 각 조각을 ```로 다시 감싼다(mrkdwn chunker 와 동일 원리).
 * - 표: 헤더행+구분행을 각 조각에 재부착해 조각마다 유효한 표가 되게 한다.
 * - 산문: 빈 줄 → 줄 → 공백 순 경계로 쪼개되 [링크](…) 토큰 중간은 피한다.
 */

import { CONTRACT } from "../core/constants.js";

// ── 블록 분해 ────────────────────────────────────────────────────────────────

type BlockKind = "code" | "table" | "prose";

interface Block {
  kind: BlockKind;
  text: string;
}

/** ``` 로 시작하는 라인(언어 힌트 허용) — 코드펜스 여닫이. */
const FENCE_RE = /^```/;
/**
 * GFM 표 구분행 — `|---|:--:|` 형태(파이프·콜론·하이픈·공백만). 헤더행 바로 아래 이 행이 있어야
 * 표로 렌더된다. 이 행의 존재로 "표 블록의 시작(헤더행)"을 역추적한다.
 */
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
/** 표 본문 행 — 파이프를 포함하는 라인(구분행 판정 후의 데이터/헤더행). */
const TABLE_ROW_RE = /\|/;

/**
 * 텍스트를 코드/표/산문 블록으로 분해한다. 인접 산문은 한 블록으로 합치고, 표·코드는 각각
 * 독립 블록으로 떼어낸다 — 이 경계가 곧 "절단 금지" 단위다.
 *
 * 제약: 표는 "헤더행 + 구분행 + 데이터행들" 을 한 덩어리로 본다. 구분행을 만나면 직전 산문의
 * 마지막 비어있지 않은 줄(헤더행)까지 되짚어 표 블록에 편입한다.
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length > 0) {
      blocks.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // 코드펜스 블록 — 여는 펜스부터 닫는 펜스(또는 EOF)까지 통째로.
    if (FENCE_RE.test(line)) {
      flushProse();
      const codeLines = [line];
      i++;
      for (; i < lines.length; i++) {
        const cur = lines[i] ?? "";
        codeLines.push(cur);
        if (FENCE_RE.test(cur)) break; // 닫는 펜스 포함하고 종료
      }
      blocks.push({ kind: "code", text: codeLines.join("\n") });
      continue;
    }

    // 표 블록 — 구분행을 만나면 직전 헤더행(prose 마지막 비어있지 않은 줄)부터 표로 본다.
    const next = lines[i + 1] ?? "";
    const isHeaderRow = TABLE_ROW_RE.test(line) && TABLE_DELIM_RE.test(next);
    if (isHeaderRow) {
      // prose 에서 헤더행으로 딸려갈 줄을 떼어낸다: prose 의 마지막 줄이 헤더행이 아니라,
      // 현재 line 이 헤더행이다(구분행이 next). prose 는 그대로 flush.
      flushProse();
      const tableLines = [line, next];
      i += 2;
      for (; i < lines.length; i++) {
        const cur = lines[i] ?? "";
        // 파이프가 있는 연속 행만 표 본문 — 빈 줄이나 파이프 없는 줄에서 표 종료.
        if (cur.trim() === "" || !TABLE_ROW_RE.test(cur)) {
          i--; // 이 줄은 표가 아니다 — 되돌려 산문으로 처리
          break;
        }
        tableLines.push(cur);
      }
      blocks.push({ kind: "table", text: tableLines.join("\n") });
      continue;
    }

    prose.push(line);
  }
  flushProse();
  return blocks;
}

// ── 블록 내부 분할(상한 초과 블록) ──────────────────────────────────────────

/** [텍스트](url) 링크 토큰의 시작/끝 인덱스 — 이 구간 내부에서는 자르지 않는다. */
const LINK_RE = /\[[^\]]*\]\([^)]*\)/g;

/**
 * pos 가 어떤 링크 토큰 내부(시작 다음 ~ 끝 이전)이면 그 토큰의 시작 인덱스를 반환한다.
 * 링크 밖이면 -1. 하드 컷이 링크 중간을 절단하지 않게 시작으로 후퇴시키는 데 쓴다.
 */
function linkStartCovering(text: string, pos: number): number {
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m !== null; m = LINK_RE.exec(text)) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (pos > start && pos < end) return start;
    if (start >= pos) break; // 정렬된 매치라 더 볼 필요 없음
  }
  return -1;
}

/**
 * pos 에서 시작하거나 pos 를 지나가는 첫 링크 토큰의 [시작,끝] — 하드 컷이 이 토큰을 쪼개지
 * 않게 통째로 넘길 구간을 찾는 데 쓴다. 없으면 null.
 */
function linkAtOrAfter(text: string, pos: number): { start: number; end: number } | null {
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m !== null; m = LINK_RE.exec(text)) {
    const end = m.index + m[0].length;
    if (end > pos) return { start: m.index, end };
  }
  return null;
}

/** 산문 한 덩어리를 상한 안에서 빈 줄 → 줄 → 공백 순으로 끊는다(링크 중간 회피). */
function splitProse(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rem = text;
  while (rem.length > limit) {
    let cut = pickProseCut(rem, limit);
    // 경계가 링크 토큰 중간이면 링크 시작으로 후퇴(링크 앞이 limit 초과여도 링크를 통째로 넘긴다)
    const linkStart = linkStartCovering(rem, cut);
    if (linkStart > 0) {
      cut = linkStart;
    } else if (linkStart === 0) {
      // rem 이 링크로 시작하는데 그 링크가 limit 을 넘는다 — 링크를 통째로 한 조각으로 내보낸다
      // (링크는 절대 쪼개지 않는다). 링크 끝까지가 이번 조각.
      const link = linkAtOrAfter(rem, 0);
      cut = link ? link.end : limit;
    }
    if (cut <= 0) cut = limit; // 진행 보장(퇴행 입력)
    out.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).replace(/^\n+/, "");
  }
  if (rem) out.push(rem.trimEnd());
  return out;
}

/** limit 이내 최적 컷 위치 — 빈 줄 > 줄 > 공백. half 미만이면 하드 컷. */
function pickProseCut(text: string, limit: number): number {
  const half = Math.floor(limit / 2);
  const para = text.lastIndexOf("\n\n", limit - 2);
  if (para >= half) return para + 2;
  const line = text.lastIndexOf("\n", limit - 1);
  if (line >= half) return line + 1;
  const space = text.lastIndexOf(" ", limit - 1);
  if (space >= half) return space + 1;
  return limit;
}

/**
 * 코드블록을 줄 경계로 쪼개고 각 조각을 유효한 펜스로 감싼다. 여는 펜스 라인(```lang)을 각
 * 조각 앞에 재부착해 언어 힌트를 보존한다. 한 줄이 상한을 넘는 극단은 그 줄만 하드 컷한다.
 */
function splitCodeBlock(text: string, limit: number): string[] {
  const lines = text.split("\n");
  const fenceOpen = lines[0] ?? "```"; // ```lang
  const inner = lines.slice(1, -1); // 여닫이 제외한 본문
  const out: string[] = [];
  let cur: string[] = [];
  let curLen = fenceOpen.length + 4; // 여는 펜스 + 닫는 ```\n 여유

  const flush = (): void => {
    if (cur.length === 0) return;
    out.push([fenceOpen, ...cur, "```"].join("\n"));
    cur = [];
    curLen = fenceOpen.length + 4;
  };

  for (const raw of inner) {
    // 한 줄 자체가 상한 초과 — 그 줄만 하드 컷해 여러 조각으로(각각 펜스로 감쌈).
    if (raw.length + fenceOpen.length + 5 > limit) {
      flush();
      let rem = raw;
      const bodyLimit = limit - fenceOpen.length - 5;
      while (rem.length > bodyLimit) {
        out.push([fenceOpen, rem.slice(0, bodyLimit), "```"].join("\n"));
        rem = rem.slice(bodyLimit);
      }
      if (rem) {
        cur = [rem];
        curLen = fenceOpen.length + 4 + rem.length + 1;
      }
      continue;
    }
    if (curLen + raw.length + 1 > limit) flush();
    cur.push(raw);
    curLen += raw.length + 1;
  }
  flush();
  return out.length > 0 ? out : [text];
}

/**
 * 표를 데이터 행 경계로 쪼개고 각 조각에 헤더행 + 구분행을 재부착해 조각마다 유효한 표가 되게
 * 한다. 헤더+구분 자체가 상한을 넘는 극단(비현실적)은 표를 통째로 한 조각으로 둔다(하드 컷 금지 —
 * 표를 깨느니 상한 초과 청크 하나가 낫고, 이는 msg_too_long 경계(≈12k) 안쪽이라 실무상 안전).
 */
function splitTable(text: string, limit: number): string[] {
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  const delim = lines[1] ?? "";
  const rows = lines.slice(2);
  const prefix = `${header}\n${delim}`;
  const prefixLen = prefix.length + 1;
  if (prefixLen >= limit) return [text]; // 헤더+구분이 이미 상한 초과 — 통째로

  const out: string[] = [];
  let cur: string[] = [];
  let curLen = prefixLen;

  const flush = (): void => {
    if (cur.length === 0) return;
    out.push([prefix, ...cur].join("\n"));
    cur = [];
    curLen = prefixLen;
  };

  for (const row of rows) {
    if (curLen + row.length + 1 > limit && cur.length > 0) flush();
    cur.push(row);
    curLen += row.length + 1;
  }
  flush();
  return out.length > 0 ? out : [text];
}

/** 상한 초과 블록을 성질에 맞는 안전 경계로만 쪼갠다. */
function splitOversizedBlock(block: Block, limit: number): string[] {
  switch (block.kind) {
    case "code":
      return splitCodeBlock(block.text, limit);
    case "table":
      return splitTable(block.text, limit);
    case "prose":
      return splitProse(block.text, limit);
  }
}

// ── 조립 ─────────────────────────────────────────────────────────────────────

/**
 * GFM 텍스트를 markdown 블록 상한 안에서 분할한다. 블록(코드/표/산문) 경계를 우선 존중하고,
 * 한 블록이 상한을 넘으면 그 성질에 맞는 안전 경계로만 쪼갠다.
 *
 * 제약: chunkSize 기본값은 수치 계약(MARKDOWN_BLOCK_CHUNK_CHARS=11,000). Slack markdown 블록
 * msg_too_long 경계(≈12,000) 아래 안전 여유값이라 인자로만 바꾼다.
 */
export function splitMarkdownBlocks(
  text: string,
  chunkSize: number = CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS,
): string[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const blocks = splitBlocks(trimmed);
  // 각 블록을 (필요하면) 상한 이하 조각들로 펼친다 — 표/코드/링크 절단 없이.
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.text.length <= chunkSize) {
      pieces.push(block.text);
    } else {
      pieces.push(...splitOversizedBlock(block, chunkSize));
    }
  }

  // 상한 이하 조각들을 순서대로 그러모아 청크를 만든다(블록 경계는 절대 안 깨진다).
  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur === "") {
      cur = piece;
      continue;
    }
    // 조각 사이는 빈 줄로 이어 붙여 섹션 그룹핑을 보존한다.
    const joined = `${cur}\n\n${piece}`;
    if (joined.length <= chunkSize) {
      cur = joined;
    } else {
      chunks.push(cur);
      cur = piece;
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}
