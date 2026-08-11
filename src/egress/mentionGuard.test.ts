import { describe, expect, it } from "vitest";
import { guardMentions } from "./mentionGuard.js";

describe("guardMentions", () => {
  it("요청자 멘션은 그대로 유지", () => {
    const res = guardMentions("<@U111> 확인 부탁드립니다", { allowedUserIds: ["U111"] });
    expect(res.text).toBe("<@U111> 확인 부탁드립니다");
    expect(res.blockedUserIds).toEqual([]);
  });

  it("평문 raw ID(@U0DDDDDDDDD)는 아는 이름으로 교정 — 차단이 아니라 표기 문제", () => {
    const res = guardMentions("@U0DDDDDDDDD님 요청하신 내용입니다", {
      allowedUserIds: ["U0DDDDDDDDD"],
      nameByUserId: new Map([["U0DDDDDDDDD", "홍길동"]]),
    });
    expect(res.text).toBe("@홍길동님 요청하신 내용입니다");
    expect(res.blockedUserIds).toEqual([]);
  });

  it("이름을 모르는 평문 raw ID 는 건드리지 않는다", () => {
    const res = guardMentions("@U0DDDDDDDDD 님", { allowedUserIds: [] });
    expect(res.text).toBe("@U0DDDDDDDDD 님");
  });

  it("살아남은 요청자 멘션 토큰은 평문 교정에 걸리지 않는다", () => {
    const res = guardMentions("<@U111> 확인 부탁", {
      allowedUserIds: ["U111"],
      nameByUserId: new Map([["U111", "홍길동"]]),
    });
    expect(res.text).toBe("<@U111> 확인 부탁");
  });

  it("요청자 외 멘션은 이름 평문화 (매핑 테이블 우선)", () => {
    const res = guardMentions("<@U222> 님이 담당입니다", {
      allowedUserIds: ["U111"],
      nameByUserId: new Map([["U222", "철수"]]),
    });
    expect(res.text).toBe("@철수 님이 담당입니다");
    expect(res.blockedUserIds).toEqual(["U222"]);
  });

  it("매핑이 없으면 <@U|name> 인라인 이름 사용", () => {
    const res = guardMentions("<@U333|영희> 확인", { allowedUserIds: [] });
    expect(res.text).toBe("@영희 확인");
    expect(res.blockedUserIds).toEqual(["U333"]);
  });

  it("이름 정보가 전혀 없으면 ID 를 평문화", () => {
    const res = guardMentions("<@U444> 에게", { allowedUserIds: [] });
    expect(res.text).toBe("@U444 에게");
  });

  it("같은 유저 복수 멘션은 차단 목록에 1회만", () => {
    const res = guardMentions("<@U555> 그리고 다시 <@U555>", { allowedUserIds: [] });
    expect(res.blockedUserIds).toEqual(["U555"]);
    expect(res.text).toBe("@U555 그리고 다시 @U555");
  });

  it("허용/차단 멘션 혼재", () => {
    const res = guardMentions("<@U111> 님, <@U222> 님과 공유해주세요", {
      allowedUserIds: ["U111"],
    });
    expect(res.text).toBe("<@U111> 님, @U222 님과 공유해주세요");
    expect(res.blockedUserIds).toEqual(["U222"]);
  });

  it("Enterprise W 프리픽스 ID 도 잡는다", () => {
    const res = guardMentions("<@W0ABC123> 확인", { allowedUserIds: [] });
    expect(res.text).toBe("@W0ABC123 확인");
    expect(res.blockedUserIds).toEqual(["W0ABC123"]);
  });

  it("브로드캐스트 멘션은 항상 해제", () => {
    const res = guardMentions("<!channel> 급합니다 <!here|@here>", { allowedUserIds: ["U111"] });
    expect(res.text).toBe("@channel 급합니다 @here");
    expect(res.blockedBroadcasts).toEqual(["channel", "here"]);
  });

  it("멘션 없는 텍스트는 그대로", () => {
    const res = guardMentions("멘션 없는 일반 답변", { allowedUserIds: ["U111"] });
    expect(res.text).toBe("멘션 없는 일반 답변");
    expect(res.blockedUserIds).toEqual([]);
    expect(res.blockedBroadcasts).toEqual([]);
  });
});
