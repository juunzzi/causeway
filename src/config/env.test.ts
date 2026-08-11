import { describe, expect, it } from "vitest";
import { ENV_DEFAULTS, EnvError, loadEnv, parsePathList } from "./env.js";

const VALID = {
  SLACK_BOT_TOKEN: "xoxb-123-abc",
  SLACK_APP_TOKEN: "xapp-1-A1-xyz",
};

describe("loadEnv (SEC-20 순수 로더)", () => {
  it("필수값 + 기본값으로 해석한다", () => {
    const env = loadEnv(VALID);
    expect(env.slackBotToken).toBe("xoxb-123-abc");
    expect(env.slackAppToken).toBe("xapp-1-A1-xyz");
    expect(env.dbPath).toBe(ENV_DEFAULTS.CAUSEWAY_DB_PATH);
    expect(env.workspaceDir).toBe(ENV_DEFAULTS.CAUSEWAY_WORKSPACE_DIR);
    expect(env.configDir).toBe(ENV_DEFAULTS.CAUSEWAY_CONFIG_DIR);
    expect(env.referenceDirs).toEqual([]);
  });

  it("override 를 반영한다", () => {
    const env = loadEnv({
      ...VALID,
      CAUSEWAY_DB_PATH: "/data/bot.db",
      CAUSEWAY_WORKSPACE_DIR: "/srv/ws",
      CAUSEWAY_CONFIG_DIR: "/etc/causeway",
    });
    expect(env.dbPath).toBe("/data/bot.db");
    expect(env.workspaceDir).toBe("/srv/ws");
    expect(env.configDir).toBe("/etc/causeway");
  });

  it("누락은 전부 모아 한 번에 실패한다", () => {
    expect(() => loadEnv({})).toThrow(EnvError);
    try {
      loadEnv({});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("SLACK_BOT_TOKEN");
      expect(message).toContain("SLACK_APP_TOKEN");
    }
  });

  it("xoxp 토큰은 거부한다 — xoxb 전용 계약", () => {
    expect(() => loadEnv({ ...VALID, SLACK_BOT_TOKEN: "xoxp-user-token" })).toThrow(/xoxb/);
  });

  it("app 토큰 형식(xapp-)을 검증한다", () => {
    expect(() => loadEnv({ ...VALID, SLACK_APP_TOKEN: "xoxb-wrong" })).toThrow(/xapp/);
  });

  describe("참조 체크아웃 목록", () => {
    it("쉼표 구분 경로를 배열로 해석한다", () => {
      const env = loadEnv({
        ...VALID,
        CAUSEWAY_REFERENCE_DIRS: "/srv/your-repo, /srv/some-repo",
      });
      expect(env.referenceDirs).toEqual(["/srv/your-repo", "/srv/some-repo"]);
    });

    it("빈 항목은 버린다 — 빈 문자열이 cwd 로 해석되는 사고 방지", () => {
      expect(parsePathList("/a,,  ,/b,")).toEqual(["/a", "/b"]);
      expect(parsePathList("")).toEqual([]);
      expect(parsePathList(undefined)).toEqual([]);
    });
  });

  describe("도구 자격증명은 여기서 읽지 않는다 (게이트 단일화)", () => {
    it("도구별 자격증명 env 는 AppEnv 에 실리지 않는다 — 각 도구 모듈이 직접 읽는다", () => {
      const env = loadEnv({
        ...VALID,
        MYTOOL_BASE_URL: "https://mytool.example",
        MYTOOL_CLIENT_ID: "svc",
        MYTOOL_PUBLIC_KEY: "pk",
      });
      // 각 도구 모듈이 process.env 를 직접 읽는다 — 게이트가 두 곳에 갈라지면
      // "env 는 있는데 도구는 없다"가 진단 불가능해진다(env.ts 헤더).
      expect(Object.keys(env).sort()).toEqual([
        "configDir",
        "dbPath",
        "referenceDirs",
        "slackAppToken",
        "slackBotToken",
        "workspaceDir",
      ]);
    });
  });
});
