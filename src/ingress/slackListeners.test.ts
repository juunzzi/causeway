import { describe, expect, it } from "vitest";
import { openDatabase } from "../core/db/connection.js";
import { migrate } from "../core/db/migrations.js";
import { JobStore } from "../core/queue/jobStore.js";
import { createPoster } from "../egress/poster.js";
import { callsOf, makeFakeSlack } from "../egress/testSupport.js";
import type { ChatPayload } from "../jobs/chat/handler.js";
import { createIngressDedup } from "./ingressDedup.js";
import {
  ACL_DENY_NOTICE,
  chatDedupKey,
  classifyReplayKind,
  createSlackListeners,
} from "./slackListeners.js";

const BOT = "U0BOT";

interface Setup {
  store: JobStore;
  fake: ReturnType<typeof makeFakeSlack>;
  handled: Array<{ channel: string; threadTs: string; userId: string; text: string }>;
  logs: string[];
  wakes: number;
  listeners: ReturnType<typeof createSlackListeners>;
}

function setup(opts: { commandTexts?: readonly string[] } = {}): Setup {
  const db = openDatabase(":memory:");
  migrate(db);
  const store = new JobStore(db);
  const fake = makeFakeSlack();
  const handled: Setup["handled"] = [];
  const logs: string[] = [];
  const result: Setup = {
    store,
    fake,
    handled,
    logs,
    wakes: 0,
    listeners: createSlackListeners({
      botUserId: BOT,
      acl: { isAllowed: (userId) => userId.startsWith("UOK") },
      store,
      commands: {
        handle: async (ctx, text) => {
          handled.push({ ...ctx, text });
          return (opts.commandTexts ?? ["/status"]).includes(text);
        },
      },
      dedup: createIngressDedup(db),
      poster: createPoster(fake.slack),
      log: (msg) => logs.push(msg),
    }),
  };
  store.events.on("enqueued", () => {
    result.wakes += 1;
  });
  return result;
}

function mentionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "C1",
    ts: "100.1",
    user: "UOK1",
    text: `<@${BOT}> 이 에러 원인 봐줘`,
    ...overrides,
  };
}

describe("slackListeners 라우팅", () => {
  it("멘션 → chat 잡 enqueue (dedup key·lane·lane_key·payload)", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent());

    const job = s.store.getByDedupKey(chatDedupKey("C1", "100.1"));
    expect(job).toBeDefined();
    expect(job?.type).toBe("chat");
    expect(job?.lane).toBe("interactive");
    expect(job?.laneKey).toBe("C1:100.1");
    expect(job?.maxAttempts).toBe(2);
    const payload = job?.payload as ChatPayload;
    expect(payload.text).toBe("이 에러 원인 봐줘");
    expect(payload.userId).toBe("UOK1");
    expect(payload.threadKey).toBe("C1:100.1");
    // dispatcher wakeup 은 enqueue 이벤트 경로 — 이벤트가 실제로 발화하는지 (JQ-07)
    expect(s.wakes).toBe(1);
  });

  it("동일 이벤트 재전송(3초 ack 재시도)은 dedup 으로 no-op — 잡 1개 (JQ-08)", async () => {
    const s = setup();
    const event = mentionEvent();
    await s.listeners.handleEvent("app_mention", event);
    await s.listeners.handleEvent("app_mention", event);

    expect(s.store.countByStatus().pending).toBe(1);
    expect(s.wakes).toBe(1);
    expect(s.logs.some((l) => l.includes("dedup no-op"))).toBe(true);
  });

  it("acl 거부 envelope 재전송은 안내를 두 번 게시하지 않는다 (JQ-08)", async () => {
    const s = setup();
    const event = mentionEvent({ user: "UBAD" });
    await s.listeners.handleEvent("app_mention", event);
    await s.listeners.handleEvent("app_mention", event);

    // 잡 파이프라인 밖(거부 안내)도 입구 dedup 이 재전송을 무해화한다 — 안내 1개
    expect(callsOf(s.fake, "post")).toHaveLength(1);
    expect(s.logs.some((l) => l.includes("ingress dedup no-op"))).toBe(true);
  });

  it("'/' 커맨드 envelope 재전송은 커맨드를 두 번 실행하지 않는다 (JQ-08)", async () => {
    const s = setup();
    const event = mentionEvent({ text: `<@${BOT}> /status` });
    await s.listeners.handleEvent("app_mention", event);
    await s.listeners.handleEvent("app_mention", event);

    // '/run' 같은 부작용 커맨드의 이중 실행 방지 — commands.handle 은 한 번만 호출된다
    expect(s.handled).toHaveLength(1);
    expect(s.store.countByStatus().pending).toBe(0);
  });

  it("DM 멘션의 이중 전달(app_mention + message.im)도 같은 dedup 키로 잡 1개", async () => {
    const s = setup();
    const base = { channel: "D1", ts: "5.0", user: "UOK1", text: "hi", channel_type: "im" };
    await s.listeners.handleEvent("app_mention", { ...base, text: `<@${BOT}> hi` });
    await s.listeners.handleEvent("message", base);
    expect(s.store.countByStatus().pending).toBe(1);
  });

  it("봇 메시지(bot_id·bot_message)는 무시한다 (SC-05)", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ bot_id: "B77" }));
    await s.listeners.handleEvent(
      "message",
      mentionEvent({ channel_type: "im", subtype: "bot_message" }),
    );
    expect(s.store.countByStatus().pending).toBe(0);
    expect(s.fake.calls).toHaveLength(0);
  });

  it("bot_id 없이 들어온 자기 글도 무시한다 — probe replay 자기증식 차단", async () => {
    // probe replay 는 Bolt 를 안 타므로 ignoreSelf 가 없다. bot_id 가 붙어 오는 건 우연이니
    // user=자기 자신이면 bot_id 유무와 무관하게 끊는다 (#25 워처 팬아웃 가드와 같은 이유).
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ user: BOT, bot_id: undefined }));
    await s.listeners.handleEvent(
      "message",
      mentionEvent({ channel_type: "im", user: BOT, bot_id: undefined }),
    );
    expect(s.store.countByStatus().pending).toBe(0);
    expect(s.fake.calls).toHaveLength(0);
    expect(s.logs.some((l) => l.includes("ingress skip (self)"))).toBe(true);
  });

  it("편집·삭제 등 트리거 외 subtype 은 무시한다", async () => {
    const s = setup();
    await s.listeners.handleEvent(
      "message",
      mentionEvent({ channel_type: "im", subtype: "message_changed" }),
    );
    expect(s.store.countByStatus().pending).toBe(0);
  });

  it("file_share subtype 은 트리거다 — 파일 메타 동반 enqueue", async () => {
    const s = setup();
    await s.listeners.handleEvent(
      "message",
      mentionEvent({
        channel: "D1",
        channel_type: "im",
        subtype: "file_share",
        files: [{ id: "F1", name: "log.txt", mimetype: "text/plain" }],
      }),
    );
    const payload = s.store.getByDedupKey(chatDedupKey("D1", "100.1"))?.payload as
      | ChatPayload
      | undefined;
    expect(payload?.files).toEqual([{ id: "F1", name: "log.txt", mimetype: "text/plain" }]);
  });

  it("message 이벤트는 im 만 처리한다 — 채널 일반 메시지는 무시 (SC-07)", async () => {
    const s = setup();
    await s.listeners.handleEvent("message", mentionEvent({ channel_type: "channel" }));
    expect(s.store.countByStatus().pending).toBe(0);
  });

  it("acl 거부 → 안내 게시 + audit 로그 + enqueue 없음", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ user: "UBAD" }));

    expect(s.store.countByStatus().pending).toBe(0);
    const posts = callsOf(s.fake, "post");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain(ACL_DENY_NOTICE);
    expect(posts[0]?.threadTs).toBe("100.1");
    expect(s.logs.some((l) => l.includes("acl-deny user=UBAD"))).toBe(true);
  });

  it("acl 에 발신자 팀·봇 팀을 넘긴다 — 전원 허용의 개방 범위 판정 근거", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const store = new JobStore(db);
    const fake = makeFakeSlack();
    const seen: Array<Record<string, unknown>> = [];
    const listeners = createSlackListeners({
      botUserId: BOT,
      botTeamId: "T_HOME",
      // 와일드카드 acl 흉내 — 같은 워크스페이스면 전원 통과, 외부 조직은 거부
      acl: {
        isAllowed: (userId, ctx) => {
          seen.push({ userId, ...ctx });
          return ctx?.userTeamId === ctx?.botTeamId;
        },
      },
      store,
      commands: { handle: async () => false },
      dedup: createIngressDedup(db),
      poster: createPoster(fake.slack),
      log: () => {},
    });

    await listeners.handleEvent(
      "app_mention",
      mentionEvent({ user: "UEXT", team: "T_OTHER", ts: "200.1" }),
    );
    expect(seen[0]).toEqual({ userId: "UEXT", userTeamId: "T_OTHER", botTeamId: "T_HOME" });
    expect(store.countByStatus().pending).toBe(0);

    await listeners.handleEvent(
      "app_mention",
      mentionEvent({ user: "UANY", team: "T_HOME", ts: "200.2" }),
    );
    expect(store.countByStatus().pending).toBe(1);
  });

  it("'/' 커맨드는 즉시 처리 — enqueue 없음", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ text: `<@${BOT}> /status` }));

    expect(s.handled).toEqual([
      { channel: "C1", threadTs: "100.1", userId: "UOK1", text: "/status" },
    ]);
    expect(s.store.countByStatus().pending).toBe(0);
  });

  it("미확인 '/...' 는 커맨드 실행기가 거절 → chat 잡으로 진행", async () => {
    const s = setup();
    await s.listeners.handleEvent(
      "app_mention",
      mentionEvent({ text: `<@${BOT}> /src/app.ts 열어봐` }),
    );
    expect(s.handled).toHaveLength(1);
    expect(s.store.countByStatus().pending).toBe(1);
  });

  it("스레드 답글 멘션은 부모 thread_ts 를 lane_key 로 쓴다 (SC-03)", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ ts: "100.7", thread_ts: "100.1" }));
    const job = s.store.getByDedupKey(chatDedupKey("C1", "100.7"));
    expect(job?.laneKey).toBe("C1:100.1");
    const payload = job?.payload as ChatPayload;
    expect(payload.threadTs).toBe("100.1");
  });

  it("user 없는 이벤트·정규화 불가 이벤트는 무시한다", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", { channel: "C1", ts: "1.0", text: "x" });
    await s.listeners.handleEvent("app_mention", { text: "no channel/ts" });
    expect(s.store.countByStatus().pending).toBe(0);
  });

  it("본문은 sanitize 를 거친다 — zero-width 스머글링 제거 (SEC-12)", async () => {
    const s = setup();
    await s.listeners.handleEvent("app_mention", mentionEvent({ text: `<@${BOT}> hi​‮there` }));
    const payload = s.store.getByDedupKey(chatDedupKey("C1", "100.1"))?.payload as
      | ChatPayload
      | undefined;
    expect(payload?.text).toBe("hithere");
  });
});

describe("classifyReplayKind — 유실 replay kind 판정 (실시간 배선과 동일)", () => {
  it("DM(channel_type=im)은 message", () => {
    expect(classifyReplayKind({ channel_type: "im", text: "안녕" }, BOT)).toBe("message");
  });

  it("봇 멘션 토큰이 있으면 app_mention", () => {
    expect(classifyReplayKind({ channel: "C1", text: `<@${BOT}> 이거 봐줘` }, BOT)).toBe(
      "app_mention",
    );
  });

  it("label 형태 멘션(<@BOT|name>)도 app_mention", () => {
    expect(classifyReplayKind({ channel: "C1", text: `<@${BOT}|mybot> hey` }, BOT)).toBe(
      "app_mention",
    );
  });

  it("멘션 없는 워처 채널 일반 메시지는 message — im 게이트가 버리게 (핵심 회귀 방어)", () => {
    // 실시간이라면 message 이벤트로 와서 channelType!=="im" 게이트에 걸려 버려졌을 메시지가
    // app_mention 으로 둔갑해 chat 파이프라인에 강제 진입하지 않아야 한다.
    expect(classifyReplayKind({ channel: "C_WATCH", text: "그냥 잡담" }, BOT)).toBe("message");
  });

  it("타인 멘션만 있는 메시지는 app_mention 아님 (message)", () => {
    expect(classifyReplayKind({ channel: "C1", text: "<@U0OTHER> 확인 부탁" }, BOT)).toBe(
      "message",
    );
  });

  it("text 가 없어도(첨부만) 멘션 아님 → message", () => {
    expect(classifyReplayKind({ channel: "C1", attachments: [{ text: "x" }] }, BOT)).toBe(
      "message",
    );
  });
});

describe("멘션 없는 채널 메시지 replay 는 chat 잡을 만들지 않는다 (엔드투엔드 회귀)", () => {
  it("kind=message + 채널(im 아님)이면 게이트에서 버려져 enqueue 안 됨", async () => {
    const s = setup();
    // classifyReplayKind 가 워처 채널 일반 메시지에 대해 내리는 결정과 동일한 kind 로 주입
    const ev = { channel: "C_WATCH", ts: "500.1", user: "UOK1", text: "봇 안 부른 잡담" };
    const kind = classifyReplayKind(ev, BOT);
    expect(kind).toBe("message");
    await s.listeners.handleEvent(kind, ev);
    expect(s.store.countByStatus().pending).toBe(0);
    expect(s.store.getByDedupKey(chatDedupKey("C_WATCH", "500.1"))).toBeUndefined();
  });

  it("반대로 멘션이 실제로 있으면 app_mention 으로 enqueue 된다", async () => {
    const s = setup();
    const ev = { channel: "C_WATCH", ts: "500.2", user: "UOK1", text: `<@${BOT}> 이거 유실됐었어` };
    const kind = classifyReplayKind(ev, BOT);
    expect(kind).toBe("app_mention");
    await s.listeners.handleEvent(kind, ev);
    expect(s.store.getByDedupKey(chatDedupKey("C_WATCH", "500.2"))).toBeDefined();
  });
});
