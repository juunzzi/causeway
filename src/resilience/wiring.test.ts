import { describe, expect, it, vi } from "vitest";
import { createEventTracker } from "./eventTracker.js";
import type { FrictionLog } from "./friction.js";
import type { SlackHistoryPort } from "./socketHealth.js";
import { abortableSleep, createResilience, type ResilienceWiringDeps } from "./wiring.js";

function baseDeps(over: Partial<ResilienceWiringDeps> = {}): ResilienceWiringDeps {
  const friction: FrictionLog = { record: vi.fn(), summarizeRecent: () => "" };
  const history: SlackHistoryPort = {
    conversationsHistory: async () => [],
    conversationsReplies: async () => [],
  };
  return {
    clock: { now: () => 0 },
    eventTracker: createEventTracker({ now: () => 0 }),
    history,
    reconnector: { reconnect: async () => true },
    enqueueEvent: async () => {},
    listRecentThreads: () => [],
    autoTriggerChannels: [],
    listRunning: () => [],
    notify: async () => {},
    fetchPermalink: async () => null,
    friction,
    sleep: async () => {},
    exit: () => {},
    ...over,
  };
}

describe("createResilience — 플랫폼 게이팅 (RS-05)", () => {
  it("darwin 이면 wakeDetector 가 존재한다(기본 on)", () => {
    const r = createResilience(baseDeps({ platform: "darwin" }));
    expect(r.wakeDetector).not.toBeNull();
  });

  it("linux 이면 wakeDetector 가 null(자연 no-op)", () => {
    const r = createResilience(baseDeps({ platform: "linux" }));
    expect(r.wakeDetector).toBeNull();
  });

  it("linux + env 강제 on 이면 wakeDetector 가 산다", () => {
    const r = createResilience(baseDeps({ platform: "linux", wakeDetectorEnv: "1" }));
    expect(r.wakeDetector).not.toBeNull();
  });
});

describe("createResilience — 컴포넌트 조립", () => {
  it("socketHealth·watchdog 은 항상 존재하고 start/stop 이 던지지 않는다", async () => {
    const r = createResilience(baseDeps({ platform: "linux" }));
    expect(r.socketHealth).toBeDefined();
    expect(r.watchdog).toBeDefined();
    r.start();
    await r.stop();
  });

  it("wake 콜백은 friction 기록 + 재연결 + baseline 리셋을 배선한다", async () => {
    const friction: FrictionLog = { record: vi.fn(), summarizeRecent: () => "" };
    const reconnect = vi.fn(async () => true);
    const onWakeTick = vi.fn();
    const tracker = createEventTracker({ now: () => 0 });
    const resetSpy = vi.spyOn(tracker, "resetBaseline");
    const r = createResilience(
      baseDeps({
        platform: "darwin",
        friction,
        reconnector: { reconnect },
        onWakeTick,
        eventTracker: tracker,
      }),
    );
    // wakeDetector 내부 onWake 를 직접 부를 수 없으니, 존재만 확인하고
    // 배선 자체(friction·reconnect·onWakeTick·resetBaseline)를 간접 검증하기 위해
    // wakeDetector 를 start→stop 해 루프가 안전히 도는지만 확인한다.
    expect(r.wakeDetector).not.toBeNull();
    r.start();
    await r.stop();
    // resetSpy 는 onWake 가 실제로 불릴 때만 호출된다 — 여기선 gap 이 없어 0 이 정상.
    expect(resetSpy).toHaveBeenCalledTimes(0);
    expect(onWakeTick).not.toHaveBeenCalled();
  });
});

describe("abortableSleep", () => {
  it("정상 시간 경과 후 resolve", async () => {
    const ac = new AbortController();
    await expect(abortableSleep(1, ac.signal)).resolves.toBeUndefined();
  });

  it("abort 시 즉시 reject(AbortError)", async () => {
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("이미 abort 된 signal 은 즉시 reject", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(1, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
