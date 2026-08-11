/**
 * per-thread async mutex — 같은 스레드의 연속 입력을 직렬화한다 (SC-03).
 *
 * dispatcher 의 lane_key 직렬화와 이중이지만, 세션 resume 의 원자성
 * (같은 thread_key 에서 resume 과 신규 세션 생성이 겹치지 않아야 한다)을 지키는
 * 2차 방어선으로 유지한다. 선행 구현의 락 딕셔너리 를 promise 체인으로 대체.
 */

export interface ThreadLocks {
  /** key 별 직렬 실행. task 의 실패는 호출자에게 그대로 전파되고, 다음 대기자를 막지 않는다. */
  runExclusive<T>(key: string, task: () => Promise<T> | T): Promise<T>;
  /** 대기 중이거나 실행 중인 키 개수 — 락 누수 검증용. */
  readonly size: number;
}

export function createThreadLocks(): ThreadLocks {
  // 키별 '마지막 작업의 완료' promise 체인. tail 은 실패를 흡수해 체인 단절을 막는다.
  const tails = new Map<string, Promise<void>>();

  return {
    get size() {
      return tails.size;
    },
    runExclusive<T>(key: string, task: () => Promise<T> | T): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const run = prev.then(() => task());
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, tail);
      // 무한 증가 방지 — 내가 여전히 tail 일 때만 제거(그 사이 체인이 이어졌으면 유지)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
  };
}
