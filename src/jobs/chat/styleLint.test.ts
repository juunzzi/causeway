import { describe, expect, it } from "vitest";
import { CHAT_MAX_BULLET_CHARS, CHAT_MAX_CHARS, lintChatStyle } from "./styleLint.js";

describe("lintChatStyle — 통과", () => {
  it("1~3문장 답은 통과", () => {
    expect(lintChatStyle("v2.14.3 입니다. 어제 15:27 에 올라갔어요.")).toEqual([]);
  });

  it("한 목록 5개는 통과", () => {
    expect(lintChatStyle(["- 하나", "- 둘", "- 셋", "- 넷", "- 다섯"].join("\n"))).toEqual([]);
  });

  it("표는 데이터 4행부터 통과", () => {
    const text = [
      "| 서비스 | 건수 |",
      "|---|---|",
      "| a | 1 |",
      "| b | 2 |",
      "| c | 3 |",
      "| d | 4 |",
    ].join("\n");
    expect(lintChatStyle(text)).toEqual([]);
  });

  it("상한 길이 정확히는 통과", () => {
    expect(lintChatStyle("가".repeat(CHAT_MAX_CHARS))).toEqual([]);
  });
});

describe("lintChatStyle — 위반", () => {
  it("상한 + 1자는 걸린다", () => {
    expect(lintChatStyle("가".repeat(CHAT_MAX_CHARS + 1))).toHaveLength(1);
  });

  it("한 목록 6개는 걸린다", () => {
    expect(lintChatStyle(["- 1", "- 2", "- 3", "- 4", "- 5", "- 6"].join("\n"))).toHaveLength(1);
  });

  it("표시 길이 상한 + 1자 불릿은 걸린다", () => {
    expect(lintChatStyle(`- ${"가".repeat(CHAT_MAX_BULLET_CHARS + 1)}`)).toHaveLength(1);
  });

  it("들여쓰기 4칸(3단계) 불릿은 걸린다", () => {
    expect(lintChatStyle(["- 하나", "  - 둘", "    - 셋"].join("\n"))).toHaveLength(1);
  });

  it("데이터 3행 표는 걸린다", () => {
    const text = ["| 서비스 | 건수 |", "|---|---|", "| a | 1 |", "| b | 2 |", "| c | 3 |"].join(
      "\n",
    );
    expect(lintChatStyle(text)).toHaveLength(1);
  });
});

describe("lintChatStyle — 판정 경계", () => {
  it("코드블록 안의 불릿·파이프는 세지 않는다", () => {
    const text = ["```", "- 1", "- 2", "- 3", "- 4", "- 5", "- 6", "|---|", "| a |", "```"].join(
      "\n",
    );
    expect(lintChatStyle(text)).toEqual([]);
  });

  it("긴 URL 은 불릿 길이에 세지 않는다 — 표시 텍스트로 잰다", () => {
    const url = `https://example.com/${"a".repeat(200)}`;
    expect(lintChatStyle(`- 짧은 설명 [커밋](${url})`)).toEqual([]);
  });

  it("불릿 아닌 줄이 끼면 목록 구간이 끊긴다", () => {
    const five = ["- 1", "- 2", "- 3", "- 4", "- 5"].join("\n");
    expect(lintChatStyle(`${five}\n\n문장이 낀다.\n\n${five}`)).toEqual([]);
  });

  it("하위 불릿은 최상위 개수에 세지 않는다", () => {
    const text = ["- 1", "  - a", "- 2", "  - b", "- 3", "- 4", "- 5"].join("\n");
    expect(lintChatStyle(text)).toEqual([]);
  });

  it("구분행 뒤 데이터가 없으면 표로 보지 않는다", () => {
    expect(lintChatStyle(["| 헤더 |", "|---|"].join("\n"))).toEqual([]);
  });

  it("위반이 여럿이면 issues 도 여럿", () => {
    const text = ["- 1", "- 2", "- 3", "- 4", "- 5", "- 6", "  - 깊게", "    - 더 깊게"].join("\n");
    expect(lintChatStyle(text).length).toBeGreaterThanOrEqual(2);
  });
});
