import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, withDeadline } from "./deadline.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline", () => {
  it("마감 전에 끝나면 그대로 통과시킨다", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1_000, "작업")).resolves.toBe("ok");
  });

  it("원래 작업의 실패는 DeadlineError 로 바뀌지 않는다 — 진짜 원인을 가리면 안 된다", async () => {
    const boom = new Error("auth.test 401");
    await expect(withDeadline(Promise.reject(boom), 1_000, "작업")).rejects.toBe(boom);
  });

  it("마감을 넘기면 DeadlineError 로 죽는다 — 무음 대기를 시끄러운 실패로", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const raced = withDeadline(never, 15_000, "Slack auth.test");
    const assertion = expect(raced).rejects.toThrow(DeadlineError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("DeadlineError 메시지에 무엇이 얼마나 걸렸는지 남는다", async () => {
    vi.useFakeTimers();
    const raced = withDeadline(new Promise<never>(() => {}), 15_000, "Slack auth.test");
    const assertion = raced.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = await assertion;
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as DeadlineError).label).toBe("Slack auth.test");
    expect((err as DeadlineError).ms).toBe(15_000);
    expect((err as Error).message).toContain("Slack auth.test");
    expect((err as Error).message).toContain("15000ms");
  });

  it("성공하면 타이머를 정리한다 — 프로세스가 마감까지 살아 있지 않게", async () => {
    vi.useFakeTimers();
    await withDeadline(Promise.resolve(1), 60_000, "작업");
    expect(vi.getTimerCount()).toBe(0);
  });
});
