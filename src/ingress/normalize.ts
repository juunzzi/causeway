/**
 * 인바운드 Slack 이벤트 정규화 — 순수 함수만, config 접근 금지 (SC-06).
 *
 * - 본문은 event.text 단독이 아니라 text + attachments + blocks 합산 추출 (DP-02):
 *   봇 알람은 본문이 attachment 에 숨고, 사람 메시지도 section block 에 실릴 수 있다.
 * - thread_key 는 sessions 의 threadKey 를 재사용한다 — 키 조립 로직이 두 곳이면 갈라진다.
 */

import { threadKey } from "../sessions/sessionStore.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 (이 파일 전체가 순수 함수다)
// ────────────────────────────────────────────────────────────────────

export interface SlackFileMeta {
  id: string;
  name: string;
  mimetype: string;
}

export interface NormalizedInbound {
  channel: string;
  /** 트리거 메시지 ts. */
  ts: string;
  /** 스레드 부모 ts — top-level 이면 ts 자신. */
  threadTs: string;
  /** `channel:threadTs` — 세션·lane 직렬화의 키. */
  threadKey: string;
  userId: string | null;
  /**
   * 발신자의 팀 ID — 와일드카드 ACL 의 개방 범위(설치 워크스페이스) 판정 근거.
   * Slack Connect 공유 채널에서는 외부 조직 사용자의 팀 ID 가 `user_team` 에 실린다.
   * 두 필드 모두 없는 payload 도 있으므로 null 을 정상값으로 다룬다(acl 이 흡수).
   */
  userTeamId: string | null;
  botId: string | null;
  subtype: string | null;
  channelType: string | null;
  /** 합산 추출 + 봇 멘션 토큰 제거 + trim. sanitize(SEC-12)는 리스너 책임. */
  text: string;
  files: SlackFileMeta[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 처리 대상 subtype 화이트리스트: 없음(일반) + file_share(첨부 동반 일반 메시지)만.
 * bot_message·message_changed·message_deleted·channel_join 등은 트리거가 아니다 —
 * message_changed 류는 outer envelope 의 fresh ts 로 dedup 을 우회하고, top-level bot_id
 * 가 없어 any-human 게이트를 통과하므로 반드시 입구에서 자른다(chat·watcher 공통 계약).
 */
export function isTriggerSubtype(subtype: string | null): boolean {
  return subtype === null || subtype === "file_share";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 봇 자신을 향한 <@Uxxx> / <@Uxxx|label> 멘션 토큰 제거.
 * 제약: 토큰 제거로 생긴 연속 공백만 접는다(개행 보존) — 트리거 본문 정규화 목적이므로
 * 코드블록 내 의도적 다중 공백까지 완전 보존하는 것보다 멘션 잔재 제거가 우선이다.
 */
export function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  // Slack 유저 ID 는 영대문자+숫자뿐 — 정규식 이스케이프 불필요
  const re = new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
  return text
    .replace(re, " ")
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * text + attachments[].{pretext,title,text,fallback} + blocks(section text/fields) 합산 (DP-02).
 * 선행 구현 이식 — event.text 만 보면 attachment 본문을 놓친다.
 */
export function collectEventText(event: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };

  push(event.text);

  if (Array.isArray(event.attachments)) {
    for (const att of event.attachments) {
      if (!isRecord(att)) continue;
      for (const key of ["pretext", "title", "text", "fallback"]) {
        push(att[key]);
      }
    }
  }

  if (Array.isArray(event.blocks)) {
    for (const block of event.blocks) {
      if (!isRecord(block)) continue;
      // section block 의 text.text / fields[].text 만 얕게 추출 (선행 구현의 동작 계약 유지)
      if (isRecord(block.text)) push(block.text.text);
      if (Array.isArray(block.fields)) {
        for (const field of block.fields) {
          if (isRecord(field)) push(field.text);
        }
      }
    }
  }

  return parts.join("\n");
}

/** 파일은 메타만 수집 — 본문 다운로드는 잡 실행 단계의 몫이지 ingress 의 몫이 아니다 (JQ-01). */
export function collectFileMeta(event: Record<string, unknown>): SlackFileMeta[] {
  if (!Array.isArray(event.files)) return [];
  const out: SlackFileMeta[] = [];
  for (const file of event.files) {
    if (!isRecord(file)) continue;
    const id = asString(file.id);
    if (!id) continue;
    out.push({
      id,
      name: asString(file.name) ?? "(이름 없음)",
      mimetype: asString(file.mimetype) ?? "application/octet-stream",
    });
  }
  return out;
}

/** channel/ts 없는 이벤트는 정규화 불가 — null 반환으로 호출측이 조용히 무시하게 한다. */
export function normalizeInbound(
  event: Record<string, unknown>,
  opts: { botUserId: string },
): NormalizedInbound | null {
  const channel = asString(event.channel);
  const ts = asString(event.ts);
  if (!channel || !ts) return null;
  const threadTs = asString(event.thread_ts) ?? ts;
  return {
    channel,
    ts,
    threadTs,
    threadKey: threadKey(channel, threadTs),
    userId: asString(event.user),
    userTeamId: asString(event.user_team) ?? asString(event.team),
    botId: asString(event.bot_id),
    subtype: asString(event.subtype),
    channelType: asString(event.channel_type),
    text: stripBotMention(collectEventText(event), opts.botUserId),
    files: collectFileMeta(event),
  };
}
