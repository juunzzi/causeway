import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { type Clock, systemClock } from "../clock.js";
import type { Job, JobResult, JobStatus, Lane } from "./types.js";

/** DB 행(snake_case) — 외부로는 camelCase Job만 노출한다. */
interface JobRow {
  id: number;
  type: string;
  dedup_key: string;
  lane: Lane;
  lane_key: string | null;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_id: string | null;
  lease_expires_at: number | null;
  execution_started_at: number | null;
  not_before: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(row: JobRow): Job {
  return {
    id: Number(row.id),
    type: row.type,
    dedupKey: row.dedup_key,
    lane: row.lane,
    laneKey: row.lane_key,
    payload: JSON.parse(row.payload),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    executionStartedAt: row.execution_started_at === null ? null : Number(row.execution_started_at),
    notBefore: row.not_before === null ? null : Number(row.not_before),
    result: row.result,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface EnqueueInput<P = unknown> {
  type: string;
  dedupKey: string;
  lane: Lane;
  payload: P;
  /** 숨은 기본값 금지 — 근원은 JobHandler.maxAttempts, enqueue 지점이 명시적으로 넘긴다. */
  maxAttempts: number;
  laneKey?: string | null;
  notBefore?: number | null;
}

export type EnqueueOutcome = { enqueued: true; job: Job } | { enqueued: false; existing: Job };

export interface EnqueuedEvent {
  lane: Lane;
  laneKey: string | null;
}

export interface RecoverResult {
  /** inflight → pending 복구된 잡 (attempts 유지 — 크래시로 소진된 시도는 소진이다). */
  requeued: Job[];
  /** 재시도 상한 초과로 failed 종결된 잡 — 호출측(부팅 시퀀스)이 스레드/운영 채널에 통보한다. */
  exhausted: Job[];
}

export interface SettleOptions {
  result?: string;
  error?: string;
}

export interface RequeueOptions {
  /** 백오프 — 이 시각(epoch ms) 전에는 claimNext가 잡지 않는다. */
  notBefore?: number | null;
  /**
   * '실행 전 충돌'(lease 경합 등)로 되돌리는 경우 true — 실행 실패가 아니므로
   * claim에서 올라간 attempts를 되돌려 재시도 예산을 보존한다 (JQ-04).
   */
  undoAttempt?: boolean;
  error?: string;
}

/**
 * jobs 테이블의 유일한 접근 계층 (lease fencing SQL은 lease.ts).
 * enqueue 성공 시 events('enqueued')로 dispatcher 즉시 wakeup을 지원한다 (JQ-07).
 */
export class JobStore {
  readonly events = new EventEmitter();

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {}

  /** dedup_key UNIQUE 충돌 시 조용히 no-op — 중복 방지는 스키마다 (JQ-02). */
  enqueue<P>(input: EnqueueInput<P>): EnqueueOutcome {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `INSERT INTO jobs
           (type, dedup_key, lane, lane_key, payload, status, attempts, max_attempts,
            not_before, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
         ON CONFLICT (dedup_key) DO NOTHING`,
      )
      .run(
        input.type,
        input.dedupKey,
        input.lane,
        input.laneKey ?? null,
        JSON.stringify(input.payload),
        input.maxAttempts,
        input.notBefore ?? null,
        now,
        now,
      );
    const job = this.getByDedupKey(input.dedupKey);
    if (!job) {
      throw new Error(`enqueue 직후 조회 실패 — dedup_key=${input.dedupKey}`);
    }
    if (Number(res.changes) === 0) {
      return { enqueued: false, existing: job };
    }
    const event: EnqueuedEvent = { lane: input.lane, laneKey: input.laneKey ?? null };
    this.events.emit("enqueued", event);
    return { enqueued: true, job };
  }

  /**
   * pending → inflight 전환 + attempts++ + execution_started_at 기록을 원자 수행 (JQ-03).
   * BEGIN IMMEDIATE: 프로세스 밖(운영 CLI 등)의 동시 접근에서도 단일 승자를 보장한다.
   * busyLaneKeys: 실행 중인 lane_key 제외 — 같은 스레드 직렬화의 근거 (JQ-07/SC-03).
   */
  claimNext(lane: Lane, busyLaneKeys: readonly string[] = []): Job | undefined {
    const now = this.clock.now();
    const exclusion =
      busyLaneKeys.length > 0
        ? `AND (lane_key IS NULL OR lane_key NOT IN (${busyLaneKeys.map(() => "?").join(", ")}))`
        : "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE status = 'pending' AND lane = ?
             AND (not_before IS NULL OR not_before <= ?)
             ${exclusion}
           ORDER BY id
           LIMIT 1`,
        )
        .get(lane, now, ...busyLaneKeys) as JobRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db
        .prepare(
          `UPDATE jobs
           SET status = 'inflight', attempts = attempts + 1,
               execution_started_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, row.id);
      this.db.exec("COMMIT");
      return this.getById(Number(row.id));
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * inflight 잡의 payload 를 원자 갱신한다 — 진행 카드 ts 처럼 실행 도중 확정되는 값을 DB 에
   * 못박아 프로세스 재시작(kill-9·launchctl kickstart 등)에도 유실되지 않게 한다(JQ-06 계열).
   * inflight 로 한정: 종결/복구된 잡의 payload 를 뒤늦게 덮지 않는다(claim 승자만 갱신).
   */
  updatePayload<P>(id: number, payload: P): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs SET payload = ?, updated_at = ?
         WHERE id = ? AND status = 'inflight'`,
      )
      .run(JSON.stringify(payload), this.clock.now(), id);
    return Number(res.changes) === 1;
  }

  /** inflight에서만 종결 가능 — 이미 종결/복구된 잡을 덮지 않는다. write 레인은 lease.settle을 쓴다. */
  settle(id: number, verdict: JobResult, opts: SettleOptions = {}): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET status = ?, result = ?, error = ?,
             lease_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'inflight'`,
      )
      .run(verdict, opts.result ?? null, opts.error ?? null, this.clock.now(), id);
    return Number(res.changes) === 1;
  }

  /** inflight → pending 반환. undoAttempt로 '실행 전 충돌'과 '실행 실패'를 구분한다 (JQ-04). */
  requeue(id: number, opts: RequeueOptions = {}): boolean {
    const attemptsExpr = opts.undoAttempt ? "MAX(0, attempts - 1)" : "attempts";
    const res = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending', attempts = ${attemptsExpr}, not_before = ?,
             lease_id = NULL, lease_expires_at = NULL, execution_started_at = NULL,
             error = COALESCE(?, error), updated_at = ?
         WHERE id = ? AND status = 'inflight'`,
      )
      .run(opts.notBefore ?? null, opts.error ?? null, this.clock.now(), id);
    return Number(res.changes) === 1;
  }

  /**
   * 부팅 시 1회: 중단된 inflight를 복구한다 (JQ-05).
   * attempts >= max_attempts는 failed 종결 — 반환 목록으로 호출측이 통보한다(silent 금지).
   */
  recoverInflight(): RecoverResult {
    const now = this.clock.now();
    const requeuedIds: number[] = [];
    const exhaustedIds: number[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare("SELECT * FROM jobs WHERE status = 'inflight' ORDER BY id")
        .all() as unknown as JobRow[];
      for (const row of rows) {
        if (Number(row.attempts) >= Number(row.max_attempts)) {
          this.db
            .prepare(
              `UPDATE jobs
               SET status = 'failed',
                   error = COALESCE(error, '재시도 상한 초과 — 부팅 복구(recoverInflight)에서 종결'),
                   lease_id = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(now, row.id);
          exhaustedIds.push(Number(row.id));
        } else {
          this.db
            .prepare(
              `UPDATE jobs
               SET status = 'pending', not_before = NULL,
                   lease_id = NULL, lease_expires_at = NULL,
                   execution_started_at = NULL, updated_at = ?
               WHERE id = ?`,
            )
            .run(now, row.id);
          requeuedIds.push(Number(row.id));
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const byId = (id: number): Job => {
      const job = this.getById(id);
      if (!job) throw new Error(`recoverInflight 직후 조회 실패 — id=${id}`);
      return job;
    };
    return { requeued: requeuedIds.map(byId), exhausted: exhaustedIds.map(byId) };
  }

  /** 종결 잡 보존기간 경과분 삭제 — jobs 무한 증가 방지 (OPS-12). 감사 로그 역할 때문에 즉시 삭제는 금지. */
  purgeFinished(retentionDays: number): number {
    const cutoff = this.clock.now() - retentionDays * 86_400_000;
    const res = this.db
      .prepare(
        `DELETE FROM jobs
         WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?`,
      )
      .run(cutoff);
    return Number(res.changes);
  }

  countByStatus(): Record<JobStatus, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
      .all() as Array<{ status: JobStatus; n: number }>;
    const counts: Record<JobStatus, number> = {
      pending: 0,
      inflight: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) {
      counts[row.status] = Number(row.n);
    }
    return counts;
  }

  /**
   * 해당 타입의 `failed` 잡 dedup_key 전부 — 호출자가 접두사별로 세도록 **한 번에** 돌려준다.
   *
   * pr-code-review 의 `(PR, headSha)` 실패 상한(ADR-0003 §5)이 유일한 소비자다. 접두사마다
   * 질의하지 않고 목록을 한 번 받는 이유: 이전 구현은 due PR **마다** `dedup_key LIKE 'prefix%'`
   * 를 돌렸는데, EXPLAIN QUERY PLAN 실측 결과 그 질의는 `idx_jobs_claim (status=?)` 으로 풀린다 —
   * dedup_key UNIQUE 인덱스는 쓰이지 않는다(SQLite `LIKE` 는 기본 대소문자 무시라 접두사 최적화가
   * 꺼져 있다). 즉 failed 행 전체를 훑는 일이 열린 PR 수만큼 tick 마다 반복됐다. 지금은 tick 당 1회다.
   *
   * 반환 크기는 상한 자체가 묶는다: 커밋 하나가 `failed` 로 남길 수 있는 행은 상한(2)까지이므로
   * 행 수는 "리뷰에 실패한 적 있는 서로 다른 커밋 수 × 2" 이고, 정상 운영에서는 수십~수백이다.
   * (상한 도입 이전에 쌓인 접두사는 이 한도를 넘을 수 있다 — 실측 15건.)
   */
  failedDedupKeys(type: string): string[] {
    return this.dedupKeysWithStatus(type, "failed");
  }

  /**
   * 이 접두사로 시작하는 `done` 잡이 하나라도 있나 — failedDedupKeys 의 짝이다.
   *
   * 실패 상한은 **뒤에 성공한 적 없는** 커밋에만 걸려야 한다. 이게 없던 동안 상한 판정은 과거
   * `failed` 행만 셌고, 같은 커밋이 그 뒤 리뷰에 성공해도 카운트가 줄지 않았다: 실측으로
   * #16151 은 5회 실패 뒤 리뷰가 정상 게시됐는데도(GitHub 에 리뷰 존재) 상한 도달로 판정돼
   * "리뷰 중단" 오탐이 나갔고, capNotified 가 프로세스 메모리에만 있어 재시작마다 되풀이됐다.
   *
   * pr-code-review 에서 `done` 은 "이 커밋 건은 결말이 났다"와 같다 — 리뷰 게시뿐 아니라 멱등
   * skip·opt-out 라벨·PR 종료·stale sha 도 여기 들어오며, 어느 쪽이든 상한을 걸 이유가 없다.
   *
   * failedDedupKeys 와 달리 목록을 통째로 받지 않고 접두사마다 묻는다 — 방향이 반대인 이유는
   * 두 집합의 크기가 반대이기 때문이다. `failed` 는 상한이 묶지만 `done` 은 아무것도 안 묶는다:
   * 열린 PR 하나가 시간당 1건씩 `done`(대부분 멱등 skip)을 남기고 purgeFinished 는 어떤
   * 스케줄러도 부르지 않는다(실측: 3일에 287행). 그 목록을 3분마다 통째로 들어올리는 대신,
   * **이미 상한에 닿은 접두사**(정상 운영에선 0개)에 대해서만 묻는다.
   *
   * `LIKE` 대신 substr 동등비교인 이유: 접두사에 `_`(LIKE 의 단일문자 와일드카드)가 섞여도
   * 오탐이 없다. 어차피 인덱스는 `idx_jobs_claim (status=?)` 으로 풀리므로 스캔 범위는 같고,
   * `LIMIT 1` 이 첫 히트에서 끊는다.
   */
  hasDoneJobWithPrefix(type: string, prefix: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM jobs
         WHERE status = 'done' AND type = ? AND substr(dedup_key, 1, ?) = ?
         LIMIT 1`,
      )
      .get(type, prefix.length, prefix);
    return row !== undefined;
  }

  private dedupKeysWithStatus(type: string, status: JobStatus): string[] {
    const rows = this.db
      .prepare("SELECT dedup_key FROM jobs WHERE status = ? AND type = ?")
      .all(status, type) as Array<{ dedup_key: string }>;
    return rows.map((r) => r.dedup_key);
  }

  getByDedupKey(dedupKey: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE dedup_key = ?").get(dedupKey) as
      | JobRow
      | undefined;
    return row ? rowToJob(row) : undefined;
  }

  getById(id: number): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }
}
