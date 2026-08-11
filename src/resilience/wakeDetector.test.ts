import { describe, expect, it, vi } from "vitest";
import { CONTRACT } from "../core/constants.js";
import {
  createWakeDetector,
  isWakeDetectorEnabled,
  isWakeGap,
  WAKE_TICK_MS,
} from "./wakeDetector.js";

describe("isWakeGap", () => {
  it("임계 초과만 wake 로 판정", () => {
    expect(isWakeGap(CONTRACT.WAKE_GAP_THRESHOLD_MS + 1)).toBe(true);
    expect(isWakeGap(CONTRACT.WAKE_GAP_THRESHOLD_MS)).toBe(false);
    expect(isWakeGap(WAKE_TICK_MS)).toBe(false); // 정상 tick 간격은 wake 아님
  });
});

describe("isWakeDetectorEnabled", () => {
  it("darwin 은 env 미지정 시 기본 on", () => {
    expect(isWakeDetectorEnabled("darwin", undefined)).toBe(true);
  });

  it("linux 는 env 미지정 시 기본 off", () => {
    expect(isWakeDetectorEnabled("linux", undefined)).toBe(false);
  });

  it("env 강제 on/off 가 플랫폼보다 우선", () => {
    expect(isWakeDetectorEnabled("linux", "1")).toBe(true);
    expect(isWakeDetectorEnabled("linux", "true")).toBe(true);
    expect(isWakeDetectorEnabled("linux", "on")).toBe(true);
    expect(isWakeDetectorEnabled("darwin", "0")).toBe(false);
    expect(isWakeDetectorEnabled("darwin", "false")).toBe(false);
    expect(isWakeDetectorEnabled("darwin", "off")).toBe(false);
  });

  it("해석 불가 env 값은 플랫폼 기본값으로 강등", () => {
    expect(isWakeDetectorEnabled("darwin", "maybe")).toBe(true);
    expect(isWakeDetectorEnabled("linux", "maybe")).toBe(false);
  });
});

/**
 * 결정론 루프 하네스 — 주입한 clock 시퀀스를 tick 마다 소비한다.
 * sleep 은 실제 대기 없이 즉시 resolve 하되, clock 을 다음 값으로 진행시킨다.
 */
function harness(clockValues: number[]) {
  let idx = 0;
  const clock = {
    now() {
      const v = clockValues[Math.min(idx, clockValues.length - 1)];
      return v ?? 0;
    },
  };
  const advance = (): void => {
    idx = Math.min(idx + 1, clockValues.length - 1);
  };
  return { clock, advance };
}

/**
 * 루프를 결정론적으로 N tick 만 돌리고 스스로 종료시키는 드라이버.
 * sleep 은 매 호출마다 clock 을 다음 값으로 advance 하고, maxTicks 도달 시 AbortError 로
 * 루프를 끝낸다(loopDone 을 resolve). 테스트는 done 을 await 해 완료를 기다린다.
 */
function drive(clockValues: number[], maxTicks: number) {
  const { clock, advance } = harness(clockValues);
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let calls = 0;
  const sleep = async (): Promise<void> => {
    advance();
    if (++calls >= maxTicks) {
      resolveDone();
      throw new DOMException("aborted", "AbortError");
    }
  };
  return { clock, sleep, done };
}

describe("createWakeDetector 루프", () => {
  it("wall-clock gap 이 임계를 넘으면 onWake 를 호출한다", async () => {
    const big = CONTRACT.WAKE_GAP_THRESHOLD_MS + 60_000;
    // tick1: last=0 → sleep → now=big → gap 감지. tick2: 종료.
    const { clock, sleep, done } = drive([0, big, big + WAKE_TICK_MS], 2);
    const onWake = vi.fn();
    const det = createWakeDetector({ clock, onWake, tickMs: WAKE_TICK_MS, sleep });
    det.start();
    await done;
    await det.stop();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake.mock.calls[0]?.[0]).toBe(big);
  });

  it("정상 tick 간격(gap 작음)에는 onWake 를 부르지 않는다", async () => {
    const { clock, sleep, done } = drive([0, WAKE_TICK_MS, WAKE_TICK_MS * 2], 2);
    const onWake = vi.fn();
    const det = createWakeDetector({ clock, onWake, tickMs: WAKE_TICK_MS, sleep });
    det.start();
    await done;
    await det.stop();
    expect(onWake).not.toHaveBeenCalled();
  });

  it("onWake 예외는 루프를 죽이지 않는다", async () => {
    const big = CONTRACT.WAKE_GAP_THRESHOLD_MS + 60_000;
    const { clock, sleep, done } = drive([0, big, big * 2, big * 3], 3);
    const onWake = vi
      .fn()
      .mockRejectedValueOnce(new Error("reconnect 실패"))
      .mockResolvedValue(undefined);
    const det = createWakeDetector({ clock, onWake, tickMs: WAKE_TICK_MS, sleep });
    det.start();
    await done;
    await det.stop();
    // 첫 tick 에서 던졌지만 둘째 tick 도 실행됨 = 루프 생존
    expect(onWake).toHaveBeenCalledTimes(2);
  });
});
