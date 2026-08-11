import { describe, expect, it } from "vitest";
import { CONTRACT } from "../core/constants.js";
import { createPoster } from "./poster.js";
import {
  categoryFor,
  createProgressCard,
  renderProgress,
  rollupPhases,
  truncateForProgress,
} from "./progress.js";
import { callsOf, makeFakeSlack, mustGet } from "./testSupport.js";

function makeClock(startAt = 0) {
  let t = startAt;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeCard(fake = makeFakeSlack(), clock = makeClock()) {
  const poster = createPoster(fake.slack);
  const card = createProgressCard(
    { slack: fake.slack, poster, clock },
    { channel: "C1", threadTs: "111.0" },
  );
  return { fake, clock, card };
}

describe("순수부 — 카테고리/롤업/렌더/truncate", () => {
  it("tool 이름 → 카테고리 매핑", () => {
    expect(categoryFor("Read")).toBe("📖 탐색");
    expect(categoryFor("Edit")).toBe("✏ 편집");
    expect(categoryFor("Bash")).toBe("⚙ 실행");
    expect(categoryFor("Task")).toBe("🔀 위임");
    expect(categoryFor("mcp__datadog__query")).toBe("🔌 외부");
    expect(categoryFor("UnknownTool")).toBe("🛠 기타");
  });

  it("같은 카테고리 연속은 count 증가 + 최신 summary 유지", () => {
    let phases = rollupPhases([], "📖 탐색", "Read: a.ts");
    phases = rollupPhases(phases, "📖 탐색", "Read: b.ts");
    phases = rollupPhases(phases, "⚙ 실행", "Bash: ls");
    expect(phases).toEqual([
      { category: "📖 탐색", count: 2, lastSummary: "Read: b.ts" },
      { category: "⚙ 실행", count: 1, lastSummary: "Bash: ls" },
    ]);
  });

  it("렌더는 마지막 8개 카테고리만 표시", () => {
    const phases = Array.from({ length: 12 }, (_, i) => ({
      category: `분류${i}`,
      count: 1,
      lastSummary: "",
    }));
    const out = renderProgress("헤더", phases);
    expect(out).not.toContain("분류3");
    expect(out).toContain("분류4");
    expect(out).toContain("분류11");
  });

  it("truncate 는 PROGRESS_TRUNCATE_CHARS 상한을 강제한다", () => {
    const out = truncateForProgress("가".repeat(CONTRACT.PROGRESS_TRUNCATE_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(CONTRACT.PROGRESS_TRUNCATE_CHARS);
    expect(out.endsWith("… (truncated)")).toBe(true);
  });

  it("상한 이하는 자르지 않는다", () => {
    const text = "나".repeat(CONTRACT.PROGRESS_TRUNCATE_CHARS);
    expect(truncateForProgress(text)).toBe(text);
  });
});

describe("진행 카드 — rate-limit (가짜 클록)", () => {
  it("start 는 헤더 메시지를 스레드에 게시한다", async () => {
    const { fake, card } = makeCard();
    await card.start();
    const posts = callsOf(fake, "post");
    expect(posts).toHaveLength(1);
    expect(mustGet(posts, 0).threadTs).toBe("111.0");
    expect(card.ts).toBeDefined();
  });

  it("existingTs 가 있으면 start 가 post 하지 않고 그 ts 를 채택·즉시 갱신한다", async () => {
    const fake = makeFakeSlack();
    const card = createProgressCard(
      { slack: fake.slack, poster: createPoster(fake.slack), clock: makeClock() },
      { channel: "C1", threadTs: "111.0", header: "_이어가는 중…_", existingTs: "900.5" },
    );
    await card.start();
    // 새 메시지 post 없음 — 기존 카드를 채택한다(재시도 중복 카드 방지)
    expect(callsOf(fake, "post")).toHaveLength(0);
    expect(card.ts).toBe("900.5");
    // 채택 즉시 그 ts 를 update 로 갱신(새 헤더 반영)
    const updates = callsOf(fake, "update");
    expect(updates).toHaveLength(1);
    expect(mustGet(updates, 0).ts).toBe("900.5");
    expect(mustGet(updates, 0).text).toContain("이어가는 중…");
  });

  it("existingTs 채택 후 addTool·finish 는 그 ts 를 갱신·교체한다", async () => {
    const fake = makeFakeSlack();
    const card = createProgressCard(
      { slack: fake.slack, poster: createPoster(fake.slack), clock: makeClock() },
      { channel: "C1", threadTs: "111.0", existingTs: "900.5" },
    );
    await card.start();
    await card.addTool("Read", "Read: a.ts", { forceFlush: true });
    await card.finish("최종 답변");
    // 전 과정에서 새 메시지 post 없이 900.5 만 갱신/교체된다
    expect(callsOf(fake, "post")).toHaveLength(0);
    const updates = callsOf(fake, "update");
    expect(updates.every((u) => u.ts === "900.5")).toBe(true);
    expect(updates.at(-1)?.text).toBe("최종 답변");
  });

  it("headerFn 은 start·flush 마다 호출돼 회전 문구를 반영한다", async () => {
    const fake = makeFakeSlack();
    const clock = makeClock();
    let n = 0;
    const card = createProgressCard(
      { slack: fake.slack, poster: createPoster(fake.slack), clock },
      { channel: "C1", threadTs: "111.0", headerFn: () => `_상태 ${n++}_` },
    );
    await card.start();
    expect(mustGet(callsOf(fake, "post"), 0).text).toBe("_상태 0_"); // start 호출
    await card.addTool("Read", "Read: a.ts");
    // flush 시 headerFn 재호출 → 다음 문구가 카드 상단에 반영
    expect(mustGet(callsOf(fake, "update"), 0).text).toContain("_상태 1_");
  });

  it("첫 addTool 은 즉시 flush, 이후 1.5s 이내는 억제된다", async () => {
    const { fake, clock, card } = makeCard();
    await card.start();
    await card.addTool("Read", "Read: a.ts");
    expect(callsOf(fake, "update")).toHaveLength(1);

    clock.advance(CONTRACT.PROGRESS_UPDATE_INTERVAL_MS - 1);
    await card.addTool("Read", "Read: b.ts");
    expect(callsOf(fake, "update")).toHaveLength(1); // 아직 rate-limit 창 안

    clock.advance(1); // 정확히 1500ms 경과
    await card.addTool("Read", "Read: c.ts");
    const updates = callsOf(fake, "update");
    expect(updates).toHaveLength(2);
    // 억제됐던 이벤트도 롤업에는 반영돼 있다
    expect(mustGet(updates, 1).text).toContain("× 3");
    expect(mustGet(updates, 1).text).toContain("Read: c.ts");
  });

  it("forceFlush 는 rate-limit 을 무시한다", async () => {
    const { fake, card } = makeCard();
    await card.start();
    await card.addTool("Read", "Read: a.ts");
    await card.addTool("Read", "Read: b.ts", { forceFlush: true });
    expect(callsOf(fake, "update")).toHaveLength(2);
  });

  it("flush 실패 시 lastFlush 를 갱신하지 않아 다음 addTool 이 즉시 재시도한다", async () => {
    const { fake, clock, card } = makeCard();
    await card.start();
    fake.failUpdateTs.add(card.ts ?? "");
    await card.addTool("Read", "Read: a.ts"); // 실패 (swallow)
    fake.failUpdateTs.clear();
    clock.advance(10); // rate-limit 창보다 훨씬 짧아도
    await card.addTool("Read", "Read: b.ts");
    expect(callsOf(fake, "update")).toHaveLength(2); // 즉시 재시도됐다
  });

  it("갱신 본문은 항상 truncate 상한 이내", async () => {
    const { fake, card } = makeCard();
    await card.start();
    for (let i = 0; i < 20; i += 1) {
      await card.addTool(`Tool${i}`, `요약-${i}-${"x".repeat(60)}`, { forceFlush: true });
    }
    for (const u of callsOf(fake, "update")) {
      expect((u.text ?? "").length).toBeLessThanOrEqual(CONTRACT.PROGRESS_TRUNCATE_CHARS);
    }
  });

  it("summary 의 시크릿은 카드에도 마스킹된다", async () => {
    const { fake, card } = makeCard();
    await card.start();
    await card.addTool("Bash", "Bash: export API_KEY=abc123", { forceFlush: true });
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, 0).text).not.toContain("abc123");
  });

  it("onStep 으로 최근 스텝을 밖에 알린다 (watchdog 연동)", async () => {
    const fake = makeFakeSlack();
    const steps: string[] = [];
    const card = createProgressCard(
      {
        slack: fake.slack,
        poster: createPoster(fake.slack),
        clock: makeClock(),
        onStep: (s) => steps.push(s),
      },
      { channel: "C1" },
    );
    await card.start();
    await card.addTool("Read", "Read: a.ts");
    expect(steps).toEqual(["📖 탐색 Read: a.ts"]);
  });
});

describe("진행 카드 — finish", () => {
  it("finish 는 poster 에 위임해 카드 자리를 GFM markdown 블록 최종 답변으로 교체한다", async () => {
    const { fake, card } = makeCard();
    await card.start();
    await card.addTool("Read", "Read: a.ts");
    const res = await card.finish("**최종** 답변");
    const updates = callsOf(fake, "update");
    const last = mustGet(updates, updates.length - 1);
    expect(last.ts).toBe(card.ts);
    // 최종 답변은 markdown 블록으로 게시된다(GFM 원본 보존 — mdToMrkdwn 변환 안 함, EG-10).
    expect(last.block?.markdown).toBe("**최종** 답변");
    // text 는 알림/폴백용 평문 요약(마크업 제거)
    expect(last.text).toBe("최종 답변");
    expect(res.usedFallback).toBe(false);
    expect(res.postedTs).toEqual([card.ts]);
  });

  it("finish 의 chat.update 실패 시 새 답글 fallback + 카드 완료 안내 교체", async () => {
    const { fake, card } = makeCard();
    await card.start();
    fake.failUpdateTs.add(card.ts ?? "");
    const res = await card.finish("최종 답변");
    expect(res.usedFallback).toBe(true);
    const posts = callsOf(fake, "post");
    // [0]=진행 카드 start, [1]=fallback 답글
    expect(mustGet(posts, 1).text).toBe("최종 답변");
    expect(mustGet(posts, 1).threadTs).toBe("111.0");
  });

  it("start 전에 finish 하면 카드 없이 새 답글로만 게시한다", async () => {
    const { fake, card } = makeCard();
    const res = await card.finish("바로 최종");
    expect(callsOf(fake, "update")).toHaveLength(0);
    const posts = callsOf(fake, "post");
    expect(mustGet(posts, 0).text).toBe("바로 최종");
    expect(res.postedTs).toHaveLength(1);
  });

  it("finish 는 멘션 게이트 옵션을 파이프라인에 전달한다", async () => {
    const { fake, card } = makeCard();
    await card.start();
    const res = await card.finish("<@U999> 참고", { allowedMentionUserIds: ["U111"] });
    expect(res.blockedMentions).toEqual(["U999"]);
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, updates.length - 1).text).toBe("@U999 참고");
  });
});
