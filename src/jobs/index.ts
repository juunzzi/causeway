/**
 * 잡 핸들러 명시 조립 (JQ-09) — 새 자동화는 반드시 이 배열에 한 줄을 더하는 PR 이어야 한다.
 * glob 자동발견 금지: 보안 경계(어떤 잡이 실행 가능한가)가 PR diff 에 드러나는 것이 목적이다.
 *
 * causeway 은 현재 chat 하나뿐이다 — 사람이 멘션/DM 으로 물으면 조회 도구로 답한다.
 * 배열이 하나여도 이 파일을 남겨 두는 이유는 두 번째 잡이 생길 때 등록 지점이 어디인지
 * 코드가 스스로 말하게 하기 위해서다(잡이 열 개로 자라는 경로가 여기다).
 */

import type { AnyJobHandler } from "../core/queue/types.js";
import { type ChatHandlerDeps, createChatHandler } from "./chat/handler.js";

export interface JobHandlerDeps {
  chat: ChatHandlerDeps;
}

export function buildJobHandlers(deps: JobHandlerDeps): AnyJobHandler[] {
  // 타입별 핸들러는 deps 주입 팩토리 — dispatcher 가 safeParse 로 payload 를 재검증하므로
  // 타입 소거 캐스트는 안전하다 (zod 스키마가 런타임 경계를 지킨다).
  return [createChatHandler(deps.chat) as unknown as AnyJobHandler];
}
