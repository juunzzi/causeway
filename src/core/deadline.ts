/**
 * 마감 시한 래퍼 — "끝나지 않는 대기"를 "시끄러운 실패"로 바꾼다.
 *
 * 무한 대기의 진짜 비용은 느림이 아니라 **무음**이다. 로그도 스택도 없이 멈춰 있으면 상위
 * 감시자(부팅 판정·워치독)는 그것을 '실패'로만 볼 뿐 원인을 남기지 못한다. 2026-07-30
 * 부팅 행 사고가 정확히 그랬다(CONTRACT.SLACK_REQUEST_TIMEOUT_MS 주석 참조).
 *
 * 취소는 하지 않는다 — 원래 작업은 계속 돌지만 결과는 버려진다. Promise.race 가 양쪽에
 * 핸들러를 걸어두므로, 마감 후 원래 작업이 늦게 reject 해도 unhandled rejection 이 되지 않는다.
 */

/** 마감 초과. 원래 작업의 실패와 구분하려고 별도 타입을 둔다. */
export class DeadlineError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} 이 ${ms}ms 안에 끝나지 않았다`);
    this.name = "DeadlineError";
  }
}

export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
