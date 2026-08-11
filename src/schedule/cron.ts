/**
 * 최소 cron 매처 + **놓친 발화 따라잡기**.
 *
 * 왜 라이브러리를 안 쓰나: 필요한 건 5필드 매칭 하나뿐이고, 진짜 어려운 부분은 cron 문법이
 * 아니라 **맥이 자는 동안 지나간 발화를 어떻게 처리하느냐**다. 그건 어느 라이브러리도 대신
 * 해주지 않는다(팀 메모리 `local_monitor_mac_sleep_gap` — 고정 lookback 창이면 갭이 영구
 * 미관측으로 남는다).
 *
 * ── 따라잡기 설계 ──────────────────────────────────────────────────────────────
 * "타이머가 정각에 울리면 실행"이 아니라 **"지금 기준 최근 발화 시각을 계산해 그 시각을 키로
 * 큐에 넣는다"** 로 뒤집었다. 09:00 발화를 11:00 에 깨어나서 알아채도 키는 여전히 09:00 이라
 * 같은 잡이 들어간다. 그리고 `jobs.dedup_key` 가 UNIQUE 라 **중복 삽입은 DB가 거절한다** —
 * 따라잡기와 중복 방지가 같은 메커니즘 하나로 처리된다. 별도 last_fired 상태를 두지 않는
 * 이유이기도 하다(인메모리 상태는 재시작에 소실되고, DB 상태는 큐와 이중 장부가 된다).
 *
 * 놓친 발화가 여러 번이면(예: 3일 꺼져 있었다) 가장 최근 것 하나만 넣는다. 어제치 브리핑을
 * 오늘 만들어봐야 "최근 24시간" 전제가 이미 깨져 있어 쓸모가 없다.
 */

// 5필드: 분 시 일 월 요일. 와일드카드·숫자·`a-b` 범위·`a,b` 목록·스텝(슬래시) 지원.
// (스텝 예시를 주석에 그대로 못 쓴다 — 별표+슬래시가 블록 주석을 닫아 버린다. 실측으로 밟았다.)
export type CronField = "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

const RANGES: Record<CronField, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

const ORDER: CronField[] = ["minute", "hour", "dayOfMonth", "month", "dayOfWeek"];

/** 한 필드가 매칭하는 값 집합 (순수). 문법 오류는 null — 부팅 때 걸러 죽인다. */
export function parseField(expr: string, field: CronField): Set<number> | null {
  const [lo, hi] = RANGES[field];
  const values = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start: number;
    let end: number;
    if (rangePart === "*" || rangePart === undefined) {
      start = lo;
      end = hi;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      start = a as number;
      end = b as number;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      start = n;
      end = stepPart === undefined ? n : hi;
    }
    if (start < lo || end > hi || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values.size > 0 ? values : null;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/** `"0 9 * * *"` → 매칭 집합 (순수). 형식이 틀리면 null. */
export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const out = {} as ParsedCron;
  for (let i = 0; i < ORDER.length; i += 1) {
    const field = ORDER[i] as CronField;
    const set = parseField(parts[i] as string, field);
    if (!set) return null;
    out[field] = set;
  }
  return out;
}

/** 그 분(minute)이 발화 시각인가 (순수). 로컬 시간 기준 — 사람이 "9시"라고 할 때의 그 9시다. */
export function matches(cron: ParsedCron, at: Date): boolean {
  return (
    cron.minute.has(at.getMinutes()) &&
    cron.hour.has(at.getHours()) &&
    cron.dayOfMonth.has(at.getDate()) &&
    cron.month.has(at.getMonth() + 1) &&
    cron.dayOfWeek.has(at.getDay())
  );
}

/**
 * 지금(now) 기준 **가장 최근 발화 시각**을 lookback 안에서 찾는다 (순수). 없으면 null.
 *
 * 분 단위로 거슬러 올라가며 첫 매칭을 반환한다. lookback 기본 6시간은 "맥이 반나절 자다
 * 깨어도 오늘 아침 발화는 잡되, 어제 것까지 되살리지는 않는다"는 선이다.
 */
export function lastFireAt(cron: ParsedCron, now: Date, lookbackMinutes = 360): Date | null {
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i <= lookbackMinutes; i += 1) {
    if (matches(cron, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() - 1);
  }
  return null;
}

/** 발화 시각 → dedup key. 같은 발화는 몇 번을 계산해도 같은 키라 DB가 중복을 거절한다. */
export function fireKey(scheduleId: string, fireAt: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${fireAt.getFullYear()}${p(fireAt.getMonth() + 1)}${p(fireAt.getDate())}` +
    `T${p(fireAt.getHours())}${p(fireAt.getMinutes())}`;
  return `schedule:${scheduleId}:${stamp}`;
}
