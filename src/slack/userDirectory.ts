/**
 * Slack 유저 표시명 디렉토리 (EG-08) — `U0DDDDDDDDD` 를 사람 이름으로 바꾼다.
 *
 * 이름이 없으면 두 곳에서 raw ID 가 그대로 사람 눈에 닿는다:
 *  1) chat 프롬프트의 스레드 맥락(`[ts] U0DDDDDDDDD: ...`) → 모델이 답변에 그대로 옮겨 적는다.
 *  2) 멘션 게이트가 평문화한 `<@U...>` → `@U0DDDDDDDDD`.
 * 그래서 해석 결과는 프롬프트와 egress 양쪽에 같은 맵으로 흘린다.
 *
 * 계약: **절대 throw 하지 않는다.** 이름은 표시 품질이지 정확성이 아니다 — users.info 실패로
 * 답변 자체가 죽으면 안 되므로 실패는 로그 + ID 폴백(맵에서 빠짐)으로 흡수한다.
 */

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * users.info 의 user 객체에서 표시명 선택.
 *
 * 우선순위는 "슬랙에서 사람들이 서로를 부르는 이름"에 가까운 순서다:
 * profile.display_name(본인이 정한 표시명) → profile.real_name → real_name → name(핸들).
 * 봇 유저(is_bot)도 이름을 돌려준다 — 스레드 맥락에서 타 봇 발화를 식별하는 데 쓰인다.
 */
export function pickDisplayName(user: unknown): string | null {
  if (!isRecord(user)) return null;
  const profile = isRecord(user.profile) ? user.profile : {};
  return (
    nonEmpty(profile.display_name) ??
    nonEmpty(profile.real_name) ??
    nonEmpty(user.real_name) ??
    nonEmpty(user.name)
  );
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (Slack API 조회 + 캐시)
// ────────────────────────────────────────────────────────────────────

export type FetchUserName = (userId: string) => Promise<string | null>;

export interface UserDirectory {
  /** 아는 이름만 담아 돌려준다 — 미상/조회 실패는 키 자체가 없다(호출부가 ID 폴백). */
  namesFor(userIds: Iterable<string>): Promise<ReadonlyMap<string, string>>;
}

/** 표시명 캐시 TTL — 개명은 드물고, 매 턴 users.info 를 때리면 rate-limit 이 먼저 온다. */
export const NAME_CACHE_TTL_MS = 6 * 60 * 60_000;

/** 조회 실패(권한·rate-limit·삭제된 유저) 재시도 간격 — 성공 캐시보다 훨씬 짧게. */
export const NAME_NEGATIVE_TTL_MS = 5 * 60_000;

export function createUserDirectory(deps: {
  fetchUserName: FetchUserName;
  clock?: { now(): number };
  log?: (msg: string) => void;
}): UserDirectory {
  const now = (): number => (deps.clock ? deps.clock.now() : Date.now());
  const log = deps.log ?? (() => {});
  const cache = new Map<string, { name: string | null; at: number }>();
  // 같은 턴에 같은 유저가 여러 번 나와도 조회는 1회 — 스레드 참여자는 대개 반복 등장한다
  const inflight = new Map<string, Promise<string | null>>();

  function cached(userId: string): { name: string | null } | null {
    const hit = cache.get(userId);
    if (!hit) return null;
    const ttl = hit.name === null ? NAME_NEGATIVE_TTL_MS : NAME_CACHE_TTL_MS;
    if (now() - hit.at >= ttl) return null;
    return hit;
  }

  function resolve(userId: string): Promise<string | null> {
    const running = inflight.get(userId);
    if (running) return running;
    const task = deps
      .fetchUserName(userId)
      .catch((err) => {
        // 이름 해석 실패로 답변을 죽이지 않는다 — ID 폴백으로 계속 간다
        log(`userDirectory: 표시명 조회 실패 user=${userId} — ${String(err)}`);
        return null;
      })
      .then((name) => {
        cache.set(userId, { name, at: now() });
        inflight.delete(userId);
        return name;
      });
    inflight.set(userId, task);
    return task;
  }

  return {
    async namesFor(userIds) {
      const out = new Map<string, string>();
      const pending: string[] = [];
      for (const id of new Set(userIds)) {
        if (!id) continue;
        const hit = cached(id);
        if (hit === null) {
          pending.push(id);
        } else if (hit.name !== null) {
          out.set(id, hit.name);
        }
      }
      const resolved = await Promise.all(pending.map((id) => resolve(id)));
      pending.forEach((id, idx) => {
        const name = resolved[idx];
        if (name) out.set(id, name);
      });
      return out;
    },
  };
}
