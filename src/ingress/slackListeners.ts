/**
 * Slack 이벤트 리스너 — app_mention + message.im (SC-05/07, JQ-01/08).
 *
 * Ingress 는 절대 실행하지 않는다: 가드 → sanitize → acl → 커맨드 분기 → normalize →
 * 멱등 enqueue 가 전부다. Slack 이벤트 재전송(3초 ack 지연)·DM 멘션의 이중 전달
 * (app_mention + message.im)은 dedup_key(`slack:channel:ts`) UNIQUE 가 구조적으로 무해화한다.
 *
 * 무해화 범위는 chat 잡뿐 아니라 세 경로 전부다: acl 거부 안내·'/' 커맨드 즉답은 잡
 * 파이프라인을 타지 않으므로 handleEvent 최상단에서 ingressDedup 이 같은 envelope 을 한 번만
 * 통과시킨다 (JQ-08 — 이중 응답 없음). dispatcher wakeup 은 JobStore.enqueue 의 'enqueued'
 * 이벤트가 담당 — 별도 호출 불필요 (JQ-07).
 */

import type { CommandExecutor } from "../commands/index.js";
import type { JobStore } from "../core/queue/jobStore.js";
import type { Poster } from "../egress/poster.js";
import { CHAT_JOB_TYPE, CHAT_MAX_ATTEMPTS, type ChatPayload } from "../jobs/chat/handler.js";
import type { AclContext } from "../security/acl.js";
import { sanitizeText } from "../security/sanitize.js";
import type { IngressDedup } from "./ingressDedup.js";
import { isTriggerSubtype, normalizeInbound } from "./normalize.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

export type SlackEventKind = "app_mention" | "message";

export function chatDedupKey(channel: string, ts: string): string {
  return `slack:${channel}:${ts}`;
}

/**
 * 유실 메시지 replay 시 이벤트 kind 판정 — 실시간 리스너 배선과 동일한 결과를 내야 한다.
 *
 * 실시간 경로에서는 Slack 이 멘션을 감지했을 때만 app_mention 을 배달하고, 그 외 채널
 * 메시지는 message 이벤트로 와서 `channelType !== "im"` 게이트에 걸려 버려진다. 그런데
 * probe/replay 는 채널 top-level 을 REST 로 긁어오므로 '봇을 멘션하지 않은 워처 채널 일반
 * 메시지'까지 수집된다. 이걸 channel_type 만으로 app_mention 으로 둔갑시키면 실시간이라면
 * 버려졌을 메시지가 chat 파이프라인(ACL/커맨드/LLM 잡)에 강제 진입한다.
 *
 * 그래서 replay 는 원본 이벤트가 실제로 무엇이었는지로 판정한다:
 *  - DM(channel_type === "im") → message (실시간 message.im 경로와 동일).
 *  - 봇 멘션 토큰(<@BOT> / <@BOT|label>)이 본문에 실제로 있으면 → app_mention.
 *  - 그 외(멘션 없는 채널 메시지) → message. 실시간과 똑같이 message 로 넣어
 *    `channelType !== "im"` 게이트가 버리게 한다(워처 채널 일반 메시지 강제 진입 차단).
 */
export function classifyReplayKind(
  event: Record<string, unknown>,
  botUserId: string,
): SlackEventKind {
  if (event.channel_type === "im") return "message";
  if (botUserId && typeof event.text === "string") {
    const mentionRe = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`);
    if (mentionRe.test(event.text)) return "app_mention";
  }
  // 멘션 없는 채널 메시지 — message 로 넣어 실시간과 동일하게 im 게이트가 버리게 한다.
  return "message";
}

export const ACL_DENY_NOTICE =
  "⛔ 허용된 사용자가 아닙니다. FE 챕터 관리자에게 access 등록을 요청하세요.";

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────

export interface SlackListenersDeps {
  botUserId: string;
  /**
   * 봇이 설치된 워크스페이스 팀 ID(부팅 auth.test) — access.json 와일드카드('*', 전원 허용)의
   * 개방 범위를 이 워크스페이스로 한정하는 근거다. null 이면 팀 판정 없이 와일드카드가 적용된다.
   */
  botTeamId?: string | null;
  acl: { isAllowed(userId: string, ctx?: AclContext): boolean };
  store: Pick<JobStore, "enqueue">;
  commands: Pick<CommandExecutor, "handle">;
  /**
   * envelope 멱등 클레임 — acl 거부·'/' 커맨드·chat 전 경로를 재전송으로부터 보호한다 (JQ-08).
   * chat 잡의 dedup_key 는 잡 파이프라인 안에서만 무해화하므로, 잡을 안 만드는 경로까지
   * 덮으려면 입구에서 한 번 더 걸러야 한다.
   */
  dedup: IngressDedup;
  /** 거부 안내 등 즉답 게시 — egress 일원화 (EG-01). */
  poster: Pick<Poster, "postFinal">;
  /** audit 로그 싱크 — acl 거부·dedup no-op 기록. */
  log?: (msg: string) => void;
}

export interface SlackListeners {
  handleEvent(kind: SlackEventKind, event: Record<string, unknown>): Promise<void>;
}

export function createSlackListeners(deps: SlackListenersDeps): SlackListeners {
  const log = deps.log ?? (() => {});

  return {
    async handleEvent(kind, event) {
      const inbound = normalizeInbound(event, { botUserId: deps.botUserId });
      if (!inbound) return;

      // 봇 가드 — bot_id 결정론 판별 (SC-05). 봇↔봇 왕복은 여기서 원천 차단된다.
      if (inbound.botId !== null || inbound.subtype === "bot_message") return;
      if (!isTriggerSubtype(inbound.subtype)) return;
      if (inbound.userId === null) return;

      // 자기 자신 배제 — 위 bot_id 가드가 실전에서는 자기 글을 다 잡지만, 그건 "우리가 쓴 글은
      // 항상 bot_id 를 달고 돌아온다"는 우연에 기댄 것이다. 실시간 경로는 Bolt ignoreSelf 가
      // 한 겹 더 막아주는 반면 **probe replay 는 Bolt 를 안 탄다** — REST 로 긁어온 자기 글이
      // bot_id 없이 들어오면 그대로 chat 잡이 된다. 워처 쪽은 #25 가 같은 이유로 이미 막았고
      // (팬아웃 8건), socketHealth probe 채널이 최근 대화 채널까지 넓어지면서 이 경로의
      // 노출면도 함께 넓어졌으므로 동일한 구조적 가드를 둔다.
      if (inbound.userId === deps.botUserId) {
        log(`ingress skip (self) — channel=${inbound.channel} ts=${inbound.ts} kind=${kind}`);
        return;
      }

      // message 이벤트는 DM(message.im)만 — 채널 대화는 app_mention 경로가 전부다 (SC-07)
      if (kind === "message" && inbound.channelType !== "im") return;

      // 재전송/이중 전달 무해화 — 잡을 안 만드는 acl 거부·'/' 커맨드까지 한 envelope 을 한 번만
      // 처리한다 (JQ-08). 봇/subtype 잡음을 다 자른 뒤라 실제 처리 대상만 dedup 행을 남긴다.
      const dedupKey = chatDedupKey(inbound.channel, inbound.ts);
      if (!deps.dedup.claim(dedupKey)) {
        log(`ingress dedup no-op — key=${dedupKey} kind=${kind}`);
        return;
      }

      const text = sanitizeText(inbound.text);

      if (
        !deps.acl.isAllowed(inbound.userId, {
          userTeamId: inbound.userTeamId,
          botTeamId: deps.botTeamId ?? null,
        })
      ) {
        // team 을 함께 남긴다 — 전원 허용(와일드카드) 상태의 거부는 대개 외부 조직 사용자다
        log(
          `acl-deny user=${inbound.userId} team=${inbound.userTeamId ?? "?"} channel=${inbound.channel} ts=${inbound.ts} kind=${kind}`,
        );
        await deps.poster.postFinal(ACL_DENY_NOTICE, {
          channel: inbound.channel,
          threadTs: inbound.threadTs,
        });
        return;
      }

      // '/' 커맨드는 잡이 아니라 즉시 처리 — 미확인 '/...' 토큰은 일반 대화로 흘려보낸다
      if (text.startsWith("/")) {
        const wasCommand = await deps.commands.handle(
          { channel: inbound.channel, threadTs: inbound.threadTs, userId: inbound.userId },
          text,
        );
        if (wasCommand) return;
      }

      const payload: ChatPayload = {
        schema_version: 1,
        channel: inbound.channel,
        ts: inbound.ts,
        threadTs: inbound.threadTs,
        threadKey: inbound.threadKey,
        userId: inbound.userId,
        text,
        files: inbound.files,
      };
      const outcome = deps.store.enqueue({
        type: CHAT_JOB_TYPE,
        dedupKey,
        lane: "interactive",
        laneKey: inbound.threadKey,
        maxAttempts: CHAT_MAX_ATTEMPTS,
        payload,
      });
      if (!outcome.enqueued) {
        // 입구 dedup 이 이미 재전송을 걸러 여기까지 재전송은 오지 않지만, jobs 테이블의
        // dedup_key UNIQUE 를 2차 방어선으로 유지한다 — 도달하면 침묵이 아니라 기록한다
        log(`chat enqueue dedup no-op — key=${dedupKey}`);
      }
    },
  };
}
