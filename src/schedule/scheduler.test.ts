import { describe, expect, it } from "vitest";
import { parseCron } from "./cron.js";
import { type LoadedSchedule, type SchedulerDeps, tick, validateSchedules } from "./scheduler.js";

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
  promptFile: "config/briefings/fe-ai.md",
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
