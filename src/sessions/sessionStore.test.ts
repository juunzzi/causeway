import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionStore,
  parseThreadKey,
  type SessionStore,
  threadKey,
} from "./sessionStore.js";

describe("threadKey / parseThreadKey (순수)", () => {
  it("channel:thread_ts 로 조립하고 되돌린다", () => {
    const key = threadKey("C123ABC", "1720000000.123456");
    expect(key).toBe("C123ABC:1720000000.123456");
    expect(parseThreadKey(key)).toEqual({ channel: "C123ABC", threadTs: "1720000000.123456" });
  });

  it("형식이 깨진 키는 null", () => {
    expect(parseThreadKey("nocolon")).toBeNull();
    expect(parseThreadKey(":ts-only")).toBeNull();
    expect(parseThreadKey("channel-only:")).toBeNull();
  });
});

describe("sessionStore (:memory: SQLite)", () => {
  let db: DatabaseSync;
  let store: SessionStore;
  const key = threadKey("C123ABC", "1720000000.000100");

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    store = createSessionStore(db);
  });

  it("upsert → get 왕복", () => {
    store.upsert({ threadKey: key, sessionId: "sess-1", cwd: "/workspace" });
    expect(store.get(key)).toEqual({
      threadKey: key,
      sessionId: "sess-1",
      cwd: "/workspace",
      lastSeenTs: "",
      modelOverride: null,
    });
  });

  it("없는 키는 null", () => {
    expect(store.get("C999:1.2")).toBeNull();
  });

  it("upsert 2회는 세션을 덮되 model_override 는 보존한다", () => {
    store.upsert({ threadKey: key, sessionId: "sess-1", cwd: "/a" });
    store.setModelOverride(key, "opus");
    store.upsert({ threadKey: key, sessionId: "sess-2", cwd: "/b" });
    const rec = store.get(key);
    expect(rec?.sessionId).toBe("sess-2");
    expect(rec?.cwd).toBe("/b");
    expect(rec?.modelOverride).toBe("opus");
  });

  it("세션 만료 흐름: drop 후 신규 upsert 가 새 세션으로 조회된다 (SC-04)", () => {
    store.upsert({ threadKey: key, sessionId: "expired", cwd: "/w" });
    store.drop(key);
    expect(store.get(key)).toBeNull();
    store.upsert({ threadKey: key, sessionId: "fresh", cwd: "/w" });
    expect(store.get(key)?.sessionId).toBe("fresh");
  });

  it("last_seen_ts 갱신", () => {
    store.upsert({ threadKey: key, sessionId: "s", cwd: "/w" });
    store.setLastSeenTs(key, "1720000001.000200");
    expect(store.get(key)?.lastSeenTs).toBe("1720000001.000200");
  });

  it("세션이 아직 없어도 model override 를 기록하고, get 은 null 을 유지한다", () => {
    store.setModelOverride(key, "sonnet");
    expect(store.get(key)).toBeNull(); // session_id='' 는 resume 대상이 아니다
    expect(store.getModelOverride(key)).toBe("sonnet");
    store.upsert({ threadKey: key, sessionId: "s", cwd: "/w" });
    expect(store.get(key)?.modelOverride).toBe("sonnet");
  });

  it("model override 해제(null)", () => {
    store.setModelOverride(key, "opus");
    store.setModelOverride(key, null);
    expect(store.getModelOverride(key)).toBeNull();
  });

  describe("listRecentThreads (RS-04 지원)", () => {
    it("최근 관여 스레드만 최신순으로 돌려준다", () => {
      store.upsert({ threadKey: "C1:100.1", sessionId: "a", cwd: "/w" });
      store.upsert({ threadKey: "C2:200.2", sessionId: "b", cwd: "/w" });
      // 오래된 스레드 시뮬레이션 — updated_at 을 2시간 전으로 직접 조작
      db.prepare(
        "UPDATE sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-7200 seconds') WHERE thread_key = ?",
      ).run("C1:100.1");
      expect(store.listRecentThreads(3600)).toEqual([{ channel: "C2", threadTs: "200.2" }]);
    });

    it("형식이 깨진 thread_key 행은 건너뛴다", () => {
      db.prepare("INSERT INTO sessions (thread_key, session_id) VALUES ('broken-key', 's')").run();
      store.upsert({ threadKey: "C3:300.3", sessionId: "c", cwd: "/w" });
      expect(store.listRecentThreads(3600)).toEqual([{ channel: "C3", threadTs: "300.3" }]);
    });
  });
});
