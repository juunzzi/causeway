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
 * 중복 발화면 게시한 루트가 고아가 된다** — 그래서 순서를 뒤집어 `enqueue` 를 먼저 시도하고
 * 새 잡일 때만 게시한다. 게시 실패 시엔 잡을 취소해 "루트 없는 브리핑"이 남지 않게 한다.
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
    const dedupKey = fireKey(s.id, at);

    // 이미 처리된 발화면 조용히 넘어간다 — 따라잡기 설계상 같은 발화가 매 tick 계산되는 것이
    // 정상이다. **게시 전에 확인하는 것이 핵심** — 순서를 뒤집으면 중복 발화마다 DM 에
    // 고아 루트가 하나씩 쌓인다.
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
    }
  }
  return fired;
}
