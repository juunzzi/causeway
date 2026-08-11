/**
 * egress SlackPort 의 실제 구현 — bolt WebClient 배선 (EG-01).
 *
 * 제약: Slack 쓰기 API 호출 코드는 이 파일과 egress/* 뿐이다. 다른 모듈에서 WebClient 를
 * 직접 쓰는 순간 mask→mrkdwn→chunk→멘션게이트 파이프라인이 우회된다 — 금지.
 *
 * WebClient 는 구조적 최소 인터페이스(SlackWebClientLike)로 받는다: 테스트가 가짜 클라이언트를
 * 주입할 수 있고, pnpm 격리 node_modules 에서 전이 의존성(@slack/web-api)을 직접 import 하지
 * 않아도 된다 (bolt 의 App["client"] 가 이 형태를 구조적으로 만족한다).
 */

import type {
  ActionButton,
  ChatStreamHandle,
  CreateStreamArgs,
  ModalInput,
  SectionButtonBlock,
  SlackPort,
} from "../egress/ports.js";
import type { ProbedMessage, SlackHistoryPort } from "../resilience/socketHealth.js";
import { maskSecrets } from "../security/maskSecrets.js";
import type { Chunk } from "./agentStream.js";
import { pickDisplayName } from "./userDirectory.js";

// ────────────────────────────────────────────────────────────────────
// 인터페이스 (순수 타입)
// ────────────────────────────────────────────────────────────────────

/**
 * ChatStreamer(web-api chatStream 반환)의 구조적 최소 인터페이스.
 *
 * append 인자는 {markdown_text} 또는 {chunks} 중 하나 — bolt 4.7.3 + web-api 7.19.0(전이
 * 의존)의 ChatStreamer 가 구조적으로 이 형태를 만족한다. web-api 를 직접 import 하지 않기
 * 위해(pnpm 격리) 좁혀서 받는다.
 */
export interface ChatStreamerLike {
  // 인자를 unknown 으로 넓게 받아 web-api ChatStreamer(엄격한 AnyChunk[] 타입)를 구조적으로
  // 만족시킨다 — 실제 chunk 형태 보증은 append 호출부(maskChunk 후 검증된 Chunk)가 맡는다.
  append(args: unknown): Promise<unknown>;
  stop(args?: unknown): Promise<unknown>;
  // web-api ChatStreamer.ts 게터 — chat.startStream(첫 flush) 전엔 undefined. 스트림이 죽었을 때
  // 프리즌 카드를 chat.update 로 정리하려면 이 ts 가 필요하다(A 버그).
  readonly ts?: string | undefined;
}

/**
 * Slack `markdown` 블록 — web-api 의 blocks 배열 요소. GFM 텍스트를 그대로 실으면 Slack 이
 * 표·헤더·링크·코드를 네이티브 렌더한다(EG-10). blocks 요소 타입은 넓게 두고(구조 최소),
 * 실제 형태 보증은 호출부(createSlackPort)가 맡는다. section(+버튼) 블록도 같은 배열로 실린다.
 */
type BlockElement = Record<string, unknown>;

/** plain_text 라벨 — 모달 조립 전용 최소형. */
type PlainText = { type: "plain_text"; text: string };

/** 모달 input 블록 — web-api InputBlock 에 구조적으로 맞는 필요 최소 형태. */
interface ModalInputBlockArg {
  type: "input";
  block_id: string;
  label: PlainText;
  optional?: boolean;
  element:
    | {
        type: "plain_text_input";
        action_id: string;
        multiline: boolean;
        max_length?: number;
        placeholder?: PlainText;
      }
    | {
        type: "conversations_select";
        action_id: string;
        placeholder?: PlainText;
        filter?: { include: ("public" | "private")[]; exclude_bot_users?: boolean };
      };
}

/** views.open 에 보내는 모달 — web-api ModalView 에 구조적으로 맞는 필요 최소 형태. */
interface ModalViewArg {
  type: "modal";
  callback_id: string;
  private_metadata: string;
  title: PlainText;
  submit: PlainText;
  close: PlainText;
  blocks: ModalInputBlockArg[];
}

/** Block Kit section text 상한(3,000자)의 안전 마진 클립. */
const SECTION_TEXT_MAX = 2_900;

/**
 * SectionButtonBlock → Block Kit JSON (순수). 텍스트는 이 포트가 마스킹 경계이므로 maskSecrets
 * 를 거친다(SEC-11). 버튼 value 는 결정론 식별자 계약이라 마스킹하지 않는다(ports.ts 주석).
 */
export function sectionToBlock(section: SectionButtonBlock): BlockElement {
  let text = maskSecrets(section.text);
  if (text.length > SECTION_TEXT_MAX) text = `${text.slice(0, SECTION_TEXT_MAX)}…`;
  return {
    type: "section",
    text: { type: "mrkdwn", text },
    ...(section.button ? { accessory: buttonToElement(section.button) } : {}),
  };
}

/** ActionButton → Block Kit button (순수). 라벨은 봇이 만든 정적 문자열이라 마스킹 대상이 아니다. */
function buttonToElement(button: ActionButton): BlockElement {
  return {
    type: "button",
    text: { type: "plain_text", text: button.label, emoji: true },
    action_id: button.actionId,
    value: button.value,
    ...(button.style ? { style: button.style } : {}),
  };
}

/**
 * ActionButton[] → `actions` 블록 (순수). Slack 은 한 블록에 담긴 버튼을 한 줄에 나란히
 * 그린다. 그래서 버튼이 몇 개든 블록 하나로 낸다. 쪼개는 순간 줄이 갈린다.
 */
export function actionsToBlock(buttons: readonly ActionButton[]): BlockElement {
  return { type: "actions", elements: buttons.map(buttonToElement) };
}

/**
 * ModalInput → Block Kit input 블록 (순수). 라벨·placeholder 는 봇이 만든 정적 문자열이라
 * 마스킹 대상이 아니다(사용자 입력은 제출 payload 로 들어오고, 그 영속화·게시가 마스킹 경계다).
 */
export function modalInputToBlock(input: ModalInput): ModalInputBlockArg {
  const placeholder =
    input.placeholder !== undefined
      ? { placeholder: { type: "plain_text" as const, text: input.placeholder } }
      : {};
  return {
    type: "input",
    block_id: input.blockId,
    label: { type: "plain_text", text: input.label },
    ...(input.optional !== undefined ? { optional: input.optional } : {}),
    element:
      input.kind === "conversation"
        ? {
            type: "conversations_select",
            action_id: input.actionId,
            ...placeholder,
            ...(input.include ? { filter: { include: input.include } } : {}),
          }
        : {
            type: "plain_text_input",
            action_id: input.actionId,
            multiline: input.multiline,
            ...(input.maxLength !== undefined ? { max_length: input.maxLength } : {}),
            ...placeholder,
          },
  };
}

/** post/update 공용 blocks 조립. sections → actions → markdown 순이고, 셋 다 없으면 생략. */
function buildBlocks(args: {
  block?: { markdown: string } | undefined;
  sections?: readonly SectionButtonBlock[] | undefined;
  actions?: readonly ActionButton[] | undefined;
}): { blocks: BlockElement[] } | Record<string, never> {
  if (args.sections) return { blocks: args.sections.map(sectionToBlock) };
  if (args.actions) return { blocks: [actionsToBlock(args.actions)] };
  if (args.block) {
    return { blocks: [{ type: "markdown", text: maskSecrets(args.block.markdown) }] };
  }
  return {};
}

export interface SlackWebClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: BlockElement[];
    }): Promise<{ ok?: boolean; ts?: string }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: BlockElement[];
    }): Promise<{ ok?: boolean }>;
    getPermalink(args: {
      channel: string;
      message_ts: string;
    }): Promise<{ ok?: boolean; permalink?: string }>;
  };
  /** views.open — 피드백 입력 모달. web-api View 타입에 구조적으로 맞는 정밀 형태만 보낸다. */
  views: {
    open(args: { trigger_id: string; view: ModalViewArg }): Promise<{ ok?: boolean }>;
  };
  /**
   * chat.startStream/appendStream/stopStream 를 감싼 ChatStreamer 생성(plan 카드 스트리밍).
   * 채널 스트리밍이면 recipient_team_id + recipient_user_id 가 필수(chat.d.ts 명시).
   */
  chatStream(args: {
    channel: string;
    thread_ts?: string;
    recipient_team_id?: string;
    recipient_user_id?: string;
    task_display_mode?: string;
  }): ChatStreamerLike;
  /**
   * assistant.threads.setStatus — assistant 스레드에 처리 중 상태 문구를 띄운다(코스메틱).
   * status="" 로 호출하면 상태가 지워진다. web-api 7.19.0 에 존재(런타임 확인).
   */
  assistant: {
    threads: {
      setStatus(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown>;
    };
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  /** users.info — ID→표시명 해석(manifest 의 users:read 스코프). user 형태 좁히기는 구현부 책임. */
  users: {
    info(args: { user: string }): Promise<{ ok?: boolean; user?: unknown }>;
  };
  conversations: {
    // messages 는 unknown[] — web-api 의 MessageElement 는 인덱스 시그니처가 없어
    // Record 로 받으면 실제 WebClient 가 구조적으로 불일치한다. 좁히기는 구현부 책임.
    replies(args: {
      channel: string;
      ts: string;
      oldest?: string;
      limit?: number;
    }): Promise<{ ok?: boolean; messages?: unknown[] }>;
    // 좀비 probe 의 채널 top-level 유실 조회(RS-01). oldest 이후만.
    history(args: {
      channel: string;
      oldest?: string;
      limit?: number;
    }): Promise<{ ok?: boolean; messages?: unknown[] }>;
    /**
     * 채널 메타(멤버십·공개 여부·이름) — slack_read 의 멤버십 게이트 근거(매니페스트의
     * channels:read·groups:read·im:read 스코프). channel 은 unknown 으로 받는다: web-api 의
     * Channel 타입은 인덱스 시그니처가 없어 Record 로 받으면 실제 WebClient 가 구조적으로
     * 불일치한다(replies 의 messages 와 같은 이유) — 좁히기는 구현부 책임.
     */
    info(args: { channel: string }): Promise<{ ok?: boolean; channel?: unknown }>;
    /** 채널 멤버 ID 목록(페이지네이션) — 비공개 채널에서 "요청자도 멤버인가" 판정에 쓴다. */
    members(args: { channel: string; limit?: number; cursor?: string }): Promise<{
      ok?: boolean;
      members?: string[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

export interface ThreadMessageRecord {
  ts: string;
  user: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
}

/** 스레드 읽기 포트 — chat 잡의 증분 컨텍스트(SC-02) 입력. 쓰기 포트(SlackPort)와 분리 주입. */
export interface ThreadReader {
  fetchThreadMessages(args: {
    channel: string;
    threadTs: string;
    limit?: number;
  }): Promise<ThreadMessageRecord[]>;
}

/**
 * 채널 메타 — slack_read 멤버십 게이트가 보는 전부다(원본 Channel 객체를 세션 쪽으로
 * 흘리지 않는다). DM/그룹DM 은 `is_member` 를 주지 않으므로 isMember=false 로 온다 —
 * 게이트가 im/mpim 을 멤버십보다 먼저 판정하는 이유다(slackRead.ts decideSlackReadAccess).
 */
export interface SlackChannelInfo {
  /** `#` 없는 채널명. DM 은 null. */
  name: string | null;
  /** 봇이 이 채널의 멤버인가(conversations.info 의 is_member). */
  isMember: boolean;
  isPrivate: boolean;
  isIm: boolean;
  isMpim: boolean;
}

/**
 * 채널 메타·멤버십 조회 포트 — 조회 게이트 전용. 두 메서드 모두 **절대 throw 하지 않는다**:
 * 실패는 "볼 수 없다"(null) / "멤버가 아니다"(false)로 강등한다. 게이트의 실패 방향이 곧
 * 거부여야 하므로 예외로 새는 경로를 두지 않는다(userDirectory 의 흡수 규율과 같은 정신).
 */
export interface ChannelInfoReader {
  fetchChannelInfo(channel: string): Promise<SlackChannelInfo | null>;
  isChannelMember(args: { channel: string; userId: string }): Promise<boolean>;
}

/** 유저 표시명 조회 포트 — userDirectory 가 캐시를 얹어 소비한다 (EG-08). */
export interface UserReader {
  /** 표시명. 조회 실패는 throw — 흡수·폴백은 userDirectory 의 책임이다. */
  fetchUserName(userId: string): Promise<string | null>;
}

export type ChatSlackPort = SlackPort & ThreadReader & UserReader & ChannelInfoReader;

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (Slack API 부작용)
// ────────────────────────────────────────────────────────────────────

/** 스레드 조회 상한 — 선행 구현의 200 계승(그 이상은 컨텍스트 예산이 먼저 깨진다). */
export const THREAD_FETCH_LIMIT_DEFAULT = 200;

/** conversations.members 한 페이지 크기(Slack 기본 상한과 같다). */
export const CHANNEL_MEMBERS_PAGE_SIZE = 1_000;
/** 멤버 스캔 페이지 상한 — 초과하면 "멤버 아님"으로 판정한다(거부가 안전한 방향). */
export const CHANNEL_MEMBERS_MAX_PAGES = 3;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * plan/task chunk 의 사용자 노출 문자열(text/title)에 maskSecrets 를 적용한다(SEC-11).
 * chunk 는 이미 agentStream 이 240자 클램프·zod 검증을 마쳤으므로 여기선 마스킹만 한다.
 */
function maskChunk(chunk: Chunk): Chunk {
  switch (chunk.type) {
    case "markdown_text":
      return { ...chunk, text: maskSecrets(chunk.text) };
    case "plan_update":
      return { ...chunk, title: maskSecrets(chunk.title) };
    case "task_update":
      return { ...chunk, title: maskSecrets(chunk.title) };
  }
}

export function createSlackPort(
  client: SlackWebClientLike,
  deps: { log?: (msg: string) => void } = {},
): ChatSlackPort {
  const log = deps.log ?? (() => {});

  return {
    async postMessage(args) {
      // markdown/section 블록·text 모두 egress 이므로 maskSecrets 를 거친다(SEC-11 — 이 포트가 마스킹 경계).
      const res = await client.chat.postMessage({
        channel: args.channel,
        text: maskSecrets(args.text),
        ...(args.threadTs !== undefined ? { thread_ts: args.threadTs } : {}),
        ...buildBlocks(args),
      });
      if (!res.ts) {
        // ts 없는 성공은 후속 update/리액션 배선을 전부 깨뜨린다 — 조용히 지나가면 안 된다
        throw new Error(`chat.postMessage 응답에 ts 없음 — channel=${args.channel}`);
      }
      return { ts: res.ts };
    },

    async updateMessage(args) {
      await client.chat.update({
        channel: args.channel,
        ts: args.ts,
        text: maskSecrets(args.text),
        ...buildBlocks(args),
      });
    },

    async addReaction(args) {
      await client.reactions.add({ channel: args.channel, timestamp: args.ts, name: args.name });
    },

    async removeReaction(args) {
      await client.reactions.remove({ channel: args.channel, timestamp: args.ts, name: args.name });
    },

    async fetchPermalink(args) {
      const res = await client.chat.getPermalink({ channel: args.channel, message_ts: args.ts });
      if (!res.permalink) {
        throw new Error(`chat.getPermalink 실패 — channel=${args.channel} ts=${args.ts}`);
      }
      return res.permalink;
    },

    async openView(args) {
      // 모달 텍스트는 봇이 만든 정적 라벨뿐이라 마스킹 불필요 — 사용자 입력은 제출 payload 로
      // 들어오고, 그 영속화(writeFeedbackNote)가 maskSecrets 경계다.
      const view = args.view;
      await client.views.open({
        trigger_id: args.triggerId,
        view: {
          type: "modal",
          callback_id: view.callbackId,
          private_metadata: view.privateMetadata,
          title: { type: "plain_text", text: view.title },
          submit: { type: "plain_text", text: view.submitLabel },
          close: { type: "plain_text", text: "취소" },
          blocks: view.inputs.map(modalInputToBlock),
        },
      });
    },

    createStream(args: CreateStreamArgs): ChatStreamHandle {
      // ChatStreamer 생성 — 실제 네트워크는 첫 append 에서 일어난다. 생성 자체 예외(권한/토큰)는
      // 여기서 throw 되고, 첫 append 예외는 append 에서 throw 된다. 둘 다 호출부가 폴백 판정에 쓴다.
      const streamer = client.chatStream({
        channel: args.channel,
        ...(args.threadTs !== undefined ? { thread_ts: args.threadTs } : {}),
        ...(args.recipientTeamId ? { recipient_team_id: args.recipientTeamId } : {}),
        ...(args.recipientUserId !== undefined ? { recipient_user_id: args.recipientUserId } : {}),
        task_display_mode: "plan",
      });
      // ChatStreamer 호출 직렬화 — 겹치면 스트림 메시지가 둘로 갈라진다.
      //
      // web-api chat-stream.js 의 flush 는 `if (!this.streamTs) { await startStream(); this.streamTs = ... }`
      // 라 잠금이 없다: 첫 startStream 이 아직 응답 전이면 뒤이은 flush 도 streamTs 를 못 보고
      // 자기 startStream 을 친다 → 메시지 2개. 실사고(2026-07-28): 본문 없이 plan 블록만 달린
      // 카드가 스레드에 남고(Slack 폴백 문구 "This message contains interactive elements.")
      // 실제 답변은 그 다음 메시지로 갔다. 진행 chunk append 는 드라이버가 fire-and-forget 으로
      // 흘리므로(진행 표시가 답변을 막으면 안 된다) 겹침은 구조적으로 발생한다 — 순서를 여기서 잡는다.
      let chain: Promise<unknown> = Promise.resolve();
      const serial = <T>(op: () => Promise<T>): Promise<T> => {
        const run = chain.then(op, op);
        // 앞선 호출의 실패가 뒤 호출을 막지 않게 체인은 항상 성공으로 이어붙인다
        // (개별 실패는 아래 await 를 통해 호출부가 그대로 받는다).
        chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      };

      return {
        async appendChunks(chunks: Chunk[]) {
          if (chunks.length === 0) return;
          await serial(() => streamer.append({ chunks: chunks.map(maskChunk) }));
        },
        async appendText(markdown: string) {
          const masked = maskSecrets(markdown);
          if (!masked) return;
          await serial(() => streamer.append({ markdown_text: masked }));
        },
        async stop(o) {
          await serial(() =>
            streamer.stop(
              o?.markdownText !== undefined ? { markdown_text: maskSecrets(o.markdownText) } : {},
            ),
          );
        },
        ts() {
          // 첫 flush(startStream) 전엔 undefined — 그 전이면 뜬 카드가 없으니 정리할 것도 없다.
          return streamer.ts;
        },
      };
    },

    async setAssistantStatus(args) {
      // 상태 표시는 코스메틱 — 실패해도 응답 성패와 무관하므로 절대 throw 하지 않는다(best-effort).
      // status 도 egress 이므로 maskSecrets 를 거친다(SEC-11). status="" 는 마스킹 후에도 "".
      try {
        await client.assistant.threads.setStatus({
          channel_id: args.channel,
          thread_ts: args.threadTs,
          status: maskSecrets(args.status),
        });
      } catch (err) {
        log(
          `assistant.threads.setStatus 실패(무시) channel=${args.channel} ts=${args.threadTs}: ${String(err)}`,
        );
      }
    },

    async fetchThreadMessages(args) {
      // 조회 실패는 빈 컨텍스트로 강등 — 스레드 조회가 안 된다고 응답 자체를 포기하지 않는다 (선행 구현 계승)
      let messages: unknown[];
      try {
        const res = await client.conversations.replies({
          channel: args.channel,
          ts: args.threadTs,
          limit: args.limit ?? THREAD_FETCH_LIMIT_DEFAULT,
        });
        messages = res.messages ?? [];
      } catch (err) {
        log(
          `conversations.replies 실패 channel=${args.channel} ts=${args.threadTs}: ${String(err)}`,
        );
        return [];
      }
      const out: ThreadMessageRecord[] = [];
      for (const m of messages) {
        if (!isRecord(m)) continue;
        const ts = asString(m.ts);
        if (!ts) continue;
        out.push({
          ts,
          user: asString(m.user),
          botId: asString(m.bot_id),
          subtype: asString(m.subtype),
          text: typeof m.text === "string" ? m.text : "",
        });
      }
      return out;
    },

    async fetchChannelInfo(channel) {
      // 조회 실패(봇이 없는 채널·미지의 ID·스코프 부족)는 null = "볼 수 없다" — 게이트의 거부 방향이다.
      try {
        const res = await client.conversations.info({ channel });
        if (!isRecord(res.channel)) {
          log(`conversations.info 응답에 channel 없음 channel=${channel}`);
          return null;
        }
        const ch = res.channel;
        return {
          name: asString(ch.name),
          isMember: ch.is_member === true,
          isPrivate: ch.is_private === true,
          isIm: ch.is_im === true,
          isMpim: ch.is_mpim === true,
        };
      } catch (err) {
        log(`conversations.info 실패 channel=${channel}: ${String(err)}`);
        return null;
      }
    },

    async isChannelMember(args) {
      // 페이지 상한을 두고, 못 찾으면 false — 상한을 늘리는 대신 거부로 끝낸다(거대 채널은
      // 대개 공개라 이 경로를 타지 않는다: 이 판정은 비공개 채널에서만 호출된다).
      let cursor: string | undefined;
      for (let page = 0; page < CHANNEL_MEMBERS_MAX_PAGES; page++) {
        try {
          const res = await client.conversations.members({
            channel: args.channel,
            limit: CHANNEL_MEMBERS_PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
          });
          if ((res.members ?? []).includes(args.userId)) return true;
          cursor = res.response_metadata?.next_cursor || undefined;
          if (!cursor) return false;
        } catch (err) {
          log(`conversations.members 실패 channel=${args.channel}: ${String(err)}`);
          return false;
        }
      }
      log(
        `conversations.members 페이지 상한(${CHANNEL_MEMBERS_MAX_PAGES}) 초과 — ` +
          `channel=${args.channel} user=${args.userId} 를 멤버 아님으로 판정한다`,
      );
      return false;
    },

    async fetchUserName(userId) {
      const res = await client.users.info({ user: userId });
      return pickDisplayName(res.user);
    },
  };
}

/**
 * 좀비 probe 용 SlackHistoryPort 어댑터 — conversations.history/replies 를 ProbedMessage 로 매핑.
 *
 * API 실패는 null 을 돌려 "판정 불가"로 강등한다(socketHealth 가 유실 확인 전에는 재연결하지
 * 않게, RS-01). raw 는 원본 메시지 + channel 을 채워 replay 시 normalize 에 그대로 넘긴다(RS-02).
 */
export function createSlackHistoryPort(
  client: Pick<SlackWebClientLike, "conversations">,
  deps: { log?: (msg: string) => void } = {},
): SlackHistoryPort {
  const log = deps.log ?? (() => {});

  const toProbed = (m: unknown, channel: string): ProbedMessage | null => {
    if (!isRecord(m)) return null;
    const ts = asString(m.ts);
    if (!ts) return null;
    return {
      ts,
      channel,
      botId: asString(m.bot_id),
      subtype: asString(m.subtype),
      raw: m,
    };
  };

  return {
    async conversationsHistory({ channel, oldest, limit }) {
      try {
        const res = await client.conversations.history({ channel, oldest, limit });
        const out: ProbedMessage[] = [];
        for (const m of res.messages ?? []) {
          const p = toProbed(m, channel);
          if (p) out.push(p);
        }
        return out;
      } catch (err) {
        log(`probe conversations.history 실패 (${channel}): ${String(err)}`);
        return null;
      }
    },
    async conversationsReplies({ channel, ts, oldest, limit }) {
      try {
        const res = await client.conversations.replies({ channel, ts, oldest, limit });
        const out: ProbedMessage[] = [];
        for (const m of res.messages ?? []) {
          const p = toProbed(m, channel);
          if (p) out.push(p);
        }
        return out;
      } catch (err) {
        log(`probe conversations.replies 실패 (${channel}:${ts}): ${String(err)}`);
        return null;
      }
    },
  };
}
