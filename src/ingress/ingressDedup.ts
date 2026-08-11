/**
 * Ingress 이벤트 멱등 클레임 — 처리한 (channel, ts) envelope 을 UNIQUE 로 한 번만 통과시킨다.
 *
 * chat 잡은 jobStore 의 dedup_key UNIQUE 가 재전송을 무해화하지만, acl 거부 안내·'/'
 * 커맨드 즉답은 잡 파이프라인을 타지 않아 그 보호막 밖에 있었다. Slack 의 3초 ack 지연
 * 재전송이 같은 envelope 을 다시 보내면 안내가 두 번 게시되거나 '/run' 같은 부작용 커맨드가
 * 이중 실행됐다 (JQ-08 계약 위반). handleEvent 최상단에서 이 테이블에 한 줄을 선점(claim)해
 * 세 경로 전부를 같은 스키마 기반 dedup(JQ-02) 아래로 모은다.
 *
 * jobs 테이블에 sentinel 행을 넣지 않는 이유: dispatcher 가 미등록 타입으로 claim →
 * 즉시 failed 처리해 감사 로그/지표를 오염시킨다. 별도 경량 테이블이 옳다 (JQ-14 alert_dedup 선례).
 *
 * 영속(SQLite): 재시작 직후 재전송이 도착해도 무해화가 유지된다 — 인메모리 필수 상태 금지(OPS-13).
 */
import type { DatabaseSync } from "node:sqlite";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface IngressDedup {
  /**
   * envelope 키를 선점한다. true = 이번이 첫 처리(진행) / false = 이미 처리됨(재전송 — skip).
   * INSERT OR IGNORE 로 UNIQUE 충돌을 원자 판정 — 휴리스틱이 아니라 스키마가 무해화한다.
   */
  claim(key: string): boolean;
  /** 보존기간 경과분 삭제 — 테이블 무한 증가 방지. Slack 재전송 창은 분 단위라 짧게 잡아도 안전. */
  purge(retentionDays: number): number;
}

export function createIngressDedup(db: DatabaseSync): IngressDedup {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ingress_dedup (
      dedup_key  TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (${NOW_SQL})
    );
  `);

  const claimStmt = db.prepare("INSERT OR IGNORE INTO ingress_dedup (dedup_key) VALUES (?)");
  const purgeStmt = db.prepare(
    `DELETE FROM ingress_dedup WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
  );

  return {
    claim(key) {
      return Number(claimStmt.run(key).changes) === 1;
    },
    purge(retentionDays) {
      return Number(purgeStmt.run(`-${retentionDays} days`).changes);
    },
  };
}
