import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOW_ALL,
  ConfigError,
  createChannelResolver,
  loadConfig,
  parseAccessJson,
  parseChannelsConfig,
} from "./loader.js";

const CHANNELS_YAML = `
channels:
  - logical: alarm-frontend-error
    id: C0000000001
    role: ops-notify
  - logical: fe-chapter
    id: C0000000004
    role: release-notify
`;

describe("parseChannelsConfig", () => {
  it("정상 yaml 을 파싱한다", () => {
    const channels = parseChannelsConfig(CHANNELS_YAML);
    expect(channels).toHaveLength(2);
    expect(channels[0]).toMatchObject({
      logical: "alarm-frontend-error",
      id: "C0000000001",
      role: "ops-notify",
    });
  });

  it("논리명 중복은 fail-fast", () => {
    const dup = `
channels:
  - { logical: same, id: C0000000001, role: ops-notify }
  - { logical: same, id: C0000000002, role: ops-notify }
`;
    expect(() => parseChannelsConfig(dup)).toThrow(ConfigError);
    expect(() => parseChannelsConfig(dup)).toThrow("논리명 중복");
  });

  it("같은 role 안의 채널 ID 중복은 fail-fast", () => {
    const dup = `
channels:
  - { logical: a, id: C0000000001, role: ops-notify }
  - { logical: b, id: C0000000001, role: ops-notify }
`;
    expect(() => parseChannelsConfig(dup)).toThrow("채널 ID 중복");
  });

  it("다른 role 끼리 같은 ID 를 쓰는 것은 허용 — 1인 운영 봇은 두 role 다 본인 DM 이다", () => {
    const shared = `
channels:
  - { logical: ops, id: D0000000001, role: ops-notify }
  - { logical: release, id: D0000000001, role: release-notify }
`;
    expect(parseChannelsConfig(shared)).toHaveLength(2);
  });

  it("스키마 위반 — 잘못된 role", () => {
    const bad = `
channels:
  - { logical: a, id: C0000000001, role: not-a-role }
`;
    expect(() => parseChannelsConfig(bad)).toThrow(ConfigError);
  });

  it("스키마 위반 — Slack ID 형식이 아닌 id", () => {
    const bad = `
channels:
  - { logical: a, id: general, role: ops-notify }
`;
    expect(() => parseChannelsConfig(bad)).toThrow(ConfigError);
  });

  it("스키마 위반 — 미지의 키(오타)는 거부한다", () => {
    const bad = `
channels:
  - { logical: a, id: C0000000001, role: watcher, jobtype: chat }
`;
    expect(() => parseChannelsConfig(bad)).toThrow(ConfigError);
  });

  it("yaml 문법 오류", () => {
    expect(() => parseChannelsConfig("channels: [ {")).toThrow("파싱 실패");
  });
});

describe("createChannelResolver", () => {
  const channels = parseChannelsConfig(CHANNELS_YAML);

  it("논리명 → ID 해석", () => {
    const resolver = createChannelResolver(channels);
    expect(resolver.idOf("fe-chapter")).toBe("C0000000004");
  });

  it("미선언 논리명은 throw — 하드코딩 ID 우회를 막는다", () => {
    const resolver = createChannelResolver(channels);
    expect(() => resolver.idOf("no-such-channel")).toThrow("선언되지 않은 논리 채널명");
  });

  it("role 별 조회", () => {
    const resolver = createChannelResolver(channels);
    expect(resolver.byRole("ops-notify").map((c) => c.logical)).toEqual(["alarm-frontend-error"]);
    expect(resolver.byRole("release-notify").map((c) => c.logical)).toEqual(["fe-chapter"]);
  });
});

describe("parseAccessJson", () => {
  it("정상 파싱", () => {
    expect(parseAccessJson('{"allowed":["U1"],"admins":[]}')).toEqual({
      allowed: ["U1"],
      admins: [],
    });
  });

  it("admins 키 누락은 스키마 위반", () => {
    expect(() => parseAccessJson('{"allowed":[]}')).toThrow(ConfigError);
  });

  it("미지의 키(오타)는 거부한다", () => {
    expect(() => parseAccessJson('{"allowed":[],"admins":[],"alowed":["U1"]}')).toThrow(
      ConfigError,
    );
  });

  it("allowed 의 와일드카드는 정상 — 워크스페이스 전원 허용 선언", () => {
    expect(parseAccessJson('{"allowed":["*"],"admins":["UA"]}')).toEqual({
      allowed: [ALLOW_ALL],
      admins: ["UA"],
    });
  });

  it("admins 의 와일드카드는 거부 — 관리 권한은 명시 지명만", () => {
    expect(() => parseAccessJson('{"allowed":["*"],"admins":["*"]}')).toThrow(ConfigError);
  });
});

describe("loadConfig (디렉토리 일괄 로드)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "causeway-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("두 파일이 모두 있으면 전부 로드하고 해석기를 세운다", () => {
    writeFileSync(join(dir, "channels.yaml"), CHANNELS_YAML);
    writeFileSync(join(dir, "access.json"), JSON.stringify({ allowed: ["U1"], admins: [] }));

    const config = loadConfig(dir);
    expect(config.channels).toHaveLength(2);
    expect(config.access).toEqual({ allowed: ["U1"], admins: [] });
    expect(config.resolver.idOf("alarm-frontend-error")).toBe("C0000000001");
  });

  it("channels.yaml 부재는 빈 구성으로 허용한다 (선택 파일)", () => {
    writeFileSync(join(dir, "access.json"), JSON.stringify({ allowed: [], admins: [] }));
    expect(loadConfig(dir).channels).toEqual([]);
  });

  it("access.json 부재는 null — acl 이 fail-closed 로 처리한다", () => {
    const config = loadConfig(dir);
    expect(config.access).toBeNull();
  });

  it("존재하는 파일의 내용 위반은 그대로 fail-fast", () => {
    writeFileSync(
      join(dir, "channels.yaml"),
      "channels:\n  - { logical: a, id: C0000000001, role: ops-notify }\n  - { logical: a, id: C0000000002, role: ops-notify }\n",
    );
    expect(() => loadConfig(dir)).toThrow("논리명 중복");
  });
});
