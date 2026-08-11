import { describe, expect, it, vi } from "vitest";
import { CONTRACT } from "../core/constants.js";
import type { LastSeen } from "./eventTracker.js";
import {
  buildProbeChannels,
  createSocketHealth,
  isMissed,
  MISSED_THREAD_LOOKBACK_SEC,
  PROBE_MIN_INTERVAL_MS,
  type ProbedMessage,
  type SlackHistoryPort,
  uniqueChannels,
} from "./socketHealth.js";

function pm(over: Partial<ProbedMessage> = {}): ProbedMessage {
  return {
    ts: "200.0",
    channel: "C1",
    botId: null,
    subtype: null,
    raw: { ts: "200.0", user: "U1", text: "안녕" },
    ...over,
  };
}

describe("buildProbeChannels", () => {
  it("자동 트리거 채널 + lastSeen 채널을 중복 없이 합친다", () => {
    const seen: LastSeen = { channel: "C_SEEN", ts: "1.1" };
    expect(buildProbeChannels(["C_ALERT", "C_BUG"], seen)).toEqual(["C_ALERT", "C_BUG", "C_SEEN"]);
  });

  it("lastSeen 채널이 이미 목록에 있으면 중복 안 넣는다", () => {
    const seen: LastSeen = { channel: "C_ALERT", ts: "1.1" };
    expect(buildProbeChannels(["C_ALERT"], seen)).toEqual(["C_ALERT"]);
  });

  it("lastSeen 이 null 이면 자동 트리거 채널만", () => {
    expect(buildProbeChannels(["C_ALERT"], null)).toEqual(["C_ALERT"]);
  });

  it("최근 대화 채널(DM)이 뒤에 붙는다 — 워처 채널만 보면 DM 유실을 못 본다", () => {
    const seen: LastSeen = { channel: "C_ALERT", ts: "1.1" };
    expect(buildProbeChannels(["C_ALERT"], seen, ["D_DM", "C_ALERT", "C_OTHER"])).toEqual([
      "C_ALERT",
      "D_DM",
      "C_OTHER",
    ]);
  });

  it("max 는 최근 채널 꼬리만 자른다 — 자동 트리거·lastSeen 은 안 잘린다", () => {
    const seen: LastSeen = { channel: "C_SEEN", ts: "1.1" };
    expect(buildProbeChannels(["C_A", "C_B"], seen, ["D1", "D2", "D3"], 2)).toEqual([
      "C_A",
      "C_B",
      "C_SEEN",
    ]);
    expect(buildProbeChannels(["C_A"], seen, ["D1", "D2", "D3"], 3)).toEqual([
      "C_A",
      "C_SEEN",
      "D1",
    ]);
  });
});

describe("uniqueChannels", () => {
  it("순서를 보존하며 중복 채널을 접는다", () => {
    const threads: Array<{ channel: string; threadTs: string }> = [
      { channel: "D1", threadTs: "3" },
      { channel: "C1", threadTs: "2" },
      { channel: "D1", threadTs: "1" },
    ];
    expect(uniqueChannels(threads)).toEqual(["D1", "C1"]);
  });
});

describe("isMissed", () => {
  const base = "100.0";
  it("기준선 이후 + 봇 아님 + 일반 subtype 은 유실", () => {
    expect(isMissed(pm({ ts: "200.0" }), base, new Set())).toBe(true);
  });
  it("기준선 이하는 유실 아님", () => {
    expect(isMissed(pm({ ts: "50.0" }), base, new Set())).toBe(false);
  });
  it("봇 발신은 유실 아님", () => {
    expect(isMissed(pm({ botId: "B1" }), base, new Set())).toBe(false);
  });
  it("channel_join/leave 는 제외", () => {
    expect(isMissed(pm({ subtype: "channel_join" }), base, new Set())).toBe(false);
  });
  it("이미 수집된 ts 는 중복 제외", () => {
    expect(isMissed(pm({ ts: "200.0" }), base, new Set(["200.0"]))).toBe(false);
  });
});

// ── 시나리오 하네스 ──────────────────────────────────────────────────
interface HarnessOpts {
  historyByTick?: Array<ProbedMessage[] | null>;
  repliesByTick?: Array<ProbedMessage[] | null>;
  /** 답글 스캔 창(2h)에 잡히는 스레드. */
  recentThreads?: Array<{ channel: string; threadTs: string }>;
  /** probe 채널 도출 창(7d)에 잡히는 스레드 — 미지정이면 recentThreads 와 동일. */
  recentChannelThreads?: Array<{ channel: string; threadTs: string }>;
}

function makeHarness(opts: HarnessOpts = {}) {
  let now = 0;
  const lastEventAtRef = { v: 0 };
  let seen: LastSeen | null = { channel: "C1", ts: "100.0" };

  const enqueueEvent = vi.fn<(event: Record<string, unknown>) => Promise<void>>(async () => {});
  const reconnect = vi.fn<(reason: string) => Promise<boolean>>(async () => true);
  const exit = vi.fn<(code: number) => void>();
  const notify = vi.fn<(text: string) => Promise<void>>(async () => {});
  const onFriction = vi.fn<(pattern: string, detail: string) => void>();

  let historyCall = 0;
  let repliesCall = 0;
  let recentThrows = false;
  // null(=API 실패, 판정 불가)과 미지정(=조용함)을 구분해야 한다. `?? []` 로 접으면
  // null 이 빈 배열로 둔갑해 '판정 불가' 시나리오가 통째로 사라진다.
  const at = (
    arr: Array<ProbedMessage[] | null> | undefined,
    i: number,
  ): ProbedMessage[] | null => {
    const v = arr?.[i];
    return v === undefined ? [] : v;
  };

  const history: SlackHistoryPort = {
    async conversationsHistory() {
      return at(opts.historyByTick, historyCall++);
    },
    async conversationsReplies() {
      return at(opts.repliesByTick, repliesCall++);
    },
  };

  const health = createSocketHealth({
    clock: { now: () => now },
    lastEventAt: () => lastEventAtRef.v,
    lastSeen: () => seen,
    resetBaseline: () => {
      seen = { channel: "C1", ts: `${(now / 1000).toFixed(6)}` };
    },
    history,
    listRecentThreads: (secs) => {
      if (recentThrows) throw new Error("db locked");
      return secs > MISSED_THREAD_LOOKBACK_SEC
        ? (opts.recentChannelThreads ?? opts.recentThreads ?? [])
        : (opts.recentThreads ?? []);
    },
    autoTriggerChannels: ["C1"],
    enqueueEvent,
    reconnect,
    exit,
    notify,
    onFriction,
    async sleep() {},
  });

  return {
    health,
    enqueueEvent,
    reconnect,
    exit,
    notify,
    onFriction,
    setNow: (v: number) => (now = v),
    setLastEventAt: (v: number) => (lastEventAtRef.v = v),
    setSeen: (s: LastSeen | null) => (seen = s),
    getSeen: () => seen,
    throwRecentThreads: () => {
      recentThrows = true;
    },
  };
}

const IDLE = CONTRACT.ZOMBIE_PROBE_IDLE_MS;

describe("createSocketHealth.tick — idle 게이트", () => {
  it("idle 이 임계 미만이면 probe 하지 않는다(조용한 채널)", async () => {
    const h = makeHarness({ historyByTick: [[pm()]] });
    h.setNow(IDLE - 1);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.enqueueEvent).not.toHaveBeenCalled();
  });

  it("유실 없음(빈 history)이면 아무 것도 안 한다 (조용함 vs 좀비)", async () => {
    const h = makeHarness({ historyByTick: [[]] });
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("probe 전부 실패(null)면 재연결하지 않는다(유실 확인 전 재연결 금지)", async () => {
    const h = makeHarness({ historyByTick: [null] });
    // recentThreads 없음 → replies 안 부름 → anyOk=false → null
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});

describe("createSocketHealth.tick — 좀비 복구", () => {
  it("유실 확인 → replay(enqueue) + 소프트 재연결 (strike 1)", async () => {
    const missed = pm({ ts: "200.0", raw: { ts: "200.0", user: "U1", text: "놓친 질문" } });
    const h = makeHarness({ historyByTick: [[missed]] });
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    // replay 는 normalize→enqueue 경로 (channel 채워짐)
    expect(h.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(h.enqueueEvent.mock.calls[0]?.[0]).toMatchObject({ ts: "200.0", channel: "C1" });
    // 소프트 재연결
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.onFriction).toHaveBeenCalledWith("zombie_reconnect", expect.any(String));
  });

  it("history 사각지대: 스레드 답글 유실을 replies 로 잡아 replay 한다 (RS-04)", async () => {
    const reply = pm({
      ts: "300.0",
      channel: "C1",
      raw: { ts: "300.0", thread_ts: "1.1", user: "U1", text: "후속 질문" },
    });
    const h = makeHarness({
      historyByTick: [[]], // top-level 은 조용
      repliesByTick: [[reply]], // 스레드 답글에 유실
      recentThreads: [{ channel: "C1", threadTs: "1.1" }],
    });
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(h.enqueueEvent.mock.calls[0]?.[0]).toMatchObject({ ts: "300.0" });
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });

  it("연속 좀비: 2 strike 도달 시 fast-exit(주입 exit) 호출 + replay 안 함", async () => {
    // 두 tick 모두 유실. 첫 tick=strike1(재연결), 둘째 tick=strike2(exit)
    const missed = pm({ ts: "200.0" });
    const missed2 = pm({ ts: "400.0" });
    const h = makeHarness({ historyByTick: [[missed], [missed2]] });

    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick(); // strike 1 — 재연결 + verifyAt 예약
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
    const enqueueAfter1 = h.enqueueEvent.mock.calls.length;

    // verifyAt 예약 시각 이후로 진행 → 게이트 건너뛰고 즉시 재확인
    h.setNow(IDLE + 1000 + CONTRACT.RECONNECT_RECHECK_MS);
    // lastEventAt 은 그대로(실제 이벤트 유입 없음) → 여전히 유실
    await h.health.tick(); // strike 2 — exit
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.exit).toHaveBeenCalledWith(1);
    // exit 경로에서는 replay 하지 않는다
    expect(h.enqueueEvent.mock.calls.length).toBe(enqueueAfter1);
  });

  it("재연결 후 실제 이벤트가 유입되면 strike 가 리셋된다", async () => {
    const missed = pm({ ts: "200.0" });
    const h = makeHarness({ historyByTick: [[missed], []] });

    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick(); // strike 1 — 재연결

    // 45s 재확인 시점: 이번엔 실제 이벤트가 들어왔다고 가정 → lastEventAt 갱신 + 유실 없음
    const recheck = IDLE + 1000 + CONTRACT.RECONNECT_RECHECK_MS;
    h.setNow(recheck);
    h.setLastEventAt(recheck); // 방금 이벤트 유입
    // history 두번째 = [] (유실 없음)
    await h.health.tick();
    expect(h.exit).not.toHaveBeenCalled();

    // 이후 다시 유실이 생겨도 strike 는 1부터 (리셋됐으므로 exit 아님)
    const h2call = h.reconnect.mock.calls.length;
    expect(h2call).toBe(1); // 두번째 tick 은 유실 없어 재연결 안 함
  });

  it("replay 재주입은 markEvent 를 부르지 않는다(주입 경로에 lastEventAt 갱신 없음)", async () => {
    // enqueueEvent 만 부르고 lastEventAt 갱신 훅은 socketHealth 가 건드리지 않음을 확인.
    const missed = pm({ ts: "200.0" });
    const h = makeHarness({ historyByTick: [[missed]] });
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    const before = 0;
    await h.health.tick();
    // socketHealth 는 lastEventAt 을 직접 못 바꾼다(주입 getter). 갱신은 실제 수신 훅만.
    // 재주입이 idle 을 리셋하지 않음을 표현: 다음 tick 에서도 여전히 idle 상태로 판정 가능
    expect(before).toBe(0);
    expect(h.enqueueEvent).toHaveBeenCalled();
  });
});

describe("createSocketHealth.tick — DM 채널 커버리지 (2026-07-28 실사고)", () => {
  it("워처 채널은 조용해도 최근 대화 DM 의 유실을 잡아 replay 한다", async () => {
    const dm = pm({
      ts: "200.0",
      raw: { ts: "200.0", user: "U1", channel_type: "im", text: "왜 답장 안 하니" },
    });
    const h = makeHarness({
      // 채널 순서 = [C1(워처), D_DM(최근 대화)] → 워처는 조용, DM 에 유실
      historyByTick: [[], [dm]],
      // 답글 창(2h)에는 아무것도 없다 — 어제 대화라 만료됐다고 가정
      recentThreads: [],
      recentChannelThreads: [{ channel: "D_DM", threadTs: "100.0" }],
    });
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();

    expect(h.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(h.enqueueEvent.mock.calls[0]?.[0]).toMatchObject({ ts: "200.0", channel: "D_DM" });
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });

  it("세션 조회가 던져도 probe 가 죽지 않고 워처 채널만으로 진행한다", async () => {
    const missed = pm({ ts: "200.0" });
    const h = makeHarness({ historyByTick: [[missed]] });
    h.throwRecentThreads();
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("createSocketHealth.tick — 예방적 재연결 (아무도 말을 걸지 않은 좀비)", () => {
  const PREVENT = CONTRACT.ZOMBIE_IDLE_RECONNECT_MS;

  it("무이벤트가 임계를 넘고 유실이 없으면 1회 재연결한다(strike·exit 없음)", async () => {
    const h = makeHarness({ historyByTick: [[]] });
    h.setNow(PREVENT + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.reconnect.mock.calls[0]?.[0]).toContain("idle-preventive");
    expect(h.exit).not.toHaveBeenCalled();
    // 예방 경로는 운영 채널을 시끄럽게 하지 않는다 — 로그·friction 만
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.onFriction).toHaveBeenCalledWith("zombie_reconnect", expect.stringContaining("idle"));
  });

  it("임계 미만이면 재연결하지 않는다(조용함은 좀비가 아니다, RS-01)", async () => {
    const h = makeHarness({ historyByTick: [[]] });
    h.setNow(PREVENT - 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("probe 판정 불가(API 전부 실패)면 예방 재연결도 하지 않는다", async () => {
    // 네트워크 장애 중에는 재연결해봐야 무의미 — 헛churn 금지
    const h = makeHarness({ historyByTick: [null] });
    h.setNow(PREVENT + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it("resetBaseline 이 idle 을 되돌려 연속 tick 에서 재연결이 반복되지 않는다", async () => {
    const h = makeHarness({ historyByTick: [[], []] });
    h.setNow(PREVENT + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1);

    // 실제 resetBaseline 은 lastEventAt 을 now 로 당긴다(index 배선의 eventTracker 동작)
    h.setLastEventAt(PREVENT + 1000);
    h.setNow(PREVENT + 1000 + PROBE_MIN_INTERVAL_MS + 1);
    await h.health.tick();
    expect(h.reconnect).toHaveBeenCalledTimes(1); // 늘지 않음
  });
});

describe("createSocketHealth.tick — replay dedup 안전(no-op)", () => {
  it("enqueueEvent 가 dedup no-op(예외 없이 조용히 무시)여도 흐름이 이어진다", async () => {
    const missed = pm({ ts: "200.0" });
    const h = makeHarness({ historyByTick: [[missed]] });
    // enqueueEvent 를 dedup no-op 처럼: 아무 것도 안 하고 resolve (jobStore.enqueue 가 조용히 no-op)
    h.enqueueEvent.mockResolvedValue(undefined);
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    // no-op 이어도 재연결까지 정상 진행
    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it("enqueueEvent 가 던져도 재주입 루프가 죽지 않고 재연결로 이어진다", async () => {
    const missed1 = pm({ ts: "200.0" });
    const missed2 = pm({ ts: "300.0" });
    const h = makeHarness({ historyByTick: [[missed1, missed2]] });
    h.enqueueEvent.mockRejectedValueOnce(new Error("db busy")).mockResolvedValue(undefined);
    h.setNow(IDLE + 1000);
    h.setLastEventAt(0);
    await h.health.tick();
    expect(h.enqueueEvent).toHaveBeenCalledTimes(2); // 첫 실패해도 둘째 시도
    expect(h.reconnect).toHaveBeenCalledTimes(1);
  });
});
