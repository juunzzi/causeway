/**
 * thread_key(channel:thread_ts) ↔ session_id 영속 저장소.
 *
 * - user 는 키에 넣지 않는다 — 팀 공용 봇은 한 스레드에서 여러 사람이 이어 묻는 것이
 *   기본이다 (SC-01, 선행 구현과 다른 의도적 결정).
 * - 모델 override 까지 SQLite 에 둔다 — 인메모리 필수 상태 금지(OPS-13). 선행 구현은
 *   RunningTask/override 를 dict 로 들고 있다가 재시작 때 소실했다.
 * - DB 는 주입식(DatabaseSync) — 테스트는 ':memory:' 를 주입한다 (OPS-07).
 */
import type { DatabaseSync } from "node:sqlite";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** 채널 ID 에는 ':' 가 없고 thread_ts 는 '1234.5678' 형태 — 첫 ':' 기준 분리가 안전하다. */
export function parseThreadKey(key: string): { channel: string; threadTs: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx >= key.length - 1) return null;
  return { channel: key.slice(0, idx), threadTs: key.slice(idx + 1) };
}

export interface SessionRecord {
  threadKey: string;
  sessionId: string;
  cwd: string;
  lastSeenTs: string;
  modelOverride: string | null;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (SQLite 부작용)
// ────────────────────────────────────────────────────────────────────

export interface SessionStore {
  upsert(args: { threadKey: string; sessionId: string; cwd: string }): void;
  /** 세션이 없으면(모델 override 만 있는 행 포함) null — resume 대상이 아니다. */
  get(threadKey: string): SessionRecord | null;
  /**
   * 세션 만료('No conversation found' 등 resume 실패) 시 drop → 새 세션 upsert 가
   * 재시도 흐름이다 (SC-04). 행 전체 삭제 — override 도 함께 사라지는 것이 의도.
   */
  drop(threadKey: string): void;
  setLastSeenTs(threadKey: string, ts: string): void;
  /** null 이면 override 해제. 세션이 아직 없어도 기록된다(/model 을 먼저 친 스레드). */
  setModelOverride(threadKey: string, model: string | null): void;
  getModelOverride(threadKey: string): string | null;
  /**
   * 최근 관여 스레드 목록(최신순) — 좀비 probe 가 conversations.replies 로 놓친 답글을
   * 소급 수집할 때 대상을 좁힌다 (RS-04). conversations.history 는 채널 top-level 만
   * 돌려줘 일반 스레드 답글을 누락한다.
   */
  listRecentThreads(withinSeconds: number): Array<{ channel: string; threadTs: string }>;
}

/** 저장·비교 포맷을 같은 식으로 통일 — 'T'/' ' 포맷이 섞이면 문자열 비교가 깨진다. */
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function createSessionStore(db: DatabaseSync): SessionStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      thread_key     TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL DEFAULT '',
      cwd            TEXT NOT NULL DEFAULT '',
      last_seen_ts   TEXT NOT NULL DEFAULT '',
      model_override TEXT,
      created_at     TEXT NOT NULL DEFAULT (${NOW_SQL}),
      updated_at     TEXT NOT NULL DEFAULT (${NOW_SQL})
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO sessions (thread_key, session_id, cwd, updated_at)
    VALUES (?, ?, ?, ${NOW_SQL})
    ON CONFLICT(thread_key) DO UPDATE SET
      session_id = excluded.session_id,
      cwd = excluded.cwd,
      updated_at = excluded.updated_at
  `);
  const getStmt = db.prepare(
    "SELECT thread_key, session_id, cwd, last_seen_ts, model_override FROM sessions WHERE thread_key = ?",
  );
  const dropStmt = db.prepare("DELETE FROM sessions WHERE thread_key = ?");
  const lastSeenStmt = db.prepare(
    `UPDATE sessions SET last_seen_ts = ?, updated_at = ${NOW_SQL} WHERE thread_key = ?`,
  );
  const overrideStmt = db.prepare(`
    INSERT INTO sessions (thread_key, model_override, updated_at)
    VALUES (?, ?, ${NOW_SQL})
    ON CONFLICT(thread_key) DO UPDATE SET
      model_override = excluded.model_override,
      updated_at = excluded.updated_at
  `);
  const recentStmt = db.prepare(`
    SELECT thread_key FROM sessions
    WHERE updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    ORDER BY updated_at DESC
  `);

  return {
    upsert({ threadKey: key, sessionId, cwd }) {
      upsertStmt.run(key, sessionId, cwd);
    },
    get(key) {
      const row = getStmt.get(key) as
        | {
            thread_key: string;
            session_id: string;
            cwd: string;
            last_seen_ts: string;
            model_override: string | null;
          }
        | undefined;
      // session_id='' 는 override 만 먼저 기록된 행 — resume 할 세션이 아니다
      if (!row || row.session_id === "") return null;
      return {
        threadKey: row.thread_key,
        sessionId: row.session_id,
        cwd: row.cwd,
        lastSeenTs: row.last_seen_ts,
        modelOverride: row.model_override,
      };
    },
    drop(key) {
      dropStmt.run(key);
    },
    setLastSeenTs(key, ts) {
      lastSeenStmt.run(ts, key);
    },
    setModelOverride(key, model) {
      overrideStmt.run(key, model);
    },
    getModelOverride(key) {
      const row = getStmt.get(key) as { model_override: string | null } | undefined;
      return row?.model_override ?? null;
    },
    listRecentThreads(withinSeconds) {
      const seconds = Math.max(0, Math.floor(withinSeconds));
      const rows = recentStmt.all(`-${seconds} seconds`) as Array<{ thread_key: string }>;
      const out: Array<{ channel: string; threadTs: string }> = [];
      for (const r of rows) {
        const parsed = parseThreadKey(r.thread_key);
        if (parsed) out.push(parsed);
      }
      return out;
    },
  };
}
