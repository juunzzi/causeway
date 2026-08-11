import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Clock } from "../clock.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrations.js";
import { buildRegistry } from "../registry.js";
import { Dispatcher, type DispatcherConfig } from "./dispatcher.js";
import { JobStore } from "./jobStore.js";
import { LeaseManager } from "./lease.js";
import type { AnyJobHandler, Job, JobContext, Lane } from "./types.js";

class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Setup {
  store: JobStore;
  dispatcher: Dispatcher;
  errors: unknown[];
}

function setup(
  handlers: readonly AnyJobHandler[],
  opts: { clock?: Clock; cfg?: DispatcherConfig } = {},
): Setup {
  const db = openDatabase(":memory:");
  migrate(db);
  const store = new JobStore(db, opts.clock);
  const lease = new LeaseManager(db, { clock: opts.clock });
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher(
    {
      store,
      registry: buildRegistry(handlers),
      lease,
      clock: opts.clock,
      onError: (err) => errors.push(err),
    },
    // 폴링을 사실상 꺼서(60s) 테스트가 이벤트 wakeup·수동 wake 경로만 타게 한다.
    { pollIntervalMs: 60_000, ...opts.cfg },
  );
  return { store, dispatcher, errors };
}

function enqueue(
  store: JobStore,
  overrides: {
    dedupKey: string;
    lane: Lane;
    laneKey?: string;
    payload?: unknown;
    type?: string;
    maxAttempts?: number;
  },
): void {
  store.enqueue({
    type: overrides.type ?? "test-job",
    dedupKey: overrides.dedupKey,
    lane: overrides.lane,
    laneKey: overrides.laneKey ?? null,
    payload: overrides.payload ?? {},
    maxAttempts: overrides.maxAttempts ?? 2,
  });
}

function recordingHandler(
  events: string[],
  opts: { type?: string; lane?: Lane; delayMs?: number } = {},
): AnyJobHandler {
  return {
    type: opts.type ?? "test-job",
    lane: opts.lane ?? "interactive",
    maxAttempts: 2,
    payloadSchema: z.object({ n: z.number().optional() }),
    run: async (job: Job) => {
      const n = (job.payload as { n?: number }).n ?? 0;
      events.push(`start:${n}`);
      await sleep(opts.delayMs ?? 20);
      events.push(`end:${n}`);
      return "done";
    },
  };
}

describe("Dispatcher interactive 레인 (JQ-07)", () => {
  it("같은 lane_key(thread_key)는 직렬 — 순서 보장", async () => {
    const events: string[] = [];
    const { store, dispatcher } = setup([recordingHandler(events)]);
    enqueue(store, { dedupKey: "j1", lane: "interactive", laneKey: "C1:100", payload: { n: 1 } });
    enqueue(store, { dedupKey: "j2", lane: "interactive", laneKey: "C1:100", payload: { n: 2 } });
    dispatcher.start();
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(2), { timeout: 3_000 });
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    await dispatcher.stop();
  });

  it("다른 lane_key는 병렬 — 둘 다 시작된 뒤에 끝난다", async () => {
    const events: string[] = [];
    const { store, dispatcher } = setup([recordingHandler(events, { delayMs: 40 })]);
    enqueue(store, { dedupKey: "j1", lane: "interactive", laneKey: "T1", payload: { n: 1 } });
    enqueue(store, { dedupKey: "j2", lane: "interactive", laneKey: "T2", payload: { n: 2 } });
    dispatcher.start();
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(2), { timeout: 3_000 });
    expect(events.slice(0, 2).every((e) => e.startsWith("start:"))).toBe(true);
    await dispatcher.stop();
  });

  it("동시성 상한(N=2 주입)을 넘는 잡은 슬롯 반환을 기다린다", async () => {
    const events: string[] = [];
    const { store, dispatcher } = setup([recordingHandler(events, { delayMs: 30 })], {
      cfg: { interactiveConcurrency: 2 },
    });
    for (const n of [1, 2, 3]) {
      enqueue(store, {
        dedupKey: `j${n}`,
        lane: "interactive",
        laneKey: `T${n}`,
        payload: { n },
      });
    }
    dispatcher.start();
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(3), { timeout: 3_000 });
    // 3번째 start는 반드시 어떤 end 뒤에 온다 — 동시 실행이 2를 넘지 않았다는 뜻.
    const thirdStart = events.indexOf("start:3");
    const firstEnd = events.findIndex((e) => e.startsWith("end:"));
    expect(thirdStart).toBeGreaterThan(firstEnd);
    await dispatcher.stop();
  });

  it("enqueue → 실행 시작 지연 < 50ms (EventEmitter 즉시 wakeup, 폴링 퇴행 방지)", async () => {
    let latencyMs = -1;
    let startedAt = 0;
    const handler: AnyJobHandler = {
      type: "test-job",
      lane: "interactive",
      maxAttempts: 1,
      payloadSchema: z.unknown(),
      run: async () => {
        latencyMs = performance.now() - startedAt;
        return "done";
      },
    };
    const { store, dispatcher } = setup([handler]);
    dispatcher.start();
    startedAt = performance.now();
    enqueue(store, { dedupKey: "fast", lane: "interactive" });
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(1), { timeout: 3_000 });
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(latencyMs).toBeLessThan(50);
    await dispatcher.stop();
  });
});

describe("Dispatcher automation 레인 (JQ-07)", () => {
  it("직렬 drain + tick당 상한 — 초과분은 다음 tick(wake)으로 이월된다", async () => {
    const events: string[] = [];
    const { store, dispatcher } = setup(
      [recordingHandler(events, { lane: "automation", delayMs: 5 })],
      { cfg: { automationMaxPerTick: 1 } },
    );
    enqueue(store, { dedupKey: "a1", lane: "automation", payload: { n: 1 } });
    enqueue(store, { dedupKey: "a2", lane: "automation", payload: { n: 2 } });
    dispatcher.start();
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(1), { timeout: 3_000 });
    await sleep(30);
    // 상한에 걸린 잡은 사라지지 않고 pending으로 남는다 (silent cap 아님).
    expect(store.countByStatus().pending).toBe(1);
    dispatcher.wake("automation");
    await vi.waitFor(() => expect(store.countByStatus().done).toBe(2), { timeout: 3_000 });
    await dispatcher.stop();
  });

  it("실행 실패는 백오프 requeue — not_before 도래 후 재시도해 성공한다", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const handler: AnyJobHandler = {
      type: "flaky",
      lane: "automation",
      maxAttempts: 3,
      payloadSchema: z.unknown(),
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("일시 오류");
        return "done";
      },
    };
    const { store, dispatcher, errors } = setup([handler], {
      clock,
      cfg: { backoffMs: () => 30_000 },
    });
    enqueue(store, { dedupKey: "bk", lane: "automation", type: "flaky", maxAttempts: 3 });
    dispatcher.start();
    await vi.waitFor(() => {
      expect(store.getByDedupKey("bk")?.status).toBe("pending");
      expect(store.getByDedupKey("bk")?.attempts).toBe(1);
    });
    expect(store.getByDedupKey("bk")?.notBefore).toBe(clock.now() + 30_000);
    expect(errors).toHaveLength(1);

    // 백오프 미도래 상태에서는 wake해도 집지 않는다.
    dispatcher.wake("automation");
    await sleep(20);
    expect(store.getByDedupKey("bk")?.status).toBe("pending");

    clock.advance(30_000);
    dispatcher.wake("automation");
    await vi.waitFor(() => expect(store.getByDedupKey("bk")?.status).toBe("done"));
    expect(store.getByDedupKey("bk")?.attempts).toBe(2);
    await dispatcher.stop();
  });

  it("재시도 소진 시 failed 종결 + onExhausted 통보 — silent cap 금지 (JQ-06)", async () => {
    const exhausted: number[] = [];
    const handler: AnyJobHandler = {
      type: "doomed",
      lane: "automation",
      maxAttempts: 2,
      payloadSchema: z.unknown(),
      run: async () => {
        throw new Error("항상 실패");
      },
      onExhausted: async (job) => {
        exhausted.push(job.id);
      },
    };
    const { store, dispatcher } = setup([handler], { cfg: { backoffMs: () => 0 } });
    enqueue(store, { dedupKey: "dm", lane: "automation", type: "doomed", maxAttempts: 2 });
    dispatcher.start();
    await vi.waitFor(() => expect(store.getByDedupKey("dm")?.status).toBe("failed"));
    expect(store.getByDedupKey("dm")?.attempts).toBe(2);
    expect(exhausted).toHaveLength(1);
    await dispatcher.stop();
  });

  it("payload 스키마 불일치는 재시도 없이 failed + onExhausted (ADR-0001)", async () => {
    const exhausted: number[] = [];
    let ran = false;
    const handler: AnyJobHandler = {
      type: "strict",
      lane: "automation",
      maxAttempts: 3,
      payloadSchema: z.object({ schema_version: z.literal(1) }),
      run: async () => {
        ran = true;
        return "done";
      },
      onExhausted: async (job) => {
        exhausted.push(job.id);
      },
    };
    const { store, dispatcher } = setup([handler]);
    enqueue(store, {
      dedupKey: "bad",
      lane: "automation",
      type: "strict",
      payload: { schema_version: 999 },
    });
    dispatcher.start();
    await vi.waitFor(() => expect(store.getByDedupKey("bad")?.status).toBe("failed"));
    expect(ran).toBe(false);
    expect(store.getByDedupKey("bad")?.attempts).toBe(1);
    expect(store.getByDedupKey("bad")?.error).toContain("스키마 불일치");
    expect(exhausted).toHaveLength(1);
    await dispatcher.stop();
  });

  it("미등록 잡 타입은 즉시 failed 하지 않고 pending 으로 requeue 된다 (부팅 레이스 방어)", async () => {
    const clock = new FakeClock();
    // 백오프를 걸어 같은 부팅 안에서 tight-loop 재claim 을 막는다(현실 동작 재현).
    const { store, dispatcher, errors } = setup([], { clock, cfg: { backoffMs: () => 60_000 } });
    enqueue(store, { dedupKey: "ghost", lane: "automation", type: "ghost", maxAttempts: 2 });
    dispatcher.start();
    // 즉시 failed 가 아니라 pending 재전환(복구 가능) — 잡이 소실되지 않는다.
    await vi.waitFor(() => {
      expect(store.getByDedupKey("ghost")?.status).toBe("pending");
      expect(store.getByDedupKey("ghost")?.attempts).toBe(1);
    });
    // 소실이 아님을 관찰 훅에 명확히 남긴다(requeue 통보).
    expect(errors.some((e) => String(e).includes("requeue"))).toBe(true);
    expect(store.getByDedupKey("ghost")?.status).not.toBe("failed");
    await dispatcher.stop();
  });

  it("미등록이 attempts 상한까지 지속되면 그때 failed + loud (무한 루프 방지)", async () => {
    const clock = new FakeClock();
    const { store, dispatcher, errors } = setup([], { clock, cfg: { backoffMs: () => 60_000 } });
    enqueue(store, { dedupKey: "ghost2", lane: "automation", type: "ghost2", maxAttempts: 2 });
    dispatcher.start();
    // 1회차: pending 재전환(attempts=1)
    await vi.waitFor(() => expect(store.getByDedupKey("ghost2")?.attempts).toBe(1));
    expect(store.getByDedupKey("ghost2")?.status).toBe("pending");

    // 백오프 도래 후 재claim → attempts=2 = maxAttempts → 이번엔 최종 failed.
    // 매 폴에서 다시 wake — 직전 drain 이 아직 안 끝났으면 wake 가 no-op 이라 재시도가 필요하다.
    clock.advance(60_000);
    await vi.waitFor(() => {
      dispatcher.wake("automation");
      expect(store.getByDedupKey("ghost2")?.status).toBe("failed");
    });
    expect(store.getByDedupKey("ghost2")?.attempts).toBe(2);
    // 최종 종결은 반드시 loud — '상한 초과' 문구로 운영에 드러난다.
    expect(errors.some((e) => String(e).includes("상한 초과"))).toBe(true);
    await dispatcher.stop();
  });

  it("크래시/재시작 시나리오: 첫 부팅 미등록→pending, 둘째 부팅 등록→정상 처리(소실 0)", async () => {
    const clock = new FakeClock();
    // 하나의 DB 를 두 부팅이 공유한다(프로세스 재시작 시뮬레이션 — 큐는 SQLite 로 내구).
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new JobStore(db, clock);
    const lease = new LeaseManager(db, { clock });

    const makeDispatcher = (
      handlers: readonly AnyJobHandler[],
      cfg: DispatcherConfig,
    ): Dispatcher =>
      new Dispatcher({ store, registry: buildRegistry(handlers), lease, clock }, cfg);

    // 첫 부팅: 핸들러 미등록 → requeue(pending). 백오프로 같은 부팅 내 재claim tight-loop 을 막는다.
    store.enqueue({
      type: "late-handler",
      dedupKey: "recover-me",
      lane: "automation",
      laneKey: null,
      payload: { n: 42 },
      maxAttempts: 2,
    });
    const boot1 = makeDispatcher([], { pollIntervalMs: 60_000, backoffMs: () => 60_000 });
    boot1.start();
    await vi.waitFor(() => expect(store.getByDedupKey("recover-me")?.status).toBe("pending"));
    expect(store.getByDedupKey("recover-me")?.attempts).toBe(1);
    await boot1.stop();

    // 둘째 부팅: 핸들러 등록됨 + 같은 DB → 백오프 도래 후 정상 처리(소실 0).
    const events: string[] = [];
    const handler = recordingHandler(events, {
      type: "late-handler",
      lane: "automation",
      delayMs: 1,
    });
    clock.advance(60_000);
    const boot2 = makeDispatcher([handler], { pollIntervalMs: 60_000, backoffMs: () => 0 });
    boot2.start();
    await vi.waitFor(() => expect(store.getByDedupKey("recover-me")?.status).toBe("done"));
    // 소실 0 — 잡이 실제로 실행됐다.
    expect(events).toEqual(["start:42", "end:42"]);
    await boot2.stop();
  });
});

describe("Dispatcher write 레인 (JQ-07/15)", () => {
  it("전역 직렬 — lane_key가 달라도 동시에 하나만 실행된다", async () => {
    const events: string[] = [];
    let leaseSeen = false;
    const store = { current: undefined as JobStore | undefined };
    const handler: AnyJobHandler = {
      type: "write-job",
      lane: "write",
      maxAttempts: 2,
      payloadSchema: z.object({ n: z.number() }),
      run: async (job: Job) => {
        const n = (job.payload as { n: number }).n;
        events.push(`start:${n}`);
        // write 실행 중에는 반드시 lease가 잡혀 있다.
        if (store.current?.getById(job.id)?.leaseId) leaseSeen = true;
        await sleep(20);
        events.push(`end:${n}`);
        return "done";
      },
    };
    const s = setup([handler]);
    store.current = s.store;
    enqueue(s.store, {
      dedupKey: "w1",
      lane: "write",
      laneKey: "repoA",
      type: "write-job",
      payload: { n: 1 },
    });
    enqueue(s.store, {
      dedupKey: "w2",
      lane: "write",
      laneKey: "repoB",
      type: "write-job",
      payload: { n: 2 },
    });
    s.dispatcher.start();
    await vi.waitFor(() => expect(s.store.countByStatus().done).toBe(2), { timeout: 3_000 });
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    expect(leaseSeen).toBe(true);
    await s.dispatcher.stop();
  });

  it("미등록 write 잡 requeue 는 lease 를 해제한다 (다음 부팅에서 재획득 가능)", async () => {
    const clock = new FakeClock();
    const { store, dispatcher } = setup([], { clock, cfg: { backoffMs: () => 60_000 } });
    enqueue(store, {
      dedupKey: "w-ghost",
      lane: "write",
      laneKey: "repoX",
      type: "write-ghost",
      maxAttempts: 2,
    });
    dispatcher.start();
    // 미등록 → 즉시 failed 가 아니라 pending 재전환, lease 는 해제(lease_id NULL)돼야 한다.
    await vi.waitFor(() => expect(store.getByDedupKey("w-ghost")?.status).toBe("pending"));
    const job = store.getByDedupKey("w-ghost");
    expect(job?.attempts).toBe(1);
    expect(job?.leaseId).toBeNull();
    expect(job?.leaseExpiresAt).toBeNull();
    await dispatcher.stop();
  });
});

describe("Dispatcher stop() — graceful 정지", () => {
  it("진행 중 잡 완료를 기다리고, 이후 enqueue는 처리하지 않는다", async () => {
    const events: string[] = [];
    let ctxSignal: AbortSignal | undefined;
    const handler: AnyJobHandler = {
      type: "test-job",
      lane: "interactive",
      maxAttempts: 1,
      payloadSchema: z.unknown(),
      run: async (_job: Job, ctx: JobContext) => {
        ctxSignal = ctx.signal;
        events.push("start");
        await sleep(50);
        events.push("end");
        return "done";
      },
    };
    const { store, dispatcher } = setup([handler]);
    dispatcher.start();
    enqueue(store, { dedupKey: "slow", lane: "interactive" });
    await vi.waitFor(() => expect(events).toContain("start"));
    await dispatcher.stop();
    // stop이 리턴한 시점에 잡은 이미 종결돼 있다 — 강제 킬이 아니라 완료 대기.
    expect(events).toContain("end");
    expect(store.getByDedupKey("slow")?.status).toBe("done");
    // 정지 신호는 핸들러에 전달됐다 (조기 마무리용).
    expect(ctxSignal?.aborted).toBe(true);

    enqueue(store, { dedupKey: "after-stop", lane: "interactive" });
    await sleep(30);
    expect(store.getByDedupKey("after-stop")?.status).toBe("pending");
  });
});

describe("recoverInflight + Dispatcher 연계 (JQ-05)", () => {
  it("크래시 시뮬레이션: 복구된 pending을 dispatcher가 이어서 처리한다", async () => {
    const events: string[] = [];
    const { store, dispatcher } = setup([recordingHandler(events, { delayMs: 5 })]);
    enqueue(store, { dedupKey: "crashed", lane: "interactive", payload: { n: 7 } });
    // 크래시 재현: claim만 하고 settle 없이 방치된 inflight.
    expect(store.claimNext("interactive")).toBeDefined();

    const recovered = store.recoverInflight();
    expect(recovered.requeued).toHaveLength(1);
    dispatcher.start();
    await vi.waitFor(() => expect(store.getByDedupKey("crashed")?.status).toBe("done"));
    expect(events).toEqual(["start:7", "end:7"]);
    await dispatcher.stop();
  });
});
