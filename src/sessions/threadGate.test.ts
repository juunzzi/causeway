import { describe, expect, it, vi } from "vitest";
import {
  alreadyRepliedInThread,
  hasOwnReply,
  type SlackHistoryPort,
  THREAD_GATE_SCAN_LIMIT,
  type ThreadMessage,
} from "./threadGate.js";

const THREAD_TS = "1720000000.000100";
const SELF = { botId: "B_SELF", userId: "U_SELF" };

function portOf(messages: ThreadMessage[]): SlackHistoryPort {
  return { fetchReplies: async () => messages };
}

describe("hasOwnReply (순수)", () => {
  it("봇 자신의 답글이 있으면 true", () => {
    const messages: ThreadMessage[] = [
      { ts: THREAD_TS, user: "U_OTHER" }, // 트리거(부모)
      { ts: "1720000001.1", botId: "B_SELF" },
    ];
    expect(hasOwnReply(messages, SELF, THREAD_TS)).toBe(true);
  });

  it("부모(트리거) 메시지 자체는 답변으로 치지 않는다", () => {
    // 세션 DB 소실 시나리오: 부모가 자기 user 로 잡혀도 재진입을 막으면 안 된다
    const messages: ThreadMessage[] = [{ ts: THREAD_TS, user: "U_SELF", botId: "B_SELF" }];
    expect(hasOwnReply(messages, SELF, THREAD_TS)).toBe(false);
  });

  it("타인 답글만 있으면 false", () => {
    const messages: ThreadMessage[] = [
      { ts: THREAD_TS, user: "U_OTHER" },
      { ts: "1720000001.1", user: "U_ANOTHER", botId: "B_OTHER" },
    ];
    expect(hasOwnReply(messages, SELF, THREAD_TS)).toBe(false);
  });

  it("구봇(user) 답글도 자기 것으로 인정한다", () => {
    const messages: ThreadMessage[] = [
      { ts: THREAD_TS, user: "U_OTHER" },
      { ts: "1720000001.1", user: "U_SELF" },
    ];
    expect(hasOwnReply(messages, SELF, THREAD_TS)).toBe(true);
  });

  it("self 식별자가 비어 있으면 어떤 메시지도 매칭되지 않는다", () => {
    const messages: ThreadMessage[] = [{ ts: "1720000001.1", botId: undefined }];
    expect(hasOwnReply(messages, {}, THREAD_TS)).toBe(false);
  });
});

describe("alreadyRepliedInThread (가짜 히스토리 포트)", () => {
  it("세션 DB 가 없어도 스레드 재스캔만으로 재진입을 판정한다 (JQ-18)", async () => {
    const replied = portOf([
      { ts: THREAD_TS, user: "U_OTHER" },
      { ts: "1720000002.2", botId: "B_SELF" },
    ]);
    await expect(
      alreadyRepliedInThread(replied, { channel: "C1", threadTs: THREAD_TS, self: SELF }),
    ).resolves.toBe(true);

    const fresh = portOf([{ ts: THREAD_TS, user: "U_OTHER" }]);
    await expect(
      alreadyRepliedInThread(fresh, { channel: "C1", threadTs: THREAD_TS, self: SELF }),
    ).resolves.toBe(false);
  });

  it("포트 실패는 fail-open(false) + 경고 로그 — 1차 방어(dedup·lease)가 있다", async () => {
    const warn = vi.fn();
    const broken: SlackHistoryPort = {
      fetchReplies: async () => {
        throw new Error("slack down");
      },
    };
    await expect(
      alreadyRepliedInThread(broken, {
        channel: "C1",
        threadTs: THREAD_TS,
        self: SELF,
        logger: { warn },
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("스캔 limit 기본값은 THREAD_GATE_SCAN_LIMIT", async () => {
    const fetchReplies = vi.fn(async () => [] as ThreadMessage[]);
    await alreadyRepliedInThread(
      { fetchReplies },
      { channel: "C1", threadTs: THREAD_TS, self: SELF },
    );
    expect(fetchReplies).toHaveBeenCalledWith({
      channel: "C1",
      threadTs: THREAD_TS,
      limit: THREAD_GATE_SCAN_LIMIT,
    });
  });
});
