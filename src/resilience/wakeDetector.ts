/**
 * wake detector — 절전(sleep) 복귀 감지 (RS-05).
 *
 * asyncio/monotonic 기반 타이머는 시스템이 절전되면 delay 계산이 어긋나, wake 이후에도
 * 예정된 tick 이 침묵 누락되는 사고가 있었다(선행 구현 기록, 팀 메모리
 * project_scheduler_wake_detector). 30s 벽시계 tick 으로 큰 wall-clock gap 을 관측하면
 * "절전에서 깬 것"으로 판정해 콜백을 부른다 — 스케줄러 tick 강제 + 소켓 재연결 자리.
 *
 * process.platform==='darwin' 이면 기본 on(배포 호스트가 당분간 맥일 가능성이 높다,
 * RS-05·세션 확정). 서버(linux)면 자연 no-op 이되, env 로 강제 on/off 할 수 있다.
 *
 * 부작용(시간·대기·플랫폼·콜백)은 전부 주입 — 테스트는 가짜 clock 으로 gap 을 만들어
 * 감지·콜백 호출을 결정론 검증한다 (OPS-07).
 */

import { CONTRACT } from "../core/constants.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — gap 판정·플랫폼 기본값
// ────────────────────────────────────────────────────────────────────

/** tick 간격(ms). gap 임계(120s) 대비 충분히 촘촘해 오탐 없이 sleep 만 잡는다. */
export const WAKE_TICK_MS = 30_000;

/** wall-clock gap 이 임계를 넘으면 절전 복귀로 판정. */
export function isWakeGap(gapMs: number): boolean {
  return gapMs > CONTRACT.WAKE_GAP_THRESHOLD_MS;
}

/**
 * 플랫폼·env 로 활성 여부 결정 (RS-05).
 * - env 명시(CAUSEWAY_WAKE_DETECTOR = "1"/"true"/"on" → on, "0"/"false"/"off" → off)가 최우선.
 * - 미지정이면 darwin 만 기본 on.
 */
export function isWakeDetectorEnabled(platform: string, envValue: string | undefined): boolean {
  if (envValue !== undefined) {
    const v = envValue.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "on") return true;
    if (v === "0" || v === "false" || v === "off") return false;
  }
  return platform === "darwin";
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (시간·대기·콜백은 주입)
// ────────────────────────────────────────────────────────────────────

export interface WakeDetectorDeps {
  /** 벽시계 — 절전 동안 실제로 흐른 시간을 관측하려면 monotonic 이 아니라 wall-clock 이어야 한다. */
  clock: { now(): number };
  /** tick 대기 — 취소 가능(AbortSignal). 테스트는 즉시 resolve 하는 가짜를 주입한다. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /**
   * 절전 복귀 시 콜백 — 스케줄러 tick 강제 + 소켓 재연결 자리 (RS-05).
   * gapMs 를 넘겨 통보/로그에 쓸 수 있게 한다. 예외를 던져도 루프는 죽지 않는다.
   */
  onWake(gapMs: number): Promise<void> | void;
  tickMs?: number;
  log?: (msg: string) => void;
}

export interface WakeDetector {
  /** 루프 시작 — resolve 는 stop() 후에만. 이미 시작됐으면 무시. */
  start(): void;
  /** 루프 정지 — 진행 중 sleep 을 깨우고 다음 tick 에서 종료한다. */
  stop(): Promise<void>;
}

export function createWakeDetector(deps: WakeDetectorDeps): WakeDetector {
  const tickMs = deps.tickMs ?? WAKE_TICK_MS;
  const log = deps.log ?? (() => {});
  let controller: AbortController | null = null;
  let loopDone: Promise<void> | null = null;

  async function loop(signal: AbortSignal): Promise<void> {
    let last = deps.clock.now();
    while (!signal.aborted) {
      try {
        await deps.sleep(tickMs, signal);
      } catch {
        // AbortError 등 — stop() 신호로 간주하고 종료
        return;
      }
      if (signal.aborted) return;
      const now = deps.clock.now();
      const gap = now - last;
      last = now;
      if (isWakeGap(gap)) {
        log(`wake-up 감지 (wall gap=${Math.round(gap / 1000)}s) — tick 강제 + 소켓 재연결`);
        try {
          await deps.onWake(gap);
        } catch (err) {
          log(`wake onWake 콜백 실패(무시): ${String(err)}`);
        }
      }
    }
  }

  return {
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
