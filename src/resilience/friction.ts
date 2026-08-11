/**
 * 장애 마찰(friction) 로그 — 반복 장애 패턴을 jsonl 에 append + 최근 N일 요약 (RS-09).
 *
 * 선행 구현 이식. 원본은 루트 로거 핸들러로 정규식 매칭했지만, 여기서는 마찰이
 * 실제로 발생하는 지점(훅 fail-open·API 재시도·fallback 발동)이 명시 콜백을 부르는
 * push 모델이다 — 로그 문자열 정규식에 의존하지 않아 결정론적이고, 소스 문자열 검사
 * 테스트를 강요하지 않는다.
 *
 * 부작용(파일 append·clock)은 전부 주입 — 테스트는 인메모리 sink 와 가짜 clock 으로
 * 각 기록 지점과 요약을 결정론 검증한다 (OPS-07).
 */

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 타입·요약
// ────────────────────────────────────────────────────────────────────

import type { Clock } from "../core/clock.js";

/**
 * 마찰 패턴 종류 — 계약(RS-09)이 지목한 "훅 fail-open·API 재시도·fallback 발동" 등
 * 반복 장애의 발화 지점. 새 패턴은 이 유니온에 추가해야 요약이 집계한다.
 */
export type FrictionPattern =
  | "slack_disconnect"
  | "zombie_reconnect"
  | "zombie_restart"
  | "wake_detected"
  | "watchdog_stall"
  | "hook_fail_open"
  | "api_error_retry"
  | "progress_fallback"
  | "scheduler_misfire";

export interface FrictionRecord {
  /** ISO8601 (초 단위) — 저장·비교 포맷 통일. */
  ts: string;
  pattern: FrictionPattern;
  /** 사람이 읽을 한 줄 상세 — 500자 상한(무한 증가 방지, OPS-12 정신). */
  detail: string;
}

/** detail 상한 — 원본 friction.py 의 500자 계승. */
export const FRICTION_DETAIL_MAX = 500;

/** rows → 패턴별 count + 최근 예시 1줄 (많은 순). 원본 summarize 계약 유지. */
export function summarizeFriction(rows: readonly FrictionRecord[]): string {
  if (rows.length === 0) return "";
  const byPattern = new Map<FrictionPattern, FrictionRecord[]>();
  for (const r of rows) {
    const list = byPattern.get(r.pattern);
    if (list) list.push(r);
    else byPattern.set(r.pattern, [r]);
  }
  const entries = [...byPattern.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines: string[] = [];
  for (const [pattern, items] of entries) {
    const last = items[items.length - 1];
    // items 는 최소 1개 — 위 push 로 보장되므로 last 는 항상 존재
    const preview = (last?.detail ?? "").slice(0, 140).replace(/\n/g, " ");
    lines.push(`- \`${pattern}\` ×${items.length} — ${preview}`);
  }
  return lines.join("\n");
}

/** since(포함) 이후 행만 — 요약 창 필터. ts 파싱 실패 행은 조용히 제외. */
export function filterSince(rows: readonly FrictionRecord[], sinceMs: number): FrictionRecord[] {
  const out: FrictionRecord[] = [];
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (!Number.isNaN(t) && t >= sinceMs) out.push(r);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (파일 append·읽기 부작용은 주입)
// ────────────────────────────────────────────────────────────────────

/** jsonl 파일 sink — 테스트는 인메모리 배열로 주입한다. */
export interface FrictionSink {
  /** 한 줄(개행 없는 JSON) append. 실패해도 던지지 않는다 — 마찰 수집이 앱을 죽이면 안 된다. */
  append(line: string): void;
  /** 전체 라인 읽기(요약용). 파일 없음/실패 시 빈 배열. */
  readAll(): string[];
}

export interface FrictionLog {
  /** 마찰 1건 기록 — fail-open·재시도·fallback 발동 지점이 부른다. 절대 던지지 않는다. */
  record(pattern: FrictionPattern, detail?: string): void;
  /** 최근 withinDays 일 요약(mrkdwn). 기록이 없으면 빈 문자열. */
  summarizeRecent(withinDays: number): string;
}

const DAY_MS = 86_400_000;

export function createFrictionLog(deps: { sink: FrictionSink; clock?: Clock }): FrictionLog {
  const clock = deps.clock ?? { now: () => Date.now() };

  function parseLine(line: string): FrictionRecord | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = typeof obj.ts === "string" ? obj.ts : null;
      const pattern = typeof obj.pattern === "string" ? (obj.pattern as FrictionPattern) : null;
      if (!ts || !pattern) return null;
      return { ts, pattern, detail: typeof obj.detail === "string" ? obj.detail : "" };
    } catch {
      return null;
    }
  }

  return {
    record(pattern, detail = "") {
      // 마찰 수집 실패로 호출부(훅·재시도 경로)가 죽으면 안 된다 — 무음 삼킴
      try {
        const row: FrictionRecord = {
          ts: new Date(clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z"),
          pattern,
          detail: detail.slice(0, FRICTION_DETAIL_MAX),
        };
        deps.sink.append(JSON.stringify(row));
      } catch {
        // 무시 — 기록 실패가 본 작업을 막지 않는다
      }
    },

    summarizeRecent(withinDays) {
      const sinceMs = clock.now() - Math.max(0, withinDays) * DAY_MS;
      let lines: string[];
      try {
        lines = deps.sink.readAll();
      } catch {
        return "";
      }
      const rows: FrictionRecord[] = [];
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed) rows.push(parsed);
      }
      return summarizeFriction(filterSince(rows, sinceMs));
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 파일 sink 구현 (실제 배선 — index.ts 에서 주입)
// ────────────────────────────────────────────────────────────────────

/**
 * jsonl 파일 sink. 파일 I/O 실패는 전부 삼킨다 — 마찰 로그는 보조 관측이지 필수 경로가 아니다.
 * node:fs 는 지연 import 하지 않고 상단에서 받되, 실제 경로 존재 보장은 index 부팅이 맡는다.
 */
export function createFileFrictionSink(
  path: string,
  fs: {
    appendFileSync(p: string, data: string): void;
    readFileSync(p: string, enc: "utf8"): string;
    existsSync(p: string): boolean;
  },
): FrictionSink {
  return {
    append(line) {
      fs.appendFileSync(path, `${line}\n`);
    },
    readAll() {
      if (!fs.existsSync(path)) return [];
      return fs.readFileSync(path, "utf8").split("\n");
    },
  };
}
