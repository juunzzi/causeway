import { describe, expect, it } from "vitest";
import type { ReactionState } from "./reactions.js";
import {
  CANCEL_AFFORDANCE_EMOJI,
  canTransition,
  createReactionManager,
  REACTION_EMOJI,
} from "./reactions.js";
import { callsOf, makeFakeSlack, mustGet } from "./testSupport.js";

describe("canTransition — 상태 전이 전수", () => {
  const terminals: ReactionState[] = ["success", "failure", "cancelled"];
  const all: ReactionState[] = ["pending", ...terminals];

  it("미기록 상태에서는 어떤 상태로도 진입 가능", () => {
    for (const to of all) expect(canTransition(undefined, to)).toBe(true);
  });

  it("pending 에서 종결 3종으로만 전이", () => {
    for (const to of terminals) expect(canTransition("pending", to)).toBe(true);
    expect(canTransition("pending", "pending")).toBe(false);
  });

  it("종결 상태는 불변 — 먼저 정해진 결과가 승리", () => {
    for (const from of terminals) {
      for (const to of all) expect(canTransition(from, to)).toBe(false);
    }
  });
});

describe("createReactionManager", () => {
  it("start → ⏳ 추가", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    expect(await mgr.start("C1", "111.0")).toBe(true);
    const adds = callsOf(fake, "addReaction");
    expect(mustGet(adds, 0).name).toBe(REACTION_EMOJI.pending);
    expect(mgr.stateOf("C1", "111.0")).toBe("pending");
  });

  it("start → ⏳ 다음 🛑 어포던스 — 표시 순서가 '받았다 → 멈출 수 있다'", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "111.0");
    const adds = callsOf(fake, "addReaction").map((c) => c.name);
    expect(adds).toEqual([REACTION_EMOJI.pending, CANCEL_AFFORDANCE_EMOJI]);
  });

  it("종결 시 🛑 를 회수한다 — 끝난 작업의 🛑 는 '아직 멈출 수 있다'는 거짓 신호다", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "111.0");
    await mgr.succeed("C1", "111.0");
    const removes = callsOf(fake, "removeReaction").map((c) => c.name);
    expect(removes).toEqual([REACTION_EMOJI.pending, CANCEL_AFFORDANCE_EMOJI]);
  });

  it("🛑 부착 실패는 삼킨다 — 어포던스가 없어도 /cancel·직접 🛑 는 그대로 동작한다", async () => {
    const fake = makeFakeSlack();
    const logs: string[] = [];
    const slack = {
      ...fake.slack,
      addReaction: async (args: { channel: string; ts: string; name: string }) => {
        if (args.name === CANCEL_AFFORDANCE_EMOJI) throw new Error("boom");
        await fake.slack.addReaction(args);
      },
    };
    const mgr = createReactionManager({ slack, log: (m) => logs.push(m) });
    expect(await mgr.start("C1", "111.0")).toBe(true);
    expect(mgr.stateOf("C1", "111.0")).toBe("pending");
    expect(logs.join("\n")).toContain("🛑 추가 실패");
  });

  it("succeed → ⏳ 제거 후 ✅ 추가", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "111.0");
    expect(await mgr.succeed("C1", "111.0")).toBe(true);
    const removes = callsOf(fake, "removeReaction");
    expect(mustGet(removes, 0).name).toBe(REACTION_EMOJI.pending);
    const adds = callsOf(fake, "addReaction");
    expect(mustGet(adds, adds.length - 1).name).toBe(REACTION_EMOJI.success);
  });

  it("fail → ❌, cancel → 🚫", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "1.0");
    await mgr.fail("C1", "1.0");
    await mgr.start("C1", "2.0");
    await mgr.cancel("C1", "2.0");
    const adds = callsOf(fake, "addReaction").map((c) => c.name);
    expect(adds).toContain(REACTION_EMOJI.failure);
    expect(adds).toContain(REACTION_EMOJI.cancelled);
  });

  it("이중 settle 은 no-op — 첫 결과가 유지된다", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "111.0");
    await mgr.succeed("C1", "111.0");
    const callCountAfterFirst = fake.calls.length;
    expect(await mgr.fail("C1", "111.0")).toBe(false);
    expect(fake.calls.length).toBe(callCountAfterFirst); // 추가 API 호출 없음
    expect(mgr.stateOf("C1", "111.0")).toBe("success");
  });

  it("중복 start 는 no-op (중복 ⏳/🛑 방지)", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    await mgr.start("C1", "111.0");
    expect(await mgr.start("C1", "111.0")).toBe(false);
    // 첫 start 의 ⏳ + 🛑 두 건이 전부 — 두 번째 start 는 아무것도 더 달지 않는다.
    expect(callsOf(fake, "addReaction")).toHaveLength(2);
  });

  it("자기 메시지에는 리액션을 달지 않는다", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({
      slack: fake.slack,
      isOwnMessage: (_c, ts) => ts === "999.0",
    });
    expect(await mgr.start("C1", "999.0")).toBe(false);
    expect(await mgr.succeed("C1", "999.0")).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("start 없이 바로 settle 도 허용 (⏳ 추가 실패 후 경로)", async () => {
    const fake = makeFakeSlack();
    const mgr = createReactionManager({ slack: fake.slack });
    expect(await mgr.fail("C1", "111.0")).toBe(true);
    const adds = callsOf(fake, "addReaction");
    expect(adds).toHaveLength(1); // ⏳ 제거 없이 ❌ 만
    expect(mustGet(adds, 0).name).toBe(REACTION_EMOJI.failure);
    expect(callsOf(fake, "removeReaction")).toHaveLength(0);
  });

  it("Slack API 실패는 삼키고 상태는 기록한다", async () => {
    const fake = makeFakeSlack();
    fake.failReactions.value = true;
    const logs: string[] = [];
    const mgr = createReactionManager({ slack: fake.slack, log: (m) => logs.push(m) });
    expect(await mgr.start("C1", "111.0")).toBe(true);
    expect(mgr.stateOf("C1", "111.0")).toBe("pending");
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});
