import { describe, expect, it, vi } from "vitest";
import { CONTRACT } from "../core/constants.js";
import type { RunningChatTaskInfo } from "../jobs/chat/runningTasks.js";
import { buildStallNotice, createWatchdog, decideStalls, type StallTrack } from "./watchdog.js";

function task(over: Partial<RunningChatTaskInfo> = {}): RunningChatTaskInfo {
  return {
    threadKey: "C1:1.1",
    channel: "C1",
    threadTs: "1.1",
    ts: "1.1",
    startedAt: 0,
    lastStep: "분석 중",
    progressTs: "9.9",
    userCancelled: false,
    ...over,
  };
}

describe("buildStallNotice", () => {
  it("permalink 있으면 링크로 감싸고 경과·정체·스텝 포함", () => {
    const out = buildStallNotice({
      permalink: "https://slack/x",
      elapsedMs: 300_000,
      idleMs: 180_000,
      lastStep: "Bash: pnpm test",
    });
    expect(out).toContain("<https://slack/x|진행 스레드>");
    expect(out).toContain("경과 `300s`");
    expect(out).toContain("`180s` 무진행");
    expect(out).toContain("Bash: pnpm test");
  });

  it("permalink 없으면 링크 없이", () => {
    const out = buildStallNotice({ permalink: null, elapsedMs: 0, idleMs: 0, lastStep: null });
    expect(out).toContain("작업 멈춤 의심");
    expect(out).not.toContain("<http");
    expect(out).toContain("(스텝 없음)");
  });

  it("permalink 없어도 threadKey 가 있으면 실어 어느 작업인지 식별된다", () => {
    const out = buildStallNotice({
      permalink: null,
      elapsedMs: 0,
      idleMs: 0,
      lastStep: null,
      threadKey: "D0CCCCCCCCC:1785744951.377899",
    });
    expect(out).toContain("D0CCCCCCCCC:1785744951.377899");
    expect(out).not.toContain("<http");
  });

  it("permalink 가 있으면 링크를 우선한다(threadKey 는 폴백 전용)", () => {
    const out = buildStallNotice({
      permalink: "https://slack/x",
      elapsedMs: 0,
      idleMs: 0,
      lastStep: null,
      threadKey: "C1:1.1",
    });
    expect(out).toContain("<https://slack/x|진행 스레드>");
    expect(out).not.toContain("C1:1.1");
  });
});

describe("decideStalls (순수 판정)", () => {
  const stall = CONTRACT.WATCHDOG_STALL_MS;

  it("최초 관측은 타이머만 시작(통보 없음)", () => {
    const { nextTracks, toNotify } = decideStalls([task()], new Map(), 1000);
    expect(toNotify).toEqual([]);
    expect(nextTracks.get("C1:1.1")?.changedAt).toBe(1000);
    expect(nextTracks.get("C1:1.1")?.notified).toBe(false);
  });

  it("스텝이 안 바뀐 채 stallMs 경과하면 통보 대상", () => {
    const prev = new Map<string, StallTrack>([
      ["C1:1.1", { lastStep: "분석 중", changedAt: 0, notified: false }],
    ]);
    const { toNotify, nextTracks } = decideStalls([task()], prev, stall);
    expect(toNotify).toHaveLength(1);
    expect(nextTracks.get("C1:1.1")?.notified).toBe(true);
  });

  it("stallMs 직전이면 통보 안 함", () => {
    const prev = new Map<string, StallTrack>([
      ["C1:1.1", { lastStep: "분석 중", changedAt: 0, notified: false }],
    ]);
    const { toNotify } = decideStalls([task()], prev, stall - 1);
    expect(toNotify).toEqual([]);
  });

  it("스텝이 바뀌면 타이머 리셋 → stall 로 안 잡힘", () => {
    const prev = new Map<string, StallTrack>([
      ["C1:1.1", { lastStep: "이전 스텝", changedAt: 0, notified: false }],
    ]);
    const { toNotify, nextTracks } = decideStalls([task({ lastStep: "새 스텝" })], prev, stall);
    expect(toNotify).toEqual([]);
    expect(nextTracks.get("C1:1.1")?.changedAt).toBe(stall);
  });

  it("이미 통보한 스레드는 다시 통보하지 않는다(1회만)", () => {
    const prev = new Map<string, StallTrack>([
      ["C1:1.1", { lastStep: "분석 중", changedAt: 0, notified: true }],
    ]);
    const { toNotify } = decideStalls([task()], prev, stall * 3);
    expect(toNotify).toEqual([]);
  });

  it("사라진 스레드는 다음 추적에서 자연 정리", () => {
    const prev = new Map<string, StallTrack>([
      ["C1:1.1", { lastStep: "분석 중", changedAt: 0, notified: true }],
    ]);
    const { nextTracks } = decideStalls([], prev, 100);
    expect(nextTracks.size).toBe(0);
  });
});

describe("createWatchdog.tick", () => {
  const stall = CONTRACT.WATCHDOG_STALL_MS;

  function makeDeps(running: RunningChatTaskInfo[]) {
    let now = 0;
    const notify = vi.fn<(text: string) => Promise<void>>(async () => {});
    const onStall = vi.fn<(task: RunningChatTaskInfo) => void>();
    const fetchPermalink = vi.fn<(c: string, t: string) => Promise<string | null>>(
      async () => "https://slack/link",
    );
    const wd = createWatchdog({
      clock: { now: () => now },
      listRunning: () => running,
      notify,
      onStall,
      fetchPermalink,
      async sleep() {},
      stallMs: stall,
    });
    return { wd, notify, onStall, fetchPermalink, setNow: (v: number) => (now = v) };
  }

  it("정확히 1회만 통보한다", async () => {
    const running = [task()];
    const { wd, notify, onStall, setNow } = makeDeps(running);
    // 1차: 최초 관측 (통보 없음)
    setNow(0);
    await wd.tick();
    expect(notify).not.toHaveBeenCalled();
    // 2차: stall 경과 → 통보
    setNow(stall);
    await wd.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    // 3차: 여전히 stall 이지만 재통보 안 함
    setNow(stall * 3);
    await wd.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("progressTs 있으면 permalink 를 조회해 링크를 넣는다", async () => {
    const { wd, notify, fetchPermalink, setNow } = makeDeps([task({ progressTs: "9.9" })]);
    setNow(0);
    await wd.tick();
    setNow(stall);
    await wd.tick();
    expect(fetchPermalink).toHaveBeenCalledWith("C1", "9.9");
    expect(notify.mock.calls[0]?.[0]).toContain("https://slack/link");
  });

  it("통보 실패 시 notified 를 되돌려 다음 tick 에 재시도", async () => {
    const running = [task()];
    let now = 0;
    const notify = vi
      .fn<(t: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("slack down"))
      .mockResolvedValue(undefined);
    const wd = createWatchdog({
      clock: { now: () => now },
      listRunning: () => running,
      notify,
      fetchPermalink: async () => null,
      async sleep() {},
      stallMs: stall,
    });
    now = 0;
    await wd.tick();
    now = stall;
    await wd.tick(); // 통보 시도 → 실패
    now = stall + 1;
    await wd.tick(); // 재시도 → 성공
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
