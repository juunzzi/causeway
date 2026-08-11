/** 시간 의존 로직의 단일 주입 지점 — 테스트에서 가짜 클록으로 백오프·lease 만료를 결정론 검증하기 위함. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
