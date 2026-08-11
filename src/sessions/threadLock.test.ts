import { describe, expect, it } from "vitest";
import { createThreadLocks } from "./threadLock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createThreadLocks", () => {
  it("같은 키는 직렬 — 앞 작업이 끝나기 전에 뒤 작업이 시작되지 않는다", async () => {
    const locks = createThreadLocks();
    const gate = deferred();
    const events: string[] = [];

    const first = locks.runExclusive("t1", async () => {
      events.push("a-start");
      await gate.promise;
      events.push("a-end");
    });
    const second = locks.runExclusive("t1", async () => {
      events.push("b-start");
    });

    await tick();
    expect(events).toEqual(["a-start"]); // b 는 아직 대기
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("다른 키는 서로 막지 않는다", async () => {
    const locks = createThreadLocks();
    const gate = deferred();
    const events: string[] = [];

    const slow = locks.runExclusive("t1", async () => {
      await gate.promise;
      events.push("slow");
    });
    await locks.runExclusive("t2", async () => {
      events.push("fast");
    });

    expect(events).toEqual(["fast"]);
    gate.resolve();
    await slow;
    expect(events).toEqual(["fast", "slow"]);
  });

  it("앞 작업 실패는 호출자에게 전파되고 다음 대기자를 막지 않는다", async () => {
    const locks = createThreadLocks();
    const first = locks.runExclusive("t1", async () => {
      throw new Error("boom");
    });
    const second = locks.runExclusive("t1", async () => "ok");

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
  });

  it("모든 작업이 끝나면 락 맵이 비워진다 (누수 방지)", async () => {
    const locks = createThreadLocks();
    await Promise.all([
      locks.runExclusive("t1", async () => {}),
      locks.runExclusive("t1", async () => {}),
      locks.runExclusive("t2", async () => {}),
    ]);
    await tick(); // 정리 콜백(마이크로태스크) 소진 대기
    expect(locks.size).toBe(0);
  });

  it("반환값을 그대로 돌려준다", async () => {
    const locks = createThreadLocks();
    await expect(locks.runExclusive("t1", () => 42)).resolves.toBe(42);
  });
});
