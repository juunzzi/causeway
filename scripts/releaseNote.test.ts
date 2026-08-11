import { describe, expect, it } from "vitest";
import {
  formatReleaseNote,
  parseGitLog,
  parseRepoUrl,
  type RawCommit,
  toEntry,
} from "./releaseNote.js";

const REPO = "https://github.com/OWNER/REPO";

function commit(subject: string, body = "", sha = "a".repeat(40)): RawCommit {
  return { sha, subject, body };
}

describe("parseGitLog", () => {
  it("레코드/필드 구분자로 커밋을 나눈다", () => {
    const raw = `abc123\x1ffeat: 하나 (#1)\x1f본문\n둘째 줄\x1edef456\x1ffix: 둘 (#2)\x1f\x1e`;
    expect(parseGitLog(raw)).toEqual([
      { sha: "abc123", subject: "feat: 하나 (#1)", body: "본문\n둘째 줄" },
      { sha: "def456", subject: "fix: 둘 (#2)", body: "" },
    ]);
  });

  it("빈 입력은 빈 배열", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\x1e\n\x1e")).toEqual([]);
  });
});

describe("toEntry", () => {
  it("squash 커밋 — conventional 접두사와 (#NN) 를 떼고 PR 번호를 뽑는다", () => {
    expect(toEntry(commit("feat(mcp,chat): Analytics 를 커넥터로 처리 (#35)"))).toEqual({
      title: "Analytics 를 커넥터로 처리",
      pr: 35,
      silent: false,
    });
  });

  it("merge 커밋 — 제목이 아니라 본문 첫 줄이 PR 제목이다", () => {
    const c = commit(
      "Merge pull request #31 from OWNER/PROJ-929",
      "\nfeat(chat): 권한 요청 자동 처리\n\n상세 설명",
    );
    expect(toEntry(c)).toEqual({ title: "권한 요청 자동 처리", pr: 31, silent: false });
  });

  it("merge 커밋 본문이 비면 제목으로 폴백한다", () => {
    expect(toEntry(commit("Merge pull request #7 from OWNER/x")).pr).toBe(7);
  });

  it("PR 번호 없는 커밋도 제목만으로 한 줄이 된다", () => {
    expect(toEntry(commit("fix: 급한 핫픽스"))).toEqual({
      title: "급한 핫픽스",
      pr: null,
      silent: false,
    });
  });

  it("conventional 접두사가 없으면 제목을 그대로 쓴다", () => {
    expect(toEntry(commit("Analytics 커넥터 도입 (#35)")).title).toBe("Analytics 커넥터 도입");
  });

  it("chore/docs 류는 silent — 사람이 쓰는 방식이 안 바뀐다", () => {
    for (const type of ["chore", "ci", "docs", "test", "style", "build"]) {
      expect(toEntry(commit(`${type}: 정리 (#9)`)).silent).toBe(true);
    }
  });

  it("refactor 는 silent 가 아니다 — 동작 불변이 보장은 아니라 공지 쪽으로 기운다", () => {
    expect(toEntry(commit("refactor: 큐 정리 (#9)")).silent).toBe(false);
  });

  it("breaking(!) 표기도 접두사로 인식한다", () => {
    expect(toEntry(commit("feat(api)!: 스킬 인자 변경 (#12)")).title).toBe("스킬 인자 변경");
  });

  it("PR 없는 브랜치 머지는 silent — 제목이 아무 정보도 안 준다", () => {
    expect(toEntry(commit("Merge branch 'main' into hotfix")).silent).toBe(true);
  });
});

describe("formatReleaseNote", () => {
  it("PR 번호를 링크로 걸어 한 줄씩 적는다", () => {
    const note = formatReleaseNote(
      [commit("feat: 이벤트 카탈로그 조회 스킬 (#33)"), commit("fix: DM 유실 복구 (#34)")],
      { repoUrl: REPO },
    );
    expect(note).toBe(
      ":rocket: causeway 업데이트 — 재시작 완료\n" +
        `• 이벤트 카탈로그 조회 스킬 (<${REPO}/pull/33|#33>)\n` +
        `• DM 유실 복구 (<${REPO}/pull/34|#34>)`,
    );
  });

  it("repoUrl 을 모르면 링크 없이 번호만 적는다", () => {
    expect(formatReleaseNote([commit("feat: 무언가 (#3)")], { repoUrl: null })).toContain(
      "• 무언가 (#3)",
    );
  });

  it("알릴 것이 없으면 null — 재시작 사실만으로는 공지하지 않는다", () => {
    expect(formatReleaseNote([])).toBeNull();
    expect(
      formatReleaseNote([commit("chore: lockfile (#1)"), commit("docs: README (#2)")]),
    ).toBeNull();
  });

  it("silent 커밋이 섞여 있으면 나머지만 공지한다", () => {
    const note = formatReleaseNote([commit("chore: 정리 (#1)"), commit("feat: 새 스킬 (#2)")], {
      repoUrl: null,
    });
    expect(note).toBe(":rocket: causeway 업데이트 — 재시작 완료\n• 새 스킬 (#2)");
  });

  it("너무 길면 접는다", () => {
    const commits = Array.from({ length: 11 }, (_, i) => commit(`feat: 변경 ${i} (#${i + 1})`));
    const note = formatReleaseNote(commits, { repoUrl: null, maxItems: 3 });
    expect(note?.split("\n")).toHaveLength(5); // 헤더 + 3줄 + "…외 8건"
    expect(note).toContain("• …외 8건");
  });

  it("Slack 특수문자를 이스케이프한다", () => {
    expect(formatReleaseNote([commit("fix: <script> & 인용 (#1)")], { repoUrl: null })).toContain(
      "• &lt;script&gt; &amp; 인용 (#1)",
    );
  });
});

describe("parseRepoUrl", () => {
  it.each([
    ["git@github.com:OWNER/REPO.git", "https://github.com/OWNER/REPO"],
    ["ssh://git@github.com/OWNER/REPO.git", "https://github.com/OWNER/REPO"],
    ["https://github.com/OWNER/REPO.git", "https://github.com/OWNER/REPO"],
    ["https://x-token@github.com/OWNER/REPO", "https://github.com/OWNER/REPO"],
  ])("%s → %s", (remote, expected) => {
    expect(parseRepoUrl(remote)).toBe(expected);
  });

  it("알 수 없는 형식은 null — 링크 없이 번호만 적게 한다", () => {
    expect(parseRepoUrl("")).toBeNull();
    expect(parseRepoUrl("/srv/git/causeway")).toBeNull();
  });
});
