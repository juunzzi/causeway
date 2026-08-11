/**
 * Slack 최종 게시 — mask → mrkdwn → mentionGuard → chunk → post 파이프라인 강제 (EG-01).
 *
 * 이 파일이 봇의 유일한 Slack 본문 게시 경로다. 어떤 세션 프로파일에도 Slack 쓰기
 * 도구를 주지 않는 규약과 한 세트 — 게시 책임은 여기로 일원화된다.
 */

import { maskSecrets } from "../security/maskSecrets.js";
import { splitForSlack } from "./chunker.js";
import { splitMarkdownBlocks } from "./mdBlockChunker.js";
import { guardMentions } from "./mentionGuard.js";
import { mdToMrkdwn, unwrapFullCodeBlock } from "./mrkdwn.js";
import type { MarkdownBlock, SlackPort } from "./ports.js";

// ── 순수 함수부 ─────────────────────────────────────────────────────────────

export interface OutboundOptions {
  /** 멘션 알림이 허용되는 유저 (요청자 등). 생략 시 모든 멘션이 평문화된다. */
  allowedMentionUserIds?: readonly string[];
  nameByUserId?: ReadonlyMap<string, string>;
}

export interface OutboundBuild {
  chunks: string[];
  blockedMentions: string[];
}

/**
 * 제약: 파이프라인 순서 고정 — mask 가 최우선(변환이 시크릿 문자열을 쪼개기 전에),
 * chunk 가 최후(마킹·변환·평문화로 길이가 확정된 뒤에 분할해야 경계가 안 흔들린다).
 */
export function buildOutboundChunks(text: string, opts: OutboundOptions = {}): OutboundBuild {
  const masked = maskSecrets(text);
  const converted = mdToMrkdwn(masked);
  const guarded = guardMentions(converted, {
    allowedUserIds: opts.allowedMentionUserIds ?? [],
    nameByUserId: opts.nameByUserId,
  });
  const blockedMentions = [
    ...guarded.blockedUserIds,
    ...guarded.blockedBroadcasts.map((b) => `!${b}`),
  ];

  if (!guarded.text.trim()) return { chunks: [], blockedMentions };

  const parts = splitForSlack(guarded.text);
  const total = parts.length;
  const chunks = parts.map((chunk, idx) => {
    if (total === 1) return chunk;
    const i = idx + 1;
    // 여러 답글로 나뉠 때 어느 답글이 끝인지 보이도록 연속 표시
    const marker = i < total ? `\n_(이어집니다 ↓ ${i}/${total})_` : `\n_(${i}/${total} 끝)_`;
    return chunk + marker;
  });
  return { chunks, blockedMentions };
}

// ── markdown 블록 파이프라인 (EG-10) ─────────────────────────────────────────

/** markdown 블록 청크 — GFM 본문 + 그 청크의 알림/폴백용 요약(text). */
export interface MarkdownChunk extends MarkdownBlock {}

export interface MarkdownBuild {
  chunks: MarkdownChunk[];
  blockedMentions: string[];
}

/** GFM 링크·표·굵게 마크업을 걷어낸 평문 요약 — 푸시 알림이 빈 텍스트로 뜨지 않게. */
export function toNotificationText(markdown: string, limit = 200): string {
  let t = markdown
    .replace(/```[\s\S]*?```/g, " ") // 코드블록 통째 제거
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [텍스트](url) → 텍스트
    .replace(/[#>|`*_~-]/g, " ") // 헤더/표/강조/불릿 마크업 제거
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > limit) t = `${t.slice(0, limit - 1).trimEnd()}…`;
  return t;
}

/**
 * markdown 블록 게시용 청크 빌드 — GFM 원본을 보존한다(mdToMrkdwn 변환하지 않는다, EG-10).
 *
 * 파이프라인: mask → (전체 ``` 감싸기 벗기기) → mentionGuard → splitMarkdownBlocks.
 * mrkdwn 경로와 달리 GFM 을 그대로 Slack markdown 블록에 실어 표·헤더·링크를 네이티브 렌더한다.
 * 멘션은 여전히 게이트한다 — markdown 블록에서도 <@U> 오멘션 알림 위험은 동일하기 때문이다.
 *
 * 제약: 전체를 ``` 로 감싼 입력은 벗긴다(팀 규칙 SK — inline-snippet 접힘 방지). 분할 marker 는
 * 붙이지 않는다 — 표/코드 경계로 자연 분할되므로 "이어집니다" 꼬리가 표 뒤에 붙어 렌더를 흔드는
 * 것을 피하고, 대신 각 청크가 독립적으로 유효한 GFM 이 되게 한다.
 */
export function buildMarkdownBlockChunks(text: string, opts: OutboundOptions = {}): MarkdownBuild {
  const masked = maskSecrets(text);
  const unwrapped = unwrapFullCodeBlock(masked);
  const guarded = guardMentions(unwrapped, {
    allowedUserIds: opts.allowedMentionUserIds ?? [],
    nameByUserId: opts.nameByUserId,
  });
  const blockedMentions = [
    ...guarded.blockedUserIds,
    ...guarded.blockedBroadcasts.map((b) => `!${b}`),
  ];
  if (!guarded.text.trim()) return { chunks: [], blockedMentions };

  const parts = splitMarkdownBlocks(guarded.text);
  const chunks = parts.map((markdown) => ({
    markdown,
    notificationText: toNotificationText(markdown),
  }));
  return { chunks, blockedMentions };
}

// ── 오케스트레이션부 ─────────────────────────────────────────────────────────

export interface PostFinalOptions extends OutboundOptions {
  channel: string;
  threadTs?: string;
  /** 진행 카드 자리 교체 — 첫 chunk 를 이 ts 의 chat.update 로 보낸다. */
  replaceTs?: string;
  /**
   * true 면 최종 답변을 GFM `markdown` 블록으로 게시한다(표·헤더·링크 네이티브 렌더, EG-10) —
   * mdToMrkdwn 변환을 거치지 않고 GFM 원본 그대로 실으며 11,000자 상한으로 표/코드 경계 분할한다.
   * 미지정/false 면 기존 mrkdwn 평문 경로(짧은 상수 안내 등 GFM 이 불필요한 게시).
   */
  asMarkdownBlock?: boolean;
}

/** 게시 단위 — text 는 항상(알림/폴백용), block 이 있으면 markdown 블록으로 렌더된다. */
interface PostUnit {
  text: string;
  block?: MarkdownBlock;
}

/**
 * postFinal 의 두 모드(mrkdwn 평문 / markdown 블록)를 공통 PostUnit 배열로 정규화한다.
 * 오케스트레이션(첫 chunk 교체·나머지 답글·동결 방지)은 이 배열만 보고 동작하므로 모드 분기가
 * 여기 한 곳에 국소화된다.
 */
function buildUnits(
  text: string,
  opts: PostFinalOptions,
): {
  units: PostUnit[];
  blockedMentions: string[];
} {
  if (opts.asMarkdownBlock) {
    const { chunks, blockedMentions } = buildMarkdownBlockChunks(text, opts);
    const units = chunks.map((c) => ({ text: c.notificationText || " ", block: c }));
    return { units, blockedMentions };
  }
  const { chunks, blockedMentions } = buildOutboundChunks(text, opts);
  const units = chunks.map((text) => ({ text }));
  return { units, blockedMentions };
}

export interface PostFinalResult {
  /** 게시(또는 교체)된 메시지 ts 목록 — 첫 항목이 본문 시작. */
  postedTs: string[];
  blockedMentions: string[];
  /** replaceTs 교체가 실패해 새 답글 fallback 을 탔는가. */
  usedFallback: boolean;
}

export interface Poster {
  postFinal(text: string, opts: PostFinalOptions): Promise<PostFinalResult>;
}

/** 진행 카드 동결 방지용 교체 문구 — fallback 시 원 카드가 "작업 중…"으로 남지 않게. */
export const FROZEN_CARD_NOTICE = "✅ 완료 — 답변은 아래 ↓";
export const EMPTY_RESPONSE_NOTICE = "_(빈 응답)_";

export function createPoster(slack: SlackPort, deps: { log?: (msg: string) => void } = {}): Poster {
  const log = deps.log ?? (() => {});

  return {
    async postFinal(text, opts) {
      const { units, blockedMentions } = buildUnits(text, opts);
      const threadTs = opts.threadTs ?? opts.replaceTs;
      const postedTs: string[] = [];
      let usedFallback = false;

      const [first, ...rest] = units;
      if (first === undefined) {
        // 빈 응답이라도 진행 카드는 동결시키지 않는다
        if (opts.replaceTs !== undefined) {
          try {
            await slack.updateMessage({
              channel: opts.channel,
              ts: opts.replaceTs,
              text: EMPTY_RESPONSE_NOTICE,
            });
          } catch (err) {
            // non-empty 경로와 동일한 동결 방지 — 새 답글 fallback 후 원 카드를
            // 완료 안내로 교체. 안내는 본문이 아니므로 postedTs 에는 넣지 않는다.
            usedFallback = true;
            log(`빈 응답 카드 교체 실패 ts=${opts.replaceTs} — 새 답글 fallback: ${String(err)}`);
            await slack.postMessage({
              channel: opts.channel,
              threadTs,
              text: EMPTY_RESPONSE_NOTICE,
            });
            try {
              await slack.updateMessage({
                channel: opts.channel,
                ts: opts.replaceTs,
                text: FROZEN_CARD_NOTICE,
              });
            } catch (noticeErr) {
              log(`동결 방지 안내 교체 실패 ts=${opts.replaceTs}: ${String(noticeErr)}`);
            }
          }
        }
        return { postedTs, blockedMentions, usedFallback };
      }

      if (opts.replaceTs !== undefined) {
        try {
          await slack.updateMessage({
            channel: opts.channel,
            ts: opts.replaceTs,
            text: first.text,
            ...(first.block ? { block: first.block } : {}),
          });
          postedTs.push(opts.replaceTs);
        } catch (err) {
          // chat.update 거절(msg_too_long 등) → 새 답글 fallback. 이마저 실패하면
          // 게시 전체 실패이므로 throw — 잡 핸들러가 ❌ 로 통보할 수 있어야 한다.
          usedFallback = true;
          log(`chat.update 실패 ts=${opts.replaceTs} — 새 답글 fallback: ${String(err)}`);
          const res = await slack.postMessage({
            channel: opts.channel,
            threadTs,
            text: first.text,
            ...(first.block ? { block: first.block } : {}),
          });
          postedTs.push(res.ts);
          try {
            await slack.updateMessage({
              channel: opts.channel,
              ts: opts.replaceTs,
              text: FROZEN_CARD_NOTICE,
            });
          } catch (noticeErr) {
            log(`동결 방지 안내 교체 실패 ts=${opts.replaceTs}: ${String(noticeErr)}`);
          }
        }
      } else {
        const res = await slack.postMessage({
          channel: opts.channel,
          threadTs,
          text: first.text,
          ...(first.block ? { block: first.block } : {}),
        });
        postedTs.push(res.ts);
      }

      for (const unit of rest) {
        try {
          const res = await slack.postMessage({
            channel: opts.channel,
            threadTs,
            text: unit.text,
            ...(unit.block ? { block: unit.block } : {}),
          });
          postedTs.push(res.ts);
        } catch (err) {
          // 일부 chunk 실패는 이미 게시된 앞부분을 무효화하지 않는다 — 기록 후 계속
          log(`chunk 전송 실패 channel=${opts.channel}: ${String(err)}`);
        }
      }

      return { postedTs, blockedMentions, usedFallback };
    },
  };
}
