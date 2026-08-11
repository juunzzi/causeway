import { describe, expect, it } from "vitest";
import type { CancelTargetItem } from "../jobs/chat/runningTasks.js";
import {
  createReactionListener,
  isCancelReaction,
  normalizeReaction,
  normalizeReactionName,
} from "./reactionListener.js";

const BOT = "UBOT";

function reactionEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "reaction_added",
    user: "U1",
    reaction: "octagonal_sign",
    item: { type: "message", channel: "C1", ts: "9.1" },
    event_ts: "9.5",
    ...over,
  };
}

interface Harness {
  listener: ReturnType<typeof createReactionListener>;
  cancelled: CancelTargetItem[];
  logs: string[];
}

function setup(over: { allowed?: boolean; hit?: string | null } = {}): Harness {
  const cancelled: CancelTargetItem[] = [];
  const logs: string[] = [];
  const listener = createReactionListener({
    botUserId: BOT,
    acl: { isAllowed: () => over.allowed ?? true },
    cancelByMessage: (item) => {
      cancelled.push(item);
      return over.hit === undefined ? "C1:1.0" : over.hit;
    },
    log: (msg) => logs.push(msg),
  });
  return { listener, cancelled, logs };
}

describe("normalizeReactionName", () => {
  it("스킨톤 접미사를 떼어낸다", () => {
    expect(normalizeReactionName("+1::skin-tone-3")).toBe("+1");
    expect(normalizeReactionName("octagonal_sign")).toBe("octagonal_sign");
  });
});

describe("isCancelReaction", () => {
  it("🛑·⏹️·⏹·❌ 를 취소로 읽는다", () => {
    expect(isCancelReaction("octagonal_sign")).toBe(true);
    expect(isCancelReaction("stop_button")).toBe(true);
    expect(isCancelReaction("black_square_for_stop")).toBe(true);
    expect(isCancelReaction("x")).toBe(true);
    expect(isCancelReaction("eyes")).toBe(false);
  });

  it("취소 완료 표시(🚫)는 취소 입력이 아니다", () => {
    // 🚫 를 입력으로도 받으면 봇이 남긴 종결 표시와 사람의 지시가 같은 기호로 겹친다.
    expect(isCancelReaction("no_entry_sign")).toBe(false);
  });
});

describe("normalizeReaction", () => {
  it("메시지 리액션만 통과시킨다", () => {
    expect(normalizeReaction(reactionEvent())).toEqual({
      userId: "U1",
      name: "octagonal_sign",
      item: { channel: "C1", ts: "9.1" },
    });
  });

  it("파일 리액션·좌표 결손은 null", () => {
    expect(normalizeReaction(reactionEvent({ item: { type: "file", file: "F1" } }))).toBeNull();
    expect(normalizeReaction(reactionEvent({ item: { type: "message", ts: "9.1" } }))).toBeNull();
    expect(normalizeReaction(reactionEvent({ user: "" }))).toBeNull();
  });
});

describe("createReactionListener", () => {
  it("허용 사용자의 🛑 는 그 좌표의 작업을 취소한다", async () => {
    const h = setup();
    await h.listener.handleReactionAdded(reactionEvent());
    expect(h.cancelled).toEqual([{ channel: "C1", ts: "9.1" }]);
    expect(h.logs.join("\n")).toContain("reaction-cancel thread=C1:1.0");
  });

  it("봇 자신이 단 어포던스는 절대 취소로 읽지 않는다", async () => {
    // 이 가드가 없으면 ⏳ 옆에 🛑 를 다는 행위가 곧 자기 작업 취소가 되어 모든 대화가 즉사한다.
    const h = setup();
    await h.listener.handleReactionAdded(reactionEvent({ user: BOT }));
    expect(h.cancelled).toEqual([]);
  });

  it("취소 이모지가 아니면 무시한다", async () => {
    const h = setup();
    await h.listener.handleReactionAdded(reactionEvent({ reaction: "eyes" }));
    expect(h.cancelled).toEqual([]);
  });

  it("acl 미허용자는 취소하지 못하고 거부만 기록된다", async () => {
    const h = setup({ allowed: false });
    await h.listener.handleReactionAdded(reactionEvent());
    expect(h.cancelled).toEqual([]);
    expect(h.logs.join("\n")).toContain("reaction-cancel acl-deny user=U1");
  });

  it("진행 중 작업이 없으면 조용히 로그만 남긴다", async () => {
    // 끝난 대화·남의 글에 🛑 를 다는 건 흔한 일이다 — 봇이 말을 걸면 그게 노이즈다.
    const h = setup({ hit: null });
    await h.listener.handleReactionAdded(reactionEvent());
    expect(h.logs.join("\n")).toContain("reaction-cancel no-op");
  });
});
