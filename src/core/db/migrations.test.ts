import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";
import { migrate, readUserVersion } from "./migrations.js";

describe("connection + migrations", () => {
  it(":memory: DB를 열고 최신 스키마를 적용한다", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    expect(readUserVersion(db)).toBe(3);
    const jobs = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
      .all();
    expect(jobs).toHaveLength(1);
    // v2: watcher_cursor — 채널별 커서 백필의 마지막 처리 ts (JQ-10).
    const cursor = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watcher_cursor'")
      .all();
    expect(cursor).toHaveLength(1);
    // v3: daily_report_snapshot — 데일리 리포트 전일 diff 소비(SK-10).
    const snapshot = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_report_snapshot'",
      )
      .all();
    expect(snapshot).toHaveLength(1);
  });

  it("파일 DB는 WAL 저널 모드로 열린다", () => {
    const dir = mkdtempSync(join(tmpdir(), "causeway-db-"));
    try {
      const db = openDatabase(join(dir, "queue.db"));
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrate 재실행은 no-op — user_version이 그대로다", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    migrate(db);
    expect(readUserVersion(db)).toBe(3);
  });

  it("dedup_key UNIQUE 제약이 스키마에 존재한다", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const insert = db.prepare(
      `INSERT INTO jobs (type, dedup_key, lane, payload, max_attempts, created_at, updated_at)
       VALUES ('t', 'same-key', 'automation', '{}', 1, 0, 0)`,
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/i);
  });

  it("코드보다 새로운 user_version이면 거부한다", () => {
    const db = openDatabase(":memory:");
    db.exec("PRAGMA user_version = 999");
    expect(() => migrate(db)).toThrow(/새롭다/);
  });
});
