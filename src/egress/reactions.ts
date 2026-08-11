/**
 * 트리거 메시지 리액션 상태머신 — ⏳(수신) → ✅(성공)/❌(실패)/🚫(취소) (EG-06).
 *
 * 선행 구현 이식. 리액션은 상태 피드백일 뿐 본 작업의 일부가 아니므로
 * Slack API 실패는 삼키고 로그만 남긴다.
 */

import type { SlackPort } from "./ports.js";

// ── 순수 함수부 ─────────────────────────────────────────────────────────────

export type ReactionState = "pending" | "success" | "failure" | "cancelled";

export const REACTION_EMOJI: Readonly<Record<ReactionState, string>> = {
  pending: "hourglass_flowing_sand",
  success: "white_check_mark",
  failure: "x",
  cancelled: "no_entry_sign",
};

/**
 * 취소 어포던스 🛑 — ⏳ 와 함께 달아 두는 "누르면 중단" 버튼이다.
 *
 * 버튼이 아니라 리액션인 이유: 정상 경로의 진행 표시는 Slack agent plan 카드(스트리밍)이고
 * 그 카드에는 Block Kit 버튼을 붙일 수 없다(chunk 타입이 markdown_text/task_update/plan_update
 * 뿐 — agentStream.ts). 스레드에 버튼 메시지를 따로 띄우면 대화마다 부산물이 하나씩 늘고
 * 삭제 실패가 곧 잔재가 된다. 이미 달고 있는 ⏳ 옆에 하나 더 다는 것은 노이즈가 0 이면서
 * 클릭 한 번이라는 점에서 버튼과 동등하다.
 *
 * 사람이 직접 단 🛑 와 봇이 단 이 어포던스는 **같은 reaction_added 이벤트**로 돌아온다 —
 * 트리거 경로가 하나뿐이라는 뜻이다(ingress/reactionListener.ts). 대신 봇 자신이 단 것까지
 * 취소로 읽으면 시작하자마자 자기 작업을 죽이므로, 리스너의 botUserId 가드가 필수다.
 */
export const CANCEL_AFFORDANCE_EMOJI = "octagonal_sign";

/**
 * 전이 규칙:
 * - 미기록 → 어떤 상태든 허용 (⏳ 추가 실패 후에도 종결 리액션은 달 수 있어야 한다)
 * - pending → 종결 3종만 (중복 ⏳ 방지)
 * - 종결 상태는 불변 — 먼저 정해진 결과가 승리 (재전송·중복 settle 무해화)
 */
export function canTransition(from: ReactionState | undefined, to: ReactionState): boolean {
  if (from === undefined) return true;
  if (from === "pending") return to !== "pending";
  return false;
}

// ── 오케스트레이션부 ─────────────────────────────────────────────────────────

export interface ReactionManagerDeps {
  slack: SlackPort;
  /** 자기 메시지 리액션 금지 가드 — 상태 피드백은 제3자 글에만 단다. */
  isOwnMessage?: (channel: string, ts: string) => boolean;
  log?: (msg: string) => void;
}

export interface ReactionManager {
  start(channel: string, ts: string): Promise<boolean>;
  succeed(channel: string, ts: string): Promise<boolean>;
  fail(channel: string, ts: string): Promise<boolean>;
  cancel(channel: string, ts: string): Promise<boolean>;
  stateOf(channel: string, ts: string): ReactionState | undefined;
}

export function createReactionManager(deps: ReactionManagerDeps): ReactionManager {
  const isOwn = deps.isOwnMessage ?? (() => false);
  const log = deps.log ?? (() => {});
  const states = new Map<string, ReactionState>();

  async function transition(channel: string, ts: string, to: ReactionState): Promise<boolean> {
    if (isOwn(channel, ts)) return false;
    const key = `${channel}:${ts}`;
    const from = states.get(key);
    if (!canTransition(from, to)) return false;
    // 상태는 API 성공 여부와 무관하게 기록 — 로컬 의도가 진실원, 재시도 폭주 방지
    states.set(key, to);

    if (from === "pending") {
      try {
        await deps.slack.removeReaction({ channel, ts, name: REACTION_EMOJI.pending });
      } catch (err) {
        log(`⏳ 제거 실패 channel=${channel} ts=${ts}: ${String(err)}`);
      }
      // 어포던스도 함께 회수 — 끝난 작업에 🛑 가 남아 있으면 "아직 멈출 수 있다"는 거짓 신호다.
      // (사람이 직접 단 🛑 는 남는다 — reactions.remove 는 자기가 단 것만 지운다. 무해하다.)
      try {
        await deps.slack.removeReaction({ channel, ts, name: CANCEL_AFFORDANCE_EMOJI });
      } catch (err) {
        log(`🛑 제거 실패 channel=${channel} ts=${ts}: ${String(err)}`);
      }
    }
    try {
      await deps.slack.addReaction({ channel, ts, name: REACTION_EMOJI[to] });
    } catch (err) {
      log(`리액션(${to}) 추가 실패 channel=${channel} ts=${ts}: ${String(err)}`);
    }
    if (to === "pending") {
      // ⏳ 다음에 단다 — 표시 순서가 곧 "받았다 → 멈출 수 있다" 라는 읽는 순서다.
      // 실패해도 삼킨다: 어포던스가 없어도 /cancel 과 직접 🛑 는 그대로 동작한다.
      try {
        await deps.slack.addReaction({ channel, ts, name: CANCEL_AFFORDANCE_EMOJI });
      } catch (err) {
        log(`🛑 추가 실패 channel=${channel} ts=${ts}: ${String(err)}`);
      }
    }
    return true;
  }

  return {
    start: (channel, ts) => transition(channel, ts, "pending"),
    succeed: (channel, ts) => transition(channel, ts, "success"),
    fail: (channel, ts) => transition(channel, ts, "failure"),
    cancel: (channel, ts) => transition(channel, ts, "cancelled"),
    stateOf: (channel, ts) => states.get(`${channel}:${ts}`),
  };
}
