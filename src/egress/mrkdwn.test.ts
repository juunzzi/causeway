import { describe, expect, it } from "vitest";
import { mdToMrkdwn, unwrapFullCodeBlock } from "./mrkdwn.js";

describe("mdToMrkdwn — 변환표", () => {
  it("굵게: ** → *", () => {
    expect(mdToMrkdwn("**중요** 그리고 **강조**")).toBe("*중요* 그리고 *강조*");
  });

  it("헤딩 → 굵게 (레벨 무관)", () => {
    expect(mdToMrkdwn("# 제목\n## 소제목\n###### 깊은 제목")).toBe("*제목*\n*소제목*\n*깊은 제목*");
  });

  it("해시 뒤 공백 없는 라인은 헤딩이 아니다", () => {
    expect(mdToMrkdwn("#태그 언급")).toBe("#태그 언급");
  });

  it("링크: [t](u) → <u|t>", () => {
    expect(mdToMrkdwn("[문서](https://example.com/a)")).toBe("<https://example.com/a|문서>");
  });

  it("리스트 마커는 유지", () => {
    const text = "- 첫째\n- 둘째\n1. 하나\n2. 둘";
    expect(mdToMrkdwn(text)).toBe(text);
  });

  it("코드펜스 내부는 변환하지 않는다", () => {
    const out = mdToMrkdwn("앞 **굵게**\n```\n**코드 그대로**\n# 주석\n```\n뒤 **굵게**");
    expect(out).toBe("앞 *굵게*\n```\n**코드 그대로**\n# 주석\n```\n뒤 *굵게*");
  });
});

describe("unwrapFullCodeBlock — 전체 코드블록 벗기기 (EG-05)", () => {
  it("전체가 ``` 로 감싸진 입력은 내용만 남긴다", () => {
    expect(unwrapFullCodeBlock("```\n리포트 본문\n두번째 줄\n```")).toBe("리포트 본문\n두번째 줄");
  });

  it("언어 힌트가 있어도 벗긴다", () => {
    expect(unwrapFullCodeBlock("```markdown\n# 제목\n```")).toBe("# 제목");
  });

  it("mdToMrkdwn 은 벗긴 뒤 변환까지 수행한다", () => {
    expect(mdToMrkdwn("```markdown\n# 제목\n**내용**\n```")).toBe("*제목*\n*내용*");
  });

  it("내부에 다른 펜스가 있으면 전체 감싸기가 아니므로 손대지 않는다", () => {
    const text = "```\na\n```\n산문\n```\nb\n```";
    expect(unwrapFullCodeBlock(text)).toBe(text);
  });

  it("부분 펜스만 있는 입력은 그대로", () => {
    const text = "산문\n```\n코드\n```";
    expect(unwrapFullCodeBlock(text)).toBe(text);
  });

  it("앞뒤 공백이 있어도 전체 감싸기로 인식한다", () => {
    expect(unwrapFullCodeBlock("\n```\n본문\n```\n")).toBe("본문");
  });
});
