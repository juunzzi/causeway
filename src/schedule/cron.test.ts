import { describe, expect, it } from "vitest";
import { fireKey, lastFireAt, matches, parseCron, parseField } from "./cron.js";

/**
 * 스케줄 [계약] — 이 봇에서 스케줄의 어려운 부분은 cron 문법이 아니라 **놓친 발화**다.
 * 맥이 자는 동안 09:00 이 지나가도 깨어난 뒤 그 발화를 잡아야 하고, 그러면서 같은 발화를
 * 두 번 넣지는 않아야 한다. 두 성질을 여기서 고정한다.
 */

const parse = (e: string) => {
  const c = parseCron(e);
  if (!c) throw new Error(`파싱 실패: ${e}`);
  return c;
};

describe("parseCron / parseField", () => {
  it("매일 09:00", () => {
    const c = parse("0 9 * * *");
    expect([...c.minute]).toEqual([0]);
    expect([...c.hour]).toEqual([9]);
    expect(c.dayOfWeek.size).toBe(7);
  });

  it("범위·목록·스텝", () => {
    expect([...(parseField("1-3", "hour") ?? [])]).toEqual([1, 2, 3]);
    expect([...(parseField("1,5", "hour") ?? [])]).toEqual([1, 5]);
    expect([...(parseField("*/15", "minute") ?? [])]).toEqual([0, 15, 30, 45]);
    expect([...(parseField("9/6", "hour") ?? [])]).toEqual([9, 15, 21]);
  });

  /** 문법 오류를 null 로 돌려야 부팅 때 죽일 수 있다 — 조용히 "안 울리는 스케줄"이 최악이다. */
  it("잘못된 표현은 null", () => {
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("0 99 * * *")).toBeNull();
    expect(parseCron("a 9 * * *")).toBeNull();
    expect(parseField("5-1", "hour")).toBeNull();
  });
});

describe("matches", () => {
  it("로컬 시간 기준이다 — 사람이 말하는 '9시'가 그 9시여야 한다", () => {
    const c = parse("0 9 * * *");
    const nine = new Date(2026, 7, 11, 9, 0, 0);
    expect(matches(c, nine)).toBe(true);
    expect(matches(c, new Date(2026, 7, 11, 9, 1, 0))).toBe(false);
    expect(matches(c, new Date(2026, 7, 11, 10, 0, 0))).toBe(false);
  });

  it("평일 전용 표현", () => {
    const c = parse("0 9 * * 1-5");
    expect(matches(c, new Date(2026, 7, 10, 9, 0))).toBe(true); // 월
    expect(matches(c, new Date(2026, 7, 9, 9, 0))).toBe(false); // 일
  });
});

describe("lastFireAt (놓친 발화 따라잡기)", () => {
  const daily9 = parse("0 9 * * *");

  it("정각이면 그 시각", () => {
    const now = new Date(2026, 7, 11, 9, 0, 30);
    expect(lastFireAt(daily9, now)?.getHours()).toBe(9);
  });

  /** 이게 핵심 — 자다 깨어나 두 시간 늦게 알아채도 09:00 발화를 놓치지 않는다. */
  it("맥이 자다 깨서 11시에 확인해도 오늘 09:00 을 잡는다", () => {
    const fire = lastFireAt(daily9, new Date(2026, 7, 11, 11, 0));
    expect(fire?.getDate()).toBe(11);
    expect(fire?.getHours()).toBe(9);
  });

  /**
   * 그렇다고 무한정 거슬러 올라가면 안 된다. 어제치 브리핑을 오늘 만들어봐야
   * "최근 24시간" 전제가 이미 깨져 쓸모가 없다.
   */
  it("lookback 을 넘긴 발화는 되살리지 않는다", () => {
    expect(lastFireAt(daily9, new Date(2026, 7, 11, 20, 0), 360)).toBeNull();
  });

  it("발화가 지나기 전이면 null — 앞당겨 실행하지 않는다", () => {
    expect(lastFireAt(daily9, new Date(2026, 7, 11, 8, 59), 60)).toBeNull();
  });
});

describe("fireKey (멱등성의 근거)", () => {
  /**
   * 같은 발화는 몇 번을 계산해도 같은 키여야 한다. 그래야 `jobs.dedup_key` UNIQUE 가
   * 중복 삽입을 거절하고, 따라잡기와 중복 방지가 한 메커니즘으로 처리된다.
   */
  it("같은 발화 시각이면 몇 시에 계산하든 같은 키다", () => {
    const at9 = lastFireAt(parse("0 9 * * *"), new Date(2026, 7, 11, 9, 0)) as Date;
    const at11 = lastFireAt(parse("0 9 * * *"), new Date(2026, 7, 11, 11, 30)) as Date;
    expect(fireKey("daily-briefing", at9)).toBe(fireKey("daily-briefing", at11));
    expect(fireKey("daily-briefing", at9)).toBe("schedule:daily-briefing:20260811T0900");
  });

  it("다른 날이면 다른 키 — 매일 한 번은 실제로 새로 돈다", () => {
    const a = fireKey("x", new Date(2026, 7, 11, 9, 0));
    const b = fireKey("x", new Date(2026, 7, 12, 9, 0));
    expect(a).not.toBe(b);
  });

  /** day 스코프 — 예비 시각을 여러 개 적어도 하루치 키는 하나다. */
  it("scope=day 면 같은 날의 다른 발화 시각이 같은 키가 된다", () => {
    const at9 = fireKey("x", new Date(2026, 7, 11, 9, 20), "day");
    const at13 = fireKey("x", new Date(2026, 7, 11, 13, 20), "day");
    expect(at9).toBe("schedule:x:20260811");
    expect(at13).toBe(at9);
    expect(fireKey("x", new Date(2026, 7, 12, 9, 20), "day")).not.toBe(at9);
  });
});
