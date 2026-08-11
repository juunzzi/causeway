import { describe, expect, it } from "vitest";
import { maskSecrets } from "../security/maskSecrets.js";
import { createPoster } from "./poster.js";
import { createProgressDriver, type ProgressDriverOptions } from "./progressDriver.js";
import { callsOf, makeFakeSlack } from "./testSupport.js";

const CHANNEL = "C1";
const THREAD = "100.1";
const TEAM = "T0TEAM";

function baseOpts(overrides: Partial<ProgressDriverOptions> = {}): ProgressDriverOptions {
  return {
    channel: CHANNEL,
    threadTs: THREAD,
    threadKey: `${CHANNEL}:${THREAD}`,
    recipientUserId: "U1",
    recipientTeamId: TEAM,
    planTitle: "작업 진행 중",
    maskSecrets,
    ...overrides,
  };
}

function setup(opts: Partial<ProgressDriverOptions> = {}) {
  const fake = makeFakeSlack();
  const poster = createPoster(fake.slack);
  const deps = { slack: fake.slack, poster, clock: { now: () => 2_000 }, log: () => {} };
  return { fake, poster, deps, opts };
}

function assistantToolUse(id: string, name: string, input: unknown): unknown {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}
function userToolResult(toolUseId: string, isError = false): unknown {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
  };
}

describe("createProgressDriver — plan 성공 경로", () => {
  it("createStream→append(chunks)→finish(appendText+stop)로 최종 답변을 종결한다", async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts());

    // 스트림 생성 시 recipient_* 가 전달된다
    const created = s.fake.calls.find((c) => c.kind === "streamCreate");
    expect(created?.createArgs?.recipientUserId).toBe("U1");
    expect(created?.createArgs?.recipientTeamId).toBe(TEAM);

    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await driver.finish("최종 분석 결과");

    // plan 앵커 + in_progress → complete chunk 가 흘렀다
    const allChunks = callsOf(s.fake, "streamChunks").flatMap((c) => c.chunks ?? []);
    expect(allChunks.some((c) => c.type === "plan_update")).toBe(true);
    expect(allChunks.some((c) => c.type === "task_update" && c.status === "in_progress")).toBe(
      true,
    );
    expect(allChunks.some((c) => c.type === "task_update" && c.status === "complete")).toBe(true);

    // 최종 답변은 appendText → stop 으로 종결. 진행 카드(chat.update)는 쓰지 않는다.
    expect(callsOf(s.fake, "streamText").at(-1)?.text).toContain("최종 분석 결과");
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });

  it('statusText 지정 시 생성 직후 상태(≠"")를 띄우고 finish 에서 clear("")', async () => {
    const s = setup();
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ statusText: "분석 중… · sonnet" }),
    );
    await driver.finish("답변");

    const statuses = callsOf(s.fake, "setStatus");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]?.status).toBe("분석 중… · sonnet");
    expect(statuses[1]?.status).toBe("");
  });

  it('statusText 미지정(자동화)이면 생성 시 상태(≠"")를 안 띄운다 — finish 의 plan clear 만 남는다', async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts({ statusText: undefined }));
    await driver.finish("답변");
    // 생성 시엔 처리 중 상태를 안 띄운다. plan finish 경로의 clear("")는 chat 과 바이트 동등하게 유지.
    const statuses = callsOf(s.fake, "setStatus");
    expect(statuses.some((c) => c.status !== "")).toBe(false);
    expect(statuses.every((c) => c.status === "")).toBe(true);
  });

  it("plan 경로도 멘션 게이트를 적용한다 — 요청자 외 <@U> 는 평문화해 append (EG-07)", async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts());
    // 요청자 U0REQ 는 허용, U0OTHER 는 게이트로 평문화되어야 한다(멘션 RE 는 U+2자 이상 요구)
    await driver.finish("<@U0REQ> 확인 요청 그리고 <@U0OTHER> 님 참고", {
      allowedMentionUserIds: ["U0REQ"],
    });
    const streamed = callsOf(s.fake, "streamText").at(-1)?.text ?? "";
    // 허용 유저 멘션은 그대로, 미허용 유저는 @U0OTHER 평문으로 해제된 채 plan 본문에 실린다
    expect(streamed).toContain("<@U0REQ>");
    expect(streamed).not.toContain("<@U0OTHER>");
    expect(streamed).toContain("@U0OTHER");
    // plan 경로가 유지됐다(폴백 카드 update 없음)
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });

  it("plan 경로도 11k 초과면 여러 답글로 안전 분할(폴백 카드 강등) — plan 단일 본문 한계 회피", async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts());
    // 표/코드 없는 산문 12k — 단일 markdown_text 로는 msg_too_long. 여러 청크로 나뉘어야 한다.
    const longText = `${"가나다라마바사아자차 ".repeat(1300)}끝`;
    await driver.finish(longText);
    // plan appendText 로 통째로 흘리지 않는다(msg_too_long 회피)
    expect(callsOf(s.fake, "streamText")).toHaveLength(0);
    // 폴백 카드로 강등돼 poster 가 여러 답글(post)로 분할 게시한다
    const posts = callsOf(s.fake, "post");
    expect(posts.length).toBeGreaterThan(1);
    // 각 게시 청크는 11k(MARKDOWN_BLOCK_CHUNK_CHARS) 이하 GFM 블록이다
    for (const p of posts) {
      expect(p.block?.markdown.length ?? 0).toBeLessThanOrEqual(11_000);
    }
  });

  it("plan 단일 청크(≤11k)는 append→stop 으로 종결하고 폴백 카드를 만들지 않는다", async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts());
    await driver.finish("## 짧은 답변\n**요약**");
    expect(callsOf(s.fake, "streamText").at(-1)?.text).toContain("## 짧은 답변");
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(true);
    // 폴백 카드(post/update)를 만들지 않는다
    expect(callsOf(s.fake, "post")).toHaveLength(0);
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });
});

describe("createProgressDriver — 폴백 카드 경로", () => {
  it("createStream 실패 → 폴백 카드가 뜨고 onProgress 가 addTool 로 반영된다", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const driver = await createProgressDriver(s.deps, baseOpts());

    // 폴백 카드가 즉시 post 된다(plan 불가)
    expect(callsOf(s.fake, "post")).toHaveLength(1);

    driver.onProgress("Bash: pnpm test");
    driver.onProgress("Read: /repo/a.ts");
    await driver.finish("## 폴백 답변\n**표** 데이터");

    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.text?.includes("⚙ 실행"))).toBe(true);
    // 최종 답변은 카드 자리를 GFM markdown 블록으로 교체한다(plan 스트림 markdown_text 와 렌더 일치, EG-10)
    expect(updates.at(-1)?.block?.markdown).toBe("## 폴백 답변\n**표** 데이터");
    // plan 스트림 append 는 일어나지 않는다
    expect(s.fake.calls.some((c) => c.kind === "streamChunks")).toBe(false);
  });

  it("첫 append 예외 → 폴백 강등, 이후 onProgress 로 카드를 채운다", async () => {
    const s = setup();
    s.fake.failStream.value = "append";
    const driver = await createProgressDriver(s.deps, baseOpts());

    // 첫 tool_use → 첫 appendChunks throw → 폴백 강등
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    // 강등이 fire-and-forget catch 라 마이크로태스크 flush 를 기다린다
    await new Promise((r) => setTimeout(r, 0));
    driver.onProgress("Bash: pnpm build");
    await driver.finish("강등 후 답변");

    expect(callsOf(s.fake, "update").at(-1)?.text).toContain("강등 후 답변");
    expect(s.fake.calls.some((c) => c.kind === "streamCreate")).toBe(true);
  });

  it("createStream 실패 시 statusText 가 있어도 상태를 띄우지 않는다(강등 경로)", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ statusText: "분석 중… · sonnet" }),
    );
    await driver.finish("폴백 답변");
    // handle===null 이면 상태를 애초에 안 띄웠으므로 clear 도 하지 않는다.
    expect(callsOf(s.fake, "setStatus")).toHaveLength(0);
  });
});

describe("createProgressDriver — 죽은 스트림(#20) freeze 정리", () => {
  it("finish 시 appendText 가 죽은 스트림에 실패 → 얼어붙은 카드 ts 를 chat.update 로 정리·교체", async () => {
    const s = setup();
    s.fake.failStreamAppendText.value = "dead";
    const driver = await createProgressDriver(s.deps, baseOpts());

    // 도구 1건 flush 로 plan 카드 ts 가 정의된다
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await new Promise((r) => setTimeout(r, 0));
    await driver.finish("최종 답변 본문");

    const planCardTs = "9001.000"; // fake 가 첫 chunk flush 때 부여
    const updates = callsOf(s.fake, "update");
    // 얼어붙은 카드 자리를 최종 답변으로 교체한다
    expect(updates.some((u) => u.ts === planCardTs && u.text?.includes("최종 답변 본문"))).toBe(
      true,
    );
    // 죽은 스트림이라 stop 은 시도하지 않는다
    expect(s.fake.calls.some((c) => c.kind === "streamStop")).toBe(false);
    // 새 답글(post)로 재게시하지 않는다
    expect(callsOf(s.fake, "post").some((p) => p.text?.includes("최종 답변 본문"))).toBe(false);
  });

  it("abortStream: 정상 stop 은 streamClosedNotice 를 종결 문구로 실어 정지 카드를 스테일 상태로 남기지 않는다", async () => {
    const s = setup();
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ streamClosedNotice: "⚠️ 재시도 중" }),
    );
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await new Promise((r) => setTimeout(r, 0));
    await driver.abortStream();

    // plan 카드 ts 는 재개 불가 — 다음 attempt 는 새 plan 카드를 만든다. 이 정지 카드가 "작업 진행
    // 중…"으로 얼어붙지 않게, stop 에 종결 문구를 실어 카드를 종결 상태로 갈아끼운다.
    const stops = callsOf(s.fake, "streamStop");
    expect(stops).toHaveLength(1);
    expect(stops.at(-1)?.text).toBe("⚠️ 재시도 중");
  });

  it("abortStream: streamClosedNotice 미지정이면 정상 stop 은 종결 문구 없이 스트림만 닫는다", async () => {
    const s = setup();
    const driver = await createProgressDriver(s.deps, baseOpts({ streamClosedNotice: undefined }));
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await new Promise((r) => setTimeout(r, 0));
    await driver.abortStream();

    const stops = callsOf(s.fake, "streamStop");
    expect(stops).toHaveLength(1);
    expect(stops.at(-1)?.text).toBeUndefined();
  });

  it("abortStream: 죽은 스트림 stop 실패 → streamClosedNotice 로 카드 정리 + onCardTs 발화", async () => {
    const s = setup();
    s.fake.failStreamStopDead.value = true;
    const cardTsSeen: string[] = [];
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ streamClosedNotice: "⚠️ 스트림 종료", onCardTs: (ts) => cardTsSeen.push(ts) }),
    );
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await new Promise((r) => setTimeout(r, 0));
    await driver.abortStream();

    const updates = callsOf(s.fake, "update");
    expect(updates.some((u) => u.ts === "9001.000" && u.text === "⚠️ 스트림 종료")).toBe(true);
    // 죽은 카드 ts 를 onCardTs 로 흘려 호출부 재시도 안내가 그 자리를 교체하게 한다
    expect(cardTsSeen).toContain("9001.000");
  });

  it("streamClosedNotice 미지정이면 죽은 스트림 정리를 건너뛴다(문구 없이 교체 안 함)", async () => {
    const s = setup();
    s.fake.failStreamStopDead.value = true;
    const driver = await createProgressDriver(s.deps, baseOpts({ streamClosedNotice: undefined }));
    driver.onStreamEvent(assistantToolUse("tu-A", "Read", { file_path: "/a.ts" }));
    driver.onStreamEvent(userToolResult("tu-A"));
    await new Promise((r) => setTimeout(r, 0));
    await driver.abortStream();
    // 정리용 chat.update 가 없다
    expect(callsOf(s.fake, "update")).toHaveLength(0);
  });
});

describe("createProgressDriver — 콜백·재시작 폴백 ts", () => {
  it("onStep: 폴백 카드 addTool 이 스텝 문자열을 흘린다", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const steps: string[] = [];
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ onStep: (step) => steps.push(step) }),
    );
    driver.onProgress("Bash: pnpm test");
    await driver.finish("답변");
    expect(steps.some((step) => step.includes("⚙ 실행"))).toBe(true);
  });

  it("onStep: plan 경로(정상)도 스텝을 흘린다 — 카드 없이 도는 잡이 워치독에 무진행으로 보이면 안 된다", async () => {
    const s = setup();
    const steps: string[] = [];
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ onStep: (step) => steps.push(step) }),
    );
    driver.onProgress("Bash: pnpm test");
    driver.onProgress("Read: src/foo.ts");
    await driver.finish("답변");
    // 폴백 카드로 강등되지 않은 정상 plan 경로 — 스텝이 그대로 나와야 한다(RS-06 입력)
    expect(steps).toEqual(["⚙ 실행 pnpm test", "📖 탐색 src/foo.ts"]);
  });

  it("onStep: 같은 도구 라인은 두 경로에서 같은 라벨을 낸다 — 강등 순간 정체 타이머 헛리셋 방지", async () => {
    const planSteps: string[] = [];
    const cardSteps: string[] = [];

    const plan = setup();
    const planDriver = await createProgressDriver(
      plan.deps,
      baseOpts({ onStep: (step) => planSteps.push(step) }),
    );
    planDriver.onProgress("Bash: pnpm test");
    await planDriver.finish("답변");

    const card = setup();
    card.fake.failStream.value = "create";
    const cardDriver = await createProgressDriver(
      card.deps,
      baseOpts({ onStep: (step) => cardSteps.push(step) }),
    );
    cardDriver.onProgress("Bash: pnpm test");
    await cardDriver.finish("답변");

    expect(planSteps).toEqual(cardSteps);
  });

  it("onStep: 카드 경로는 중복 발화하지 않는다 — addTool 한 번당 스텝 한 번", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const steps: string[] = [];
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ onStep: (step) => steps.push(step) }),
    );
    driver.onProgress("Bash: pnpm test");
    await driver.finish("답변");
    expect(steps).toEqual(["⚙ 실행 pnpm test"]);
  });

  it("onCardTs: 폴백 카드 start 시 확정 ts 를 흘린다", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const cardTsSeen: string[] = [];
    const driver = await createProgressDriver(
      s.deps,
      baseOpts({ onCardTs: (ts) => cardTsSeen.push(ts) }),
    );
    await driver.finish("답변");
    // fake 첫 post ts=1001.000
    expect(cardTsSeen).toContain("1001.000");
  });

  it("fallbackExistingTs: 폴백 카드가 새 post 없이 기존 ts 를 이어 쓴다(재시작 재시도)", async () => {
    const s = setup();
    s.fake.failStream.value = "create";
    const driver = await createProgressDriver(s.deps, baseOpts({ fallbackExistingTs: "8888.000" }));
    driver.onProgress("Bash: pnpm test");
    await driver.finish("이어 쓴 답변");

    // 기존 ts 를 채택하므로 새 카드 post 는 없다 — update 로만 그 자리를 갱신/교체
    expect(callsOf(s.fake, "post")).toHaveLength(0);
    const updates = callsOf(s.fake, "update");
    expect(updates.every((u) => u.ts === "8888.000")).toBe(true);
    expect(updates.at(-1)?.text).toContain("이어 쓴 답변");
  });
});
