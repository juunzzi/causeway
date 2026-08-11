import { describe, expect, it } from "vitest";
import { createEventTracker, tsGreater } from "./eventTracker.js";

describe("tsGreater", () => {
  it("숫자 비교로 나중 여부 판정", () => {
    expect(tsGreater("1000.000200", "1000.000100")).toBe(true);
    expect(tsGreater("1000.000100", "1000.000200")).toBe(false);
    expect(tsGreater("1000.0", "1000.0")).toBe(false);
  });

  it("파싱 불가는 false(보수적)", () => {
    expect(tsGreater("x", "1000.0")).toBe(false);
    expect(tsGreater("1000.0", "y")).toBe(false);
  });
});

describe("createEventTracker", () => {
  it("markEvent 는 lastEventAt 을 현재 clock 으로 갱신한다", () => {
    let t = 1000;
    const tracker = createEventTracker({ now: () => t });
    expect(tracker.lastEventAt()).toBe(1000);
    t = 5000;
    tracker.markEvent("C1", "1.1");
    expect(tracker.lastEventAt()).toBe(5000);
  });

  it("lastSeen 은 ts 가 더 큰 좌표만 유지한다", () => {
    const tracker = createEventTracker({ now: () => 0 });
    tracker.markEvent("C1", "100.0");
    tracker.markEvent("C2", "200.0");
    expect(tracker.lastSeen()).toEqual({ channel: "C2", ts: "200.0" });
    // 더 오래된 ts 는 무시
    tracker.markEvent("C3", "150.0");
    expect(tracker.lastSeen()).toEqual({ channel: "C2", ts: "200.0" });
  });

  it("channel/ts 없는 markEvent 는 좌표를 바꾸지 않지만 idle 은 리셋한다", () => {
    let t = 1000;
    const tracker = createEventTracker({ now: () => t });
    tracker.markEvent("C1", "100.0");
    t = 2000;
    tracker.markEvent();
    expect(tracker.lastEventAt()).toBe(2000);
    expect(tracker.lastSeen()).toEqual({ channel: "C1", ts: "100.0" });
  });

  it("resetBaseline 은 좌표 ts 를 '지금'으로 당긴다", () => {
    let t = 1_000_000;
    const tracker = createEventTracker({ now: () => t });
    tracker.markEvent("C1", "100.0");
    t = 2_000_000; // 2000초
    tracker.resetBaseline();
    const seen = tracker.lastSeen();
    // ts 는 now/1000 = 2000.000000
    expect(seen?.ts).toBe("2000.000000");
    expect(tracker.lastEventAt()).toBe(2_000_000);
  });
});
