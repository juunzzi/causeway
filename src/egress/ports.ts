/**
 * Slack 송신 포트 — egress 가 의존하는 유일한 Slack 인터페이스.
 *
 * 제약: 구현(실제 WebClient 배선)은 chat 배선 PR 의 몫이다. egress 는 이 인터페이스만
 * 주입받아 동작해야 테스트에서 가짜 포트로 파이프라인 전체를 검증할 수 있다 (EG-01, OPS-07).
 */

import type { Chunk } from "../slack/agentStream.js";

/**
 * 죽은 plan 스트림 판별 — Slack 스트리밍 창이 만료됐거나 이미 stop 된 스트림에 append/stop 하면
 * `An API error occurred: message_not_in_streaming_state` 를 던진다(2026-07-22 실사고). 이때는
 * 스트림 API 로는 카드를 못 닫으므로, 호출부가 일반 chat.update 로 프리즌 카드를 정리해야 한다(A 버그).
 *
 * 에러 메시지 문자열을 본다: web-api 는 `An API error occurred: <code>` 형태로 던지고, 실로그도
 * 이 형태였다. .data.error 접근보다 메시지 매칭이 심(fake) 주입과 실환경 모두에 견고하다.
 */
export const STREAM_DEAD_RE = /message_not_in_streaming_state/i;

export function isStreamDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return STREAM_DEAD_RE.test(msg);
}

/**
 * markdown 블록 게시 인자 — GFM 원본을 `blocks:[{type:"markdown", text}]` 로 실어 표·헤더·링크를
 * Slack 이 네이티브 렌더하게 한다(EG-10). text 는 알림 클라이언트/폴백용 요약이다 — blocks 를 못
 * 읽는 클라이언트(푸시 알림 등)가 빈 알림을 받지 않도록 함께 넣는다(Slack 권장).
 *
 * 제약: markdown 블록 경로는 mrkdwn 변환을 거치지 않는다(GFM 그대로). blocks 를 넘기면 최종 렌더는
 * blocks 가 담당하고 text 는 알림용으로만 쓰인다.
 */
export interface MarkdownBlock {
  markdown: string;
  /** 알림/폴백용 요약(푸시 알림이 비지 않게). Slack blocks 게시 시 text 필드로 들어간다. */
  notificationText: string;
}

/**
 * 버튼 하나. section 의 accessory 로도, actions 줄의 원소로도 쓰인다. value 는 결정론
 * 식별자(규칙 해시·스레드 참조)만 싣는다. 자유 텍스트를 왕복시키면 그게 곧 주입 표면이다.
 */
export interface ActionButton {
  label: string;
  /** block_actions 라우팅 키 — 리스너의 app.action(actionId) 과 정합해야 한다. */
  actionId: string;
  /** 클릭 payload 로 돌아오는 값(≤2,000자) — 규칙 해시 등 결정론 식별자만. */
  value: string;
  style?: "primary" | "danger";
}

/**
 * section + 우측 accessory 버튼 1개 — 피드백 회고 통보의 "규칙별 제거 버튼" 이 유일한 사용처다.
 * text 는 mrkdwn(변환은 호출부 몫)이다. 버튼마다 설명 한 줄이 필요한 목록형 UI 용이고,
 * 설명 없이 버튼만 나란히 놓을 자리에는 `actions` 를 쓴다.
 */
export interface SectionButtonBlock {
  /** section 본문(mrkdwn). 3,000자 제한은 포트가 클립한다. */
  text: string;
  /** 우측 accessory 버튼 — 미지정이면 버튼 없는 일반 section. */
  button?: ActionButton;
}

export interface PostMessageArgs {
  channel: string;
  text: string;
  /** 스레드 답글이면 부모 ts. */
  threadTs?: string;
  /**
   * 지정 시 본문을 `markdown` 블록으로 게시한다(GFM 네이티브 렌더). text 는 알림용 폴백으로 남는다.
   * 미지정이면 기존 text 경로(짧은 상수 안내 등).
   */
  block?: MarkdownBlock;
  /** 지정 시 section(+버튼) 블록 배열로 게시한다 — block 과 동시 지정 금지(sections 우선). */
  sections?: readonly SectionButtonBlock[];
  /**
   * 지정 시 버튼만 담은 `actions` 블록 하나로 게시한다. 버튼이 한 줄에 나란히 놓인다.
   * 버튼마다 설명 줄이 필요하면 sections 를 쓴다. 둘 다 주면 sections 가 이긴다.
   */
  actions?: readonly ActionButton[];
}

export interface UpdateMessageArgs {
  channel: string;
  ts: string;
  text: string;
  /** 지정 시 chat.update 를 `markdown` 블록으로 교체한다(진행 카드 자리 → GFM 최종 답변). */
  block?: MarkdownBlock;
  /** 지정 시 section(+버튼) 블록 배열로 교체한다 — 버튼 메시지의 사후 갱신(제거 반영). */
  sections?: readonly SectionButtonBlock[];
}

export interface ReactionArgs {
  channel: string;
  ts: string;
  /** 콜론 없는 이모지 이름 (예: "hourglass_flowing_sand"). */
  name: string;
}

export interface FetchPermalinkArgs {
  channel: string;
  ts: string;
}

export interface CreateStreamArgs {
  channel: string;
  /** 스레드 답글이면 부모 ts. */
  threadTs?: string;
  /**
   * 채널 스트리밍에서 recipient_team_id + recipient_user_id 는 필수다(web-api chat.d.ts 명시).
   * DM 이 아닌 채널에 plan 카드를 흘리려면 항상 넘긴다. userId 는 chat 잡 payload,
   * teamId 는 부팅 auth.test 의 team_id.
   */
  recipientUserId?: string;
  recipientTeamId?: string | null;
  /** plan 카드 헤더 제목. */
  planTitle?: string;
}

/**
 * chat.startStream/appendStream/stopStream(ChatStreamer)을 감싼 스트리밍 핸들.
 *
 * append/stop 은 ChatStreamer 에 위임하되, 모든 텍스트/타이틀은 구현부에서 maskSecrets 를
 * 거친다(SEC-11 — plan 카드도 egress 이므로 마스킹 대상). appendChunks 는 agentStream 의
 * task/plan chunk 를, appendText 는 최종 답변 본문(GFM markdown_text)을 흘린다.
 */
export interface ChatStreamHandle {
  appendChunks(chunks: Chunk[]): Promise<void>;
  appendText(markdown: string): Promise<void>;
  stop(opts?: { markdownText?: string }): Promise<void>;
  /**
   * plan 카드 메시지 ts — chat.startStream(첫 flush) 이후에만 정해지고 그 전엔 undefined.
   * 스트림이 죽어(message_not_in_streaming_state) stop 으로 못 닫을 때, 이 ts 를 일반
   * chat.update 로 깔끔한 종결 상태로 교체해 "interactive elements" 프리즌 카드가 UI 에
   * 얼어붙는 것을 막는 데 쓴다(A 버그). undefined 면 아직 카드가 뜬 적 없으니 정리할 것도 없다.
   */
  ts(): string | undefined;
}

/**
 * 모달 텍스트 입력 1개 — Block Kit input 블록으로 매핑되며, Slack 기본이 required 라
 * 빈 제출은 클라이언트가 막는다(optional: true 로 뒤집을 수 있다).
 */
export interface ModalTextInput {
  kind: "text";
  blockId: string;
  actionId: string;
  label: string;
  multiline: boolean;
  maxLength?: number;
  placeholder?: string;
  /** true 면 빈 제출 허용(Slack input 블록 optional). 미지정이면 필수. */
  optional?: boolean;
}

/**
 * 대화(채널/DM) 선택 — Slack 이 그린 채널 피커를 그대로 띄운다. DM 전달의 게시처가 이 입력으로
 * 정해지는데, 그 값을 자유 텍스트로 받으면 `#채널명`→ID 해석이 필요하고 오타가 조용히 다른 곳으로
 * 가는 경로가 생긴다. 피커는 **사람이 실재하는 대화를 고르고 Slack 이 ID 를 돌려주므로** 그 경로가
 * 아예 없다(모델도 프롬프트도 개입하지 않는다 — 버튼 경로가 화이트리스트 없이 안전한 근거다).
 */
export interface ModalConversationSelect {
  kind: "conversation";
  blockId: string;
  actionId: string;
  label: string;
  placeholder?: string;
  optional?: boolean;
  /**
   * 목록에 띄울 대화 종류. Slack 의 conversations_select 는 **보는 사람 기준**으로 목록을
   * 만든다 — 봇 멤버십으로 거를 방법이 없으므로, 봇이 없는 채널을 고르는 것은 막지 못하고
   * 게시 시점의 `not_in_channel` 로만 드러난다(호출부가 그 안내를 책임진다).
   */
  include?: ("public" | "private")[];
}

export type ModalInput = ModalTextInput | ModalConversationSelect;

/** views.open 모달 정의(최소형) — title 은 Slack 제한 24자 이내여야 한다. */
export interface ModalView {
  /** view_submission 라우팅 키 — 리스너의 app.view(callbackId) 와 정합해야 한다. */
  callbackId: string;
  title: string;
  submitLabel: string;
  /** 제출 payload 로 돌아오는 은닉 문자열(≤3,000자) — 출처 스레드 참조 등 결정론 값만. */
  privateMetadata: string;
  inputs: readonly ModalInput[];
}

export interface OpenViewArgs {
  /** block_actions payload 의 trigger_id — 발급 3초 안에 써야 한다. */
  triggerId: string;
  view: ModalView;
}

export interface SlackPort {
  postMessage(args: PostMessageArgs): Promise<{ ts: string }>;
  updateMessage(args: UpdateMessageArgs): Promise<void>;
  addReaction(args: ReactionArgs): Promise<void>;
  removeReaction(args: ReactionArgs): Promise<void>;
  fetchPermalink(args: FetchPermalinkArgs): Promise<string>;
  /** 모달 열기(views.open) — 피드백 입력 모달. trigger_id 만료 등 실패는 throw(호출부 로그). */
  openView(args: OpenViewArgs): Promise<void>;
  /**
   * plan 카드 스트리밍 생성 — client.chatStream 을 감싼 ChatStreamHandle 반환.
   * 생성 실패(앱이 아직 assistant 가 아님·invalid_blocks 등)는 throw 로 알리고, 호출부가
   * 진행 카드(chat.update) 경로로 강등한다.
   */
  createStream(args: CreateStreamArgs): ChatStreamHandle;
  /**
   * Slack assistant 스레드 상태(assistant.threads.setStatus) 설정 — "분석 중… · sonnet" 같은
   * 코스메틱 표시. status="" 로 호출하면 상태를 지운다. 실패해도 절대 throw 하지 않는다
   * (best-effort — 상태 표시는 응답 성패와 무관하므로 실패는 로그만 남기고 삼킨다).
   */
  setAssistantStatus(args: { channel: string; threadTs: string; status: string }): Promise<void>;
}
