import type { AnyJobHandler } from "./queue/types.js";

/**
 * 잡 핸들러 명시 등록 배열 — glob 자동발견 금지 (JQ-09).
 * 제약: 새 자동화 추가는 반드시 이 배열에 한 줄을 더하는 PR이어야 한다(diff에 드러나는 것이 목적).
 *
 * 스케줄 잡 주의(JQ-11/13): schedules.json 의 `enabled:true` 는 여기에 대응 핸들러가
 * 등록된 뒤에만 켠다. 핸들러 없이 켜면 매 발화가 '등록되지 않은 잡 타입'으로 requeue 되며
 * (dispatcher.handleUnregistered — 부팅 레이스 방어로 즉시 failed 는 아니지만) attempts 상한
 * 초과 시 결국 failed 종결되고, self-audit(JQ-13)가 그 failed 를 오탐 통보한다.
 * 그래서 schedules.example.json 의 daily-error-report·schedule-audit 는 `enabled:false` 로 둔다
 * — 핸들러가 이 배열에 등록되는 PR에서 함께 켜라.
 */
const HANDLERS: readonly AnyJobHandler[] = [
  // deps 주입이 필요한 핸들러(chat, alert-analysis 등)는 이 정적 배열이 아니라
  // jobs/index.ts 의 buildJobHandlers(deps) 팩토리가 조립해 buildRegistry(handlers) 로 넘긴다
  // (context.ts 부팅 시퀀스). 정적 배열은 deps 없는 핸들러 전용이며 현재는 비어 있다.
  // — 등록 규약(JQ-09): 새 자동화는 buildJobHandlers 배열에 한 줄이 드러나야 한다.
];

export function buildRegistry(
  handlers: readonly AnyJobHandler[] = HANDLERS,
): ReadonlyMap<string, AnyJobHandler> {
  const registry = new Map<string, AnyJobHandler>();
  for (const handler of handlers) {
    if (registry.has(handler.type)) {
      // 같은 타입 이중 등록은 어느 핸들러가 실행될지 배포 순서에 걸리는 버그 — 부팅 시점에 죽인다.
      throw new Error(`잡 타입 중복 등록: ${handler.type}`);
    }
    registry.set(handler.type, handler);
  }
  return registry;
}
