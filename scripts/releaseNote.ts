/**
 * 배포 공지문 조립 — 순수 함수만. 부작용(git 호출·Slack 전송)은 auto-update.sh 가 맡는다.
 *
 * 자동 업데이터가 `deployed-sha..새 커밋` 구간을 배포한 직후, 그 구간에 담긴 **머지된 PR**
 * 기준으로 FE 챕터 채널에 한 줄씩 공지한다. "재시작했다"가 아니라 "무엇이 바뀌었다"가
 * 공지의 내용이라, 사람이 체감할 변화가 없는 구간이면 아무것도 만들지 않고 null 을 준다
 * (chore/docs 만 있는 배포까지 공지하면 채널이 시끄러워져 공지 자체가 무시된다).
 *
 * 입력은 `git log --first-parent` 출력이다 — main 에 실제로 얹힌 커밋(squash 커밋 또는
 * merge 커밋)만 보이고 PR 브랜치 내부 커밋은 들어오지 않으므로, 한 줄 = 한 PR 이 된다.
 */

/** git log 한 건 — sha/제목/본문. */
export interface RawCommit {
  sha: string;
  subject: string;
  body: string;
}

/** 공지 한 줄로 환산한 커밋. silent=true 면 사람에게 보이는 변화가 없다고 판단한 것. */
export interface ReleaseEntry {
  title: string;
  pr: number | null;
  silent: boolean;
}

/** auto-update.sh 가 넘겨주는 git log 포맷. 레코드 %x1e, 필드 %x1f 구분. */
export const GIT_LOG_FORMAT = "%H%x1f%s%x1f%b%x1e";

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

const MERGE_PR_RE = /^Merge pull request #(\d+) from /;
const MERGE_NOISE_RE = /^Merge (branch|remote-tracking branch|tag) /;
const TRAILING_PR_RE = /\s*\(#(\d+)\)\s*$/;
// conventional commit 접두사: type(scope)!: — 공지에서는 타입/스코프를 떼고 내용만 남긴다.
const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*/;

/**
 * 배포돼도 채널에 알리지 않는 커밋 타입 — 사람이 봇을 쓰는 방식이 달라지지 않는 것들.
 * refactor 는 일부러 뺐다: "동작 안 바뀜"이 의도지 보장은 아니라, 공지 쪽으로 기운다.
 */
export const SILENT_TYPES: ReadonlySet<string> = new Set([
  "chore",
  "ci",
  "docs",
  "test",
  "style",
  "build",
]);

/** 목록이 이보다 길면 나머지는 "…외 N건"으로 접는다. */
const MAX_ITEMS = 8;

export function parseGitLog(raw: string): RawCommit[] {
  return raw
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(FIELD_SEP);
      return { sha: sha.trim(), subject: subject.trim(), body };
    })
    .filter((c) => c.subject !== "");
}

/**
 * 커밋 1건 → 공지 한 줄. 두 가지 머지 방식을 모두 받는다.
 * - squash merge: 제목이 `feat(scope): 내용 (#35)`
 * - merge commit: 제목이 `Merge pull request #31 from …` 이고 **본문 첫 줄이 PR 제목**
 */
export function toEntry(commit: RawCommit): ReleaseEntry {
  const merge = MERGE_PR_RE.exec(commit.subject);
  const rawTitle = merge ? (firstLine(commit.body) ?? commit.subject) : commit.subject;
  const pr = merge ? toPrNumber(merge[1]) : prFromSubject(commit.subject);

  // PR 없는 로컬 머지(main 되돌리기 등)는 제목이 사람에게 아무 정보도 주지 않는다.
  if (!merge && MERGE_NOISE_RE.test(commit.subject)) {
    return { title: commit.subject, pr, silent: true };
  }

  const stripped = rawTitle.replace(TRAILING_PR_RE, "").trim();
  const conventional = CONVENTIONAL_RE.exec(stripped);
  const title = conventional ? stripped.slice(conventional[0].length).trim() : stripped;
  const type = conventional?.[1] ?? "";

  return { title: title === "" ? stripped : title, pr, silent: SILENT_TYPES.has(type) };
}

export interface ReleaseNoteOptions {
  /** `https://github.com/org/repo` — 있으면 PR 번호를 링크로 건다. */
  repoUrl?: string | null;
  maxItems?: number;
}

/**
 * 공지문 조립. 알릴 것이 없으면 **null** — 호출자는 이때 아무것도 보내지 않는다.
 * 재시작 사실 자체는 공지 사유가 아니다.
 */
export function formatReleaseNote(
  commits: readonly RawCommit[],
  options: ReleaseNoteOptions = {},
): string | null {
  const { repoUrl = null, maxItems = MAX_ITEMS } = options;
  const entries = commits.map(toEntry).filter((e) => !e.silent && e.title !== "");
  if (entries.length === 0) return null;

  const shown = entries.slice(0, maxItems);
  const lines = shown.map((e) => `• ${escapeSlack(e.title)}${prSuffix(e.pr, repoUrl)}`);
  const hidden = entries.length - shown.length;
  if (hidden > 0) lines.push(`• …외 ${hidden}건`);

  return [":rocket: causeway 업데이트 — 재시작 완료", ...lines].join("\n");
}

/** `git remote get-url origin` 출력 → `https://github.com/org/repo`. 못 알아보면 null. */
export function parseRepoUrl(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  if (trimmed === "") return null;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(trimmed);
  if (ssh?.[1] && ssh[2]) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]+@)?(.+)$/.exec(trimmed);
  if (https?.[1]) return `https://${https[1]}`;
  return null;
}

function prFromSubject(subject: string): number | null {
  const m = TRAILING_PR_RE.exec(subject);
  return m ? toPrNumber(m[1]) : null;
}

function toPrNumber(captured: string | undefined): number | null {
  const n = Number(captured);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function firstLine(body: string): string | null {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? null;
}

function prSuffix(pr: number | null, repoUrl: string | null): string {
  if (pr === null) return "";
  return repoUrl ? ` (<${repoUrl}/pull/${pr}|#${pr}>)` : ` (#${pr})`;
}

/** Slack 이 mrkdwn 에서 특수 취급하는 세 문자만 이스케이프한다. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
