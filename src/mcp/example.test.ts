import { describe, expect, it } from "vitest";
import {
  buildExampleUrl,
  EXAMPLE_MAX_CHARS,
  EXAMPLE_MAX_LIMIT,
  type ExampleRecord,
  exampleInputSchema,
  formatExampleResult,
} from "./example.js";

const INPUT = { query: "인보이스" };

describe("exampleInputSchema — 경계는 스키마다", () => {
  it("쓰기를 표현할 수 있는 필드가 없다", () => {
    const keys = Object.keys(exampleInputSchema.shape);
    expect(keys).toEqual(["query", "limit"]);
    expect(keys).not.toContain("method");
    expect(keys).not.toContain("body");
  });

  it("limit 상한을 넘기면 스키마가 거절한다 — 프롬프트가 아니라 여기서 막힌다", () => {
    expect(exampleInputSchema.safeParse({ query: "a", limit: EXAMPLE_MAX_LIMIT }).success).toBe(
      true,
    );
    expect(exampleInputSchema.safeParse({ query: "a", limit: EXAMPLE_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
  });

  it("빈 query 를 거절한다", () => {
    expect(exampleInputSchema.safeParse({ query: "" }).success).toBe(false);
  });
});

describe("buildExampleUrl", () => {
  it("쿼리를 인코딩해 파라미터 경계가 밀리지 않는다", () => {
    const url = buildExampleUrl("https://api.example.com", { query: "a&limit=999" });
    expect(new URL(url).searchParams.get("q")).toBe("a&limit=999");
    expect(new URL(url).searchParams.get("limit")).toBe("10");
  });

  it("limit 을 그대로 싣는다", () => {
    const url = buildExampleUrl("https://api.example.com", { query: "a", limit: 3 });
    expect(new URL(url).searchParams.get("limit")).toBe("3");
  });
});

describe("formatExampleResult", () => {
  const record = (id: string): ExampleRecord => ({
    id,
    title: `제목 ${id}`,
    updatedAt: "2026-08-11",
  });

  it("빈 결과를 빈 문자열이 아니라 문장으로 돌려준다", () => {
    expect(formatExampleResult([], INPUT)).toContain("없습니다");
  });

  it("한 줄에 한 건씩 요약한다", () => {
    expect(formatExampleResult([record("A"), record("B")], INPUT).split("\n")).toHaveLength(2);
  });

  it("상한을 넘으면 자르되 **잘랐다고 말한다** — 침묵하는 절단 금지", () => {
    const many = Array.from({ length: 2000 }, (_, i) => record(`ID${i}`));
    const out = formatExampleResult(many, INPUT);
    expect(out.length).toBeGreaterThan(EXAMPLE_MAX_CHARS);
    expect(out).toContain("잘렸습니다");
  });
});
