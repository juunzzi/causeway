import { describe, expect, it } from "vitest";
import {
  createStatusPicker,
  pickPlainStatus,
  pickStatusIndex,
  STATUS_POOL,
  shortModelLabel,
} from "./statusPool.js";

describe("shortModelLabel", () => {
  it("모델 ID → 짧은 라벨", () => {
    expect(shortModelLabel("claude-sonnet-5")).toBe("sonnet");
    expect(shortModelLabel("claude-opus-4-8")).toBe("opus");
    expect(shortModelLabel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(shortModelLabel("claude-fable-5")).toBe("fable");
  });
  it("알 수 없는 값은 그대로, 빈 값은 빈 문자열", () => {
    expect(shortModelLabel("some-custom")).toBe("some-custom");
    expect(shortModelLabel(null)).toBe("");
    expect(shortModelLabel(undefined)).toBe("");
  });
});

describe("pickStatusIndex", () => {
  it("직전 인덱스는 한 번 회피한다", () => {
    // rand=0 → idx 0. lastIdx=0 이면 (0+1)%len 로 밀린다.
    expect(pickStatusIndex(5, 0, () => 0)).toBe(1);
    expect(pickStatusIndex(5, -1, () => 0)).toBe(0);
  });
  it("rand()===1 경계에서 배열 밖으로 안 나간다", () => {
    expect(pickStatusIndex(3, -1, () => 1)).toBe(2);
  });
  it("빈 풀은 -1", () => {
    expect(pickStatusIndex(0, -1, () => 0.5)).toBe(-1);
  });
  it("풀 길이 1 이면 회피 없이 항상 0 (무한 루프 방지)", () => {
    expect(pickStatusIndex(1, 0, () => 0)).toBe(0);
    expect(pickStatusIndex(1, 0, () => 0.99)).toBe(0);
  });
});

describe("createStatusPicker", () => {
  it("resume 여부로 풀을 고르고 모델 접미사를 붙인다", () => {
    const rand = () => 0; // 항상 idx 0 후보
    const fresh = createStatusPicker({ isResume: false, model: "claude-sonnet-5", rand });
    // 첫 호출 lastIdx=-1 → idx 0
    expect(fresh()).toBe(`_⏳ ${STATUS_POOL.fresh[0]} · sonnet_`);
    // 둘째 호출: 직전(0) 회피 → idx 1
    expect(fresh()).toBe(`_⏳ ${STATUS_POOL.fresh[1]} · sonnet_`);

    const resume = createStatusPicker({ isResume: true, model: "claude-opus-4-8", rand });
    expect(resume()).toBe(`_⏳ ${STATUS_POOL.resume[0]} · opus_`);
  });
  it("모델 없으면 접미사 없이", () => {
    const p = createStatusPicker({ isResume: false, model: null, rand: () => 0 });
    expect(p()).toBe(`_⏳ ${STATUS_POOL.fresh[0]}_`);
  });
  it("isResume 를 함수로 주면 매 호출마다 평가해 풀을 전환한다 (세션 만료 대응)", () => {
    let resume = true;
    const p = createStatusPicker({
      isResume: () => resume,
      model: "claude-sonnet-5",
      rand: () => 0,
    });
    // 풀 소속으로 검증 — 정확 인덱스는 직전-회피 로직에 종속되므로 단언하지 않는다.
    const first = p();
    expect(STATUS_POOL.resume.some((x) => first.includes(x))).toBe(true); // 처음엔 resume 풀
    resume = false; // 세션 만료 → fresh 로 전환
    const second = p();
    expect(STATUS_POOL.fresh.some((x) => second.includes(x))).toBe(true); // 전환 후 fresh 풀
    expect(STATUS_POOL.resume.some((x) => second.includes(x))).toBe(false);
  });
});

describe("pickPlainStatus", () => {
  it("fresh 풀에서 뽑고 모델 접미사를 붙인다 — 마크다운/⏳ 없이 평문", () => {
    // rand=0 → idx 0 (lastIdx=-1 이라 회피 없음)
    expect(pickPlainStatus({ isResume: false, model: "claude-sonnet-5", rand: () => 0 })).toBe(
      `${STATUS_POOL.fresh[0]} · sonnet`,
    );
  });
  it("resume 풀에서 뽑고 모델 접미사를 붙인다", () => {
    expect(pickPlainStatus({ isResume: true, model: "claude-opus-4-8", rand: () => 0 })).toBe(
      `${STATUS_POOL.resume[0]} · opus`,
    );
  });
  it("모델 없으면 접미사 없이 문구만", () => {
    expect(pickPlainStatus({ isResume: false, model: null, rand: () => 0 })).toBe(
      STATUS_POOL.fresh[0] as string,
    );
  });
  it("rand 주입으로 풀 내 인덱스를 결정론적으로 고른다", () => {
    // rand=0.99 → 마지막 인덱스(fresh 길이 5 → idx 4)
    expect(pickPlainStatus({ isResume: false, model: null, rand: () => 0.99 })).toBe(
      STATUS_POOL.fresh[STATUS_POOL.fresh.length - 1] as string,
    );
  });
  it("반환에 마크다운/⏳ 이모지를 포함하지 않는다", () => {
    const s = pickPlainStatus({ isResume: false, model: "claude-sonnet-5", rand: () => 0 });
    expect(s).not.toContain("⏳");
    expect(s).not.toContain("_");
  });
});
