/**
 * API 에러가 "성공 텍스트"로 반환되는 함정 대응 (RS-10).
 *
 * CLI/SDK 는 529/429 를 예외가 아니라 `"API Error: 529 …"` 같은 정상 결과 텍스트로
 * 돌려줄 수 있다 (선행 구현 실측).
 * 이를 놓치면 분류기가 조용히 none 으로 오분류해 인텐트를 통째로 잃는다 —
 * 감지 → 지수 백오프 재시도 → 소진 시 grep 가능한 에러 로그가 계약이다.
 */

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────────────

/** grep 진입점 — err 로그에서 이 접두사로 재시도 소진을 찾는다. */
export const API_ERROR_LOG_PREFIX = "[api-error-retry]";

const API_ERROR_PREFIX_RE = /^\s*API Error:?\s/i;
const ERROR_ENVELOPE_RE = /^\s*\{"type"\s*:\s*"error"/;
/**
 * 응답 전체가 짧은 래퍼 접두 + 에러 타입명(선택적 trailing 구두점)으로 '끝나는' 형태만 —
 * `classification failed: overloaded_error`, `rate_limit_error`,
 * `{"error":{"type":"rate_limit_error"}}` 는 잡고, 본문 중간에 타입명이 등장하는
 * 정상 답변("rate_limit_error 를 어떻게 처리하나요")은 통과시킨다.
 */
const BARE_ERROR_LINE_RE =
  /^[^\n]{0,120}\b(overloaded_error|rate_limit_error|api_error)\b[\s"'`.,)\]}]*$/;

/**
 * 오탐 방지: 세 패턴 전부 앵커드다 — 실제 에러-텍스트 함정은 응답 '전체'가 에러
 * 페이로드인 형태로만 오므로, 본문 중간에 "API Error" / 에러 JSON 예시 / 에러 타입명을
 * 인용하는 정상 답변까지 재시도로 오인하면 안 된다(불필요한 지연 + LLM 비용).
 * 비앵커드 substring 매치는 그 오탐을 만든 전력이 있어 금지 (리뷰 지적).
 */
export function looksLikeApiError(text: string): boolean {
  if (text.length === 0) return false;
  return (
    API_ERROR_PREFIX_RE.test(text) || ERROR_ENVELOPE_RE.test(text) || BARE_ERROR_LINE_RE.test(text)
  );
}

/** attempt 는 1부터. 상한(maxMs)이 있어야 소진 직전 대기가 폭주하지 않는다. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

// ────────────────────────────────────────────────────────────────────────────
// 오케스트레이션부 — 재시도 래퍼 (클록 주입)
// ────────────────────────────────────────────────────────────────────────────

export interface ApiErrorRetryOptions<T> {
  /** 결과에서 에러 판별 대상 텍스트를 뽑는다. */
  getText: (value: T) => string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 주입 클록 — 테스트는 대기 없이 지연 시퀀스만 기록한다. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; text: string }) => void;
  onExhausted?: (info: { attempts: number; text: string }) => void;
  /** 소진 로그 출력 — 기본 console.error (grep 가능해야 한다). */
  log?: (line: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * run 결과 텍스트가 API 에러 모양이면 백오프 후 재실행한다.
 * 소진 시 예외를 던지지 않고 마지막 결과를 그대로 반환한다 — 처리 여부(실패 종결·통보)는
 * 호출자(잡 핸들러)의 책임이고, 여기서는 관측 가능성(onExhausted + 로그)만 보장한다.
 */
export async function retryOnApiErrorText<T>(
  run: (attempt: number) => Promise<T>,
  options: ApiErrorRetryOptions<T>,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((line: string) => console.error(line));

  let last: T = await run(1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) last = await run(attempt);
    const text = options.getText(last);
    if (!looksLikeApiError(text)) return last;
    if (attempt === maxAttempts) {
      options.onExhausted?.({ attempts: maxAttempts, text });
      log(`${API_ERROR_LOG_PREFIX} exhausted after ${maxAttempts} attempts: ${text.slice(0, 200)}`);
      return last;
    }
    const delayMs = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);
    options.onRetry?.({ attempt, delayMs, text });
    await sleep(delayMs);
  }
  return last;
}
