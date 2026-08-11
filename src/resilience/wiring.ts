/**
 * 복원력 트리오 배선 — socketHealth · wakeDetector · watchdog 를 주입 포트로 조립 (RS-01/05/06).
 *
 * index.ts 의 부팅 시퀀스가 이 함수를 부르고, 여기서 각 컴포넌트의 주입 의존성을
 * AppContext·bolt 어댑터로 채운다. 순수 조립부만 담아 결정론 테스트가 가능하다 —
 * 실제 bolt·fs 는 index.ts 가 어댑터로 만들어 넘긴다 (OPS-07).
 */

import type { Clock } from "../core/clock.js";
import type { RunningChatTaskInfo } from "../jobs/chat/runningTasks.js";
import { createEventTracker, type EventTracker } from "./eventTracker.js";
import type { FrictionLog } from "./friction.js";
import { createSocketHealth, type SlackHistoryPort, type SocketHealth } from "./socketHealth.js";
import { createWakeDetector, isWakeDetectorEnabled, type WakeDetector } from "./wakeDetector.js";
import { createWatchdog, type Watchdog } from "./watchdog.js";

// ────────────────────────────────────────────────────────────────────
// 주입 포트 (index.ts 가 bolt·fs 어댑터로 채운다)
// ────────────────────────────────────────────────────────────────────

/** Socket Mode 강제 재연결 — disconnect→connect. 결과 boolean, 예외는 삼켜 false. */
export interface SocketReconnector {
  reconnect(reason: string): Promise<boolean>;
}

export interface ResilienceWiringDeps {
  clock: Clock;
  /** 매 인바운드 이벤트에서 markEvent 를 부를 트래커 — index 이벤트 훅과 socketHealth 가 공유. */
  eventTracker: EventTracker;
  history: SlackHistoryPort;
  reconnector: SocketReconnector;
  /** 유실 메시지 재주입 — listeners.handleEvent 와 동일한 normalize→enqueue 경로(RS-02). */
  enqueueEvent(event: Record<string, unknown>): Promise<void>;
  /** 최근 관여 스레드 — sessionStore.listRecentThreads(RS-04). */
  listRecentThreads(withinSeconds: number): Array<{ channel: string; threadTs: string }>;
  /** probe 대상 워처/알람 채널 ID 목록(Phase 2 채널 config, 없으면 빈 배열). */
  autoTriggerChannels: readonly string[];
  /** 진행 중 chat 작업 스냅샷 — runningTasks.list. */
  listRunning(): RunningChatTaskInfo[];
  /** 운영 채널 통보(egress 경유). ops-notify 미설정이면 log-only no-op. */
  notify(text: string): Promise<void>;
  /** 진행 카드 permalink 조회(watchdog). 실패 시 null. */
  fetchPermalink(channel: string, ts: string): Promise<string | null>;
  friction: FrictionLog;
  /** fast-exit — 프로세스 매니저 재기동(RS-03). 기본 process.exit. */
  exit?: (code: number) => void;
  /** 절전 복귀 시 스케줄러 tick 강제 훅 자리 — Phase 2 스케줄러 합류 시 배선(RS-05). */
  onWakeTick?: () => void;
  /** 취소 가능 대기 — 기본 setTimeout+AbortSignal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  platform?: string;
  wakeDetectorEnv?: string | undefined;
  log?: (msg: string) => void;
}

export interface Resilience {
  socketHealth: SocketHealth;
  watchdog: Watchdog;
  /** darwin 기본 on(또는 env 강제) 일 때만 존재 — 그 외 null(RS-05). */
  wakeDetector: WakeDetector | null;
  start(): void;
  stop(): Promise<void>;
}

/** 취소 가능 setTimeout — abort 시 즉시 reject 해 루프가 정지한다. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createResilience(deps: ResilienceWiringDeps): Resilience {
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? abortableSleep;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const platform = deps.platform ?? process.platform;

  const socketHealth = createSocketHealth({
    clock: deps.clock,
    lastEventAt: () => deps.eventTracker.lastEventAt(),
    lastSeen: () => deps.eventTracker.lastSeen(),
    resetBaseline: () => deps.eventTracker.resetBaseline(),
    history: deps.history,
    listRecentThreads: deps.listRecentThreads,
    autoTriggerChannels: deps.autoTriggerChannels,
    enqueueEvent: deps.enqueueEvent,
    reconnect: (reason) => deps.reconnector.reconnect(reason),
    exit,
    notify: deps.notify,
    onFriction: (pattern, detail) => deps.friction.record(pattern, detail),
    sleep,
    log,
  });

  const watchdog = createWatchdog({
    clock: deps.clock,
    listRunning: deps.listRunning,
    notify: deps.notify,
    fetchPermalink: deps.fetchPermalink,
    onStall: (task) =>
      deps.friction.record(
        "watchdog_stall",
        `thread=${task.threadKey} step=${task.lastStep ?? ""}`,
      ),
    sleep,
    log,
  });

  const wakeEnabled = isWakeDetectorEnabled(platform, deps.wakeDetectorEnv);
  const wakeDetector = wakeEnabled
    ? createWakeDetector({
        clock: deps.clock,
        sleep,
        async onWake(gapMs) {
          deps.friction.record("wake_detected", `wall gap=${Math.round(gapMs / 1000)}s`);
          // 절전 복귀: 스케줄러 tick 강제(Phase 2 자리) + 소켓 재연결
          deps.onWakeTick?.();
          await deps.reconnector.reconnect(`wake gap=${Math.round(gapMs / 1000)}s`);
          deps.eventTracker.resetBaseline();
        },
        log,
      })
    : null;

  return {
    socketHealth,
    watchdog,
    wakeDetector,
    start() {
      socketHealth.start();
      watchdog.start();
      wakeDetector?.start();
      log(`resilience 시작 — wakeDetector=${wakeEnabled ? "on" : "off"} (platform=${platform})`);
    },
    async stop() {
      await Promise.allSettled([
        socketHealth.stop(),
        watchdog.stop(),
        wakeDetector ? wakeDetector.stop() : Promise.resolve(),
      ]);
    },
  };
}

/** EventTracker 를 외부에서 만들지 않고 wiring 에 맡길 때의 편의 생성자. */
export function createResilienceEventTracker(clock: Clock): EventTracker {
  return createEventTracker(clock);
}
