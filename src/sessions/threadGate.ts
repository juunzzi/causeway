/**
 * 스레드 재스캔 2차 게이트 (JQ-18) — 선행 구현 이식.
 *
 * 세션 DB(1차: dedup_key·lease)가 소실돼도 Slack 스레드 자체가 진실원이다:
 * 봇이 이미 답한 스레드에 write 잡이 재진입하는 것을 재스캔으로 차단한다.
 */

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

export interface ThreadMessage {
  ts: string;
  user?: string;
  botId?: string;
}

export interface ThreadGateSelf {
  /** xoxb 봇 자신의 bot_id — 결정론 판별(SC-05). */
  botId?: string;
  /** 구봇(xoxp) 시절 메시지까지 자기 것으로 인정해야 할 때만 지정. */
  userId?: string;
}

export function hasOwnReply(
  messages: readonly ThreadMessage[],
  self: ThreadGateSelf,
  threadTs: string,
): boolean {
  for (const m of messages) {
    // 부모(트리거) 메시지 자체는 답변이 아니다 — 선행 구현의 ts != thread_ts
    if (m.ts === threadTs) continue;
    if (self.botId !== undefined && m.botId === self.botId) return true;
    if (self.userId !== undefined && m.user === self.userId) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (Slack API 부작용 — 포트 주입)
// ────────────────────────────────────────────────────────────────────

export interface SlackHistoryPort {
  fetchReplies(args: {
    channel: string;
    threadTs: string;
    limit: number;
  }): Promise<ThreadMessage[]>;
}

export interface ThreadGateLogger {
  warn(message: string): void;
}

/** 선행 구현 계승 — 스레드 선두 50개면 자동 트리거 재진입 판정에 충분하다. */
export const THREAD_GATE_SCAN_LIMIT = 50;

/**
 * 재스캔 실패는 fail-open(통과) — 1차 방어(dedup·lease)가 살아 있는 상태에서
 * Slack API 장애가 잡 전체를 막으면 안 된다 (선행 구현과 동일 판단).
 */
export async function alreadyRepliedInThread(
  port: SlackHistoryPort,
  args: {
    channel: string;
    threadTs: string;
    self: ThreadGateSelf;
    limit?: number;
    logger?: ThreadGateLogger;
  },
): Promise<boolean> {
  let messages: ThreadMessage[];
  try {
    messages = await port.fetchReplies({
      channel: args.channel,
      threadTs: args.threadTs,
      limit: args.limit ?? THREAD_GATE_SCAN_LIMIT,
    });
  } catch (err) {
    args.logger?.warn(`threadGate: conversations.replies 실패 — 게이트 통과로 처리: ${err}`);
    return false;
  }
  return hasOwnReply(messages, args.self, args.threadTs);
}
