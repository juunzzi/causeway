import { describe, expect, it } from "vitest";
import { formatSlackTs, parseSlackPermalink } from "./permalink.js";

describe("parseSlackPermalink", () => {
  it("경로의 p<16자리> 를 ts 로 복원한다", () => {
    expect(
      parseSlackPermalink("https://example.slack.com/archives/C0AB/p1754400000123456"),
    ).toEqual({
      channel: "C0AB",
      ts: "1754400000.123456",
    });
  });

  it("thread_ts 쿼리가 있으면 부모 ts 를 쓴다 — 답글 링크로 중첩 스레드를 만들지 않는다", () => {
    expect(
      parseSlackPermalink(
        "https://example.slack.com/archives/C0AB/p1754400999123456?thread_ts=1754400000.123456&cid=C0AB",
      ),
    ).toEqual({ channel: "C0AB", ts: "1754400000.123456" });
  });

  it("공백은 허용하고 형식 위반은 null — 오타를 다른 스레드로 보내지 않는다", () => {
    expect(parseSlackPermalink("  https://x.slack.com/archives/D9/p1754400000123456  ")?.ts).toBe(
      "1754400000.123456",
    );
    expect(parseSlackPermalink("")).toBeNull();
    expect(parseSlackPermalink("그냥 텍스트")).toBeNull();
    expect(
      parseSlackPermalink("https://example.slack.com/archives/C0AB/1754400000123456"),
    ).toBeNull();
    expect(parseSlackPermalink("https://example.slack.com/archives/C0AB/p123")).toBeNull();
  });
});

describe("formatSlackTs", () => {
  it("KST 24시간 벽시계로 표기한다 — CLDR 판올림에 흔들리지 않게", () => {
    // 1786002161.805929 = 2026-08-06 16:42:41 KST
    expect(formatSlackTs("1786002161.805929")).toBe("16:42");
  });

  it("숫자가 아니면 빈 문자열 — 호출부가 ts 원문으로 폴백한다", () => {
    expect(formatSlackTs("")).toBe("");
    expect(formatSlackTs("ts")).toBe("");
  });
});
