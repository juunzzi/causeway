/**
 * 이벤트 수신 트래커 — "마지막으로 실제 이벤트가 들어온 시각"과 "그 좌표"의 단일 출처 (RS-01/03).
 *
 * 선행 구현 이식. index.ts 의 이벤트 수신 훅이 매 인바운드마다
 * markEvent() 를 부르고, socketHealth 가 lastEventAt/lastSeen 을 읽어 idle·probe 기준선으로
 * 쓴다. probe 가 REST 로 소급 수집한 replay 메시지는 여기를 갱신하지 않는다 — REST 로
 * 가져온 메시지는 소켓 파이프가 건강하다는 증거가 아니기 때문(RS-02, 원칙 항목).
 *
 * 인메모리여도 OPS-13 위반이 아니다: "지금 이 프로세스의 소켓이 마지막으로 받은 시각"은
 * 본질적으로 휘발성이고, 재시작하면 새 소켓의 새 기준선에서 다시 시작하는 것이 옳다.
 */

import type { Clock } from "../core/clock.js";

export interface LastSeen {
  channel: string;
  ts: string;
}

export interface EventTracker {
  /**
   * 실제 소켓 이벤트 수신 시 호출 — idle 타이머 리셋 + 최신 좌표 기록.
   * channel/ts 가 있으면 최신(ts 최대) 좌표만 유지한다.
   */
  markEvent(channel?: string, ts?: string): void;
  /** 재연결 시 기준선을 '지금'으로 당긴다 — 재연결 이전에 놓친 메시지로 좀비를 오판하지 않게. */
  resetBaseline(): void;
  lastEventAt(): number;
  lastSeen(): LastSeen | null;
}

/** Slack ts 문자열 비교: a 가 b 보다 나중인가. 파싱 실패는 false(보수적). */
export function tsGreater(a: string, b: string): boolean {
  const fa = Number.parseFloat(a);
  const fb = Number.parseFloat(b);
  if (Number.isNaN(fa) || Number.isNaN(fb)) return false;
  return fa > fb;
}

export function createEventTracker(clock: Clock = { now: () => Date.now() }): EventTracker {
  let lastAt = clock.now();
  let seen: LastSeen | null = null;

  return {
    markEvent(channel, ts) {
      lastAt = clock.now();
      if (channel && ts && (seen === null || tsGreater(ts, seen.ts))) {
        seen = { channel, ts };
      }
    },
    resetBaseline() {
      lastAt = clock.now();
      // 재연결 이후 새로 들어오는 메시지만 기준으로 삼도록 좌표를 '지금'으로 당긴다
      seen = { channel: seen?.channel ?? "", ts: `${(clock.now() / 1000).toFixed(6)}` };
    },
    lastEventAt() {
      return lastAt;
    },
    lastSeen() {
      return seen;
    },
  };
}
