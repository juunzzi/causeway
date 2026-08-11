import { describe, expect, it } from "vitest";
import { CONTRACT } from "../core/constants.js";
import {
  buildMarkdownBlockChunks,
  buildOutboundChunks,
  createPoster,
  EMPTY_RESPONSE_NOTICE,
  FROZEN_CARD_NOTICE,
  toNotificationText,
} from "./poster.js";
import { callsOf, makeFakeSlack, mustGet } from "./testSupport.js";

describe("buildOutboundChunks — 파이프라인 순수부", () => {
  it("mask → mrkdwn → mentionGuard 가 모두 적용된 chunk 를 만든다", () => {
    const { chunks, blockedMentions } = buildOutboundChunks(
      "**결과**: TOKEN=abc123 확인. <@U999> 님 참고",
      { allowedMentionUserIds: ["U111"], nameByUserId: new Map([["U999", "철수"]]) },
    );
    const first = mustGet(chunks, 0);
    expect(first).toContain("*결과*"); // mrkdwn 변환
    expect(first).toContain("TOKEN=***"); // 마스킹
    expect(first).not.toContain("abc123");
    expect(first).toContain("@철수"); // 멘션 평문화
    expect(first).not.toContain("<@U999>");
    expect(blockedMentions).toEqual(["U999"]);
  });

  it("전체 ``` 감싸기 입력은 벗긴 뒤 분할한다 (EG-05)", () => {
    const { chunks } = buildOutboundChunks("```\n리포트 **본문**\n```");
    expect(mustGet(chunks, 0)).toBe("리포트 *본문*");
  });

  it("긴 텍스트는 연속 표시 marker 와 함께 분할된다", () => {
    const para = `${"문장입니다 ".repeat(50)}\n\n`;
    const { chunks } = buildOutboundChunks(para.repeat(20));
    expect(chunks.length).toBeGreaterThan(1);
    expect(mustGet(chunks, 0)).toContain("_(이어집니다 ↓ 1/");
    expect(mustGet(chunks, chunks.length - 1)).toContain("끝)_");
  });

  it("빈 응답은 chunk 0개", () => {
    expect(buildOutboundChunks("   \n").chunks).toEqual([]);
  });
});

describe("createPoster — 게시 오케스트레이션", () => {
  it("단일 chunk 는 스레드 답글 1개로 게시된다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const res = await poster.postFinal("짧은 답변", { channel: "C1", threadTs: "111.0" });
    const posts = callsOf(fake, "post");
    expect(posts).toHaveLength(1);
    expect(mustGet(posts, 0).threadTs).toBe("111.0");
    expect(mustGet(posts, 0).text).toBe("짧은 답변");
    expect(res.postedTs).toHaveLength(1);
    expect(res.usedFallback).toBe(false);
  });

  it("replaceTs 지정 시 첫 chunk 는 진행 카드 자리를 chat.update 로 교체한다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const long = `${"문단 내용입니다 ".repeat(60)}\n\n`.repeat(10);
    const res = await poster.postFinal(long, {
      channel: "C1",
      threadTs: "111.0",
      replaceTs: "222.0",
    });

    const updates = callsOf(fake, "update");
    const posts = callsOf(fake, "post");
    expect(mustGet(updates, 0).ts).toBe("222.0");
    expect(mustGet(updates, 0).text).toContain("_(이어집니다 ↓ 1/");
    // 나머지 chunk 는 같은 스레드 새 답글
    expect(posts.length).toBeGreaterThanOrEqual(1);
    for (const p of posts) expect(p.threadTs).toBe("111.0");
    expect(mustGet(res.postedTs, 0)).toBe("222.0");
    // 첫 update 가 post 보다 먼저 — 파이프라인 게시 순서
    expect(mustGet(fake.calls, 0).kind).toBe("update");
  });

  it("각 게시 본문은 chunk 상한 + marker 여유 안에 있다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const long = `${"문단 내용입니다 ".repeat(60)}\n\n`.repeat(10);
    await poster.postFinal(long, { channel: "C1" });
    for (const call of fake.calls) {
      expect((call.text ?? "").length).toBeLessThanOrEqual(CONTRACT.MESSAGE_CHUNK_CHARS + 40);
    }
  });

  it("chat.update 실패 시 새 답글 fallback + 원 카드를 완료 안내로 교체 (EG-04)", async () => {
    const fake = makeFakeSlack();
    fake.failUpdateTs.add("222.0");
    const logs: string[] = [];
    const poster = createPoster(fake.slack, { log: (m) => logs.push(m) });
    const res = await poster.postFinal("최종 답변", {
      channel: "C1",
      threadTs: "111.0",
      replaceTs: "222.0",
    });

    expect(res.usedFallback).toBe(true);
    const posts = callsOf(fake, "post");
    expect(mustGet(posts, 0).text).toBe("최종 답변");
    expect(mustGet(posts, 0).threadTs).toBe("111.0");
    // 동결 방지: 실패한 카드에 완료 안내 교체 시도
    const updates = callsOf(fake, "update");
    expect(updates).toHaveLength(2);
    expect(mustGet(updates, 1).text).toBe(FROZEN_CARD_NOTICE);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("fallback 게시마저 실패하면 throw — 잡 핸들러가 실패를 알 수 있어야 한다", async () => {
    const fake = makeFakeSlack();
    fake.failUpdateTs.add("222.0");
    fake.failPost.value = true;
    const poster = createPoster(fake.slack);
    await expect(poster.postFinal("답변", { channel: "C1", replaceTs: "222.0" })).rejects.toThrow(
      "post_failed",
    );
  });

  it("빈 응답 + replaceTs 는 카드를 빈 응답 안내로 교체한다 (동결 방지)", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const res = await poster.postFinal("", { channel: "C1", replaceTs: "222.0" });
    expect(res.postedTs).toEqual([]);
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, 0).ts).toBe("222.0");
    expect(callsOf(fake, "post")).toHaveLength(0);
  });

  it("빈 응답 + replaceTs 의 chat.update 실패도 동결시키지 않는다 — 안내 답글 fallback (EG-04)", async () => {
    const fake = makeFakeSlack();
    fake.failUpdateTs.add("222.0");
    const logs: string[] = [];
    const poster = createPoster(fake.slack, { log: (m) => logs.push(m) });
    const res = await poster.postFinal("", {
      channel: "C1",
      threadTs: "111.0",
      replaceTs: "222.0",
    });

    expect(res.usedFallback).toBe(true);
    expect(res.postedTs).toEqual([]); // 안내는 본문이 아니다
    const posts = callsOf(fake, "post");
    expect(posts).toHaveLength(1);
    expect(mustGet(posts, 0).text).toBe(EMPTY_RESPONSE_NOTICE);
    expect(mustGet(posts, 0).threadTs).toBe("111.0");
    // 동결 방지: 실패한 카드에 완료 안내 교체 시도
    const updates = callsOf(fake, "update");
    expect(updates).toHaveLength(2);
    expect(mustGet(updates, 1).text).toBe(FROZEN_CARD_NOTICE);
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("중간 chunk 전송 실패는 이후 chunk 게시를 막지 않는다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const original = fake.slack.postMessage.bind(fake.slack);
    let postCount = 0;
    fake.slack.postMessage = async (args) => {
      postCount += 1;
      if (postCount === 2) throw new Error("net_error");
      return original(args);
    };
    const long = `${"문단 내용입니다 ".repeat(60)}\n\n`.repeat(20);
    const res = await poster.postFinal(long, { channel: "C1" });
    // 실패한 1개를 제외한 나머지가 게시됐다
    expect(res.postedTs.length).toBeGreaterThanOrEqual(2);
  });
});

describe("toNotificationText — 알림 요약", () => {
  it("링크/표/헤더/코드 마크업을 걷어낸 평문을 만든다", () => {
    const md =
      "## 헤더\n[문서](https://x.com) 참고\n\n| A | B |\n|---|---|\n| 1 | 2 |\n```\ncode\n```";
    const notif = toNotificationText(md);
    expect(notif).not.toContain("##");
    expect(notif).not.toContain("](");
    expect(notif).not.toContain("```");
    expect(notif).not.toContain("code"); // 코드블록 통째 제거
    expect(notif).toContain("문서"); // 링크 텍스트는 남는다
  });

  it("길면 말줄임한다", () => {
    const notif = toNotificationText("가".repeat(500), 100);
    expect(notif.length).toBeLessThanOrEqual(100);
    expect(notif.endsWith("…")).toBe(true);
  });
});

describe("buildMarkdownBlockChunks — GFM 보존 파이프라인 (EG-10)", () => {
  it("GFM 원본을 mdToMrkdwn 변환 없이 보존한다", () => {
    const { chunks } = buildMarkdownBlockChunks("## 제목\n**굵게** [링크](https://x.com)");
    const first = mustGet(chunks, 0);
    // ## 헤더·**굵게**·[링크](url) 가 GFM 그대로 (mrkdwn 의 *굵게*·<url|링크> 로 바뀌지 않음)
    expect(first.markdown).toBe("## 제목\n**굵게** [링크](https://x.com)");
  });

  it("마스킹은 적용하되 멘션은 게이트한다", () => {
    const { chunks, blockedMentions } = buildMarkdownBlockChunks(
      "TOKEN=abc123 확인. <@U999> 참고",
      { allowedMentionUserIds: ["U111"], nameByUserId: new Map([["U999", "철수"]]) },
    );
    const first = mustGet(chunks, 0);
    expect(first.markdown).toContain("TOKEN=***");
    expect(first.markdown).not.toContain("abc123");
    expect(first.markdown).toContain("@철수");
    expect(blockedMentions).toEqual(["U999"]);
  });

  it("전체 ``` 감싸기 입력은 벗긴다(SK inline-snippet 방지)", () => {
    const { chunks } = buildMarkdownBlockChunks("```\n## 리포트\n본문\n```");
    expect(mustGet(chunks, 0).markdown).toBe("## 리포트\n본문");
  });

  it("빈 응답은 chunk 0개", () => {
    expect(buildMarkdownBlockChunks("  \n").chunks).toEqual([]);
  });
});

describe("createPoster — markdown 블록 게시 (EG-10)", () => {
  it("asMarkdownBlock 이면 blocks + text 폴백으로 게시한다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    await poster.postFinal("## 리포트\n**중요** 내용", {
      channel: "C1",
      threadTs: "111.0",
      asMarkdownBlock: true,
    });
    const posts = callsOf(fake, "post");
    expect(posts).toHaveLength(1);
    const p = mustGet(posts, 0);
    // GFM 원본이 block 에, 알림용 평문이 text 에
    expect(p.block?.markdown).toBe("## 리포트\n**중요** 내용");
    expect(p.text).toBeTruthy();
    expect(p.text).not.toContain("##");
  });

  it("replaceTs 교체도 markdown 블록으로 update 한다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    await poster.postFinal("## 리포트\n표 데이터", {
      channel: "C1",
      threadTs: "111.0",
      replaceTs: "222.0",
      asMarkdownBlock: true,
    });
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, 0).ts).toBe("222.0");
    expect(mustGet(updates, 0).block?.markdown).toBe("## 리포트\n표 데이터");
  });

  it("notificationText 가 비는 청크도 빈 text 로 게시하지 않는다(Slack text 필수)", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    // 산문 없이 표만 있는 본문 — toNotificationText 가 표 마크업을 걷어내면 거의 비어 있다.
    // 어떤 청크도 text 가 빈 문자열이 아니어야 한다(Slack 이 빈 text+blocks 를 거절할 수 있다).
    await poster.postFinal("| --- | --- |\n|---|---|\n| --- | --- |", {
      channel: "C1",
      asMarkdownBlock: true,
    });
    const posts = callsOf(fake, "post");
    for (const p of posts) {
      expect((p.text ?? "").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("11k 초과는 표/코드블록 절단 없이 여러 markdown 블록으로 분할 + 각 청크 ≤ 11k", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    // 큰 표 + 큰 코드블록 + 산문 — 상한을 넘겨 분할을 강제
    const fence = "```";
    const rows = Array.from({ length: 1200 }, (_, i) => `| svc-${i} | ${i} | 메모${i} |`);
    const table = ["| 서비스 | 건수 | 비고 |", "|---|---|---|", ...rows].join("\n");
    const codeBody = Array.from({ length: 800 }, (_, i) => `log line ${i}`).join("\n");
    const code = `${fence}\n${codeBody}\n${fence}`;
    const body = `## 표\n${table}\n\n## 코드\n${code}`;
    await poster.postFinal(body, { channel: "C1", asMarkdownBlock: true });

    const posts = callsOf(fake, "post");
    expect(posts.length).toBeGreaterThan(1);
    for (const p of posts) {
      const md = p.block?.markdown ?? "";
      // msg_too_long 경계 회피: 각 청크 ≤ 11k
      expect(md.length).toBeLessThanOrEqual(CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS);
      // 각 청크의 코드펜스는 짝수(코드블록 중간 절단 없음)
      expect((md.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // 표 데이터가 전부 보존됐다
    const allMd = posts.map((p) => p.block?.markdown ?? "").join("\n");
    for (const r of rows) expect(allMd).toContain(r);
  });

  it("빈 응답 + asMarkdownBlock + replaceTs 는 카드를 빈 응답 안내로 교체한다", async () => {
    const fake = makeFakeSlack();
    const poster = createPoster(fake.slack);
    const res = await poster.postFinal("", {
      channel: "C1",
      replaceTs: "222.0",
      asMarkdownBlock: true,
    });
    expect(res.postedTs).toEqual([]);
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, 0).ts).toBe("222.0");
    expect(mustGet(updates, 0).text).toBe(EMPTY_RESPONSE_NOTICE);
    // 빈 응답 안내는 상수 text 경로 — block 을 싣지 않는다
    expect(mustGet(updates, 0).block).toBeUndefined();
  });

  it("markdown 블록 chat.update 실패 시 새 답글 fallback + 원 카드 완료 안내(EG-04)", async () => {
    const fake = makeFakeSlack();
    fake.failUpdateTs.add("222.0");
    const poster = createPoster(fake.slack);
    const res = await poster.postFinal("## 리포트\n내용", {
      channel: "C1",
      threadTs: "111.0",
      replaceTs: "222.0",
      asMarkdownBlock: true,
    });
    expect(res.usedFallback).toBe(true);
    const posts = callsOf(fake, "post");
    // fallback 답글도 markdown 블록으로
    expect(mustGet(posts, 0).block?.markdown).toBe("## 리포트\n내용");
    // 동결 방지: 원 카드에 완료 안내(text 상수)로 교체
    const updates = callsOf(fake, "update");
    expect(mustGet(updates, 1).text).toBe(FROZEN_CARD_NOTICE);
    expect(mustGet(updates, 1).block).toBeUndefined();
  });
});
