import { DatabaseSync } from "node:sqlite";

/**
 * 경로 주입 팩토리 — 테스트(':memory:')와 운영(파일)이 같은 코드 경로를 쓴다 (인메모리 필수 상태 금지, OPS-13).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL: 파일 DB에서 reader가 writer를 막지 않게. :memory:는 memory 모드로 응답할 뿐 무해.
  db.exec("PRAGMA journal_mode = WAL");
  // BEGIN IMMEDIATE 경합(외부 CLI 점검 등) 시 즉시 SQLITE_BUSY로 죽지 않게 대기 상한을 둔다.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
