import { describe, expect, it, vi } from "vitest";
import {
  createUserDirectory,
  NAME_CACHE_TTL_MS,
  NAME_NEGATIVE_TTL_MS,
  pickDisplayName,
} from "./userDirectory.js";

describe("pickDisplayName (순수)", () => {
  it("display_name → profile.real_name → real_name → name 순서로 고른다", () => {
    expect(
      pickDisplayName({
        name: "gildong",
        real_name: "홍길동",
        profile: { display_name: "홍길동_FE" },
      }),
    ).toBe("홍길동_FE");
    expect(pickDisplayName({ name: "gildong", profile: { real_name: "홍길동" } })).toBe("홍길동");
    expect(pickDisplayName({ name: "gildong", real_name: "홍길동" })).toBe("홍길동");
    expect(pickDisplayName({ name: "gildong" })).toBe("gildong");
  });

  it("빈 문자열·공백은 값이 없는 것으로 본다 (display_name 은 미설정 시 '')", () => {
    expect(pickDisplayName({ profile: { display_name: "   " }, real_name: "홍길동" })).toBe(
      "홍길동",
    );
    expect(pickDisplayName({ profile: {} })).toBeNull();
    expect(pickDisplayName(null)).toBeNull();
    expect(pickDisplayName("U1")).toBeNull();
  });
});

describe("createUserDirectory", () => {
  it("ID→이름 맵을 돌려주고, 미상 유저는 키 자체가 없다 (호출부 ID 폴백)", async () => {
    const dir = createUserDirectory({
      fetchUserName: async (id) => (id === "U1" ? "홍길동" : null),
    });
    const names = await dir.namesFor(["U1", "U2"]);
    expect(names.get("U1")).toBe("홍길동");
    expect(names.has("U2")).toBe(false);
  });

  it("같은 유저 반복·중복 요청은 조회 1회 (캐시 + 동시 요청 합류)", async () => {
    const fetchUserName = vi.fn(async () => "홍길동");
    const dir = createUserDirectory({ fetchUserName });

    const [a, b] = await Promise.all([dir.namesFor(["U1", "U1"]), dir.namesFor(["U1"])]);
    await dir.namesFor(["U1"]);

    expect(a.get("U1")).toBe("홍길동");
    expect(b.get("U1")).toBe("홍길동");
    expect(fetchUserName).toHaveBeenCalledTimes(1);
  });

  it("조회 실패는 흡수한다 — throw 없이 ID 폴백 + 로그", async () => {
    const logs: string[] = [];
    const dir = createUserDirectory({
      fetchUserName: async () => {
        throw new Error("ratelimited");
      },
      log: (m) => logs.push(m),
    });

    const names = await dir.namesFor(["U1"]);
    expect(names.size).toBe(0);
    expect(logs.some((l) => l.includes("표시명 조회 실패"))).toBe(true);
  });

  it("실패 캐시는 짧게 — 성공 TTL 전이라도 재조회하고, 성공 캐시는 TTL 동안 유지", async () => {
    let nowMs = 1_000;
    const fetchUserName = vi.fn(async (id: string) => (id === "U_OK" ? "홍길동" : null));
    const dir = createUserDirectory({ fetchUserName, clock: { now: () => nowMs } });

    await dir.namesFor(["U_OK", "U_MISS"]);
    expect(fetchUserName).toHaveBeenCalledTimes(2);

    nowMs += NAME_NEGATIVE_TTL_MS; // 실패만 만료
    await dir.namesFor(["U_OK", "U_MISS"]);
    expect(fetchUserName).toHaveBeenCalledTimes(3);
    expect(fetchUserName).toHaveBeenLastCalledWith("U_MISS");

    nowMs += NAME_CACHE_TTL_MS; // 성공도 만료
    await dir.namesFor(["U_OK"]);
    expect(fetchUserName).toHaveBeenLastCalledWith("U_OK");
  });
});
