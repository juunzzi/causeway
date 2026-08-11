import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrations.js";
import { JobStore } from "./jobStore.js";
import { LeaseManager } from "./lease.js";
import type { Job } from "./types.js";

class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function setup(): { db: DatabaseSync; store: JobStore; lease: LeaseManager; clock: FakeClock } {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  return {
    db,
    store: new JobStore(db, clock),
    lease: new LeaseManager(db, { clock, ttlMs: 60_000 }),
    clock,
  };
}

function claimWriteJob(store: JobStore): Job {
  store.enqueue({
    type: "write-job",
    dedupKey: "w1",
    lane: "write",
    payload: { schema_version: 1 },
    maxAttempts: 3,
  });
  const job = store.claimNext("write");
  if (!job) throw new Error("테스트 전제 위반 — claim 실패");
  return job;
}

describe("LeaseManager (JQ-15)", () => {
  it("inflight 잡에만 lease가 발급된다", () => {
    const { store, lease } = setup();
    const outcome = store.enqueue({
      type: "write-job",
      dedupKey: "pending-only",
      lane: "write",
      payload: {},
      maxAttempts: 1,
    });
    const id = outcome.enqueued ? outcome.job.id : -1;
    expect(lease.acquire(id)).toBeUndefined();
    store.claimNext("write");
    expect(lease.acquire(id)).toBeDefined();
  });

  it("살아있는 타인 lease는 획득 불가, 만료된 lease는 탈취 가능", () => {
    const { store, lease, clock } = setup();
    const job = claimWriteJob(store);
    const first = lease.acquire(job.id);
    expect(first).toBeDefined();
    expect(lease.acquire(job.id)).toBeUndefined();
    clock.advance(60_000);
    const takeover = lease.acquire(job.id);
    expect(takeover).toBeDefined();
    expect(takeover?.leaseId).not.toBe(first?.leaseId);
  });

  it("heartbeat가 만료를 연장해 탈취를 막는다", () => {
    const { store, lease, clock } = setup();
    const job = claimWriteJob(store);
    const grant = lease.acquire(job.id);
    if (!grant) throw new Error("acquire 실패");
    clock.advance(50_000);
    const renewed = lease.heartbeat(job.id, grant.leaseId);
    expect(renewed?.expiresAt).toBe(clock.now() + 60_000);
    clock.advance(50_000);
    // 최초 만료(t0+60s)는 이미 지났지만 heartbeat 연장(t0+110s) 덕에 아직 탈취 불가.
    expect(lease.acquire(job.id)).toBeUndefined();
  });

  it("탈취된 lease의 heartbeat는 실패한다 — 워커가 스스로 물러날 신호", () => {
    const { store, lease, clock } = setup();
    const job = claimWriteJob(store);
    const stale = lease.acquire(job.id);
    if (!stale) throw new Error("acquire 실패");
    clock.advance(60_000);
    lease.acquire(job.id);
    expect(lease.heartbeat(job.id, stale.leaseId)).toBeUndefined();
  });

  it("fencing: 만료 lease 탈취 후 이전 워커의 늦은 settle이 상태를 못 덮는다", () => {
    const { store, lease, clock } = setup();
    const job = claimWriteJob(store);
    const workerA = lease.acquire(job.id);
    if (!workerA) throw new Error("acquire 실패");
    clock.advance(60_000);
    const workerB = lease.acquire(job.id);
    if (!workerB) throw new Error("탈취 실패");

    // A(stale)의 늦은 settle → 0행 갱신, 상태 그대로 inflight.
    expect(lease.settle(job.id, workerA.leaseId, "done", { result: "stale-write" })).toBe(false);
    expect(store.getById(job.id)?.status).toBe("inflight");
    expect(store.getById(job.id)?.result).toBeNull();

    // B(현재 소유자)의 settle만 유효하다.
    expect(lease.settle(job.id, workerB.leaseId, "done", { result: "fresh-write" })).toBe(true);
    const settled = store.getById(job.id);
    expect(settled?.status).toBe("done");
    expect(settled?.result).toBe("fresh-write");

    // 종결 후 A가 또 늦게 도착해도 무효 — 종결 상태는 불변이다.
    expect(lease.settle(job.id, workerA.leaseId, "failed")).toBe(false);
    expect(store.getById(job.id)?.status).toBe("done");
  });

  it("fencing: 만료 lease 탈취 후 이전 워커의 늦은 requeue가 상태를 못 덮는다", () => {
    const { store, lease, clock } = setup();
    const job = claimWriteJob(store);
    const workerA = lease.acquire(job.id);
    if (!workerA) throw new Error("acquire 실패");
    clock.advance(60_000);
    const workerB = lease.acquire(job.id);
    if (!workerB) throw new Error("탈취 실패");

    // A(stale)의 늦은 requeue → 0행 갱신. 상태는 inflight 유지, B의 lease도 그대로다.
    expect(lease.requeue(job.id, workerA.leaseId, { error: "stale-retry" })).toBe(false);
    const untouched = store.getById(job.id);
    expect(untouched?.status).toBe("inflight");
    expect(untouched?.leaseId).toBe(workerB.leaseId);
    expect(untouched?.error).toBeNull();

    // B(현재 소유자)의 requeue만 유효 — pending 반환 + lease 정리 + attempts 유지.
    const notBefore = clock.now() + 15_000;
    expect(lease.requeue(job.id, workerB.leaseId, { notBefore, error: "transient" })).toBe(true);
    const requeued = store.getById(job.id);
    expect(requeued?.status).toBe("pending");
    expect(requeued?.notBefore).toBe(notBefore);
    expect(requeued?.error).toBe("transient");
    expect(requeued?.attempts).toBe(job.attempts);
    expect(requeued?.leaseId).toBeNull();
    expect(requeued?.leaseExpiresAt).toBeNull();
    expect(requeued?.executionStartedAt).toBeNull();

    // pending으로 돌아간 뒤에는 B의 lease마저 무효 — inflight에서만 requeue 가능하다.
    expect(lease.requeue(job.id, workerB.leaseId)).toBe(false);
  });

  it("settle 성공 시 lease 필드가 정리된다", () => {
    const { store, lease } = setup();
    const job = claimWriteJob(store);
    const grant = lease.acquire(job.id);
    if (!grant) throw new Error("acquire 실패");
    lease.settle(job.id, grant.leaseId, "done");
    const settled = store.getById(job.id);
    expect(settled?.leaseId).toBeNull();
    expect(settled?.leaseExpiresAt).toBeNull();
  });
});
