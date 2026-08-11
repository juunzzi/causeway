import type { z } from "zod";

export type Lane = "interactive" | "automation" | "write";

export type JobStatus = "pending" | "inflight" | "done" | "failed" | "cancelled";

/**
 * run()의 종국 판정. 'failed'는 핸들러가 내린 최종 실패(재시도 무의미) —
 * 재시도가 필요한 일시 오류는 throw로 표현한다(dispatcher가 백오프 requeue).
 */
export type JobResult = "done" | "failed" | "cancelled";

export interface Job<P = unknown> {
  id: number;
  type: string;
  dedupKey: string;
  lane: Lane;
  laneKey: string | null;
  payload: P;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  executionStartedAt: number | null;
  notBefore: number | null;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 잡 실행 부작용 의존성 컨테이너 — deps는 전부 여기로 주입된다(테스트 가능).
 * Phase 진행(runner/egress 합류)에 따라 필드가 늘어난다.
 */
export interface JobContext {
  /** dispatcher.stop() 시 abort — 핸들러는 이를 보고 조기 마무리할 수 있다. */
  signal: AbortSignal;
  /**
   * 실행 중인 잡의 payload 를 DB 에 못박는다(inflight 한정, JobStore.updatePayload 위임).
   * 진행 카드 ts 처럼 실행 도중 확정되는 값을 영속화해 프로세스 재시작(kill-9·launchctl kickstart)
   * 후 재시도에서도 같은 카드/부모 스레드를 이어 쓰게 한다(맵 유실로 인한 고아·중복 카드 방지).
   * 미주입(단위 테스트 등)이면 핸들러는 in-process 맵 폴백으로 동작한다.
   */
  persistPayload?<P>(payload: P): void;
}

/** ARCHITECTURE.md §2 잡 핸들러 계약 그대로 — 이 인터페이스가 새 자동화 추가의 전부다. */
export interface JobHandler<P> {
  type: string;
  lane: Lane;
  maxAttempts: number;
  /** payload에 schema_version 포함 — zod 실패는 재시도가 아니라 failed + 통보다 (ADR-0001). */
  payloadSchema: z.ZodType<P>;
  run(job: Job<P>, ctx: JobContext): Promise<JobResult>;
  /** silent cap 금지(JQ-06) — 재시도 소진·스키마 불일치 시 dispatcher가 반드시 호출한다. */
  onExhausted?(job: Job<P>, ctx: JobContext): Promise<void>;
}

/** registry/dispatcher가 payload 타입을 지운 채 다루기 위한 별칭. */
export type AnyJobHandler = JobHandler<unknown>;
