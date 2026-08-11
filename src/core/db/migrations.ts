import type { DatabaseSync } from "node:sqlite";

/**
 * user_version 기반 순차 마이그레이션.
 * 제약: 배열은 append-only — 이미 배포된 DB가 지나간 항목을 고치면 스키마가 갈라진다.
 */
const MIGRATIONS: readonly string[] = [
  // v1: jobs — 내구 잡 큐. dedup_key UNIQUE가 중복 방지의 본체다(휴리스틱 아님, JQ-02).
  //     시각 컬럼은 전부 epoch ms INTEGER — 주입 클록과의 직접 비교를 위해 문자열 포맷을 피한다.
  `
  CREATE TABLE jobs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    type                 TEXT    NOT NULL,
    dedup_key            TEXT    NOT NULL UNIQUE,
    lane                 TEXT    NOT NULL CHECK (lane IN ('interactive', 'automation', 'write')),
    lane_key             TEXT,
    payload              TEXT    NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'inflight', 'done', 'failed', 'cancelled')),
    attempts             INTEGER NOT NULL DEFAULT 0,
    max_attempts         INTEGER NOT NULL,
    lease_id             TEXT,
    lease_expires_at     INTEGER,
    execution_started_at INTEGER,
    not_before           INTEGER,
    result               TEXT,
    error                TEXT,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_claim ON jobs (status, lane, not_before, id);
  `,
  // v2: watcher_cursor — 채널별 커서 백필의 '마지막 처리 ts'(JQ-10). 커서는 문자열 Slack ts 로
  //     저장한다(숫자 캐스팅은 정밀도 손실 위험). advanceCursor 는 전진만(monotonic) — 실시간과
  //     백필의 race 에도 역행하지 않는다. 인메모리 필수 상태 금지(OPS-13)라 SQLite 에 둔다.
  `
  CREATE TABLE watcher_cursor (
    channel    TEXT    NOT NULL PRIMARY KEY,
    cursor_ts  TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v3: daily_report_snapshot — 데일리 에러 리포트의 일자별 스냅샷(SK-10). '전일 대비 diff'
  //     ("어제 대비 변화")를 프롬프트에 주입하려면 어제 리포트의 정량 상태를 어딘가 남겨야 한다.
  //     report_date(KST 'YYYY-MM-DD')를 PRIMARY KEY 로 둬 하루 1건 upsert — 같은 날 재실행
  //     (절전 따라잡기·재시도)이 어제 스냅샷을 덮어쓰지 않고 오늘 것만 갱신한다. summary 는
  //     서비스별 에러 카운트/블로커를 담은 JSON(스키마는 snapshotStore 가 소유, DB 는 문자열만).
  `
  CREATE TABLE daily_report_snapshot (
    report_date TEXT    NOT NULL PRIMARY KEY,
    summary     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  `,
];

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

export function migrate(db: DatabaseSync): void {
  const current = readUserVersion(db);
  if (current > MIGRATIONS.length) {
    // 구버전 코드가 신버전 DB를 열면 조용한 스키마 오해가 생긴다 — 즉시 거부가 안전하다.
    throw new Error(
      `DB user_version(${current})이 코드가 아는 버전(${MIGRATIONS.length})보다 새롭다 — 코드/DB 버전을 맞춰라`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) continue;
    // 마이그레이션 도중 크래시가 절반 적용 스키마를 남기지 않도록 버전 갱신까지 한 트랜잭션.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
