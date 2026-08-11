import { type Clock, systemClock } from "../clock.js";
import type { EnqueuedEvent, JobStore } from "./jobStore.js";
import type { LeaseManager } from "./lease.js";
import type { AnyJobHandler, Job, JobContext, JobResult, Lane } from "./types.js";

export interface DispatcherDeps {
  store: JobStore;
  /**
   * 명시 등록 registry (core/registry.ts). 미등록 타입은 즉시 failed 하지 않고 pending 으로
   * requeue 해 재시작(핸들러 등록된 부팅) 복구를 노린다 — attempts 상한 초과 시에만 최종 failed
   * (handleUnregistered, 부팅 레이스 방어).
   */
  registry: ReadonlyMap<string, AnyJobHandler>;
  /** write 레인 필수 — lease 없이 write 잡을 실행하는 경로는 존재하지 않는다 (JQ-15). */
  lease: LeaseManager;
  clock?: Clock;
  /**
   * JobContext 조립 주입 지점 — signal 과 실행 중 잡을 받아 컨텍스트를 만든다.
   * 미주입 시 기본 구현이 signal + persistPayload(store.updatePayload 위임)를 배선한다.
   */
  makeContext?: (signal: AbortSignal, job: Job) => JobContext;
  /** 핸들러 throw·stale settle 등 관찰 훅 — 로깅/통보는 호출측 책임. */
  onError?: (err: unknown, job?: Job) => void;
}

export interface DispatcherConfig {
  /** interactive 병렬 상한 — ARCHITECTURE §2 동시성 모델의 N=3. */
  interactiveConcurrency?: number;
  /** automation tick당 처리 상한 — LLM 비용의 구조적 상한. 초과분은 다음 tick으로 이월된다. */
  automationMaxPerTick?: number;
  /** 폴백 폴링 간격(ms) — 주 경로는 enqueue 이벤트 즉시 wakeup, 폴링은 not_before 도래용. */
  pollIntervalMs?: number;
  /** write lease heartbeat 간격(ms) — lease TTL보다 충분히 짧아야 한다. */
  heartbeatIntervalMs?: number;
  /** 실행 실패 백오프(ms). attempt는 방금 소진된 시도 횟수(1부터). */
  backoffMs?: (attempt: number) => number;
}

/** 지수 백오프 기본값 — 일시 장애(API 5xx 등)가 잦아드는 시간을 벌되 상한으로 폭주를 막는다. */
function defaultBackoffMs(attempt: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** (attempt - 1));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 레인 3분할 실행기 (JQ-07):
 * - interactive: 병렬 N + lane_key(thread_key) 직렬화 + enqueue 즉시 wakeup(<50ms)
 * - automation: 직렬 drain + tick당 상한
 * - write: 전역 직렬 + lease 필수
 */
export class Dispatcher {
  private readonly store: JobStore;
  private readonly registry: ReadonlyMap<string, AnyJobHandler>;
  private readonly lease: LeaseManager;
  private readonly clock: Clock;
  private readonly makeContext: (signal: AbortSignal, job: Job) => JobContext;
  private readonly onError: (err: unknown, job?: Job) => void;

  private readonly interactiveConcurrency: number;
  private readonly automationMaxPerTick: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly backoffMs: (attempt: number) => number;

  private started = false;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly abort = new AbortController();
  private readonly interactiveRunning = new Map<number, Promise<void>>();
  private readonly busyLaneKeys = new Set<string>();
  private automationPromise: Promise<void> | undefined;
  private writePromise: Promise<void> | undefined;
  private readonly onEnqueued = (event: EnqueuedEvent): void => {
    this.wake(event.lane);
  };

  constructor(deps: DispatcherDeps, cfg: DispatcherConfig = {}) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.lease = deps.lease;
    this.clock = deps.clock ?? systemClock;
    this.makeContext =
      deps.makeContext ??
      ((signal, job) => ({
        signal,
        // 진행 카드 ts 등 실행 중 확정값을 DB payload 에 못박아 재시작 후 재시도에 이어 쓰게 한다.
        persistPayload: <P>(payload: P) => {
          this.store.updatePayload(job.id, payload);
        },
      }));
    this.onError = deps.onError ?? (() => {});
    this.interactiveConcurrency = cfg.interactiveConcurrency ?? 3;
    this.automationMaxPerTick = cfg.automationMaxPerTick ?? 3;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 1_000;
    this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? 20_000;
    this.backoffMs = cfg.backoffMs ?? defaultBackoffMs;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.store.events.on("enqueued", this.onEnqueued);
    // 폴링은 폴백일 뿐이다 — 이벤트 경로가 죽어도 not_before 도래·잔여 pending을 놓치지 않기 위함.
    this.pollTimer = setInterval(() => this.wakeAll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    // 부팅 직전 recoverInflight가 되돌린 pending을 이벤트 없이도 즉시 집는다.
    this.wakeAll();
  }

  /** graceful 정지: 새 claim 중단 + 진행 중 잡에 abort 신호 + 완료 대기 — 강제 킬은 recoverInflight 몫. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.store.events.off("enqueued", this.onEnqueued);
    this.abort.abort();
    await Promise.allSettled([
      ...this.interactiveRunning.values(),
      this.automationPromise ?? Promise.resolve(),
      this.writePromise ?? Promise.resolve(),
    ]);
  }

  wake(lane: Lane): void {
    if (this.stopped || !this.started) return;
    if (lane === "interactive") {
      this.pumpInteractive();
    } else if (lane === "automation") {
      this.pumpAutomation();
    } else {
      this.pumpWrite();
    }
  }

  private wakeAll(): void {
    this.wake("interactive");
    this.wake("automation");
    this.wake("write");
  }

  private pumpInteractive(): void {
    if (this.stopped) return;
    while (this.interactiveRunning.size < this.interactiveConcurrency) {
      // busyLaneKeys 제외 claim — 같은 thread_key는 직렬, 다른 thread_key는 병렬 (JQ-07/SC-03).
      const job = this.store.claimNext("interactive", [...this.busyLaneKeys]);
      if (!job) return;
      if (job.laneKey !== null) this.busyLaneKeys.add(job.laneKey);
      const running = this.execute(job).finally(() => {
        this.interactiveRunning.delete(job.id);
        if (job.laneKey !== null) this.busyLaneKeys.delete(job.laneKey);
        // 슬롯/lane_key 반환 직후 재펌프 — 같은 스레드 후속 잡이 다음 폴링까지 기다리지 않게.
        this.pumpInteractive();
      });
      this.interactiveRunning.set(job.id, running);
    }
  }

  private pumpAutomation(): void {
    if (this.stopped || this.automationPromise) return;
    this.automationPromise = this.drainAutomation().finally(() => {
      this.automationPromise = undefined;
    });
  }

  private async drainAutomation(): Promise<void> {
    // tick당 상한 — 초과분은 pending으로 남아 다음 tick에 이월된다(잡이 사라지는 cap이 아니다).
    for (let i = 0; i < this.automationMaxPerTick; i++) {
      if (this.stopped) return;
      const job = this.store.claimNext("automation");
      if (!job) return;
      await this.execute(job);
    }
  }

  private pumpWrite(): void {
    if (this.stopped || this.writePromise) return;
    this.writePromise = this.drainWrite().finally(() => {
      this.writePromise = undefined;
    });
  }

  private async drainWrite(): Promise<void> {
    while (!this.stopped) {
      const job = this.store.claimNext("write");
      if (!job) return;
      const grant = this.lease.acquire(job.id);
      if (!grant) {
        // 실행 전 lease 경합 — 실행 실패가 아니므로 attempts를 되돌려 예산을 보존한다 (JQ-04/15).
        this.store.requeue(job.id, {
          undoAttempt: true,
          notBefore: this.clock.now() + this.backoffMs(1),
        });
        return;
      }
      const heartbeat = setInterval(() => {
        this.lease.heartbeat(job.id, grant.leaseId);
      }, this.heartbeatIntervalMs);
      heartbeat.unref?.();
      try {
        await this.execute(job, grant.leaseId);
      } finally {
        clearInterval(heartbeat);
      }
    }
  }

  private async execute(job: Job, leaseId?: string): Promise<void> {
    const ctx = this.makeContext(this.abort.signal, job);
    const handler = this.registry.get(job.type);
    if (!handler) {
      this.handleUnregistered(job, leaseId);
      return;
    }
    const parsed = handler.payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      // 스키마 불일치는 재시도로 해결되지 않는다 — 즉시 failed + onExhausted 통보 (ADR-0001, 침묵 금지).
      this.settle(
        job,
        "failed",
        { error: `payload 스키마 불일치: ${parsed.error.message}` },
        leaseId,
      );
      await this.notifyExhausted(handler, job, ctx);
      return;
    }
    const typedJob: Job = { ...job, payload: parsed.data };
    let verdict: JobResult;
    try {
      verdict = await handler.run(typedJob, ctx);
    } catch (err) {
      this.onError(err, job);
      if (job.attempts >= job.maxAttempts) {
        this.settle(job, "failed", { error: errorMessage(err) }, leaseId);
        // silent cap 금지 (JQ-06) — 재시도 소진은 반드시 핸들러 통보 경로를 태운다.
        await this.notifyExhausted(handler, typedJob, ctx);
      } else {
        // attempts는 claim에서 이미 소진됐다 — 백오프만 걸어 되돌린다.
        const requeued = this.requeue(
          job,
          {
            notBefore: this.clock.now() + this.backoffMs(job.attempts),
            error: errorMessage(err),
          },
          leaseId,
        );
        if (!requeued) {
          // write 레인 fencing: 탈취된 lease의 늦은 requeue — 상태를 덮지 못한 것이 정상 동작이다 (JQ-15).
          this.onError(new Error(`requeue 무효(stale lease 또는 상태 경합) — job=${job.id}`), job);
        }
      }
      return;
    }
    const applied = this.settle(job, verdict, {}, leaseId);
    if (!applied) {
      // write 레인 fencing: 탈취된 lease의 늦은 settle — 상태를 덮지 못한 것이 정상 동작이다.
      this.onError(new Error(`settle 무효(stale lease 또는 상태 경합) — job=${job.id}`), job);
    }
  }

  /**
   * 미등록 잡 타입 처리 (JQ 부팅 레이스 방어) — 즉시 영구 failed 하지 않는다.
   *
   * 근거(2026-07-22 실사고): 재시작 churn 중 핸들러 등록 갭(레이스)에도 잡이 즉시 failed 로
   * 영구 소실됐다(alert-analysis 1건). 핸들러가 등록된 다음 부팅으로 복구 가능하도록 pending 으로
   * 되돌린다(release/requeue). attempts 를 상한으로 써(claim 에서 이미 소진) 상한 초과 시에만
   * 최종 failed + loud — 핸들러가 영영 안 붙어도 무한 루프하지 않는다. 백오프로 같은 부팅 안에서의
   * 즉시 재claim tight-loop 을 막는다(같은 부팅은 registry 가 고정이라 재시도해도 못 붙는다).
   *
   * write 레인(leaseId 보유)은 requeue/settle 헬퍼가 lease 를 해제한다(fenced).
   */
  private handleUnregistered(job: Job, leaseId?: string): void {
    if (job.attempts >= job.maxAttempts) {
      // 상한 초과 — 여러 부팅에 걸쳐 핸들러가 계속 미등록이면 그때만 최종 종결한다(반드시 loud).
      const err = new Error(
        `등록되지 않은 잡 타입(재시도 상한 초과): ${job.type} — attempts=${job.attempts}/${job.maxAttempts}`,
      );
      const applied = this.settle(job, "failed", { error: err.message }, leaseId);
      // 등록된 핸들러가 없어 onExhausted 통보 경로가 없다 — onError(loud)로 운영에 드러낸다.
      this.onError(err, job);
      if (!applied) {
        this.onError(new Error(`settle 무효(stale lease 또는 상태 경합) — job=${job.id}`), job);
      }
      return;
    }
    // 재시작 복구용 requeue — 소실이 아니다. 백오프로 같은 부팅 내 tight-loop 방지.
    const requeued = this.requeue(
      job,
      {
        notBefore: this.clock.now() + this.backoffMs(job.attempts),
        error: `등록되지 않은 잡 타입: ${job.type} — 재시작(핸들러 등록) 복구 대기`,
      },
      leaseId,
    );
    // 관찰 훅 — 소실이 아님을 명확히(loud 아님, 정상 방어 동작). onError 는 유지하되 requeue 성공은 통보만.
    this.onError(
      new Error(`미등록 잡 타입 requeue(복구 대기, 소실 아님): ${job.type} — job=${job.id}`),
      job,
    );
    if (!requeued) {
      this.onError(new Error(`requeue 무효(stale lease 또는 상태 경합) — job=${job.id}`), job);
    }
  }

  private settle(
    job: Job,
    verdict: JobResult,
    opts: { result?: string; error?: string },
    leaseId?: string,
  ): boolean {
    return leaseId !== undefined
      ? this.lease.settle(job.id, leaseId, verdict, opts)
      : this.store.settle(job.id, verdict, opts);
  }

  /** settle과 대칭 — write 레인(leaseId 보유)은 fenced requeue만 태운다 (JQ-15). */
  private requeue(
    job: Job,
    opts: { notBefore?: number | null; error?: string },
    leaseId?: string,
  ): boolean {
    return leaseId !== undefined
      ? this.lease.requeue(job.id, leaseId, opts)
      : this.store.requeue(job.id, opts);
  }

  private async notifyExhausted(handler: AnyJobHandler, job: Job, ctx: JobContext): Promise<void> {
    try {
      await handler.onExhausted?.(job, ctx);
    } catch (err) {
      this.onError(err, job);
    }
  }
}
