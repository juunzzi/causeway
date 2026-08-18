import { describe, expect, it } from "vitest";
import { parseCron } from "./cron.js";
import {
  createTicker,
  type LoadedSchedule,
  type SchedulerDeps,
  tick,
  validateSchedules,
} from "./scheduler.js";

/**
 * 발화기 [계약] — 이 스케줄이 조용히 안 울리거나 매일 두 번 울리면 사람은 한참 뒤에 안다.
 * 세 가지를 고정한다: ① 지난 발화를 잡는다 ② 같은 발화를 두 번 안 넣는다
 * ③ 루트 게시가 실패해도 고아 잡·고아 메시지를 남기지 않는다.
 */

const cron = (e: string) => {
  const p = parseCron(e);
  if (!p) throw new Error(e);
  return p;
};

const schedule = (over: Partial<LoadedSchedule> = {}): LoadedSchedule => ({
  id: "daily-briefing",
  cron: "0 9 * * *",
  enabled: true,
  channel: "D1",
  userId: "U1",
  rootText: "☀️ 오늘 브리핑",
  promptFile: "config/prompts/daily-briefing.md",
  parsed: cron("0 9 * * *"),
  prompt: "브리핑 하라",
  ...over,
});

function fakeJobs() {
  const rows = new Map<string, { payload: unknown }>();
  return {
    rows,
    enqueue(input: { dedupKey: string; payload: unknown }) {
      if (rows.has(input.dedupKey)) return { enqueued: false, existing: {} } as never;
      rows.set(input.dedupKey, { payload: input.payload });
      return { enqueued: true } as never;
    },
    getByDedupKey(k: string) {
      return rows.has(k) ? ({} as never) : undefined;
    },
  };
}

const deps = (over: Partial<SchedulerDeps> = {}): SchedulerDeps => ({
  schedules: [schedule()],
  jobs: fakeJobs(),
  postRoot: async () => "1786.1",
  now: () => new Date(2026, 7, 11, 9, 0),
  ...over,
});

describe("tick", () => {
  it("발화 시각이 지나면 chat 잡으로 넣는다 — 새 잡 타입을 만들지 않는다", async () => {
    const jobs = fakeJobs();
    const fired = await tick(deps({ jobs }));
    expect(fired).toEqual(["daily-briefing"]);
    const [key, row] = [...jobs.rows.entries()][0] as [string, { payload: Record<string, string> }];
    expect(key).toBe("schedule:daily-briefing:20260811T0900");
    expect(row.payload.text).toBe("브리핑 하라");
    expect(row.payload.threadKey).toBe("D1:1786.1");
  });

  /** 따라잡기의 대가 — 같은 발화가 매 tick 계산된다. 두 번 넣으면 브리핑이 두 번 돈다. */
  it("같은 발화는 두 번 넣지 않는다", async () => {
    const jobs = fakeJobs();
    const d = deps({ jobs });
    expect(await tick(d)).toEqual(["daily-briefing"]);
    expect(await tick({ ...d, now: () => new Date(2026, 7, 11, 10, 30) })).toEqual([]);
    expect(jobs.rows.size).toBe(1);
  });

  it("맥이 자다 깨서 늦게 확인해도 그날 발화를 잡는다", async () => {
    const jobs = fakeJobs();
    const fired = await tick(deps({ jobs, now: () => new Date(2026, 7, 11, 11, 0) }));
    expect(fired).toEqual(["daily-briefing"]);
    expect([...jobs.rows.keys()][0]).toBe("schedule:daily-briefing:20260811T0900");
  });

  it("발화 전에는 아무것도 안 한다", async () => {
    const jobs = fakeJobs();
    expect(await tick(deps({ jobs, now: () => new Date(2026, 7, 11, 8, 30) }))).toEqual([]);
    expect(jobs.rows.size).toBe(0);
  });

  /**
   * 게시를 먼저 하고 큐를 나중에 잡으면, 중복 발화마다 DM 에 고아 루트가 쌓인다.
   * 그래서 tick 은 **게시 전에** dedup 를 확인한다.
   */
  it("이미 처리된 발화면 루트 메시지를 아예 올리지 않는다", async () => {
    const jobs = fakeJobs();
    let posts = 0;
    const d = deps({
      jobs,
      postRoot: async () => {
        posts += 1;
        return "1786.1";
      },
    });
    await tick(d);
    await tick(d);
    expect(posts).toBe(1);
  });

  /** oncePerDay — cron 의 여러 시각은 "또 돈다"가 아니라 "못 돌았으면 그때 받는다"여야 한다. */
  describe("oncePerDay", () => {
    const backup = (over: Partial<LoadedSchedule> = {}) =>
      schedule({
        cron: "20 9,11,13 * * *",
        parsed: cron("20 9,11,13 * * *"),
        oncePerDay: true,
        ...over,
      });

    it("예비 시각이 세 개여도 하루에 한 번만 돈다", async () => {
      const jobs = fakeJobs();
      const d = deps({ jobs, schedules: [backup()], now: () => new Date(2026, 7, 11, 9, 20) });
      expect(await tick(d)).toEqual(["daily-briefing"]);
      expect([...jobs.rows.keys()][0]).toBe("schedule:daily-briefing:20260811");

      expect(await tick({ ...d, now: () => new Date(2026, 7, 11, 11, 20) })).toEqual([]);
      expect(await tick({ ...d, now: () => new Date(2026, 7, 11, 13, 20) })).toEqual([]);
      expect(jobs.rows.size).toBe(1);
    });

    it("9시를 통째로 놓쳤으면 11시가 받는다", async () => {
      const jobs = fakeJobs();
      // 9시 발화는 아무도 안 넣었다(맥이 자 있었거나 게시가 계속 실패했다).
      const fired = await tick(
        deps({ jobs, schedules: [backup()], now: () => new Date(2026, 7, 11, 11, 25) }),
      );
      expect(fired).toEqual(["daily-briefing"]);
      expect([...jobs.rows.keys()][0]).toBe("schedule:daily-briefing:20260811");
    });

    /**
     * 평일 배치(`1-5`)의 계약. 예비 시각이 여러 개라 "금요일을 놓치면 토요일이 받는" 것처럼
     * 보이기 쉬운데, lastFireAt 은 요일도 함께 매칭하므로 주말엔 아무 발화도 안 잡힌다.
     * 그 사이 대화는 커서가 들고 있다가 월요일 실행이 함께 읽는다(구간이 비지 않는다).
     */
    it("주말엔 안 울린다 — 금요일을 통째로 놓쳐도 토요일이 되살리지 않는다", async () => {
      const jobs = fakeJobs();
      const weekday = backup({
        cron: "20 9,11,13 * * 1-5",
        parsed: cron("20 9,11,13 * * 1-5"),
      });
      // 2026-08-14(금) 발화는 아무도 안 넣었다. 다음은 토요일 아침.
      const sat = await tick(
        deps({ jobs, schedules: [weekday], now: () => new Date(2026, 7, 15, 9, 30) }),
      );
      expect(sat).toEqual([]);
      expect(jobs.rows.size).toBe(0);

      // 월요일에는 그날 몫으로 새로 돈다.
      const mon = await tick(
        deps({ jobs, schedules: [weekday], now: () => new Date(2026, 7, 17, 9, 20) }),
      );
      expect(mon).toEqual(["daily-briefing"]);
      expect([...jobs.rows.keys()][0]).toBe("schedule:daily-briefing:20260817");
    });

    it("다음 날은 다시 돈다 — 날짜가 바뀌면 키도 바뀐다", async () => {
      const jobs = fakeJobs();
      const d = deps({ jobs, schedules: [backup()], now: () => new Date(2026, 7, 11, 9, 20) });
      await tick(d);
      expect(await tick({ ...d, now: () => new Date(2026, 7, 12, 9, 20) })).toEqual([
        "daily-briefing",
      ]);
      expect([...jobs.rows.keys()]).toEqual([
        "schedule:daily-briefing:20260811",
        "schedule:daily-briefing:20260812",
      ]);
    });
  });

  it("루트 게시가 실패하면 잡을 넣지 않는다 — 답 달 자리 없는 브리핑을 만들지 않는다", async () => {
    const jobs = fakeJobs();
    const logs: string[] = [];
    const fired = await tick(
      deps({
        jobs,
        postRoot: async () => {
          throw new Error("channel_not_found");
        },
        log: (m) => logs.push(m),
      }),
    );
    expect(fired).toEqual([]);
    expect(jobs.rows.size).toBe(0);
    expect(logs.join()).toContain("루트 게시 실패");
  });
});

/**
 * [회귀 2026-08-14] 09:20~10:20 DNS 장애 구간에서 한 스케줄의 루트 게시가 37회 시도됐다.
 * 원인은 dedup 이 아니라 **겹침**이다: postRoot 가 재시도로 수 분을 붙드는 동안 1분 타이머가
 * 새 tick 을 계속 던졌고, 각 tick 이 똑같이 "아직 잡이 없다"를 봤다. 잡은 UNIQUE 로 하나만
 * 남지만 **이미 올라간 메시지는 되돌릴 수 없다** — 사람에게는 그게 전부다.
 */
describe("createTicker", () => {
  /** 겹친 tick 을 재현한다: postRoot 가 매달려 있는 동안 두 번째 tick 이 들어온다. */
  function hangingDeps() {
    const jobs = fakeJobs();
    let posts = 0;
    let release: (() => void) | undefined;
    const d = deps({
      jobs,
      postRoot: async () => {
        posts += 1;
        await new Promise<void>((r) => {
          release = r;
        });
        return "1786.1";
      },
    });
    return { jobs, d, posts: () => posts, release: () => release?.() };
  }

  it("앞 tick 이 게시에 매달려 있으면 새 tick 을 시작하지 않는다", async () => {
    const h = hangingDeps();
    const ticker = createTicker(h.d);
    const first = ticker();
    const skipped = await ticker(); // 겹침 — 게시를 또 예약하면 안 된다
    expect(skipped).toEqual([]);
    expect(h.posts()).toBe(1);
    h.release();
    expect(await first).toEqual(["daily-briefing"]);
    expect(h.posts()).toBe(1);
  });

  it("앞 tick 이 끝나면 다음 tick 은 정상 동작한다 — 가드가 발화를 영영 막지 않는다", async () => {
    const jobs = fakeJobs();
    const ticker = createTicker(deps({ jobs }));
    expect(await ticker()).toEqual(["daily-briefing"]);
    expect(await ticker()).toEqual([]); // dedup 로 조용히 넘어간다
    expect(jobs.rows.size).toBe(1);
  });

  it("tick 이 던져도 가드가 풀린다 — 한 번의 예외로 발화기가 영구 정지하면 안 된다", async () => {
    const ticker = createTicker(
      deps({
        jobs: {
          enqueue: () => {
            throw new Error("db 잠김");
          },
          getByDedupKey: () => undefined,
        } as unknown as SchedulerDeps["jobs"],
      }),
    );
    await expect(ticker()).rejects.toThrow("db 잠김");
    await expect(ticker()).rejects.toThrow("db 잠김"); // 가드에 걸려 [] 를 주면 안 된다
  });

  /** 가드가 없던 시절의 동작 — 이 테스트가 깨지면 재현 경로 자체가 사라진 것이다. */
  it("맨 tick 은 겹치면 중복 게시한다 (가드가 필요한 이유)", async () => {
    const h = hangingDeps();
    void tick(h.d);
    await Promise.resolve();
    void tick(h.d);
    await Promise.resolve();
    expect(h.posts()).toBe(2);
  });
});

describe("validateSchedules", () => {
  const readPrompt = (f: string) => (f === "ok.md" ? "프롬프트" : null);
  const base = {
    id: "a",
    cron: "0 9 * * *",
    enabled: true,
    channel: "D1",
    userId: "U1",
    rootText: "r",
    promptFile: "ok.md",
  };

  it("정상 정의를 싣는다", () => {
    const { schedules, errors } = validateSchedules([base], readPrompt);
    expect(errors).toEqual([]);
    expect(schedules[0]?.prompt).toBe("프롬프트");
    expect(schedules[0]?.oncePerDay).toBe(false);
  });

  it("oncePerDay 는 명시적으로 true 일 때만 켜진다 — 오타가 조용히 켜지지 않게", () => {
    const on = validateSchedules([{ ...base, oncePerDay: true }], readPrompt);
    expect(on.schedules[0]?.oncePerDay).toBe(true);
    const typo = validateSchedules([{ ...base, oncePerDay: "true" }], readPrompt);
    expect(typo.schedules[0]?.oncePerDay).toBe(false);
  });

  it("꺼진 스케줄은 검증도 적재도 안 한다", () => {
    const { schedules, errors } = validateSchedules(
      [{ ...base, enabled: false, cron: "쓰레기" }],
      readPrompt,
    );
    expect(errors).toEqual([]);
    expect(schedules).toEqual([]);
  });

  /** 조용히 안 울리는 스케줄이 최악이라, 문제를 전부 모아 한 번에 드러낸다. */
  it("문제를 모아서 돌려준다 — 하나 고치고 또 부팅하는 일이 없게", () => {
    const { schedules, errors } = validateSchedules(
      [{ ...base, cron: "0 99 * * *", promptFile: "없음.md", channel: "" }],
      readPrompt,
    );
    expect(schedules).toEqual([]);
    expect(errors.join("\n")).toContain("cron 파싱 실패");
    expect(errors.join("\n")).toContain("channel 없음");
    expect(errors.join("\n")).toContain("프롬프트 파일 없음");
  });

  it("id 중복은 에러 — 뒤엣것이 앞엣것의 dedup_key 를 먹는다", () => {
    const { errors } = validateSchedules([base, base], readPrompt);
    expect(errors.join()).toContain("id 중복");
  });
});
