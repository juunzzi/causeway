/**
 * 진행 카드 — tool 이벤트 카테고리 롤업 + rate-limit 갱신 (EG-02, EG-04).
 *
 * 선행 구현 이식. msg_too_long 으로 chat.update 가 거절되면 "작업 중…" 카드가
 * 영구 동결되는 실사고(팀 메모리 project_progress_msg_too_long)가 truncate 상한의 근거다.
 */

import { CONTRACT } from "../core/constants.js";
import { maskSecrets } from "../security/maskSecrets.js";
import { mdToMrkdwn } from "./mrkdwn.js";
import type { SlackPort } from "./ports.js";
import type { OutboundOptions, Poster, PostFinalResult } from "./poster.js";

// ── 순수 함수부 ─────────────────────────────────────────────────────────────

// 스레드에 노이즈 안 주도록 tool 이름 → 굵은 카테고리로만 롤업
const TOOL_CATEGORY: Readonly<Record<string, string>> = {
  Read: "📖 탐색",
  Grep: "📖 탐색",
  Glob: "📖 탐색",
  WebFetch: "📖 탐색",
  WebSearch: "📖 탐색",
  Edit: "✏ 편집",
  Write: "✏ 편집",
  MultiEdit: "✏ 편집",
  NotebookEdit: "✏ 편집",
  Bash: "⚙ 실행",
  BashOutput: "⚙ 실행",
  KillBash: "⚙ 실행",
  Task: "🔀 위임",
  Agent: "🔀 위임",
  TodoWrite: "🗂 계획",
  ExitPlanMode: "🗂 계획",
};

export function categoryFor(toolName: string): string {
  const known = TOOL_CATEGORY[toolName];
  if (known) return known;
  if (toolName.startsWith("mcp__")) return "🔌 외부";
  return "🛠 기타";
}

/**
 * 카드 표시용 요약 — 백틱은 인라인 코드 표시(`summary`)를 깨므로 치환, 70자 상한은 카드 폭 유지.
 */
export function progressSummary(toolName: string, summary?: string): string {
  return maskSecrets(summary ?? toolName)
    .replaceAll("`", "'")
    .slice(0, 70);
}

/**
 * 워치독 신호(onStep)로 흘리는 스텝 라벨 — "📖 탐색 src/foo.ts" 꼴.
 *
 * 카드 경로(addTool)와 plan 경로(progressDriver.onProgress)가 **같은 문자열**을 내야 한다.
 * 워치독은 이 값의 변화만으로 진행/정체를 가르므로(RS-06), 경로마다 라벨이 다르면 폴백
 * 강등 순간에 값이 튀어 정체 타이머가 헛리셋된다.
 */
export function formatStepLabel(toolName: string, summary?: string): string {
  return `${categoryFor(toolName)} ${progressSummary(toolName, summary)}`;
}

export interface ProgressPhase {
  category: string;
  count: number;
  lastSummary: string;
}

/** 같은 카테고리 연속이면 count 만 증가시키고 summary 는 최신으로 갱신. */
export function rollupPhases(
  phases: readonly ProgressPhase[],
  category: string,
  summary: string,
): ProgressPhase[] {
  const last = phases.at(-1);
  if (last && last.category === category) {
    return [...phases.slice(0, -1), { category, count: last.count + 1, lastSummary: summary }];
  }
  return [...phases, { category, count: 1, lastSummary: summary }];
}

/** 제약: 계속 덮어쓰이는 표시용 truncate — 최종 답변에는 쓰지 말 것(그쪽은 chunk 분할). */
export function truncateForProgress(
  text: string,
  limit: number = CONTRACT.PROGRESS_TRUNCATE_CHARS,
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n… (truncated)`;
}

/**
 * runner 의 onProgress 라인("Bash: pnpm test")을 진행 카드 addTool 인자(tool·summary)로 분해.
 * 첫 ": " 앞이 도구명, 뒤가 요약. 구분자가 없으면 라인 전체를 도구명으로 본다.
 */
export function splitProgressLine(line: string): { tool: string; summary?: string } {
  const idx = line.indexOf(": ");
  if (idx < 0) return { tool: line };
  return { tool: line.slice(0, idx), summary: line.slice(idx + 2) };
}

export function renderProgress(header: string, phases: readonly ProgressPhase[]): string {
  const lines = phases.slice(-8).map((p) => {
    const head = p.count === 1 ? `• ${p.category}` : `• ${p.category} × ${p.count}`;
    return p.lastSummary ? `${head} — \`${p.lastSummary}\`` : head;
  });
  const body = lines.join("\n");
  return truncateForProgress(body ? `${header}\n${body}` : header);
}

// ── 오케스트레이션부 ─────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
}

export interface ProgressCardDeps {
  slack: SlackPort;
  poster: Poster;
  /** 주입 클록 — 테스트에서 rate-limit 을 결정론적으로 검증하기 위한 필수 주입점. */
  clock?: Clock;
  /** watchdog 연동용 — 최근 스텝 문자열을 밖으로 흘린다. */
  onStep?: (step: string) => void;
  log?: (msg: string) => void;
}

export interface ProgressCardOptions {
  channel: string;
  threadTs?: string;
  /** 정적 헤더 (하위호환). headerFn 이 있으면 무시된다. */
  header?: string;
  /**
   * 동적 헤더 — 매 렌더(start·flush)마다 호출해 회전 상태 문구를 얻는다 (EG-02).
   * statusPool.createStatusPicker 를 주로 넘긴다. 미지정 시 정적 header 로 폴백.
   */
  headerFn?: () => string;
  /**
   * 기존 카드 ts 채택 — 있으면 start() 가 새 메시지를 post 하지 않고 이 ts 를 갱신 대상으로 삼는다.
   * 재시도(throw)마다 같은 잡이 새 카드를 만들어 고아/중복 카드가 생기는 것을 막는다 —
   * 첫 attempt 만 post 하고, 이후 attempt 는 이 값으로 같은 카드를 이어 쓴다.
   */
  existingTs?: string;
}

export interface ProgressCard {
  readonly ts: string | undefined;
  start(): Promise<void>;
  addTool(toolName: string, summary?: string, opts?: { forceFlush?: boolean }): Promise<void>;
  /** 최종 답변으로 카드 자리를 교체 — 게시는 poster 파이프라인에 위임한다. */
  finish(finalText: string, opts?: OutboundOptions): Promise<PostFinalResult>;
}

export function createProgressCard(
  deps: ProgressCardDeps,
  opts: ProgressCardOptions,
): ProgressCard {
  const clock = deps.clock ?? { now: () => Date.now() };
  const log = deps.log ?? (() => {});
  // headerFn 이 있으면 매 렌더마다 회전 문구를, 없으면 정적 헤더를 반환한다.
  const staticHeader = opts.header ?? "_▶ 작업 준비 중…_";
  const headerFn = opts.headerFn ?? (() => staticHeader);

  let ts: string | undefined;
  let phases: readonly ProgressPhase[] = [];
  // 첫 addTool 은 즉시 flush 되도록 — 주입 클록이 0 부터 시작해도 성립해야 한다
  let lastFlush = Number.NEGATIVE_INFINITY;
  // flush 직렬화 — 늦게 시작한 update 가 최신 상태를 덮는 역전 방지
  let chain: Promise<void> = Promise.resolve();

  async function flushNow(): Promise<void> {
    if (ts === undefined) return;
    const text = mdToMrkdwn(maskSecrets(renderProgress(headerFn(), phases)));
    try {
      await deps.slack.updateMessage({ channel: opts.channel, ts, text });
      lastFlush = clock.now();
    } catch (err) {
      // 실패 시 lastFlush 를 갱신하지 않는다 — 다음 addTool 이 즉시 재시도하게
      log(`progress chat.update 실패 ts=${ts}: ${String(err)}`);
    }
  }

  return {
    get ts() {
      return ts;
    },

    async start() {
      if (opts.existingTs !== undefined) {
        // 기존 카드 채택 — post 를 생략하고 그 ts 를 갱신 대상으로 삼는다(재시도 시 중복 카드 방지).
        // 즉시 flush 로 새 헤더/빈 phases 를 반영해 카드가 "이어지는 중" 임을 보인다.
        ts = opts.existingTs;
        await flushNow();
        return;
      }
      const res = await deps.slack.postMessage({
        channel: opts.channel,
        threadTs: opts.threadTs,
        text: headerFn(),
      });
      ts = res.ts;
    },

    async addTool(toolName, summary, o) {
      const shown = progressSummary(toolName, summary);
      const category = categoryFor(toolName);
      phases = rollupPhases(phases, category, shown);
      deps.onStep?.(formatStepLabel(toolName, summary));

      const due = clock.now() - lastFlush >= CONTRACT.PROGRESS_UPDATE_INTERVAL_MS;
      if (!o?.forceFlush && !due) return;
      chain = chain.then(flushNow);
      await chain;
    },

    async finish(finalText, o) {
      // 대기 중 flush 가 최종 교체 뒤에 도착해 카드를 되살리는 역전 방지
      await chain;
      // 폴백 카드의 최종 답변도 GFM markdown 블록으로 게시한다 — plan 스트림 경로(appendText 의
      // markdown_text)와 렌더 포맷을 일치시켜, 어느 경로로 강등되든 표·헤더·링크가 동일하게 보인다(EG-10).
      return deps.poster.postFinal(finalText, {
        channel: opts.channel,
        threadTs: opts.threadTs ?? ts,
        replaceTs: ts,
        asMarkdownBlock: true,
        ...o,
      });
    },
  };
}
