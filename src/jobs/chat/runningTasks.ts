/**
 * 진행 중 chat 작업 인메모리 레지스트리 — /cancel 라우팅 + shutdown 안내 스냅샷.
 *
 * 인메모리여도 OPS-13 위반이 아니다: 여기 상태는 '지금 이 프로세스에서 도는 작업'이라는
 * 본질적으로 휘발성인 사실뿐이고, 크래시 시 진실원은 jobs 테이블(recoverInflight)이다.
 */

// ────────────────────────────────────────────────────────────────────
// 순수 타입부
// ────────────────────────────────────────────────────────────────────

export interface RunningChatTaskInfo {
  threadKey: string;
  channel: string;
  threadTs: string;
  /**
   * 트리거 메시지 ts — 리액션 취소가 겨냥하는 좌표 중 하나다(EG-06 의 ⏳/🛑 가 달린 그 메시지).
   * reaction_added 이벤트는 `item.{channel,ts}` 만 싣고 thread_ts 를 안 준다 — 스레드를 역산할
   * 방법이 없으므로, 진행 중 작업이 자기 좌표를 들고 있어야 리액션 한 개로 매칭이 성립한다.
   */
  ts: string;
  startedAt: number;
  lastStep: string | null;
  /** 진행 카드 ts — shutdown 안내가 카드를 그대로 교체할 수 있게 (선행 구현 계승). */
  progressTs: string | null;
  /** true = 사용자 /cancel 로 중단됨 — shutdown abort 와 리액션/안내 분기 (SC-09). */
  userCancelled: boolean;
}

export interface ChatTaskHandle {
  readonly info: RunningChatTaskInfo;
  setStep(step: string): void;
  setProgressTs(ts: string): void;
  finish(): void;
}

export interface ChatTaskRegistry {
  start(args: {
    threadKey: string;
    channel: string;
    threadTs: string;
    ts: string;
    abort: () => void;
  }): ChatTaskHandle;
  /** 사용자 /cancel — userCancelled 마킹 후 abort. false = 해당 스레드 작업 없음. */
  cancel(threadKey: string): boolean;
  /**
   * 리액션 취소 — 메시지 좌표 하나로 그 대화의 진행 중 작업을 찾아 중단한다.
   * 반환값은 취소된 threadKey(없으면 null) — 호출부가 로그에 남길 유일한 식별자다.
   */
  cancelByMessage(item: CancelTargetItem): string | null;
  /** shutdown 안내용 스냅샷 (복사본 — 이후 변형이 스냅샷을 오염시키지 않는다). */
  list(): RunningChatTaskInfo[];
}

export interface CancelTargetItem {
  channel: string;
  ts: string;
}

/**
 * 리액션이 달린 메시지가 이 작업을 겨냥하는가 (순수).
 *
 * 사람이 🛑 를 다는 자리는 셋뿐이다: 자기 요청 메시지(트리거 ts), 스레드 부모(threadTs),
 * 봇이 띄운 진행 카드(progressTs). plan 카드 ts 는 레지스트리에 없다 — Slack 스트리밍 카드는
 * 리액션 대상으로 쓰이지 않고(사람은 자기 글이나 스레드 머리에 단다) ts 도 첫 flush 전엔 없다.
 */
export function matchesCancelTarget(info: RunningChatTaskInfo, item: CancelTargetItem): boolean {
  if (info.channel !== item.channel) return false;
  return item.ts === info.ts || item.ts === info.threadTs || item.ts === info.progressTs;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부
// ────────────────────────────────────────────────────────────────────

interface Entry {
  info: RunningChatTaskInfo;
  abort: () => void;
}

export function createChatTaskRegistry(
  clock: { now(): number } = { now: () => Date.now() },
): ChatTaskRegistry {
  const entries = new Map<string, Entry>();

  return {
    start(args) {
      const info: RunningChatTaskInfo = {
        threadKey: args.threadKey,
        channel: args.channel,
        threadTs: args.threadTs,
        ts: args.ts,
        startedAt: clock.now(),
        lastStep: null,
        progressTs: null,
        userCancelled: false,
      };
      const entry: Entry = { info, abort: args.abort };
      // 같은 thread_key 동시 실행은 dispatcher lane_key + threadLock 이 막는다 — 덮어쓰기는 방어적 처리
      entries.set(args.threadKey, entry);
      return {
        info,
        setStep(step) {
          info.lastStep = step;
        },
        setProgressTs(ts) {
          info.progressTs = ts;
        },
        finish() {
          // 내 entry 일 때만 제거 — 재시도로 새 entry 가 등록된 뒤의 늦은 finish 가 그것을 지우면 안 된다
          if (entries.get(args.threadKey) === entry) entries.delete(args.threadKey);
        },
      };
    },

    cancel(threadKeyArg) {
      const entry = entries.get(threadKeyArg);
      if (!entry) return false;
      entry.info.userCancelled = true;
      entry.abort();
      return true;
    },

    cancelByMessage(item) {
      for (const entry of entries.values()) {
        if (!matchesCancelTarget(entry.info, item)) continue;
        entry.info.userCancelled = true;
        entry.abort();
        return entry.info.threadKey;
      }
      return null;
    },

    list() {
      return [...entries.values()].map((e) => ({ ...e.info }));
    },
  };
}
