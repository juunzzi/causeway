/**
 * egress 테스트 전용 가짜 SlackPort — 호출 순서와 인자를 기록한다.
 * 제약: 프로덕션 코드에서 import 금지 (테스트 colocation 지원 파일).
 */

import type { Chunk } from "../slack/agentStream.js";
import type { ChatStreamHandle, CreateStreamArgs, MarkdownBlock, SlackPort } from "./ports.js";

export interface RecordedCall {
  kind:
    | "post"
    | "update"
    | "addReaction"
    | "removeReaction"
    | "streamCreate"
    | "streamChunks"
    | "streamText"
    | "streamStop"
    | "setStatus"
    | "openView";
  channel: string;
  ts?: string;
  threadTs?: string;
  text?: string;
  name?: string;
  /** setStatus 시 넘어온 상태 문구(빈 문자열이면 clear). */
  status?: string;
  /** streamCreate 시 넘어온 recipient/planTitle. */
  createArgs?: CreateStreamArgs;
  /** streamChunks 시 넘어온 chunk 배열. */
  chunks?: Chunk[];
  /** post/update 시 넘어온 markdown 블록(EG-10) — 있으면 GFM 블록 게시. */
  block?: MarkdownBlock;
}

export interface FakeSlack {
  slack: SlackPort;
  calls: RecordedCall[];
  /** 이 ts 로의 updateMessage 는 실패한다 (msg_too_long 모사). */
  failUpdateTs: Set<string>;
  /** true 면 postMessage 가 실패한다. */
  failPost: { value: boolean };
  /** true 면 리액션 add/remove 가 실패한다. */
  failReactions: { value: boolean };
  /** "create": createStream 자체가 throw / "append": 첫 appendChunks 가 throw. null 이면 정상. */
  failStream: { value: "create" | "append" | null };
  /** true 면 스트림 handle.stop() 이 throw (appendText 성공 후 stop 실패 모사). */
  failStreamStop: { value: boolean };
  /**
   * "dead" 면 handle.appendText() 가 message_not_in_streaming_state 로 throw — 죽은 plan 스트림에
   * 최종 답변을 못 싣는 실사고를 모사한다(A 버그). 이때 handle.ts() 는 이미 정의돼(첫 chunk flush)
   * 프리즌 카드가 UI 에 얼어붙어 있는 상태다. null 이면 정상.
   */
  failStreamAppendText: { value: "dead" | null };
  /** "dead" 면 handle.stop() 이 message_not_in_streaming_state 로 throw — 죽은 스트림 stop 실패 모사. */
  failStreamStopDead: { value: boolean };
}

/** web-api 가 죽은 스트림에 append/stop 할 때 던지는 실제 메시지 형태(2026-07-22 실로그). */
const STREAM_DEAD_ERROR = "An API error occurred: message_not_in_streaming_state";

export function makeFakeSlack(): FakeSlack {
  const calls: RecordedCall[] = [];
  const failUpdateTs = new Set<string>();
  const failPost = { value: false };
  const failReactions = { value: false };
  const failStream: { value: "create" | "append" | null } = { value: null };
  const failStreamStop = { value: false };
  const failStreamAppendText: { value: "dead" | null } = { value: null };
  const failStreamStopDead = { value: false };
  let tsCounter = 0;

  const slack: SlackPort = {
    async postMessage(args) {
      calls.push({
        kind: "post",
        channel: args.channel,
        threadTs: args.threadTs,
        text: args.text,
        ...(args.block ? { block: args.block } : {}),
      });
      if (failPost.value) throw new Error("post_failed");
      tsCounter += 1;
      return { ts: `100${tsCounter}.000` };
    },
    async updateMessage(args) {
      calls.push({
        kind: "update",
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ...(args.block ? { block: args.block } : {}),
      });
      if (failUpdateTs.has(args.ts)) throw new Error("msg_too_long");
    },
    async addReaction(args) {
      calls.push({ kind: "addReaction", channel: args.channel, ts: args.ts, name: args.name });
      if (failReactions.value) throw new Error("reaction_failed");
    },
    async removeReaction(args) {
      calls.push({ kind: "removeReaction", channel: args.channel, ts: args.ts, name: args.name });
      if (failReactions.value) throw new Error("reaction_failed");
    },
    async fetchPermalink(args) {
      return `https://OWNER.slack.com/archives/${args.channel}/p${args.ts.replace(".", "")}`;
    },
    async openView(args) {
      // 모달은 채널이 없다 — kind 로만 식별하고 view 식별자를 text 자리에 남긴다.
      calls.push({ kind: "openView", channel: "", text: args.view.callbackId });
    },
    async setAssistantStatus(args) {
      // 코스메틱 — best-effort. 프로덕션과 동일하게 실패해도 throw 하지 않는다(여기선 항상 성공).
      calls.push({
        kind: "setStatus",
        channel: args.channel,
        threadTs: args.threadTs,
        status: args.status,
      });
    },
    createStream(args) {
      calls.push({ kind: "streamCreate", channel: args.channel, createArgs: args });
      if (failStream.value === "create") throw new Error("stream_create_failed");
      let appended = 0;
      // 첫 flush(append) 전엔 undefined — 그 뒤엔 startStream 이 만든 카드 ts 를 흉내낸다.
      let streamTs: string | undefined;
      const ensureStreamTs = (): void => {
        if (streamTs === undefined) {
          tsCounter += 1;
          streamTs = `900${tsCounter}.000`;
        }
      };
      const handle: ChatStreamHandle = {
        async appendChunks(chunks) {
          appended += 1;
          // 첫 chunk flush 가 startStream(카드 생성) — ts 가 여기서 정해진다.
          ensureStreamTs();
          calls.push({ kind: "streamChunks", channel: args.channel, chunks });
          // "append" 모드는 첫 append 만 실패시켜 폴백 강등 경로를 유도한다.
          if (failStream.value === "append" && appended === 1) throw new Error("invalid_blocks");
        },
        async appendText(markdown) {
          // 죽은 스트림이면 카드는 이미 떠(ts 정의) 있고 append 만 거절된다 — ts 를 지우지 않는다.
          if (failStreamAppendText.value === "dead") throw new Error(STREAM_DEAD_ERROR);
          ensureStreamTs();
          calls.push({ kind: "streamText", channel: args.channel, text: markdown });
        },
        async stop(o) {
          calls.push({ kind: "streamStop", channel: args.channel, text: o?.markdownText });
          if (failStreamStopDead.value) throw new Error(STREAM_DEAD_ERROR);
          if (failStreamStop.value) throw new Error("stop_failed");
        },
        ts() {
          return streamTs;
        },
      };
      return handle;
    },
  };

  return {
    slack,
    calls,
    failUpdateTs,
    failPost,
    failReactions,
    failStream,
    failStreamStop,
    failStreamAppendText,
    failStreamStopDead,
  };
}

export function callsOf(fake: FakeSlack, kind: RecordedCall["kind"]): RecordedCall[] {
  return fake.calls.filter((c) => c.kind === kind);
}

export function mustGet<T>(arr: readonly T[], index: number): T {
  const v = arr[index];
  if (v === undefined) throw new Error(`index ${index} 가 없습니다 (length=${arr.length})`);
  return v;
}
