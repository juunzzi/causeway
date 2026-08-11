/**
 * reaction_added 취소 트리거 — 진행 중 대화를 이모지 하나로 중단한다 (SC-09).
 *
 * 봇이 트리거 메시지에 ⏳ 와 함께 달아 두는 🛑(egress/reactions.ts 의 어포던스)을 누르는 것도,
 * 사람이 직접 🛑/⏹️/❌ 를 다는 것도 Slack 은 **같은 reaction_added 이벤트**로 보낸다. 그래서
 * 취소 경로는 여기 하나뿐이고, `/cancel` 커맨드와 같은 종착지(runningTasks)로 수렴한다 —
 * 중단의 의미(userCancelled 마킹 → abort → 🚫 + "취소됨" 안내)가 트리거마다 갈리지 않는다.
 *
 * ingress 규율은 slackListeners 와 같다: 여기서 실행하는 것은 없고 가드→매칭→취소 신호가 전부다.
 * 취소 결과 안내도 게시하지 않는다 — 그건 실행 중인 chat 핸들러의 finishCancelled 몫이고,
 * 여기서 한 줄 더 쓰면 같은 사실이 스레드에 두 번 적힌다.
 */

import type { CancelTargetItem } from "../jobs/chat/runningTasks.js";
import type { AclContext } from "../security/acl.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

/**
 * 취소로 읽는 리액션.
 *
 * - `octagonal_sign` 🛑 — 봇이 미리 달아 두는 어포던스이자 사람이 가장 먼저 떠올리는 정지 기호.
 * - `stop_button` ⏹️ — 이모지 피커에서 "stop" 을 치면 먼저 뜨는 쪽이라 함께 받는다.
 * - `black_square_for_stop` ⏹ — ⏹️ 의 이형(variation selector 없는 쪽). 사람 눈에는 같은 기호다.
 * - `x` ❌ — 멈추라는 뜻으로 가장 자주 눌리는 기호라 받는다.
 *
 * ❌ 는 봇이 **실패 결과로도 다는 기호**다(egress/reactions.ts 의 `failure`). 그래도 자기 작업을
 * 죽이지 않는 이유는 아래 핸들러의 botUserId 가드다 — 봇이 단 ❌ 는 취소로 읽히지 않는다.
 * 다만 사람이 끝난 대화에 "실패했네" 뜻으로 ❌ 를 달면 그때는 진행 중 작업이 없어 no-op 이다.
 *
 * 🚫 `no_entry_sign` 은 계속 뺀다 — 그건 취소가 **완료됐다**는 종결 표시라, 입력으로도 받으면
 * 봇이 남긴 결과와 사람의 지시가 같은 기호로 겹친다.
 */
export const CANCEL_REACTIONS: ReadonlySet<string> = new Set([
  "octagonal_sign",
  "stop_button",
  "black_square_for_stop",
  "x",
]);

/**
 * 스킨톤 변형 제거 — Slack 은 `+1::skin-tone-3` 처럼 접미사를 붙여 보낸다. 🛑/⏹️ 에는
 * 스킨톤이 없지만, 목록을 늘렸을 때 조용히 안 걸리는 함정을 미리 없애 둔다.
 */
export function normalizeReactionName(name: string): string {
  return name.split("::")[0] ?? name;
}

export function isCancelReaction(name: string): boolean {
  return CANCEL_REACTIONS.has(normalizeReactionName(name));
}

export interface NormalizedReaction {
  userId: string;
  /** 스킨톤 제거된 이모지 이름. */
  name: string;
  item: CancelTargetItem;
}

/**
 * reaction_added 이벤트 정규화 — 메시지 대상 리액션만 통과시킨다.
 * 파일/파일코멘트 리액션(`item.type !== "message"`)은 좌표가 다르므로 취소 대상이 아니다.
 */
export function normalizeReaction(event: Record<string, unknown>): NormalizedReaction | null {
  const userId = typeof event.user === "string" ? event.user : "";
  const reaction = typeof event.reaction === "string" ? event.reaction : "";
  if (!userId || !reaction) return null;

  const item = event.item;
  if (typeof item !== "object" || item === null) return null;
  const { type, channel, ts } = item as Record<string, unknown>;
  if (type !== "message") return null;
  if (typeof channel !== "string" || !channel) return null;
  if (typeof ts !== "string" || !ts) return null;

  return { userId, name: normalizeReactionName(reaction), item: { channel, ts } };
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────

export interface ReactionListenerDeps {
  /** 봇 자신의 user_id — 봇이 단 어포던스가 자기 작업을 죽이는 것을 막는 유일한 가드. */
  botUserId: string;
  botTeamId?: string | null;
  acl: { isAllowed(userId: string, ctx?: AclContext): boolean };
  /** 메시지 좌표 → 진행 중 작업 취소. 반환값은 취소된 threadKey(없으면 null). */
  cancelByMessage(item: CancelTargetItem): string | null;
  log?: (msg: string) => void;
}

export interface ReactionListener {
  handleReactionAdded(event: Record<string, unknown>): Promise<void>;
}

export function createReactionListener(deps: ReactionListenerDeps): ReactionListener {
  const log = deps.log ?? (() => {});

  return {
    async handleReactionAdded(event) {
      const reaction = normalizeReaction(event);
      if (!reaction) return;

      // 봇 자신의 리액션 배제 — **이 가드가 없으면 봇은 시작하자마자 자살한다.** 어포던스 🛑 를
      // 다는 행위 자체가 reaction_added 로 돌아오고, 그게 취소로 읽히면 모든 대화가 즉시 취소된다.
      if (reaction.userId === deps.botUserId) return;

      if (!isCancelReaction(reaction.name)) return;

      // 리액션 이벤트에는 발신자 팀 ID 가 실리지 않는다 — 와일드카드 ACL 의 팀 범위 판정은
      // 생략된다(ctx 미지정). 취소는 파괴적 조작이 아니고, 애초에 그 대화를 볼 수 있는
      // 사람만 리액션을 달 수 있으므로 게이트는 allowed 명단 하나로 충분하다.
      if (!deps.acl.isAllowed(reaction.userId)) {
        log(
          `reaction-cancel acl-deny user=${reaction.userId} channel=${reaction.item.channel} ts=${reaction.item.ts}`,
        );
        return;
      }

      const cancelled = deps.cancelByMessage(reaction.item);
      if (cancelled === null) {
        // 진행 중 작업이 없는 메시지에 🛑 를 단 것 — 흔한 일이다(이미 끝난 대화, 남의 글).
        // 스레드에 아무것도 쓰지 않는다: 사람이 이모지를 달았다고 봇이 말을 걸면 그게 노이즈다.
        log(
          `reaction-cancel no-op — 진행 중 작업 없음 channel=${reaction.item.channel} ts=${reaction.item.ts}`,
        );
        return;
      }
      log(`reaction-cancel thread=${cancelled} by=${reaction.userId} emoji=${reaction.name}`);
    },
  };
}
