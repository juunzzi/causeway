import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcl, isAdminIn, isAllowedIn, isExternalTeam } from "./acl.js";

const silent = { info: () => {}, error: () => {} };

describe("isAllowedIn / isAdminIn (순수, fail-closed)", () => {
  it("config 가 null 이면 무조건 false", () => {
    expect(isAllowedIn(null, "U1")).toBe(false);
    expect(isAdminIn(null, "U1")).toBe(false);
  });

  it("admin 은 allowed 목록에 없어도 허용된다", () => {
    const cfg = { allowed: ["U1"], admins: ["U9"] };
    expect(isAllowedIn(cfg, "U9")).toBe(true);
    expect(isAdminIn(cfg, "U9")).toBe(true);
    expect(isAdminIn(cfg, "U1")).toBe(false);
  });

  it("목록 밖 유저는 거부", () => {
    const cfg = { allowed: ["U1"], admins: [] };
    expect(isAllowedIn(cfg, "U2")).toBe(false);
  });
});

describe("와일드카드 전원 허용", () => {
  const openCfg = { allowed: ["*"], admins: ["U9"] };

  it("allowed 에 '*' 가 있으면 명단에 없는 유저도 허용", () => {
    expect(isAllowedIn(openCfg, "U_ANYONE")).toBe(true);
  });

  it("전원 허용이어도 admin 은 명시 지명뿐 — '*' 는 관리 권한을 주지 않는다", () => {
    expect(isAdminIn(openCfg, "U_ANYONE")).toBe(false);
    expect(isAdminIn(openCfg, "U9")).toBe(true);
  });

  it("개방 범위는 설치 워크스페이스까지 — 다른 팀(Slack Connect 외부 조직)은 거부", () => {
    expect(isAllowedIn(openCfg, "U_EXT", { userTeamId: "T_OTHER", botTeamId: "T_HOME" })).toBe(
      false,
    );
    expect(isAllowedIn(openCfg, "U_MEMBER", { userTeamId: "T_HOME", botTeamId: "T_HOME" })).toBe(
      true,
    );
  });

  it("팀 판정 근거가 없으면(payload 에 team 없음·auth.test 미제공) 막지 않는다", () => {
    expect(isAllowedIn(openCfg, "U_ANYONE", { userTeamId: null, botTeamId: "T_HOME" })).toBe(true);
    expect(isAllowedIn(openCfg, "U_ANYONE", { userTeamId: "T_OTHER", botTeamId: null })).toBe(true);
  });

  it("명시 등록 유저는 팀과 무관하게 통과 — 팀 범위는 와일드카드에만 적용", () => {
    const cfg = { allowed: ["U_EXT"], admins: [] };
    expect(isAllowedIn(cfg, "U_EXT", { userTeamId: "T_OTHER", botTeamId: "T_HOME" })).toBe(true);
  });

  it("config 가 null 이면 와일드카드 여지도 없다 — fail-closed 유지", () => {
    expect(isAllowedIn(null, "U_ANYONE", { userTeamId: "T_HOME", botTeamId: "T_HOME" })).toBe(
      false,
    );
  });

  it("isExternalTeam: 양쪽 팀 ID 가 모두 있고 다를 때만 외부", () => {
    expect(isExternalTeam({ userTeamId: "T_A", botTeamId: "T_B" })).toBe(true);
    expect(isExternalTeam({ userTeamId: "T_A", botTeamId: "T_A" })).toBe(false);
    expect(isExternalTeam({})).toBe(false);
    expect(isExternalTeam()).toBe(false);
  });
});

describe("createAcl (파일 로드·핫리로드)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "causeway-acl-"));
    path = join(dir, "access.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("파일이 없으면 fail-closed + 명확한 에러 로그", () => {
    const error = vi.fn();
    const acl = createAcl({ path, watch: false, logger: { info: () => {}, error } });
    expect(acl.isAllowed("U1")).toBe(false);
    expect(acl.current()).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toContain("fail-closed");
    acl.close();
  });

  it("정상 파일 로드 — allowed/admins 판정", () => {
    writeFileSync(path, JSON.stringify({ allowed: ["U1"], admins: ["U9"] }));
    const acl = createAcl({ path, watch: false, logger: silent });
    expect(acl.isAllowed("U1")).toBe(true);
    expect(acl.isAllowed("U9")).toBe(true);
    expect(acl.isAdmin("U9")).toBe(true);
    expect(acl.isAdmin("U1")).toBe(false);
    expect(acl.isAllowed("U_STRANGER")).toBe(false);
    acl.close();
  });

  it("핫리로드: 파일 갱신 후 reload() 가 새 명단을 반영한다", () => {
    // fs.watch 타이밍 대신 로더 함수 직접 호출로 검증 — watch 콜백도 같은 reload 를 부른다
    writeFileSync(path, JSON.stringify({ allowed: ["U1"], admins: [] }));
    const acl = createAcl({ path, watch: false, logger: silent });
    expect(acl.isAllowed("U2")).toBe(false);

    writeFileSync(path, JSON.stringify({ allowed: ["U1", "U2"], admins: ["U2"] }));
    acl.reload();
    expect(acl.isAllowed("U2")).toBe(true);
    expect(acl.isAdmin("U2")).toBe(true);
    acl.close();
  });

  it("리로드로 제거된 유저는 즉시 거부된다", () => {
    writeFileSync(path, JSON.stringify({ allowed: ["U1"], admins: [] }));
    const acl = createAcl({ path, watch: false, logger: silent });
    writeFileSync(path, JSON.stringify({ allowed: [], admins: [] }));
    acl.reload();
    expect(acl.isAllowed("U1")).toBe(false);
    acl.close();
  });

  it("손상된 파일로 리로드되면 이전 허용 상태를 버리고 fail-closed", () => {
    writeFileSync(path, JSON.stringify({ allowed: ["U1"], admins: [] }));
    const error = vi.fn();
    const acl = createAcl({ path, watch: false, logger: { info: () => {}, error } });
    expect(acl.isAllowed("U1")).toBe(true);

    writeFileSync(path, "{ not-json");
    acl.reload();
    expect(acl.isAllowed("U1")).toBe(false);
    expect(acl.current()).toBeNull();
    expect(error).toHaveBeenCalled();
    acl.close();
  });

  it("와일드카드 파일 로드 — 전원 허용 + 로그에 개방 사실을 남긴다", () => {
    writeFileSync(path, JSON.stringify({ allowed: ["*"], admins: ["U9"] }));
    const info = vi.fn();
    const acl = createAcl({ path, watch: false, logger: { info, error: () => {} } });
    expect(acl.isAllowed("U_ANYONE")).toBe(true);
    expect(acl.isAllowed("U_EXT", { userTeamId: "T_OTHER", botTeamId: "T_HOME" })).toBe(false);
    expect(acl.isAdmin("U_ANYONE")).toBe(false);
    expect(info.mock.calls[0]?.[0]).toContain("전원");
    acl.close();
  });

  it("admins 의 와일드카드는 스키마 위반 → fail-closed (관리 권한 개방 금지)", () => {
    writeFileSync(path, JSON.stringify({ allowed: [], admins: ["*"] }));
    const acl = createAcl({ path, watch: false, logger: silent });
    expect(acl.current()).toBeNull();
    expect(acl.isAdmin("U1")).toBe(false);
    expect(acl.isAllowed("U1")).toBe(false);
    acl.close();
  });

  it("스키마 위반(키 오타·누락)도 fail-closed", () => {
    writeFileSync(path, JSON.stringify({ alowed: ["U1"], admins: [] }));
    const acl = createAcl({ path, watch: false, logger: silent });
    expect(acl.isAllowed("U1")).toBe(false);
    acl.close();
  });
});
