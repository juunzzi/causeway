import { describe, expect, it } from "vitest";
import type { Clock } from "../clock.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrations.js";
import { type EnqueueInput, JobStore } from "./jobStore.js";
import type { Job } from "./types.js";

function mustEnqueue(store: JobStore, enqueueInput: EnqueueInput): Job {
  const outcome = store.enqueue(enqueueInput);
  if (!outcome.enqueued) throw new Error("테스트 전제 위반 — enqueue가 no-op이었다");
  return outcome.job;
}

class FakeClock implements Clock {
  constructor(private t = 1_700_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeStore(): { store: JobStore; clock: FakeClock } {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock();
  return { store: new JobStore(db, clock), clock };
}

function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    type: "test-job",
    dedupKey: `key-${Math.random()}`,
    lane: "automation",
    payload: { schema_version: 1 },
    maxAttempts: 2,
    ...overrides,
  };
}

describe("JobStore.enqueue (JQ-02)", () => {
  it("같은 dedup_key 2회 enqueue → 1행, 두 번째는 조용히 no-op", () => {
    const { store } = makeStore();
    const first = store.enqueue(input({ dedupKey: "dup" }));
    const second = store.enqueue(input({ dedupKey: "dup", payload: { schema_version: 2 } }));
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    if (!second.enqueued) {
      // 기존 행이 그대로다 — 재전송 payload가 원본을 덮지 않는다.
      expect(second.existing.id).toBe(first.enqueued ? first.job.id : -1);
      expect(second.existing.payload).toEqual({ schema_version: 1 });
    }
    expect(store.countByStatus().pending).toBe(1);
  });

  it("enqueue 성공 시에만 'enqueued' 이벤트가 난다 (dispatcher wakeup 경로)", () => {
    const { store } = makeStore();
    const events: unknown[] = [];
    store.events.on("enqueued", (e) => events.push(e));
    store.enqueue(input({ dedupKey: "k", lane: "interactive", laneKey: "C1:100" }));
    store.enqueue(input({ dedupKey: "k" }));
    expect(events).toEqual([{ lane: "interactive", laneKey: "C1:100" }]);
  });
});

describe("JobStore.claimNext (JQ-03)", () => {
  it("pending → inflight + attempts++ + execution_started_at 기록", () => {
    const { store, clock } = makeStore();
    store.enqueue(input({ dedupKey: "a" }));
    const job = store.claimNext("automation");
    expect(job?.status).toBe("inflight");
    expect(job?.attempts).toBe(1);
    expect(job?.executionStartedAt).toBe(clock.now());
  });

  it("단일 승자 — 두 번째 claim은 아무것도 못 집는다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "only" }));
    expect(store.claimNext("automation")?.dedupKey).toBe("only");
    expect(store.claimNext("automation")).toBeUndefined();
  });

  it("not_before 미도래 잡은 건너뛰고, 도래하면 집는다", () => {
    const { store, clock } = makeStore();
    store.enqueue(input({ dedupKey: "later", notBefore: clock.now() + 10_000 }));
    expect(store.claimNext("automation")).toBeUndefined();
    clock.advance(10_000);
    expect(store.claimNext("automation")?.dedupKey).toBe("later");
  });

  it("레인이 다르면 집지 않는다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "w", lane: "write" }));
    expect(store.claimNext("automation")).toBeUndefined();
    expect(store.claimNext("write")?.dedupKey).toBe("w");
  });

  it("busyLaneKeys의 lane_key는 제외하되 다른 lane_key·NULL은 집는다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "t1", lane: "interactive", laneKey: "T1" }));
    store.enqueue(input({ dedupKey: "t2", lane: "interactive", laneKey: "T2" }));
    store.enqueue(input({ dedupKey: "nk", lane: "interactive" }));
    expect(store.claimNext("interactive", ["T1"])?.dedupKey).toBe("t2");
    expect(store.claimNext("interactive", ["T1", "T2"])?.dedupKey).toBe("nk");
    expect(store.claimNext("interactive", ["T1"])).toBeUndefined();
  });

  it("FIFO — id 오름차순으로 집는다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "first" }));
    store.enqueue(input({ dedupKey: "second" }));
    expect(store.claimNext("automation")?.dedupKey).toBe("first");
    expect(store.claimNext("automation")?.dedupKey).toBe("second");
  });
});

describe("JobStore 상태 전이 전체", () => {
  it("pending → inflight → done", () => {
    const { store } = makeStore();
    const job = mustEnqueue(store, input({ dedupKey: "d" }));
    const claimed = store.claimNext("automation");
    expect(claimed).toBeDefined();
    expect(store.settle(job.id, "done", { result: "ok" })).toBe(true);
    const finished = store.getById(job.id);
    expect(finished?.status).toBe("done");
    expect(finished?.result).toBe("ok");
  });

  it("inflight → failed / cancelled", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "f" }));
    store.enqueue(input({ dedupKey: "c" }));
    const f = store.claimNext("automation");
    const c = store.claimNext("automation");
    expect(f && store.settle(f.id, "failed", { error: "boom" })).toBe(true);
    expect(c && store.settle(c.id, "cancelled")).toBe(true);
    expect(f && store.getById(f.id)?.status).toBe("failed");
    expect(f && store.getById(f.id)?.error).toBe("boom");
    expect(c && store.getById(c.id)?.status).toBe("cancelled");
  });

  it("inflight가 아니면 settle/requeue가 거부된다 — 종결 상태를 덮지 않는다", () => {
    const { store } = makeStore();
    const id = mustEnqueue(store, input({ dedupKey: "p" })).id;
    expect(store.settle(id, "done")).toBe(false);
    expect(store.requeue(id)).toBe(false);
    store.claimNext("automation");
    store.settle(id, "done");
    expect(store.settle(id, "failed")).toBe(false);
    expect(store.getById(id)?.status).toBe("done");
  });

  it("requeue: inflight → pending + not_before 백오프", () => {
    const { store, clock } = makeStore();
    store.enqueue(input({ dedupKey: "r" }));
    const job = store.claimNext("automation");
    expect(job).toBeDefined();
    if (!job) return;
    expect(store.requeue(job.id, { notBefore: clock.now() + 5_000, error: "일시 오류" })).toBe(
      true,
    );
    const requeued = store.getById(job.id);
    expect(requeued?.status).toBe("pending");
    expect(requeued?.attempts).toBe(1);
    expect(requeued?.notBefore).toBe(clock.now() + 5_000);
    expect(requeued?.executionStartedAt).toBeNull();
    expect(store.claimNext("automation")).toBeUndefined();
    clock.advance(5_000);
    expect(store.claimNext("automation")?.id).toBe(job.id);
  });
});

describe("JobStore.requeue undoAttempt (JQ-04)", () => {
  it("undoAttempt는 claim에서 소진한 attempts를 되돌린다 — 재시도 예산 보존", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "u", maxAttempts: 2 }));
    const job = store.claimNext("automation");
    expect(job?.attempts).toBe(1);
    if (!job) return;
    store.requeue(job.id, { undoAttempt: true });
    expect(store.getById(job.id)?.attempts).toBe(0);
    // 이후 정상 실행 실패 2회의 예산이 온전히 남아 있다.
    expect(store.claimNext("automation")?.attempts).toBe(1);
    store.requeue(job.id);
    expect(store.claimNext("automation")?.attempts).toBe(2);
  });

  it("undoAttempt여도 attempts는 0 밑으로 내려가지 않는다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "floor" }));
    const job = store.claimNext("automation");
    if (!job) return;
    store.requeue(job.id, { undoAttempt: true });
    const back = store.getById(job.id);
    expect(back?.attempts).toBe(0);
  });
});

describe("JobStore.recoverInflight (JQ-05)", () => {
  it("attempts < max는 pending 복구, attempts >= max는 failed 종결 + 목록 반환", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "revive", maxAttempts: 2 }));
    store.enqueue(input({ dedupKey: "exhaust", maxAttempts: 1 }));
    const revive = store.claimNext("automation");
    const exhaust = store.claimNext("automation");
    expect(revive?.dedupKey).toBe("revive");
    expect(exhaust?.dedupKey).toBe("exhaust");

    const result = store.recoverInflight();
    expect(result.requeued.map((j) => j.dedupKey)).toEqual(["revive"]);
    expect(result.exhausted.map((j) => j.dedupKey)).toEqual(["exhaust"]);
    expect(store.getByDedupKey("revive")?.status).toBe("pending");
    // attempts는 유지 — 크래시로 소진된 시도는 소진이다 (2번째 크래시면 다음 recover에서 종결).
    expect(store.getByDedupKey("revive")?.attempts).toBe(1);
    const failed = store.getByDedupKey("exhaust");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("재시도 상한 초과");
  });

  it("복구된 잡은 즉시 다시 claim 가능하고, 2회째 크래시면 종결된다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "twice", maxAttempts: 2 }));
    store.claimNext("automation");
    store.recoverInflight();
    const second = store.claimNext("automation");
    expect(second?.attempts).toBe(2);
    const result = store.recoverInflight();
    expect(result.exhausted.map((j) => j.dedupKey)).toEqual(["twice"]);
  });

  it("inflight가 없으면 빈 결과", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "idle" }));
    expect(store.recoverInflight()).toEqual({ requeued: [], exhausted: [] });
    expect(store.getByDedupKey("idle")?.status).toBe("pending");
  });
});

describe("JobStore.purgeFinished (OPS-12)", () => {
  it("보존일 경과한 종결 잡만 지운다 — pending/inflight·최근 종결분은 유지", () => {
    const { store, clock } = makeStore();
    store.enqueue(input({ dedupKey: "old-done" }));
    const oldDone = store.claimNext("automation");
    if (oldDone) store.settle(oldDone.id, "done");
    clock.advance(8 * 86_400_000);
    store.enqueue(input({ dedupKey: "fresh-done" }));
    const freshDone = store.claimNext("automation");
    if (freshDone) store.settle(freshDone.id, "done");
    store.enqueue(input({ dedupKey: "still-pending" }));

    expect(store.purgeFinished(7)).toBe(1);
    expect(store.getByDedupKey("old-done")).toBeUndefined();
    expect(store.getByDedupKey("fresh-done")?.status).toBe("done");
    expect(store.getByDedupKey("still-pending")?.status).toBe("pending");
  });
});

describe("JobStore.countByStatus / getByDedupKey", () => {
  it("상태별 카운트가 0 포함 전체 키를 돌려준다", () => {
    const { store } = makeStore();
    store.enqueue(input({ dedupKey: "one" }));
    store.enqueue(input({ dedupKey: "two" }));
    store.claimNext("automation");
    expect(store.countByStatus()).toEqual({
      pending: 1,
      inflight: 1,
      done: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  it("getByDedupKey는 없는 키에 undefined", () => {
    const { store } = makeStore();
    expect(store.getByDedupKey("ghost")).toBeUndefined();
  });
});

describe("JobStore.failedDedupKeys (ADR-0003 §5)", () => {
  /** enqueue → claim → settle(failed) 로 실제 failed 행을 만든다. */
  function seedFailed(store: JobStore, dedupKey: string, type = "pr-code-review"): void {
    const job = mustEnqueue(store, input({ type, dedupKey, maxAttempts: 1 }));
    store.claimNext("automation");
    store.settle(job.id, "failed", { error: "boom" });
  }

  it("해당 타입의 failed dedup_key 만 돌려준다", () => {
    const { store } = makeStore();
    seedFailed(store, "pr-code-review:o/r#1@sha1:2026-08-03T01");
    seedFailed(store, "pr-code-review:o/r#1@sha1:2026-08-03T02");
    seedFailed(store, "pr-code-review:o/r#2@sha9:2026-08-03T03");
    seedFailed(store, "chat:other#1", "chat"); // 다른 타입

    expect(store.failedDedupKeys("pr-code-review").sort()).toEqual([
      "pr-code-review:o/r#1@sha1:2026-08-03T01",
      "pr-code-review:o/r#1@sha1:2026-08-03T02",
      "pr-code-review:o/r#2@sha9:2026-08-03T03",
    ]);
  });

  it("failed 가 아닌 상태는 돌려주지 않는다 — skip(done)이 상한을 먹으면 안 된다", () => {
    const { store } = makeStore();
    const prefix = "pr-code-review:o/r#1@sha1:";
    // 이 잡의 종결은 압도적으로 done(멱등 skip)이다. 그게 세어지면 정상 PR 이 곧 상한에 걸린다.
    const done = mustEnqueue(store, input({ type: "pr-code-review", dedupKey: `${prefix}A` }));
    store.claimNext("automation");
    store.settle(done.id, "done");
    mustEnqueue(store, input({ type: "pr-code-review", dedupKey: `${prefix}B` })); // pending

    expect(store.failedDedupKeys("pr-code-review")).toEqual([]);
  });

  it("failed 가 없으면 빈 배열", () => {
    const { store } = makeStore();
    expect(store.failedDedupKeys("pr-code-review")).toEqual([]);
  });
});

describe("JobStore.hasDoneJobWithPrefix (ADR-0003 §5)", () => {
  /** enqueue → claim → settle(done) 로 실제 done 행을 만든다. */
  function seedDone(store: JobStore, dedupKey: string, type = "pr-code-review"): void {
    const job = mustEnqueue(store, input({ type, dedupKey }));
    store.claimNext("automation");
    store.settle(job.id, "done");
  }

  const PREFIX = "pr-code-review:o/r#1@sha1:";

  it("접두사에 done 행이 있으면 true — 버킷이 달라도 같은 커밋이다", () => {
    const { store } = makeStore();
    seedDone(store, `${PREFIX}2026-08-03T09`);
    expect(store.hasDoneJobWithPrefix("pr-code-review", PREFIX)).toBe(true);
  });

  it("done 이 아닌 상태만 있으면 false — 실패만 쌓인 커밋이 상한의 대상", () => {
    const { store } = makeStore();
    const failed = mustEnqueue(
      store,
      input({ type: "pr-code-review", dedupKey: `${PREFIX}2026-08-03T01`, maxAttempts: 1 }),
    );
    store.claimNext("automation");
    store.settle(failed.id, "failed", { error: "boom" });
    mustEnqueue(store, input({ type: "pr-code-review", dedupKey: `${PREFIX}2026-08-03T02` })); // pending

    expect(store.hasDoneJobWithPrefix("pr-code-review", PREFIX)).toBe(false);
  });

  it("다른 커밋·다른 타입의 done 은 새지 않는다", () => {
    const { store } = makeStore();
    seedDone(store, "pr-code-review:o/r#1@sha-other:2026-08-03T09");
    seedDone(store, "pr-code-review:o/r#2@sha1:2026-08-03T09");
    seedDone(store, `${PREFIX}2026-08-03T09`, "chat");

    expect(store.hasDoneJobWithPrefix("pr-code-review", PREFIX)).toBe(false);
  });

  it("접두사의 `_` 는 와일드카드가 아니다 — LIKE 였다면 오탐이 났을 자리", () => {
    const { store } = makeStore();
    seedDone(store, "pr-code-review:o/rXname#1@sha1:2026-08-03T09");
    expect(store.hasDoneJobWithPrefix("pr-code-review", "pr-code-review:o/r_name#1@sha1:")).toBe(
      false,
    );
  });
});
