/**
 * 진행 카드 상태 문구 회전 (EG-02) — research-bot status-pool.ts 이식.
 *
 * 정적 "작업 준비 중…" 대신, 신규/이어가기(resume)에 맞는 풀에서 문구를 회전시키고
 * 현재 모델 라벨을 접미사로 붙인다. 페르소나는 없으므로 톤은 중립으로 둔다.
 * 직전 인덱스는 한 번 회피해 같은 문구가 연속으로 보이는 깜빡임을 줄인다.
 */

export const STATUS_POOL = {
  fresh: ["처리 중…", "확인 중…", "레포 살펴보는 중…", "분석 중…", "정리 중…"],
  resume: ["이어가는 중…", "맥락 다시 확인 중…", "이전 내용 이어보는 중…"],
} as const;

/** 긴 모델 ID 를 카드에 보일 짧은 라벨로. 알 수 없는 값은 그대로 노출(디버깅 단서). */
export function shortModelLabel(model: string | null | undefined): string {
  if (!model) return "";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("fable")) return "fable";
  return model;
}

/** rand 는 주입 가능 — 테스트에서 회전 순서를 결정론적으로 검증하기 위한 필수 주입점. */
export function pickStatusIndex(
  poolLength: number,
  lastIdx: number,
  rand: () => number = Math.random,
): number {
  if (poolLength <= 0) return -1;
  let idx = Math.floor(rand() * poolLength);
  if (idx >= poolLength) idx = poolLength - 1; // rand()===1 방어
  if (idx < 0) idx = 0;
  if (poolLength > 1 && idx === lastIdx) idx = (idx + 1) % poolLength;
  return idx;
}

export interface StatusPickerOptions {
  /**
   * resume 풀/신규 풀 선택. 함수를 주면 매 호출마다 평가한다 — 세션 만료로 resume→fresh
   * 전환이 일어나도 카드 문구가 실제 실행 상태를 따라가게 하려는 것이 함수 형태의 이유다.
   */
  isResume: boolean | (() => boolean);
  model?: string | null;
  rand?: () => number;
}

/** 풀이 비어 다음 인덱스를 못 뽑을 때의 안전 문구 (공개 API 오용 방어, EG-02). */
const FALLBACK_STATUS = "처리 중…";

/**
 * 매 호출마다 다음 상태 문구를 반환하는 picker 를 만든다.
 * 진행 카드의 headerFn 으로 넘기면 실제 Slack 갱신(flush)마다 문구가 회전한다
 * — rate-limit 으로 억제된 addTool 은 회전을 진행시키지 않는다(회전=관측 가능한 갱신 기준).
 */
export function createStatusPicker(opts: StatusPickerOptions): () => string {
  const isResumeFn = typeof opts.isResume === "function" ? opts.isResume : () => opts.isResume;
  const label = shortModelLabel(opts.model);
  const suffix = label ? ` · ${label}` : "";
  const rand = opts.rand ?? Math.random;
  let lastIdx = -1;
  return () => {
    const pool = isResumeFn() ? STATUS_POOL.resume : STATUS_POOL.fresh;
    lastIdx = pickStatusIndex(pool.length, lastIdx, rand);
    const text = lastIdx >= 0 && lastIdx < pool.length ? pool[lastIdx] : FALLBACK_STATUS;
    return `_⏳ ${text}${suffix}_`;
  };
}

export interface PlainStatusOptions {
  /** resume 풀/신규 풀 선택 (평문이라 회전 picker 와 달리 boolean 만 받는다). */
  isResume: boolean;
  model?: string | null;
  rand?: () => number;
}

/**
 * Slack assistant.threads.setStatus 용 평문 상태 1건을 만든다 (도구 없이도 처리 중임을 표시).
 *
 * createStatusPicker 와 STATUS_POOL·shortModelLabel 을 공유하되, 반환은 마크다운/⏳ 없이
 * `"분석 중… · sonnet"` 형태다 — Slack 이 상태에 자체 스피너를 붙이므로 이모지를 넣지 않는다.
 * 회전이 아닌 1건 스냅샷이므로 직전-회피 없이 lastIdx=-1 로 한 번만 뽑는다.
 */
export function pickPlainStatus(opts: PlainStatusOptions): string {
  const pool = opts.isResume ? STATUS_POOL.resume : STATUS_POOL.fresh;
  const idx = pickStatusIndex(pool.length, -1, opts.rand ?? Math.random);
  const text = idx >= 0 && idx < pool.length ? pool[idx] : FALLBACK_STATUS;
  const label = shortModelLabel(opts.model);
  const suffix = label ? ` · ${label}` : "";
  return `${text}${suffix}`;
}
