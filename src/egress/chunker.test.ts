import { describe, expect, it } from "vitest";
import { CONTRACT } from "../core/constants.js";
import { splitForSlack } from "./chunker.js";

describe("splitForSlack — 경계값", () => {
  it("chunk 상한 이하는 그대로 1개", () => {
    const text = "a".repeat(CONTRACT.MESSAGE_CHUNK_CHARS);
    expect(splitForSlack(text)).toEqual([text]);
  });

  it("정확히 2800+1 자면 2개로 분할", () => {
    const text = "a".repeat(CONTRACT.MESSAGE_CHUNK_CHARS + 1);
    const chunks = splitForSlack(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe(text);
  });

  it("각 chunk 는 상한 + 펜스 닫기 여유(4자)를 넘지 않는다", () => {
    const para = `문단입니다 ${"내용 ".repeat(40)}\n\n`;
    const text = para.repeat(30);
    for (const chunk of splitForSlack(text)) {
      expect(chunk.length).toBeLessThanOrEqual(CONTRACT.MESSAGE_CHUNK_CHARS + 4);
    }
  });

  it("빈 줄 경계를 우선해 자연스럽게 끊는다", () => {
    const chunks = splitForSlack("첫 문단 내용입니다\n\n두번째 문단 내용입니다", 15);
    expect(chunks[0]).toBe("첫 문단 내용입니다");
    expect(chunks[1]).toBe("두번째 문단 내용입니다");
  });
});

describe("splitForSlack — 코드펜스 경계 보전", () => {
  it("펜스 안에서 잘리면 닫고, 다음 chunk 를 다시 연다", () => {
    const text = "intro\n```\n0123456789\n0123456789\n0123456789\n0123456789\n```\nafter";
    const chunks = splitForSlack(text, 40);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0] ?? "";
    const second = chunks[1] ?? "";
    expect(first.endsWith("```")).toBe(true);
    expect(second.startsWith("```\n")).toBe(true);
    // 각 chunk 의 펜스는 항상 짝수 개 — 잘린 펜스가 다음 답글을 전부 코드로 만들지 않는다
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    expect(chunks.at(-1)).toContain("after");
  });

  it("펜스 밖에서 잘리면 펜스를 덧붙이지 않는다", () => {
    const text = `${"산문 단락입니다 ".repeat(15)}\n\n\`\`\`\nshort\n\`\`\``;
    const chunks = splitForSlack(text, 120);
    const first = chunks[0] ?? "";
    expect(first.endsWith("```")).toBe(false);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
  });

  it("공백 없는 텍스트의 하드 컷이 ``` 토큰 중간을 절단하지 않는다", () => {
    // ``` 가 하드 컷 지점(limit)을 정확히 걸치는 배치 — 백틱 파편 회귀 방지
    const limit = 30;
    const text = `${"a".repeat(limit - 1)}\`\`\`${"b".repeat(40)}\`\`\``;
    const chunks = splitForSlack(text, limit);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      // 잘린 백틱 파편(1~2개 연속) 금지 — 펜스는 항상 3연속 완전체로만
      expect(chunk).not.toMatch(/(?<!`)`{1,2}(?!`)/);
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // 펜스 스캐폴딩(```·개행)을 걷어내면 본문이 그대로 보전된다
    const stripped = (s: string) => s.replace(/[`\n]/g, "");
    expect(chunks.map(stripped).join("")).toBe(stripped(text));
  });

  it("여러 chunk 에 걸친 긴 코드블록도 매 chunk 짝수 펜스 유지", () => {
    const text = `\`\`\`\n${"code line 0123456789\n".repeat(30)}\`\`\``;
    const chunks = splitForSlack(text, 100);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // 재개용 펜스/닫는 펜스를 제외한 본문이 보전된다
    const joined = chunks.join("\n");
    expect(joined).toContain("code line 0123456789");
  });
});
