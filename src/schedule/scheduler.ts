/**
 * 스케줄 발화기 — cron 시각이 지나면 그 발화를 **chat 잡으로** 큐에 넣는다.
 *
 * ── 왜 새 잡 타입을 안 만드나 ──────────────────────────────────────────────────
 * 브리핑은 "프롬프트를 세션에 물리고 결과를 슬랙에 올린다"인데 그건 chat 잡이 이미 하는 일
 * 전부다(세션 실행·진행 카드·재시도·취소·부팅 복구). 새 타입을 파면 그 인프라를 복제하게
 * 되고, 복제본은 원본이 고쳐질 때 같이 안 고쳐진다. 그래서 **발화기는 트리거만** 하고 실행은
 * 기존 경로에 얹는다 — registry.ts 의 JQ-09 규약("새 자동화는 배열에 한 줄")도 그대로 지킨다.
 *
 * ── 스레드 루트를 먼저 만든다 ────────────────────────────────────────────────
 * chat 잡은 스레드에 답을 단다. 없는 thread_ts 로 게시하면 Slack 이 거절하므로, 발화 시점에
 * DM 에 루트 메시지를 하나 올리고 그 ts 를 스레드로 쓴다. 사람 눈에는 "봇이 아침에 말을 걸고
 * 그 스레드에 브리핑이 달리는" 모양이 되어, 이어서 질문하면 같은 세션으로 물린다.
 *
 * ── 멱등성 ──────────────────────────────────────────────────────────────────
 * dedup_key 는 발화 시각으로 만든다(cron.fireKey). 맥이 자다 깨서 늦게 알아채도 키가 같아
 * `jobs.dedup_key` UNIQUE 가 중복을 거절한다. **다만 루트 메시지는 큐 삽입 전에 올라가므로,
 * 중복 발화면 게시한 루트가 고아가 된다** — 잡은 거절돼도 메시지는 이미 사람 눈에 보인 뒤라
 * 되돌릴 수 없다. 그래서 게시 전에 `getByDedupKey` 로 한 번 거른다.
 *
 * 그 확인만으로는 부족하다는 것이 2026-08-14 에 드러났다: 확인과 게시 사이가 `await` 이라
 * **tick 이 겹치면 여러 tick 이 모두 "아직 없다"를 보고 각자 게시한다.** 겹침 자체를 없애는
 * 것이 유일한 방어라 타이머는 `tick` 이 아니라 `createTicker` 에 건다.
 *
 * ── 하루 한 번을 원할 때 ────────────────────────────────────────────────────
 * 위 dedup 은 **발화 시각** 단위다. 그래서 cron 에 시각을 여러 개 적으면 그만큼 돈다. "하루
 * 한 번인데, 못 돌았으면 나중에 다시"는 `oncePerDay` 로 표현한다 — 키에서 시각을 떼면
 * (cron.fireKey 의 `day` 스코프) 그 시각들이 예비 시각이 된다.
 */

import type { JobStore } from "../core/queue/jobStore.js";
import { fireKey, lastFireAt, type ParsedCron, parseCron } from "./cron.js";

export interface ScheduleDef {
  id: string;
  cron: string;
  enabled: boolean;
  /** DM 채널 ID. 브리핑 루트 메시지와 결과가 여기 붙는다. */
  channel: string;
  /** 요청자로 기록될 Slack 유저 ID — chat 핸들러의 ACL·프롬프트 머리말에 쓰인다. */
  userId: string;
  /** 스레드 루트로 올릴 한 줄. */
  rootText: string;
  /** 세션에 물릴 프롬프트 파일(레포 루트 기준 상대경로). */
  promptFile: string;
  /**
   * 하루 한 번만 실제로 돈다. cron 의 여러 시각은 **예비 시각**이 된다 — 먼저 성공한 하나가
   * 그날 몫을 가져가고 나머지는 dedup 이 거절한다(cron.fireKey 의 `day` 스코프).
   */
  oncePerDay?: boolean;
}

export interface LoadedSchedule extends ScheduleDef {
  parsed: ParsedCron;
  prompt: string;
}

/**
 * 스케줄 정의 검증 (순수). **조용히 안 울리는 스케줄이 최악**이라 문제를 전부 모아 돌려준다 —
 * 부팅에서 한 번에 드러내고, 고칠 것을 다 보여준다.
 */
export function validateSchedules(
  defs: unknown,
  readPrompt: (file: string) => string | null,
): { schedules: LoadedSchedule[]; errors: string[] } {
  const errors: string[] = [];
  const schedules: LoadedSchedule[] = [];
  if (!Array.isArray(defs)) return { schedules, errors: ["schedules.json 최상위가 배열이 아니다"] };

  const seen = new Set<string>();
  for (const raw of defs) {
    const d = raw as Partial<ScheduleDef>;
    const id = typeof d.id === "string" ? d.id : "";
    if (!id) {
      errors.push("id 없는 항목");
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${id}: id 중복 — 뒤엣것이 앞엣것의 dedup_key 를 먹는다`);
      continue;
    }
    seen.add(id);
    if (d.enabled !== true) continue; // 꺼진 건 검증 대상이 아니다

    const parsed = typeof d.cron === "string" ? parseCron(d.cron) : null;
    if (!parsed) errors.push(`${id}: cron 파싱 실패 (${String(d.cron)})`);
    for (const key of ["channel", "userId", "rootText", "promptFile"] as const) {
      if (!d[key]) errors.push(`${id}: ${key} 없음`);
    }
    const prompt = d.promptFile ? readPrompt(d.promptFile) : null;
    if (d.promptFile && prompt === null) errors.push(`${id}: 프롬프트 파일 없음 (${d.promptFile})`);

    if (parsed && prompt && d.channel && d.userId && d.rootText && d.promptFile) {
      schedules.push({
        id,
        cron: d.cron as string,
        enabled: true,
        channel: d.channel,
        userId: d.userId,
        rootText: d.rootText,
        promptFile: d.promptFile,
        oncePerDay: d.oncePerDay === true,
        parsed,
        prompt,
      });
    }
  }
  return { schedules, errors };
}

export interface SchedulerDeps {
  schedules: readonly LoadedSchedule[];
  jobs: Pick<JobStore, "enqueue" | "getByDedupKey">;
  /** 스레드 루트 게시 → ts. 실패하면 throw. */
  postRoot(args: { channel: string; text: string }): Promise<string>;
  now?: () => Date;
  log?: (msg: string) => void;
  /** chat 잡 재시도 상한 — 브리핑은 비싸서 낮게 잡는다. */
  maxAttempts?: number;
}

/**
 * 한 번의 tick. 발화가 지난 스케줄을 큐에 넣는다.
 *
 * 반환값은 이번 tick 에 **실제로 새로 넣은** 스케줄 id 들 — 로그·테스트가 "울렸다"를 확인하는
 * 유일한 근거다(중복 거절은 여기 안 들어간다).
 */
export async function tick(deps: SchedulerDeps): Promise<string[]> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const fired: string[] = [];

  for (const s of deps.schedules) {
    const at = lastFireAt(s.parsed, now);
    if (!at) continue;
    const dedupKey = fireKey(s.id, at, s.oncePerDay ? "day" : "fire");

    // 이미 처리된 발화면 조용히 넘어간다 — 따라잡기 설계상 같은 발화가 매 tick 계산되는 것이
    // 정상이다. **게시 전에 확인하는 것이 핵심** — 순서를 뒤집으면 중복 발화마다 DM 에
    // 고아 루트가 하나씩 쌓인다.
    //
    // 다만 이 확인만으로는 부족하다: 확인과 게시 사이에 `await` 이 있어서, tick 이 겹치면
    // 여러 tick 이 모두 "아직 없다"를 보고 각자 게시한다(createTicker 참조).
    if (deps.jobs.getByDedupKey(dedupKey)) continue;

    let ts: string;
    try {
      ts = await deps.postRoot({ channel: s.channel, text: s.rootText });
    } catch (err) {
      // 루트가 없으면 chat 핸들러가 답을 달 자리가 없다. 큐에 넣지 않고 다음 tick 에 다시
      // 시도한다 — dedup_key 는 발화 시각 기준이라 lookback 안에서는 재시도가 성립한다.
      log(`schedule 루트 게시 실패 — ${s.id}: ${String(err)}`);
      continue;
    }

    const outcome = deps.jobs.enqueue({
      type: "chat",
      dedupKey,
      lane: "automation",
      laneKey: s.channel,
      maxAttempts: deps.maxAttempts ?? 2,
      payload: {
        schema_version: 1,
        channel: s.channel,
        ts,
        threadTs: ts,
        threadKey: `${s.channel}:${ts}`,
        userId: s.userId,
        text: s.prompt,
        files: [],
      },
    });
    if (outcome.enqueued) {
      fired.push(s.id);
      log(`schedule 발화 — ${s.id} @ ${at.toISOString()} thread=${s.channel}:${ts}`);
    } else {
      // 게시는 됐는데 잡은 거절됐다 = 방금 올린 루트가 고아다. 지울 수는 없으니(chat:write
      // 만으로는 남의 눈에 이미 보인 메시지를 되돌리지 못한다) **드러내기라도 한다** —
      // 이 줄이 로그에 있으면 DM 에 중복 루트가 하나 쌓였다는 뜻이다.
      log(`schedule 고아 루트 — ${s.id} @ ${at.toISOString()} ts=${ts} (잡은 중복으로 거절됨)`);
    }
  }
  return fired;
}

/**
 * 재진입 가드를 두른 tick. **타이머에는 반드시 이걸 건다 — 맨 `tick` 을 직접 걸면 안 된다.**
 *
 * tick 안에는 `postRoot` 라는 네트워크 await 이 있다. 평소엔 수백 ms 라 1분 간격이 겹칠 일이
 * 없지만, 슬랙이 안 닿으면(DNS 실패·타임아웃) Slack SDK 의 내부 재시도까지 겹쳐 한 번의
 * postRoot 가 수 분을 붙든다. 그동안 타이머는 계속 새 tick 을 던지고, 각 tick 은 "아직 잡이
 * 없다"를 똑같이 보고 각자 게시를 예약한다. 네트워크가 돌아오는 순간 **밀려 있던 게시가 전부
 * 한꺼번에 성공** — DM 에 같은 루트 메시지가 수십 개 쏟아지고, 그중 하나만 잡이 되고 나머지는
 * dedup_key UNIQUE 에 거절돼 고아로 남는다. (2026-08-14 실측: 09:20~10:20 DNS 장애 구간에서
 * 한 스케줄의 루트 게시 시도 37회.)
 *
 * dedup_key 는 이걸 못 막는다 — 중복을 막는 자리가 `enqueue` 라서, **이미 게시된 메시지**는
 * 되돌릴 수 없기 때문이다. 그래서 겹침 자체를 없앤다: 앞 tick 이 끝나기 전엔 새 tick 을 아예
 * 시작하지 않는다. 발화를 놓칠 걱정은 없다 — lastFireAt 이 6시간을 소급하므로 다음 tick 이
 * 같은 발화를 다시 잡는다.
 */
export function createTicker(deps: SchedulerDeps): () => Promise<string[]> {
  let running = false;
  return async () => {
    if (running) return [];
    running = true;
    try {
      return await tick(deps);
    } finally {
      running = false;
    }
  };
}
