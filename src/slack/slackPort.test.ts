import { describe, expect, it } from "vitest";
import {
  CHANNEL_MEMBERS_MAX_PAGES,
  createSlackPort,
  type SlackWebClientLike,
} from "./slackPort.js";

interface Recorded {
  method: string;
  args: Record<string, unknown>;
}

function makeFakeClient(
  opts: {
    failReplies?: boolean;
    failSetStatus?: boolean;
    failUserInfo?: boolean;
    failInfo?: boolean;
    failMembers?: boolean;
    /** conversations.info 가 돌려줄 channel 객체 — 미지정이면 봇이 멤버인 공개 채널. */
    channel?: Record<string, unknown> | null;
    /** conversations.members 페이지들(순서대로 소비). 미지정이면 U1 한 명. */
    memberPages?: { members: string[]; next?: string }[];
  } = {},
) {
  let membersPage = 0;
  const calls: Recorded[] = [];
  const client: SlackWebClientLike = {
    assistant: {
      threads: {
        async setStatus(args) {
          calls.push({ method: "assistant.threads.setStatus", args });
          if (opts.failSetStatus) throw new Error("failed_to_set_status");
          return { ok: true };
        },
      },
    },
    chat: {
      async postMessage(args) {
        calls.push({ method: "chat.postMessage", args });
        return { ok: true, ts: "111.222" };
      },
      async update(args) {
        calls.push({ method: "chat.update", args });
        return { ok: true };
      },
      async getPermalink(args) {
        calls.push({ method: "chat.getPermalink", args });
        return { ok: true, permalink: "https://OWNER.slack.com/archives/C1/p111222" };
      },
    },
    views: {
      async open(args) {
        calls.push({ method: "views.open", args });
        return { ok: true };
      },
    },
    chatStream(args) {
      calls.push({ method: "chatStream", args });
      // 첫 append(startStream) 전엔 ts 가 undefined — web-api ChatStreamer 계약을 흉내낸다.
      let streamTs: string | undefined;
      return {
        async append(a) {
          streamTs = "555.777";
          calls.push({ method: "streamer.append", args: a as Record<string, unknown> });
          return { ok: true };
        },
        async stop(a) {
          calls.push({ method: "streamer.stop", args: (a ?? {}) as Record<string, unknown> });
          return { ok: true };
        },
        get ts() {
          return streamTs;
        },
      };
    },
    users: {
      async info(args) {
        calls.push({ method: "users.info", args });
        if (opts.failUserInfo) throw new Error("user_not_found");
        return {
          ok: true,
          user: { id: args.user, name: "gildong", profile: { display_name: "홍길동_FE" } },
        };
      },
    },
    reactions: {
      async add(args) {
        calls.push({ method: "reactions.add", args });
        return {};
      },
      async remove(args) {
        calls.push({ method: "reactions.remove", args });
        return {};
      },
    },
    conversations: {
      async replies(args) {
        calls.push({ method: "conversations.replies", args });
        if (opts.failReplies) throw new Error("channel_not_found");
        return {
          ok: true,
          messages: [
            { ts: "1.0", user: "U1", text: "질문" },
            { ts: "1.1", bot_id: "B1", subtype: "bot_message", text: "봇 답" },
            { user: "U2", text: "ts 없는 이상 행 — 제외" },
            { ts: "1.2" },
          ],
        };
      },
      async history(args) {
        calls.push({ method: "conversations.history", args });
        return { ok: true, messages: [] };
      },
      async info(args) {
        calls.push({ method: "conversations.info", args });
        if (opts.failInfo) throw new Error("channel_not_found");
        if (opts.channel === null) return { ok: true };
        return {
          ok: true,
          channel: opts.channel ?? {
            id: args.channel,
            name: "alarm-frontend",
            is_member: true,
            is_private: false,
          },
        };
      },
      async members(args) {
        calls.push({ method: "conversations.members", args });
        if (opts.failMembers) throw new Error("missing_scope");
        const pages = opts.memberPages ?? [{ members: ["U1"] }];
        const page = pages[membersPage] ?? { members: [] };
        membersPage += 1;
        return {
          ok: true,
          members: page.members,
          ...(page.next ? { response_metadata: { next_cursor: page.next } } : {}),
        };
      },
    },
  };
  return { client, calls };
}

describe("createSlackPort — WebClient 인자 매핑", () => {
  it("postMessage: threadTs → thread_ts, 응답 ts 반환", async () => {
    const { client, calls } = makeFakeClient();
    const port = createSlackPort(client);
    const res = await port.postMessage({ channel: "C1", text: "hi", threadTs: "1.0" });
    expect(res.ts).toBe("111.222");
    expect(calls[0]).toEqual({
      method: "chat.postMessage",
      args: { channel: "C1", text: "hi", thread_ts: "1.0" },
    });
  });

  it("postMessage: threadTs 생략 시 thread_ts 를 보내지 않는다", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).postMessage({ channel: "C1", text: "hi" });
    expect(calls[0]?.args).toEqual({ channel: "C1", text: "hi" });
  });

  it("postMessage: 응답에 ts 가 없으면 throw — 후속 배선 보호", async () => {
    const { client } = makeFakeClient();
    client.chat.postMessage = async () => ({ ok: true });
    await expect(createSlackPort(client).postMessage({ channel: "C1", text: "x" })).rejects.toThrow(
      "ts 없음",
    );
  });

  it("postMessage: block 지정 시 blocks:[{type:markdown, text}] wire 포맷을 만든다 (EG-10)", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).postMessage({
      channel: "C1",
      text: "알림용 요약",
      threadTs: "1.0",
      block: { markdown: "## 헤더\n| a | b |\n|---|---|", notificationText: "알림용 요약" },
    });
    // text 는 알림/폴백용으로 그대로, GFM 본문은 markdown 블록 배열로 실린다
    expect(calls[0]).toEqual({
      method: "chat.postMessage",
      args: {
        channel: "C1",
        text: "알림용 요약",
        thread_ts: "1.0",
        blocks: [{ type: "markdown", text: "## 헤더\n| a | b |\n|---|---|" }],
      },
    });
  });

  it("postMessage: block.markdown 에 maskSecrets 적용 (SEC-11 — blocks 도 마스킹 경계)", async () => {
    const { client, calls } = makeFakeClient();
    // KEY=value 마스킹 규칙만 검증(진짜 시크릿 형태 픽스처 금지 — gitleaks 오탐 방지)
    await createSlackPort(client).postMessage({
      channel: "C1",
      text: "요약",
      block: { markdown: "본문 API_KEY=placeholder", notificationText: "요약" },
    });
    const args = calls[0]?.args as { blocks?: Array<{ type: string; text: string }> };
    expect(args.blocks?.[0]).toEqual({ type: "markdown", text: "본문 API_KEY=***" });
  });

  it("updateMessage: block 지정 시 blocks:[{type:markdown, text}] 로 교체 (진행 카드 자리 → GFM)", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).updateMessage({
      channel: "C1",
      ts: "111.222",
      text: "요약",
      block: { markdown: "## 최종 답변\n**표**", notificationText: "요약" },
    });
    expect(calls[0]).toEqual({
      method: "chat.update",
      args: {
        channel: "C1",
        ts: "111.222",
        text: "요약",
        blocks: [{ type: "markdown", text: "## 최종 답변\n**표**" }],
      },
    });
  });

  it("postMessage: actions 는 버튼 전부를 actions 블록 하나로 싣는다 (한 줄 배치의 근거)", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).postMessage({
      channel: "C1",
      text: "피드백 남기기",
      threadTs: "1.0",
      actions: [
        { label: "피드백 남기기", actionId: "feedback-input-open", value: "v1" },
        { label: "채널로 전달", actionId: "forward-open", value: "v2" },
      ],
    });
    // blocks 가 하나여야 한 줄로 그려진다. 버튼마다 블록을 쪼개면 이 비교가 깨진다.
    expect(calls[0]).toEqual({
      method: "chat.postMessage",
      args: {
        channel: "C1",
        text: "피드백 남기기",
        thread_ts: "1.0",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "피드백 남기기", emoji: true },
                action_id: "feedback-input-open",
                value: "v1",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "채널로 전달", emoji: true },
                action_id: "forward-open",
                value: "v2",
              },
            ],
          },
        ],
      },
    });
  });

  it("postMessage/updateMessage: block 미지정이면 blocks 를 보내지 않는다", async () => {
    const { client, calls } = makeFakeClient();
    const port = createSlackPort(client);
    await port.postMessage({ channel: "C1", text: "평문만" });
    await port.updateMessage({ channel: "C1", ts: "1.0", text: "평문 교체" });
    const postArgs = calls[0]?.args as { blocks?: unknown } | undefined;
    const updateArgs = calls[1]?.args as { blocks?: unknown } | undefined;
    expect(postArgs?.blocks).toBeUndefined();
    expect(updateArgs?.blocks).toBeUndefined();
  });

  it("리액션: ts → timestamp 매핑", async () => {
    const { client, calls } = makeFakeClient();
    const port = createSlackPort(client);
    await port.addReaction({ channel: "C1", ts: "1.0", name: "eyes" });
    await port.removeReaction({ channel: "C1", ts: "1.0", name: "eyes" });
    expect(calls[0]?.args).toEqual({ channel: "C1", timestamp: "1.0", name: "eyes" });
    expect(calls[1]?.method).toBe("reactions.remove");
  });

  it("openView: ModalView → views.open wire 포맷(modal·plain_text·input 블록)을 만든다", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).openView({
      triggerId: "T_123",
      view: {
        callbackId: "feedback-input-submit",
        title: "봇 답변 피드백",
        submitLabel: "제출",
        privateMetadata: '{"channel":"C1","threadTs":"1.0"}',
        inputs: [
          {
            kind: "text",
            blockId: "feedback_text",
            actionId: "text",
            label: "무엇을 다르게?",
            multiline: true,
            maxLength: 2000,
            placeholder: "예시",
          },
        ],
      },
    });
    expect(calls[0]?.method).toBe("views.open");
    expect(calls[0]?.args).toEqual({
      trigger_id: "T_123",
      view: {
        type: "modal",
        callback_id: "feedback-input-submit",
        private_metadata: '{"channel":"C1","threadTs":"1.0"}',
        title: { type: "plain_text", text: "봇 답변 피드백" },
        submit: { type: "plain_text", text: "제출" },
        close: { type: "plain_text", text: "취소" },
        blocks: [
          {
            type: "input",
            block_id: "feedback_text",
            label: { type: "plain_text", text: "무엇을 다르게?" },
            element: {
              type: "plain_text_input",
              action_id: "text",
              multiline: true,
              max_length: 2000,
              placeholder: { type: "plain_text", text: "예시" },
            },
          },
        ],
      },
    });
  });

  it("fetchPermalink: message_ts 매핑 + 부재 시 throw", async () => {
    const { client, calls } = makeFakeClient();
    const port = createSlackPort(client);
    const link = await port.fetchPermalink({ channel: "C1", ts: "111.222" });
    expect(link).toContain("archives/C1");
    expect(calls[0]?.args).toEqual({ channel: "C1", message_ts: "111.222" });

    client.chat.getPermalink = async () => ({ ok: false });
    await expect(port.fetchPermalink({ channel: "C1", ts: "1.0" })).rejects.toThrow(
      "getPermalink 실패",
    );
  });

  it("fetchThreadMessages: 필드 정규화(user/bot_id/subtype/text) + ts 없는 행 제외", async () => {
    const { client } = makeFakeClient();
    const rows = await createSlackPort(client).fetchThreadMessages({
      channel: "C1",
      threadTs: "1.0",
    });
    expect(rows).toEqual([
      { ts: "1.0", user: "U1", botId: null, subtype: null, text: "질문" },
      { ts: "1.1", user: null, botId: "B1", subtype: "bot_message", text: "봇 답" },
      { ts: "1.2", user: null, botId: null, subtype: null, text: "" },
    ]);
  });

  it("fetchUserName: users.info 표시명 선택 + 실패는 throw (흡수는 userDirectory 책임)", async () => {
    const { client, calls } = makeFakeClient();
    expect(await createSlackPort(client).fetchUserName("U1")).toBe("홍길동_FE");
    expect(calls.at(-1)).toEqual({ method: "users.info", args: { user: "U1" } });

    const failing = makeFakeClient({ failUserInfo: true });
    await expect(createSlackPort(failing.client).fetchUserName("U1")).rejects.toThrow(
      "user_not_found",
    );
  });

  it("fetchThreadMessages: API 실패는 빈 배열로 강등 (응답 포기 금지)", async () => {
    const logs: string[] = [];
    const { client } = makeFakeClient({ failReplies: true });
    const rows = await createSlackPort(client, { log: (m) => logs.push(m) }).fetchThreadMessages({
      channel: "C1",
      threadTs: "1.0",
    });
    expect(rows).toEqual([]);
    expect(logs.some((l) => l.includes("conversations.replies 실패"))).toBe(true);
  });

  it("fetchChannelInfo: 멤버십·공개여부·DM 플래그 정규화", async () => {
    const { client, calls } = makeFakeClient();
    expect(await createSlackPort(client).fetchChannelInfo("C1")).toEqual({
      name: "alarm-frontend",
      isMember: true,
      isPrivate: false,
      isIm: false,
      isMpim: false,
    });
    expect(calls.at(-1)).toEqual({ method: "conversations.info", args: { channel: "C1" } });

    // DM 은 is_member 를 주지 않는다 — 그래서 게이트가 im 을 멤버십보다 먼저 본다.
    const dm = makeFakeClient({ channel: { id: "D1", is_im: true } });
    expect(await createSlackPort(dm.client).fetchChannelInfo("D1")).toEqual({
      name: null,
      isMember: false,
      isPrivate: false,
      isIm: true,
      isMpim: false,
    });
  });

  it("fetchChannelInfo: 실패·channel 부재는 null (= 볼 수 없다, 거부 방향)", async () => {
    const logs: string[] = [];
    const failing = makeFakeClient({ failInfo: true });
    expect(
      await createSlackPort(failing.client, { log: (m) => logs.push(m) }).fetchChannelInfo("C9"),
    ).toBeNull();
    expect(logs.some((l) => l.includes("conversations.info 실패"))).toBe(true);

    const empty = makeFakeClient({ channel: null });
    expect(await createSlackPort(empty.client).fetchChannelInfo("C9")).toBeNull();
  });

  it("isChannelMember: 커서를 따라가며 찾고, 없으면 false", async () => {
    const { client, calls } = makeFakeClient({
      memberPages: [{ members: ["U9"], next: "cur1" }, { members: ["U1", "U2"] }],
    });
    const port = createSlackPort(client);
    expect(await port.isChannelMember({ channel: "C1", userId: "U2" })).toBe(true);
    expect(calls.filter((c) => c.method === "conversations.members")).toHaveLength(2);
    expect(calls.at(-1)?.args.cursor).toBe("cur1");

    const missing = makeFakeClient({ memberPages: [{ members: ["U9"] }] });
    expect(
      await createSlackPort(missing.client).isChannelMember({ channel: "C1", userId: "U2" }),
    ).toBe(false);
  });

  it("isChannelMember: API 실패·페이지 상한 초과는 false (멤버 아님으로 판정)", async () => {
    const logs: string[] = [];
    const failing = makeFakeClient({ failMembers: true });
    expect(
      await createSlackPort(failing.client, { log: (m) => logs.push(m) }).isChannelMember({
        channel: "C1",
        userId: "U1",
      }),
    ).toBe(false);
    expect(logs.some((l) => l.includes("conversations.members 실패"))).toBe(true);

    // 커서가 끝없이 이어지는 채널 — 상한에서 멈추고 거부한다(무한 스캔 금지).
    const endless = makeFakeClient({
      memberPages: Array.from({ length: CHANNEL_MEMBERS_MAX_PAGES + 1 }, () => ({
        members: ["U9"],
        next: "more",
      })),
    });
    const overflowLogs: string[] = [];
    expect(
      await createSlackPort(endless.client, { log: (m) => overflowLogs.push(m) }).isChannelMember({
        channel: "C1",
        userId: "U1",
      }),
    ).toBe(false);
    expect(endless.calls.filter((c) => c.method === "conversations.members")).toHaveLength(
      CHANNEL_MEMBERS_MAX_PAGES,
    );
    expect(overflowLogs.some((l) => l.includes("페이지 상한"))).toBe(true);
  });
});

describe("createSlackPort.createStream — 호출 직렬화 (중복 스트림 메시지 방지)", () => {
  /**
   * web-api ChatStreamer 의 flush 를 그대로 모사한다: `if (!ts) { await startStream(); ts = ... }`.
   * 잠금이 없어 flush 두 개가 겹치면 각자 startStream 을 친다 — 실사고에서 스레드에 본문 없는
   * plan 카드가 하나 더 남은 원인이다. 포트가 직렬화하면 startStream 은 한 번만 일어난다.
   */
  function makeRacyClient() {
    let streamTs: string | undefined;
    let starts = 0;
    const client = {
      ...makeFakeClient().client,
      chatStream() {
        const flush = async (): Promise<unknown> => {
          if (!streamTs) {
            starts += 1;
            // startStream 왕복 — 이 창이 열려 있는 동안 다른 flush 가 들어오면 갈라진다
            await new Promise((resolve) => setTimeout(resolve, 5));
            streamTs = "111.222";
          }
          return {};
        };
        return {
          append: flush,
          stop: flush,
          get ts() {
            return streamTs;
          },
        };
      },
    } as SlackWebClientLike;
    return { client, starts: () => starts };
  }

  it("동시 append 가 겹쳐도 startStream 은 한 번 — 스트림 메시지가 갈라지지 않는다", async () => {
    const racy = makeRacyClient();
    const handle = createSlackPort(racy.client).createStream({
      channel: "C1",
      recipientTeamId: null,
    });

    // 드라이버 실제 순서: 진행 chunk append(fire-and-forget) 직후 최종 답변 append → stop
    await Promise.all([
      handle.appendChunks([{ type: "markdown_text", text: "진행" }]),
      handle.appendText("최종 답변"),
    ]);
    await handle.stop();

    expect(racy.starts()).toBe(1);
    expect(handle.ts()).toBe("111.222");
  });

  it("앞선 append 실패가 뒤 호출을 막지 않는다 (체인이 거부로 끊기지 않음)", async () => {
    let calls = 0;
    const client = {
      ...makeFakeClient().client,
      chatStream: () => ({
        async append() {
          calls += 1;
          if (calls === 1) throw new Error("invalid_blocks");
          return {};
        },
        async stop() {
          return {};
        },
        ts: undefined,
      }),
    } as SlackWebClientLike;
    const handle = createSlackPort(client).createStream({ channel: "C1", recipientTeamId: null });

    await expect(handle.appendChunks([{ type: "markdown_text", text: "a" }])).rejects.toThrow(
      "invalid_blocks",
    );
    await expect(handle.appendText("b")).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe("createSlackPort.createStream — chatStream 배선 (plan 카드)", () => {
  it("recipient_* + task_display_mode:plan 전달, thread_ts 매핑", () => {
    const { client, calls } = makeFakeClient();
    createSlackPort(client).createStream({
      channel: "C1",
      threadTs: "1.0",
      recipientUserId: "U9",
      recipientTeamId: "T9",
      planTitle: "무시됨(planTitle 은 agentStream 이 앵커로 넣음)",
    });
    const created = calls.find((c) => c.method === "chatStream");
    expect(created?.args).toEqual({
      channel: "C1",
      thread_ts: "1.0",
      recipient_team_id: "T9",
      recipient_user_id: "U9",
      task_display_mode: "plan",
    });
  });

  it("recipientTeamId 가 null 이면 recipient_team_id 를 보내지 않는다", () => {
    const { client, calls } = makeFakeClient();
    createSlackPort(client).createStream({
      channel: "C1",
      recipientUserId: "U9",
      recipientTeamId: null,
    });
    const created = calls.find((c) => c.method === "chatStream");
    expect(created?.args).toEqual({
      channel: "C1",
      recipient_user_id: "U9",
      task_display_mode: "plan",
    });
  });

  it("appendChunks/appendText/stop 을 ChatStreamer 로 위임", async () => {
    const { client, calls } = makeFakeClient();
    const handle = createSlackPort(client).createStream({
      channel: "C1",
      recipientUserId: "U9",
      recipientTeamId: "T9",
    });
    await handle.appendChunks([{ type: "plan_update", title: "진행" }]);
    await handle.appendText("최종 답변");
    await handle.stop({ markdownText: "끝" });

    const appends = calls.filter((c) => c.method === "streamer.append");
    expect(appends[0]?.args).toEqual({ chunks: [{ type: "plan_update", title: "진행" }] });
    expect(appends[1]?.args).toEqual({ markdown_text: "최종 답변" });
    const stops = calls.filter((c) => c.method === "streamer.stop");
    expect(stops[0]?.args).toEqual({ markdown_text: "끝" });
  });

  it("handle.ts() 는 ChatStreamer.ts 를 그대로 노출한다 (첫 flush 전 undefined → 후 정의)", async () => {
    const { client } = makeFakeClient();
    const handle = createSlackPort(client).createStream({ channel: "C1", recipientUserId: "U9" });
    // 첫 flush(append) 전엔 카드가 없으니 undefined
    expect(handle.ts()).toBeUndefined();
    await handle.appendChunks([{ type: "plan_update", title: "진행" }]);
    // startStream 이 카드를 만든 뒤엔 그 ts 를 돌려준다 — 죽은 스트림 정리(A 버그)의 대상 ts
    expect(handle.ts()).toBe("555.777");
  });

  it("빈 chunk 배열·빈 텍스트는 append 를 유발하지 않는다", async () => {
    const { client, calls } = makeFakeClient();
    const handle = createSlackPort(client).createStream({ channel: "C1", recipientUserId: "U9" });
    await handle.appendChunks([]);
    await handle.appendText("");
    expect(calls.filter((c) => c.method === "streamer.append")).toHaveLength(0);
  });

  it("chunk title/text·최종 답변에 maskSecrets 적용 (SEC-11)", async () => {
    const { client, calls } = makeFakeClient();
    const handle = createSlackPort(client).createStream({ channel: "C1", recipientUserId: "U9" });
    // KEY=value 마스킹 규칙만 검증(진짜 시크릿 형태 픽스처 금지 — gitleaks 오탐 방지)
    await handle.appendChunks([
      {
        type: "task_update",
        id: "t1",
        title: "Bash: export API_KEY=placeholder",
        status: "complete",
      },
      { type: "markdown_text", text: "TOKEN=placeholder" },
    ]);
    await handle.appendText("답변 SECRET=placeholder 끝");
    await handle.stop({ markdownText: "PASSWORD=placeholder" });

    const appends = calls.filter((c) => c.method === "streamer.append");
    const chunkArgs = appends[0]?.args as { chunks: Array<Record<string, string>> };
    expect(chunkArgs.chunks[0]?.title).toBe("Bash: export API_KEY=***");
    expect(chunkArgs.chunks[1]?.text).toBe("TOKEN=***");
    expect(appends[1]?.args).toEqual({ markdown_text: "답변 SECRET=*** 끝" });
    const stops = calls.filter((c) => c.method === "streamer.stop");
    const stopArgs = stops[0]?.args as { markdown_text?: string } | undefined;
    expect(stopArgs?.markdown_text).toBe("PASSWORD=***");
  });
});

describe("createSlackPort.setAssistantStatus — assistant.threads.setStatus 배선", () => {
  it("channel→channel_id, threadTs→thread_ts 매핑 + status 전달", async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).setAssistantStatus({
      channel: "C1",
      threadTs: "1.0",
      status: "분석 중… · sonnet",
    });
    const set = calls.find((c) => c.method === "assistant.threads.setStatus");
    expect(set?.args).toEqual({
      channel_id: "C1",
      thread_ts: "1.0",
      status: "분석 중… · sonnet",
    });
  });

  it('status="" 로 상태를 지운다 (빈 문자열 그대로 전달)', async () => {
    const { client, calls } = makeFakeClient();
    await createSlackPort(client).setAssistantStatus({
      channel: "C1",
      threadTs: "1.0",
      status: "",
    });
    const set = calls.find((c) => c.method === "assistant.threads.setStatus");
    expect((set?.args as { status?: string } | undefined)?.status).toBe("");
  });

  it("status 에 maskSecrets 적용 (SEC-11)", async () => {
    const { client, calls } = makeFakeClient();
    // KEY=value 마스킹 규칙만 검증(진짜 시크릿 형태 픽스처 금지 — gitleaks 오탐 방지)
    await createSlackPort(client).setAssistantStatus({
      channel: "C1",
      threadTs: "1.0",
      status: "분석 중 TOKEN=placeholder",
    });
    const set = calls.find((c) => c.method === "assistant.threads.setStatus");
    expect((set?.args as { status?: string } | undefined)?.status).toBe("분석 중 TOKEN=***");
  });

  it("API 실패해도 throw 하지 않는다 (코스메틱, best-effort) + 로그만 남긴다", async () => {
    const logs: string[] = [];
    const { client } = makeFakeClient({ failSetStatus: true });
    const port = createSlackPort(client, { log: (m) => logs.push(m) });
    await expect(
      port.setAssistantStatus({ channel: "C1", threadTs: "1.0", status: "분석 중…" }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("assistant.threads.setStatus 실패"))).toBe(true);
  });
});
