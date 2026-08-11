import { describe, expect, it } from "vitest";
import {
  createFrictionLog,
  FRICTION_DETAIL_MAX,
  type FrictionRecord,
  type FrictionSink,
  filterSince,
  summarizeFriction,
} from "./friction.js";

/** 인메모리 sink — 결정론 테스트용. */
function memorySink(seed: string[] = []): FrictionSink & { lines: string[] } {
  const lines = [...seed];
  return {
    lines,
    append(line) {
      lines.push(line);
    },
    readAll() {
      return [...lines];
    },
  };
}

describe("summarizeFriction", () => {
  it("빈 입력은 빈 문자열", () => {
    expect(summarizeFriction([])).toBe("");
  });

  it("패턴별 count + 최근 예시 1줄 (많은 순)", () => {
    const rows: FrictionRecord[] = [
      { ts: "2026-07-20T00:00:00Z", pattern: "api_error_retry", detail: "첫 재시도" },
      { ts: "2026-07-20T01:00:00Z", pattern: "zombie_reconnect", detail: "재연결1" },
      { ts: "2026-07-20T02:00:00Z", pattern: "api_error_retry", detail: "둘째 재시도" },
      { ts: "2026-07-20T03:00:00Z", pattern: "api_error_retry", detail: "마지막 재시도" },
    ];
    const out = summarizeFriction(rows);
    const linesOut = out.split("\n");
    // api_error_retry(3) 가 zombie_reconnect(1) 보다 위
    expect(linesOut[0]).toBe("- `api_error_retry` ×3 — 마지막 재시도");
    expect(linesOut[1]).toBe("- `zombie_reconnect` ×1 — 재연결1");
  });

  it("detail 의 개행은 공백으로 접힌다(1줄 유지)", () => {
    const out = summarizeFriction([
      { ts: "2026-07-20T00:00:00Z", pattern: "wake_detected", detail: "줄1\n줄2" },
    ]);
    expect(out).toBe("- `wake_detected` ×1 — 줄1 줄2");
  });
});

describe("filterSince", () => {
  it("since 이후(포함)만 남긴다", () => {
    const rows: FrictionRecord[] = [
      { ts: "2026-07-19T00:00:00Z", pattern: "wake_detected", detail: "old" },
      { ts: "2026-07-20T00:00:00Z", pattern: "wake_detected", detail: "boundary" },
      { ts: "2026-07-21T00:00:00Z", pattern: "wake_detected", detail: "new" },
    ];
    const since = Date.parse("2026-07-20T00:00:00Z");
    const out = filterSince(rows, since);
    expect(out.map((r) => r.detail)).toEqual(["boundary", "new"]);
  });

  it("파싱 불가 ts 는 제외", () => {
    const rows: FrictionRecord[] = [{ ts: "not-a-date", pattern: "wake_detected", detail: "x" }];
    expect(filterSince(rows, 0)).toEqual([]);
  });
});

describe("createFrictionLog", () => {
  const clock = { now: () => Date.parse("2026-07-20T12:00:00Z") };

  it("record 는 sink 에 JSON 한 줄을 append 한다", () => {
    const sink = memorySink();
    const log = createFrictionLog({ sink, clock });
    log.record("hook_fail_open", "guard 훅 예외 → allow");
    expect(sink.lines).toHaveLength(1);
    const row = JSON.parse(sink.lines[0] as string);
    expect(row.pattern).toBe("hook_fail_open");
    expect(row.detail).toBe("guard 훅 예외 → allow");
    expect(row.ts).toBe("2026-07-20T12:00:00Z");
  });

  it("detail 은 상한(500자)으로 잘린다", () => {
    const sink = memorySink();
    const log = createFrictionLog({ sink, clock });
    log.record("api_error_retry", "x".repeat(FRICTION_DETAIL_MAX + 50));
    const row = JSON.parse(sink.lines[0] as string);
    expect(row.detail).toHaveLength(FRICTION_DETAIL_MAX);
  });

  it("sink.append 가 던져도 record 는 던지지 않는다(fail-open)", () => {
    const sink: FrictionSink = {
      append() {
        throw new Error("disk full");
      },
      readAll: () => [],
    };
    const log = createFrictionLog({ sink, clock });
    expect(() => log.record("progress_fallback")).not.toThrow();
  });

  it("summarizeRecent 는 최근 N일 창만 요약한다", () => {
    // 8일 전 · 2일 전 두 건 — withinDays=7 이면 최근 것만
    const sink = memorySink([
      JSON.stringify({ ts: "2026-07-12T11:00:00Z", pattern: "wake_detected", detail: "8일전" }),
      JSON.stringify({ ts: "2026-07-18T11:00:00Z", pattern: "wake_detected", detail: "2일전" }),
    ]);
    const log = createFrictionLog({ sink, clock });
    const out = log.summarizeRecent(7);
    expect(out).toBe("- `wake_detected` ×1 — 2일전");
  });

  it("깨진 라인은 조용히 건너뛴다", () => {
    const sink = memorySink([
      "{ not json",
      "",
      JSON.stringify({ ts: "2026-07-20T11:00:00Z", pattern: "watchdog_stall", detail: "ok" }),
    ]);
    const log = createFrictionLog({ sink, clock });
    expect(log.summarizeRecent(7)).toBe("- `watchdog_stall` ×1 — ok");
  });

  it("기록 없으면 빈 문자열", () => {
    const log = createFrictionLog({ sink: memorySink(), clock });
    expect(log.summarizeRecent(7)).toBe("");
  });
});
