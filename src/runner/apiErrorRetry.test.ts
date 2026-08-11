import { describe, expect, it } from "vitest";
import {
  API_ERROR_LOG_PREFIX,
  backoffDelayMs,
  looksLikeApiError,
  retryOnApiErrorText,
} from "./apiErrorRetry.js";

/** RS-10 [단위] — 에러-텍스트 함정 감지 + 가짜 클록 백오프. */

describe("looksLikeApiError", () => {
  const ERROR_TEXTS = [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "API Error: 429 rate limited",
    "  API Error: 500 internal",
    '{"type":"error","error":{"type":"api_error"}}',
    "classification failed: overloaded_error",
    "rate_limit_error",
    '{"error":{"type":"rate_limit_error"}}', // envelope 변형도 응답 전체가 에러면 잡는다
  ];
  const NORMAL_TEXTS = [
    "",
    "정상 응답입니다. 배포는 완료됐어요.",
    "none",
    // 본문 중간 인용은 오탐하면 안 된다 — 세 패턴 전부 앵커드 (리뷰 회귀 픽스처)
    "이 에러는 'API Error: 529' 형태로 반환되는 함정입니다 — 문서 참고.",
    "HTTP 429 는 rate limit 상태 코드다", // 코드 언급만으로는 에러 아님
    "이 코드베이스는 rate_limit_error 를 어떻게 재시도하나요?", // 타입명 중간 등장 질의
    "rate_limit_error 는 429 로 반환됩니다. 지수 백오프로 재시도하고 retry-after 를 존중하세요.",
    // 에러 JSON 예시를 인용하는 답변 — 비앵커드 JSON 마커가 만들던 오탐
    '에러 페이로드는 {"type":"error","error":{"type":"overloaded_error"}} 형태로 옵니다.',
    "다음 에러들을 재시도합니다:\n- overloaded_error\n- rate_limit_error\n각각 지수 백오프를 적용하세요.",
  ];

  it.each(ERROR_TEXTS.map((t) => [t]))("에러로 판정: %s", (text) => {
    expect(looksLikeApiError(text)).toBe(true);
  });
  it.each(NORMAL_TEXTS.map((t) => [t]))("정상으로 판정: %s", (text) => {
    expect(looksLikeApiError(text)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("지수 증가 + 상한", () => {
    expect(backoffDelayMs(1, 2_000, 30_000)).toBe(2_000);
    expect(backoffDelayMs(2, 2_000, 30_000)).toBe(4_000);
    expect(backoffDelayMs(3, 2_000, 30_000)).toBe(8_000);
    expect(backoffDelayMs(5, 2_000, 30_000)).toBe(30_000); // 32s → cap
  });
});

describe("retryOnApiErrorText", () => {
  const fakeClock = () => {
    const sleeps: number[] = [];
    return {
      sleeps,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
  };

  it("정상 텍스트면 재시도 없이 1회로 끝난다", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await retryOnApiErrorText(
      async () => {
        calls++;
        return { text: "정상 응답" };
      },
      { getText: (v) => v.text, sleep: clock.sleep },
    );
    expect(result.text).toBe("정상 응답");
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("에러 텍스트 → 백오프 시퀀스로 재시도 → 회복", async () => {
    const clock = fakeClock();
    const responses = ["API Error: 529 overloaded", "API Error: 529 overloaded", "회복된 응답"];
    let calls = 0;
    const result = await retryOnApiErrorText(
      async () => {
        const text = responses[calls];
        calls++;
        return { text: text ?? "" };
      },
      {
        getText: (v) => v.text,
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        sleep: clock.sleep,
      },
    );
    expect(result.text).toBe("회복된 응답");
    expect(calls).toBe(3);
    expect(clock.sleeps).toEqual([1_000, 2_000]); // 지수 백오프 검증
  });

  it("소진 시 마지막 결과 반환 + onExhausted + grep 가능 로그", async () => {
    const clock = fakeClock();
    const logs: string[] = [];
    let exhausted: { attempts: number; text: string } | null = null;
    const result = await retryOnApiErrorText(async () => ({ text: "API Error: 529 overloaded" }), {
      getText: (v) => v.text,
      maxAttempts: 2,
      baseDelayMs: 1_000,
      sleep: clock.sleep,
      onExhausted: (info) => {
        exhausted = info;
      },
      log: (line) => logs.push(line),
    });
    expect(result.text).toBe("API Error: 529 overloaded");
    expect(exhausted).toEqual({ attempts: 2, text: "API Error: 529 overloaded" });
    expect(clock.sleeps).toEqual([1_000]); // 마지막 시도 후에는 대기하지 않는다
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(API_ERROR_LOG_PREFIX);
    expect(logs[0]).toContain("exhausted");
  });

  it("run 에는 attempt 번호가 1부터 전달된다", async () => {
    const clock = fakeClock();
    const attempts: number[] = [];
    await retryOnApiErrorText(
      async (attempt) => {
        attempts.push(attempt);
        return { text: "API Error: 529" };
      },
      { getText: (v) => v.text, maxAttempts: 3, baseDelayMs: 1, sleep: clock.sleep, log: () => {} },
    );
    expect(attempts).toEqual([1, 2, 3]);
  });
});
