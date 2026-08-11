/**
 * 진행 중 작업 워치독 — inflight chat 잡이 오래 무진행이면 운영 채널에 1회 통보 (RS-06).
 *
 * 선행 구현 이식. "긴 정상 작업"과 "hang"을 구분해, 마지막 진행 스텝 이후
 * WATCHDOG_STALL_MS 동안 갱신이 없는 작업만 사람에게 조기 경보한다. idle/hard 2단
 * 타임아웃(RS-08, runner 책임)과 별개의 관측 신호다 — 여기서는 작업을 죽이지 않는다.
 *
 * jobs/chat/runningTasks.ts 의 RunningChatTaskInfo 레지스트리를 재사용한다(재구현 금지).
 * 그 스냅샷에는 lastStep(문자열)만 있고 "언제 바뀌었는지"는 없으므로, 워치독이 자체로
 * per-thread 마지막 관측 스텝과 관측 시각을 추적해 stall 을 판정한다 — 레지스트리를
 * 건드리지 않고 관측만으로 구현한다.
 *
 * 부작용(시간·통보·permalink)은 전부 주입 — 테스트는 가짜 clock·통보 spy 로 1회 통보를
 * 결정론 검증한다 (OPS-07).
 */

import { CONTRACT } from "../core/constants.js";
import type { RunningChatTaskInfo } from "../jobs/chat/runningTasks.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — stall 판정·통보문 조립
// ────────────────────────────────────────────────────────────────────

/** 워치독 자체 추적 상태 — 스레드별 마지막 관측 스텝과 그 관측 시각. */
export interface StallTrack {
  /** 마지막으로 관측한 lastStep 값(null 은 아직 스텝 없음). 바뀌면 진행 중으로 간주. */
  lastStep: string | null;
  /** lastStep 이 마지막으로 바뀐(또는 최초 관측된) 시각(ms). */
  changedAt: number;
  /** 이 스레드에 이미 통보했는가 — 1회만 (RS-06). */
  notified: boolean;
}

export const WATCHDOG_POLL_MS = 60_000;

/**
 * 통보문 — 진행 카드 링크(permalink) + 경과·정체 시간 + 마지막 스텝.
 * 통보문에 링크가 반드시 포함돼야 운영자가 스레드로 바로 진입한다(RS-06).
 */
export function buildStallNotice(args: {
  permalink: string | null;
  elapsedMs: number;
  idleMs: number;
  lastStep: string | null;
  /** permalink 를 못 얻었을 때의 최소 식별자 — 없으면 어느 작업인지 알 방법이 없다. */
  threadKey?: string;
}): string {
  const elapsed = Math.round(args.elapsedMs / 1000);
  const idle = Math.round(args.idleMs / 1000);
  const step = args.lastStep ? args.lastStep.slice(0, 120) : "(스텝 없음)";
  // permalink 조회는 진행 카드가 아직 없으면(progressTs=null) 실패한다. 그때 헤드에 아무 단서도
  // 안 남기면 운영자가 "뭘 멈춘 거냐"를 되물어야 한다(2026-08-03 실측) — threadKey 라도 싣는다.
  const head = args.permalink
    ? `⌛ 작업 멈춤 의심 — <${args.permalink}|진행 스레드>`
    : args.threadKey
      ? `⌛ 작업 멈춤 의심 — \`${args.threadKey}\``
      : "⌛ 작업 멈춤 의심";
  return `${head}\n> 경과 \`${elapsed}s\`, 마지막 스텝 이후 \`${idle}s\` 무진행\n> \`${step}\``;
}

/**
 * 스냅샷과 이전 추적 상태로 다음 추적 상태와 "이번에 통보할 작업"을 계산 — 순수 함수.
 * 부작용(통보 발송·permalink 조회)은 오케스트레이션부가 결과를 보고 수행한다.
 */
export interface StallDecision {
  /** 스레드별 다음 추적 상태(사라진 스레드는 제외 — 자연 정리). */
  nextTracks: Map<string, StallTrack>;
  /** 이번 tick 에 새로 stall 로 판정돼 통보 대상이 된 작업들. */
  toNotify: RunningChatTaskInfo[];
}

export function decideStalls(
  running: readonly RunningChatTaskInfo[],
  prev: ReadonlyMap<string, StallTrack>,
  nowMs: number,
  stallMs: number = CONTRACT.WATCHDOG_STALL_MS,
): StallDecision {
  const nextTracks = new Map<string, StallTrack>();
  const toNotify: RunningChatTaskInfo[] = [];

  for (const task of running) {
    const prior = prev.get(task.threadKey);
    let track: StallTrack;
    if (!prior || prior.lastStep !== task.lastStep) {
      // 최초 관측이거나 스텝이 바뀜 = 진행 중 → 타이머 리셋, 통보 플래그 해제
      track = { lastStep: task.lastStep, changedAt: nowMs, notified: false };
    } else {
      track = { ...prior };
    }

    if (!track.notified && nowMs - track.changedAt >= stallMs) {
      track.notified = true; // 1회만 (RS-06)
      toNotify.push(task);
    }
    nextTracks.set(task.threadKey, track);
  }
  // running 에서 사라진 스레드는 nextTracks 에 넣지 않아 자연 정리된다
  return { nextTracks, toNotify };
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (시간·통보·permalink 는 주입)
// ────────────────────────────────────────────────────────────────────

export interface WatchdogDeps {
  clock: { now(): number };
  /** 진행 중 작업 스냅샷 — runningTasks.list() 를 그대로 주입한다. */
  listRunning(): RunningChatTaskInfo[];
  /** 운영 채널 통보 — 게시는 egress(poster) 경유로 배선한다 (EG-01). */
  notify(text: string): Promise<void>;
  /** 진행 카드 permalink 조회 — 실패 시 null 을 돌려주면 링크 없이 통보한다. */
  fetchPermalink(channel: string, ts: string): Promise<string | null>;
  /** tick 대기 — 취소 가능. 테스트는 즉시 resolve 하는 가짜를 주입한다. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** stall 통보 시 friction 기록(RS-09) 자리. */
  onStall?: (task: RunningChatTaskInfo) => void;
  pollMs?: number;
  stallMs?: number;
  log?: (msg: string) => void;
}

export interface Watchdog {
  /** 단일 점검(주입 clock 기준) — 루프 없이 결정론 테스트용으로도 쓴다. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const pollMs = deps.pollMs ?? WATCHDOG_POLL_MS;
  const stallMs = deps.stallMs ?? CONTRACT.WATCHDOG_STALL_MS;
  const log = deps.log ?? (() => {});
  let tracks: Map<string, StallTrack> = new Map();
  let controller: AbortController | null = null;
  let loopDone: Promise<void> | null = null;

  async function tick(): Promise<void> {
    const now = deps.clock.now();
    const running = deps.listRunning();
    const { nextTracks, toNotify } = decideStalls(running, tracks, now, stallMs);
    tracks = nextTracks;

    for (const task of toNotify) {
      const permalink =
        task.progressTs !== null
          ? await deps.fetchPermalink(task.channel, task.progressTs).catch(() => null)
          : null;
      const notice = buildStallNotice({
        permalink,
        elapsedMs: now - task.startedAt,
        idleMs: stallMs, // 판정 시점 기준 최소 정체 시간 — changedAt 은 tracks 에 남지 않으므로 하한값 사용
        lastStep: task.lastStep,
        threadKey: task.threadKey,
      });
      try {
        await deps.notify(notice);
        deps.onStall?.(task);
        log(`watchdog stall 통보 thread=${task.threadKey}`);
      } catch (err) {
        // 통보 실패 시 다음 tick 재시도를 위해 notified 를 되돌린다 — silent 하게 놓치지 않는다
        const t = tracks.get(task.threadKey);
        if (t) t.notified = false;
        log(`watchdog 통보 실패 thread=${task.threadKey}: ${String(err)}`);
      }
    }
  }

  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await deps.sleep(pollMs, signal);
      } catch {
        return;
      }
      if (signal.aborted) return;
      try {
        await tick();
      } catch (err) {
        log(`watchdog tick 실패: ${String(err)}`);
      }
    }
  }

  return {
    tick,
    start() {
      if (controller) return;
      controller = new AbortController();
      loopDone = loop(controller.signal);
    },
    async stop() {
      if (!controller) return;
      controller.abort();
      const done = loopDone;
      controller = null;
      loopDone = null;
      if (done) await done;
    },
  };
}
