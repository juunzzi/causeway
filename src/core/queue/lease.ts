import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Clock, systemClock } from "../clock.js";
import type { JobResult } from "./types.js";

/**
 * write 레인 lease 기본 TTL(ms).
 * dispatcher heartbeat 간격(기본 TTL/3)이 여러 번 유실돼야 만료되는 여유 — 일시 GC 멈춤 오탐 방지.
 */
export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface LeaseGrant {
  leaseId: string;
  expiresAt: number;
}

export interface LeaseOptions {
  clock?: Clock;
  ttlMs?: number;
}

/**
 * write 레인 fencing (JQ-15): 모든 갱신이 WHERE lease_id 조건부 UPDATE라서
 * 만료 후 탈취당한 stale 워커의 늦은 쓰기가 현재 상태를 덮을 수 없다.
 */
export class LeaseManager {
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(
    private readonly db: DatabaseSync,
    opts: LeaseOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** inflight 잡에 lease 발급. 유효한 타인 lease가 살아있으면 실패 — 만료된 lease만 탈취한다. */
  acquire(jobId: number): LeaseGrant | undefined {
    const now = this.clock.now();
    const leaseId = randomUUID();
    const expiresAt = now + this.ttlMs;
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET lease_id = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'inflight'
           AND (lease_id IS NULL OR lease_expires_at <= ?)`,
      )
      .run(leaseId, expiresAt, now, jobId, now);
    return Number(res.changes) === 1 ? { leaseId, expiresAt } : undefined;
  }

  /** 만료 연장 — lease_id가 더 이상 내 것이 아니면(탈취됨) 실패를 돌려줘 워커가 스스로 물러나게 한다. */
  heartbeat(jobId: number, leaseId: string): LeaseGrant | undefined {
    const now = this.clock.now();
    const expiresAt = now + this.ttlMs;
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'inflight' AND lease_id = ?`,
      )
      .run(expiresAt, now, jobId, leaseId);
    return Number(res.changes) === 1 ? { leaseId, expiresAt } : undefined;
  }

  /**
   * fenced requeue — 재시도 반환도 settle과 같은 WHERE lease_id 조건을 태운다 (JQ-15).
   * stale lease의 늦은 requeue가 탈취자의 lease를 지우거나 상태를 pending으로 되돌리는 것을 막는다.
   * attempts는 건드리지 않는다 — 실행 실패의 시도 소진은 claim에서 이미 반영됐다 (JQ-04).
   */
  requeue(
    jobId: number,
    leaseId: string,
    opts: { notBefore?: number | null; error?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending', not_before = ?,
             lease_id = NULL, lease_expires_at = NULL, execution_started_at = NULL,
             error = COALESCE(?, error), updated_at = ?
         WHERE id = ? AND status = 'inflight' AND lease_id = ?`,
      )
      .run(opts.notBefore ?? null, opts.error ?? null, this.clock.now(), jobId, leaseId);
    return Number(res.changes) === 1;
  }

  /** fencing의 본체 — WHERE lease_id = ? 라서 stale lease의 늦은 settle은 0행 갱신으로 무효화된다. */
  settle(
    jobId: number,
    leaseId: string,
    verdict: JobResult,
    opts: { result?: string; error?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, result = ?, error = ?,
             lease_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'inflight' AND lease_id = ?`,
      )
      .run(verdict, opts.result ?? null, opts.error ?? null, this.clock.now(), jobId, leaseId);
    return Number(res.changes) === 1;
  }
}
