import { describe, expect, it } from "vitest";
import { openDatabase } from "../core/db/connection.js";
import { createIngressDedup } from "./ingressDedup.js";

describe("ingressDedup", () => {
  it("첫 claim 은 true, 같은 키 재claim 은 false (스키마 UNIQUE 무해화)", () => {
    const dedup = createIngressDedup(openDatabase(":memory:"));
    expect(dedup.claim("slack:C1:100.1")).toBe(true);
    expect(dedup.claim("slack:C1:100.1")).toBe(false);
    expect(dedup.claim("slack:C1:100.1")).toBe(false);
  });

  it("서로 다른 키는 각각 첫 claim 에서 true", () => {
    const dedup = createIngressDedup(openDatabase(":memory:"));
    expect(dedup.claim("slack:C1:1.0")).toBe(true);
    expect(dedup.claim("slack:C1:2.0")).toBe(true);
    expect(dedup.claim("slack:C2:1.0")).toBe(true);
  });

  it("동일 db 재오픈(영속)에서도 이전 claim 이 유지된다 — 재시작 직후 재전송 무해화", () => {
    const db = openDatabase(":memory:");
    const first = createIngressDedup(db);
    expect(first.claim("slack:C1:9.9")).toBe(true);
    // 같은 커넥션에 재구성해도 CREATE TABLE IF NOT EXISTS 는 기존 행을 보존한다
    const again = createIngressDedup(db);
    expect(again.claim("slack:C1:9.9")).toBe(false);
  });

  it("purge 는 보존기간 경과분만 삭제한다", () => {
    const db = openDatabase(":memory:");
    const dedup = createIngressDedup(db);
    // 방금 claim 한 행(now)은 1일 보존 컷오프(now-1day)보다 최신이라 남는다.
    // 컷오프를 now 가 아닌 now-1day 로 잡아야 claim↔purge 사이의 ms 지터에 무관하게 결정적이다
    // (purge(0)=now 경계는 서브밀리초 레이스라 플래키했다).
    dedup.claim("slack:C1:recent");
    // 과거로 심은 행은 컷오프보다 오래돼 삭제된다.
    db.prepare(
      "INSERT INTO ingress_dedup (dedup_key, created_at) VALUES ('slack:C1:old', '2000-01-01T00:00:00.000Z')",
    ).run();
    expect(dedup.purge(1)).toBe(1);
    // recent 는 유지(재claim 불가), old 는 삭제(재claim 가능).
    expect(dedup.claim("slack:C1:recent")).toBe(false);
    expect(dedup.claim("slack:C1:old")).toBe(true);
  });
});
