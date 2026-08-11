import { describe, expect, it } from "vitest";
import {
  digest,
  parseArgs,
  projectDirFor,
  renderArchive,
  selectVictims,
} from "./archive-sessions.mjs";

/**
 * 아카이브 [계약] — 이 스크립트는 **원본을 지운다.** 되돌릴 수 없으므로 "무엇을 고르는가"와
 * "요약에 무엇이 들어가는가" 두 가지가 코드로 고정돼 있어야 한다.
 */

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const file = (name: string, sizeMb: number, ageHours: number) => ({
  path: `/p/${name}.jsonl`,
  dir: "/p",
  sessionId: name,
  size: sizeMb * MB,
  mtime: NOW - ageHours * HOUR,
});

describe("selectVictims (무엇을 접는가)", () => {
  const opts = { maxMb: 100, keep: 2, minAgeHours: 24 };

  it("상한 이하면 아무것도 접지 않는다 — 용량이 트리거다", () => {
    const files = [file("a", 10, 500), file("b", 10, 400)];
    expect(selectVictims(files, opts, NOW).victims).toEqual([]);
  });

  it("상한을 넘으면 오래된 것부터, 상한 아래로 내려가는 만큼만 접는다", () => {
    const files = [
      file("old", 60, 500),
      file("mid", 60, 400),
      file("new1", 30, 300),
      file("new2", 30, 200),
    ];
    const { victims } = selectVictims(files, opts, NOW); // 합계 180MB > 100MB
    expect(victims.map((v) => v.sessionId)).toEqual(["old", "mid"]);
  });

  /** 최근 것을 접으면 그 스레드의 이어묻기가 그 자리에서 깨진다. */
  it("최근 keep 개는 상한을 넘어도 보호한다", () => {
    const files = [file("a", 90, 500), file("b", 90, 400)];
    expect(selectVictims(files, { ...opts, keep: 2 }, NOW).victims).toEqual([]);
  });

  /**
   * 상한을 혼자 넘기는 파일이 '진행 중'이면 그건 못 건드린다. 이때 남은 작은 것들을 접어도
   * 상한 아래로는 못 내려가는데, **그래도 접는 게 맞다** — 용량 트리거 GC 는 부분 진행이
   * 정상이고, 다음 실행이 이어서 한다. 여기서 지켜야 할 선은 하나뿐이다: 진행 중 파일은 제외.
   */
  it("방금 수정된 파일은 상한을 혼자 넘겨도 접지 않는다 — 진행 중일 수 있다", () => {
    const files = [file("running", 200, 1), file("k1", 1, 900), file("k2", 1, 800)];
    const ids = selectVictims(files, opts, NOW).victims.map((v) => v.sessionId);
    expect(ids).not.toContain("running");
  });
});

describe("digest (요약에 무엇이 들어가는가)", () => {
  const records = [
    {
      type: "user",
      message: {
        content:
          "## Slack 스레드 맥락\n채널: D123 | 스레드 ts: 1786.1 | 요청자: 장owner\n\n## 현재 요청\n권한 좀 봐줘\n\n## 사용 가능 스킬\n- 어쩌고",
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "중간 답" },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__db__db_query" },
          {
            type: "text",
            text: "끝났습니다 https://github.com/OWNER/REPO/pull/7 참고",
          },
        ],
      },
    },
  ];

  it("슬랙 좌표와 '현재 요청'만 뽑는다 — 프롬프트 머리말은 버린다", () => {
    const d = digest(records);
    expect(d.slack).toEqual({ channel: "D123", threadTs: "1786.1", requester: "장owner" });
    expect(d.firstRequest).toBe("권한 좀 봐줘");
  });

  it("도구는 이름과 횟수만 센다", () => {
    expect(digest(records).tools).toEqual({ Bash: 2, mcp__db__db_query: 1 });
  });

  /** 재시도·재개 때 같은 프롬프트가 다시 실린다 — 인접만 거르면 아카이브에 중복이 남는다. */
  it("떨어져 있는 중복 요청도 한 번만 남긴다", () => {
    const dup = { type: "user", message: { content: "## 현재 요청\n같은 질문" } };
    const other = { type: "user", message: { content: "## 현재 요청\n다른 질문" } };
    expect(digest([dup, other, dup]).requests).toEqual(["같은 질문", "다른 질문"]);
  });

  it("tool_result 만 담긴 user 레코드는 요청으로 세지 않는다", () => {
    const toolOnly = {
      type: "user",
      message: { content: [{ type: "tool_result", content: "행" }] },
    };
    expect(digest([toolOnly]).requests).toEqual([]);
  });

  it("마지막 assistant 텍스트와 PR 링크를 남긴다", () => {
    const d = digest(records);
    expect(d.lastAssistant).toContain("끝났습니다");
    expect(d.prLinks).toEqual(["https://github.com/OWNER/REPO/pull/7"]);
  });

  /**
   * 원본에는 도구 **출력**(DB 행·권한 응답)이 평문으로 들어 있다. 접는 목적 중 하나가 그
   * 평문을 없애는 것이라, 요약에 tool_result 가 새어 들어가면 안 된다.
   */
  it("도구 출력은 요약에 넣지 않는다 — 접는 행위가 민감면을 줄여야 한다", () => {
    const withSecret = [
      ...records,
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "id|email\n1|someone@example.kr" }],
        },
      },
    ];
    const body = renderArchive(
      { sessionId: "s", mtime: NOW, path: "/p/s.jsonl", size: 1024, records: withSecret.length },
      digest(withSecret),
    );
    expect(body).not.toContain("someone@example.kr");
    expect(body).toContain("mcp__db__db_query×1");
  });
});

describe("parseArgs / projectDirFor", () => {
  it("기본값이 보수적이다 — 상한 100MB, 최근 5개 보호, 24시간 유예", () => {
    expect(parseArgs([])).toEqual({ dry: false, maxMb: 100, keep: 5, minAgeHours: 24, dirs: [] });
  });

  it("플래그 값이 대상 디렉토리로 새지 않는다", () => {
    const a = parseArgs(["--max-mb", "50", "--dry", "/some/dir"]);
    expect(a.maxMb).toBe(50);
    expect(a.dry).toBe(true);
    expect(a.dirs).toEqual(["/some/dir"]);
  });

  it("cwd 경로를 ~/.claude/projects 폴더명으로 인코딩한다", () => {
    expect(projectDirFor("/Users/me/ws/causeway", "/Users/me")).toBe(
      "/Users/me/.claude/projects/-Users-me-ws-causeway",
    );
  });
});
