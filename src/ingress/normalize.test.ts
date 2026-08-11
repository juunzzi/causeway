import { describe, expect, it } from "vitest";
import {
  collectEventText,
  collectFileMeta,
  normalizeInbound,
  stripBotMention,
} from "./normalize.js";

const BOT = "U0BOT";

describe("stripBotMention (SC-06)", () => {
  it("선두 멘션 토큰을 제거한다", () => {
    expect(stripBotMention(`<@${BOT}> 이 버그 봐줘`, BOT)).toBe("이 버그 봐줘");
  });

  it("label 형태(<@U|name>)와 중첩 멘션도 제거한다", () => {
    expect(stripBotMention(`<@${BOT}|mybot> 안녕 <@${BOT}> 또 안녕`, BOT)).toBe("안녕 또 안녕");
  });

  it("타인 멘션은 보존한다", () => {
    expect(stripBotMention(`<@${BOT}> <@U0OTHER> 님 질문 전달`, BOT)).toBe(
      "<@U0OTHER> 님 질문 전달",
    );
  });

  it("멀티라인 본문에서 개행을 보존한다", () => {
    const input = `<@${BOT}> 첫 줄\n둘째 줄\n<@${BOT}> 셋째 줄`;
    expect(stripBotMention(input, BOT)).toBe("첫 줄\n둘째 줄\n셋째 줄");
  });

  it("botUserId 가 비면 trim 만 한다", () => {
    expect(stripBotMention("  hello  ", "")).toBe("hello");
  });
});

describe("collectEventText (DP-02)", () => {
  it("attachment-only 메시지에서 본문을 추출한다", () => {
    const event = {
      text: "",
      attachments: [{ pretext: "P", title: "T", text: "본문", fallback: "F" }, { text: "둘째" }],
    };
    expect(collectEventText(event)).toBe("P\nT\n본문\nF\n둘째");
  });

  it("blocks-only 메시지에서 section text/fields 를 추출한다", () => {
    const event = {
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "섹션 본문" } },
        { type: "section", fields: [{ type: "mrkdwn", text: "필드1" }, { text: "필드2" }] },
        { type: "divider" },
      ],
    };
    expect(collectEventText(event)).toBe("섹션 본문\n필드1\n필드2");
  });

  it("text + attachments + blocks 를 합산한다", () => {
    const event = {
      text: "본문",
      attachments: [{ fallback: "att" }],
      blocks: [{ text: { text: "blk" } }],
    };
    expect(collectEventText(event)).toBe("본문\natt\nblk");
  });

  it("비정상 형태(문자열 아님)는 조용히 건너뛴다", () => {
    const event = {
      text: 123,
      attachments: [null, "str", { text: 1 }],
      blocks: [{ text: "not-a-dict" }],
    };
    expect(collectEventText(event as Record<string, unknown>)).toBe("");
  });
});

describe("collectFileMeta", () => {
  it("파일 메타(id/name/mimetype)만 수집한다", () => {
    const event = {
      files: [
        { id: "F1", name: "err.log", mimetype: "text/plain", url_private: "https://x" },
        { id: "F2" },
        { name: "no-id.png" },
        null,
      ],
    };
    expect(collectFileMeta(event as Record<string, unknown>)).toEqual([
      { id: "F1", name: "err.log", mimetype: "text/plain" },
      { id: "F2", name: "(이름 없음)", mimetype: "application/octet-stream" },
    ]);
  });
});

describe("normalizeInbound", () => {
  it("top-level 메시지는 ts 가 threadTs — thread_key=channel:ts", () => {
    const n = normalizeInbound(
      { channel: "C1", ts: "100.1", user: "U1", text: `<@${BOT}> hi` },
      { botUserId: BOT },
    );
    expect(n).not.toBeNull();
    expect(n?.threadTs).toBe("100.1");
    expect(n?.threadKey).toBe("C1:100.1");
    expect(n?.text).toBe("hi");
  });

  it("스레드 답글은 thread_ts 기준 thread_key", () => {
    const n = normalizeInbound(
      { channel: "C1", ts: "100.5", thread_ts: "100.1", user: "U1", text: "reply" },
      { botUserId: BOT },
    );
    expect(n?.threadTs).toBe("100.1");
    expect(n?.threadKey).toBe("C1:100.1");
  });

  it("userTeamId: user_team 우선, 없으면 team, 둘 다 없으면 null", () => {
    const withUserTeam = normalizeInbound(
      { channel: "C1", ts: "100.1", user: "U1", team: "T_HOME", user_team: "T_EXT", text: "hi" },
      { botUserId: BOT },
    );
    expect(withUserTeam?.userTeamId).toBe("T_EXT");

    const withTeam = normalizeInbound(
      { channel: "C1", ts: "100.1", user: "U1", team: "T_HOME", text: "hi" },
      { botUserId: BOT },
    );
    expect(withTeam?.userTeamId).toBe("T_HOME");

    const withNeither = normalizeInbound(
      { channel: "C1", ts: "100.1", user: "U1", text: "hi" },
      { botUserId: BOT },
    );
    expect(withNeither?.userTeamId).toBeNull();
  });

  it("channel/ts 없으면 null", () => {
    expect(normalizeInbound({ ts: "1.0" }, { botUserId: BOT })).toBeNull();
    expect(normalizeInbound({ channel: "C1" }, { botUserId: BOT })).toBeNull();
  });

  it("bot_id·subtype·channel_type·files 를 그대로 보존한다", () => {
    const n = normalizeInbound(
      {
        channel: "D1",
        ts: "1.0",
        bot_id: "B9",
        subtype: "bot_message",
        channel_type: "im",
        text: "x",
        files: [{ id: "F1", name: "a", mimetype: "b" }],
      },
      { botUserId: BOT },
    );
    expect(n?.botId).toBe("B9");
    expect(n?.subtype).toBe("bot_message");
    expect(n?.channelType).toBe("im");
    expect(n?.files).toHaveLength(1);
  });
});
