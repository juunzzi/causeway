import { describe, expect, it } from "vitest";
import { CONTRACT } from "../core/constants.js";
import { splitBlocks, splitMarkdownBlocks } from "./mdBlockChunker.js";

const FENCE = "```";
// 각 청크가 유효한 GFM 인지 검사하는 헬퍼들 —
const fenceCount = (s: string): number => (s.match(/```/g) ?? []).length;
/** 잘린 링크 파편: 여는 대괄호는 있는데 닫는 `)` 로 끝나지 않는 링크 시작 조각. */
function hasBrokenLink(s: string): boolean {
  // 완전한 [..](..)를 지운 뒤 남은 `](` 파편이 있으면 절단된 링크다.
  const stripped = s.replace(/\[[^\]]*\]\([^)]*\)/g, "");
  return stripped.includes("](");
}

describe("splitBlocks — 블록 분해", () => {
  it("산문·표·코드를 독립 블록으로 나눈다", () => {
    const text = [
      "앞 산문",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```",
      "code",
      "```",
    ].join("\n");
    const blocks = splitBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "table", "prose", "code"]);
    const table = blocks.find((b) => b.kind === "table");
    expect(table?.text).toContain("| A | B |");
    expect(table?.text).toContain("| 1 | 2 |");
  });

  it("구분행 없는 파이프 라인은 표가 아니다", () => {
    const text = "그냥 | 파이프 | 텍스트\n다음 줄";
    const blocks = splitBlocks(text);
    expect(blocks.every((b) => b.kind === "prose")).toBe(true);
  });

  it("코드블록 안의 파이프/헤더는 표·헤더로 오인하지 않는다", () => {
    const text = "```\n| not | a | table |\n|---|---|---|\n## not a header\n```";
    const blocks = splitBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("code");
  });
});

describe("splitMarkdownBlocks — 경계값", () => {
  it("상한 이하는 그대로 1개", () => {
    const text = "짧은 리포트\n\n## 섹션\n내용";
    expect(splitMarkdownBlocks(text)).toEqual([text]);
  });

  it("빈/공백 입력은 0개", () => {
    expect(splitMarkdownBlocks("   \n\n")).toEqual([]);
  });

  it("각 청크는 상한 이하다", () => {
    const para = `${"문단 내용입니다. ".repeat(30)}\n\n`;
    const text = para.repeat(400); // 상한 훨씬 초과
    const chunks = splitMarkdownBlocks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks)
      expect(c.length).toBeLessThanOrEqual(CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS);
  });

  it("섹션(헤더/빈 줄) 경계를 우선해 분할한다", () => {
    const a = `## 섹션 A\n${"에이 ".repeat(50)}`;
    const b = `## 섹션 B\n${"비 ".repeat(50)}`;
    const chunks = splitMarkdownBlocks(`${a}\n\n${b}`, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 헤더가 청크 중간에서 잘려 산문에 붙지 않는다
    expect(chunks[0]).toContain("## 섹션 A");
    expect(chunks.some((c) => c.startsWith("## 섹션 B"))).toBe(true);
  });
});

describe("splitMarkdownBlocks — 표 절단 금지", () => {
  it("표가 상한을 넘으면 행 경계로 쪼개고 각 조각에 헤더+구분행을 재부착한다", () => {
    const header = "| 서비스 | 건수 |";
    const delim = "|---|---|";
    const rows = Array.from({ length: 40 }, (_, i) => `| svc-${i} | ${i * 3} |`);
    const table = [header, delim, ...rows].join("\n");
    const chunks = splitMarkdownBlocks(table, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // 각 조각이 유효한 표 — 헤더행 + 구분행으로 시작
      expect(c.startsWith(`${header}\n${delim}`)).toBe(true);
      // 데이터 행이 파이프 없이 절단되지 않았다(각 행이 | 로 시작·끝)
      const lines = c.split("\n").slice(2);
      for (const ln of lines) expect(ln.startsWith("| svc-")).toBe(true);
    }
    // 모든 데이터 행이 어딘가에 보존됐다
    const allRows = chunks.join("\n");
    for (const r of rows) expect(allRows).toContain(r);
  });

  it("표를 행 중간에서 절단하지 않는다", () => {
    const header = "| 이름 | 값 | 비고 |";
    const delim = "|---|---|---|";
    const rows = Array.from({ length: 30 }, (_, i) => `| 항목${i} | ${i} | 메모메모메모${i} |`);
    const chunks = splitMarkdownBlocks([header, delim, ...rows].join("\n"), 250);
    for (const c of chunks) {
      const dataLines = c.split("\n").slice(2);
      // 파이프 개수가 데이터 행마다 헤더와 동일 — 중간 절단이면 파이프 수가 어긋난다
      const headerPipes = (header.match(/\|/g) ?? []).length;
      for (const ln of dataLines) {
        expect((ln.match(/\|/g) ?? []).length).toBe(headerPipes);
      }
    }
  });
});

describe("splitMarkdownBlocks — 코드블록 절단 금지", () => {
  it("긴 코드블록은 줄 경계로 쪼개고 각 조각을 유효한 펜스로 감싼다", () => {
    const codeLines = Array.from({ length: 60 }, (_, i) => `line ${i} 0123456789 abcdefghij`);
    const text = `${FENCE}ts\n${codeLines.join("\n")}\n${FENCE}`;
    const chunks = splitMarkdownBlocks(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // 각 청크의 펜스는 짝수 — 잘린 펜스가 렌더를 오염시키지 않는다
      expect(fenceCount(c) % 2).toBe(0);
      // 언어 힌트가 각 조각에 재부착됐다
      expect(c.startsWith("```ts")).toBe(true);
    }
    // 코드 본문이 전부 보존됐다
    const joined = chunks.join("\n");
    for (const ln of codeLines) expect(joined).toContain(ln);
  });

  it("코드블록과 표가 섞인 리포트에서 둘 다 절단하지 않는다", () => {
    const table = [
      "| A | B |",
      "|---|---|",
      ...Array.from({ length: 20 }, (_, i) => `| ${i} | x |`),
    ].join("\n");
    const code = `${FENCE}\n${Array.from({ length: 20 }, (_, i) => `code ${i}`).join("\n")}\n${FENCE}`;
    const text = `## 표\n${table}\n\n## 코드\n${code}`;
    const chunks = splitMarkdownBlocks(text, 300);
    for (const c of chunks) {
      expect(fenceCount(c) % 2).toBe(0);
    }
  });
});

describe("splitMarkdownBlocks — 링크 절단 금지", () => {
  it("[텍스트](url) 를 중간에서 자르지 않는다", () => {
    // 링크가 상한 경계 근처에 오도록 배치
    const filler = "가나다라마바사 ".repeat(20);
    const link =
      "[아주 긴 링크 텍스트입니다](https://app.datadoghq.com/logs?query=very-long-query-string-here&from_ts=1&to_ts=2)";
    const text = `${filler}${link} 뒤 텍스트 ${filler}`;
    for (const limit of [80, 100, 120, 150, 200]) {
      const chunks = splitMarkdownBlocks(text, limit);
      for (const c of chunks) {
        expect(hasBrokenLink(c)).toBe(false);
      }
      // 링크가 통째로 어느 한 청크에 보존됐다
      expect(chunks.some((c) => c.includes(link))).toBe(true);
    }
  });
});
