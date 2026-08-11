#!/usr/bin/env node
/**
 * 세션 트랜스크립트 아카이브 — 오래된 `.jsonl` 을 작은 md 요약으로 접고 원본을 지운다.
 *
 * 왜 필요한가: 봇이 도는 동안 `~/.claude/projects/<cwd-인코딩>/<session-id>.jsonl` 이 무한히
 * 쌓인다. 자동 만료가 없고, 한 세션이 수백 KB 다. 용량도 용량이지만 **더 큰 문제는 내용**이다 —
 * 트랜스크립트에는 도구 입출력이 평문으로 들어간다(`mytool_query` 결과 행, `mytool_admin` 응답 등).
 * 요약본은 도구 **이름과 횟수만** 남기고 출력은 버리므로, 접는 행위 자체가 민감면을 줄인다.
 *
 * ── 요약은 LLM 이 아니라 추출이다 ────────────────────────────────────────────────
 * 세션마다 모델을 한 번씩 더 부르는 대신 트랜스크립트에서 사실만 뽑는다. 아카이브 요약이
 * 틀리면 없느니만 못하다 — 사람은 원본이 지워진 뒤에 그 요약을 믿는다. 뽑는 것은 전부
 * 파일에 실제로 있는 값이다: 슬랙 스레드 좌표·요청자, 첫 요청, 마지막 답변, 도구 호출 히스토그램,
 * PR 링크. 산문 요약이 필요하면 그때 원본이 아니라 이 md 를 모델에 물리면 된다.
 *
 * ── DB 정합성 ────────────────────────────────────────────────────────────────
 * `var/causeway.db` 의 `sessions` 가 thread_key → session_id 를 들고 있다. 파일만 지우면
 * 그 매핑이 죽은 세션을 가리키고, 스레드에 이어 물었을 때 resume 이 실패한다(핸들러가 만료로
 * 보고 새 세션을 파므로 치명적이진 않지만 조용한 낭비다). 그래서 **아카이브한 세션의 매핑 행도
 * 같은 실행에서 지운다.** 파일과 DB 중 하나만 정리하는 경로를 만들지 않는다.
 *
 * 사용:
 *   node scripts/archive-sessions.mjs [--dry] [--max-mb N] [--keep N] [--min-age-hours N] [디렉토리...]
 *
 *   --dry             지우지 않고 무엇을 접을지만 출력
 *   --max-mb  (100)   대상 폴더 합계가 이 값을 넘을 때만 동작한다. 넘은 만큼만 오래된 것부터 접는다
 *   --keep    (5)     폴더당 최근 N 개는 무슨 일이 있어도 남긴다
 *   --min-age-hours (24)  이 시간 안에 수정된 파일은 건드리지 않는다(진행 중일 수 있다)
 *   디렉토리...        생략하면 이 봇의 프로젝트 폴더 2개. 다른 경로를 주면 거기를 대상으로 한다
 *                     (예: ~/.claude/projects 전체)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_DIR = join(ROOT, "var", "session-archive");
const DB_PATH = join(ROOT, "var", "causeway.db");

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 인자 파싱·대상 선정·요약 생성
// ────────────────────────────────────────────────────────────────────

/** `~/.claude/projects` 는 cwd 절대경로의 `/`·`.` 를 `-` 로 바꾼 이름을 폴더로 쓴다. */
export function projectDirFor(cwd, home = homedir()) {
  return join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

export function parseArgs(argv) {
  const num = (flag, fallback) => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    dry: argv.includes("--dry"),
    maxMb: num("--max-mb", 100),
    keep: num("--keep", 5),
    minAgeHours: num("--min-age-hours", 24),
    dirs: argv.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a)),
  };
}

/**
 * 접을 대상을 고른다 (순수). 오래된 것부터, 합계가 상한 아래로 내려갈 때까지만.
 *
 * 세 겹의 안전장치: ① 상한 미만이면 아무것도 안 한다 ② 최근 keep 개는 제외 ③ 방금 수정된
 * 것은 제외. 진행 중인 대화를 접으면 그 스레드의 이어묻기가 그 자리에서 깨진다.
 */
export function selectVictims(files, { maxMb, keep, minAgeHours }, now) {
  const limit = maxMb * 1024 * 1024;
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total <= limit) return { total, victims: [] };

  const cutoff = now - minAgeHours * 3600_000;
  const byNewest = [...files].sort((a, b) => b.mtime - a.mtime);
  const protectedPaths = new Set(byNewest.slice(0, keep).map((f) => f.path));

  const victims = [];
  let remaining = total;
  for (const f of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (remaining <= limit) break;
    if (protectedPaths.has(f.path)) continue;
    if (f.mtime > cutoff) continue;
    victims.push(f);
    remaining -= f.size;
  }
  return { total, victims };
}

const asArray = (c) => (Array.isArray(c) ? c : []);

/** 트랜스크립트에서 사실만 뽑는다 (순수). 여기서 만들지 않은 문장은 요약에 들어가지 않는다. */
export function digest(records) {
  const counts = {};
  const tools = {};
  let firstRequest = null;
  let slack = null;
  const requests = [];
  const seenRequests = new Set();
  let lastAssistant = null;
  const prLinks = new Set();

  for (const r of records) {
    counts[r.type] = (counts[r.type] ?? 0) + 1;
    const content = r.message?.content;

    if (r.type === "user") {
      const text =
        typeof content === "string"
          ? content
          : asArray(content).find((c) => c?.type === "text")?.text;
      if (text) {
        // 봇이 조립한 프롬프트 머리에 스레드 좌표가 들어 있다(jobs/chat/context.ts).
        if (!slack) {
          const m = /채널:\s*(\S+)\s*\|\s*스레드 ts:\s*(\S+)\s*\|\s*요청자:\s*([^\n]+)/.exec(text);
          if (m) slack = { channel: m[1], threadTs: m[2], requester: m[3].trim() };
        }
        // **요청은 전부 모은다.** 첫 요청만 남기면 긴 스레드에서 아카이브가 무의미해진다 —
        // 실측한 381레코드 세션의 첫 요청은 "ㅎㅇㅎㅇ?" 였고 실제 작업은 전부 중간에 있었다.
        // 요청문은 짧아서 다 모아도 요약본이 몇 KB 를 넘지 않는다.
        const req = /##\s*현재 요청\s*\n([\s\S]*?)(?:\n##|\n*$)/.exec(text);
        const line = (req ? req[1] : text).trim();
        // tool_result 만 담긴 user 레코드(프롬프트 머리말 없음)는 요청이 아니다.
        // 중복은 인접이 아니라 **전체**로 거른다 — 재시도·재개 때 같은 프롬프트가 다시 실린다
        // (실측: 한 세션에서 같은 요청이 3번째·5번째로 떨어져 두 번 나왔다).
        if (req && line && !seenRequests.has(line)) {
          seenRequests.add(line);
          requests.push(line);
        }
        if (!firstRequest) firstRequest = line;
      }
    }

    if (r.type === "assistant") {
      for (const c of asArray(content)) {
        if (c?.type === "tool_use") tools[c.name] = (tools[c.name] ?? 0) + 1;
        if (c?.type === "text" && c.text?.trim()) lastAssistant = c.text;
      }
    }

    for (const url of JSON.stringify(r).matchAll(
      /https:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/g,
    )) {
      prLinks.add(url[0]);
    }
  }
  return { counts, tools, firstRequest, requests, slack, lastAssistant, prLinks: [...prLinks] };
}

/** 요청 목록 상한 — 이걸 넘으면 접은 파일이 다시 커진다. */
const MAX_REQUESTS = 60;

const clip = (s, n) => {
  if (!s) return "(없음)";
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n)}\n\n…(${t.length - n}자 생략)`;
};

/** 요약 md 본문 (순수). */
export function renderArchive(meta, d) {
  const toolLine = Object.entries(d.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(", ");
  return `# ${meta.sessionId}

- 마지막 활동: ${new Date(meta.mtime).toISOString()}
- 원본: \`${meta.path}\` (${(meta.size / 1024).toFixed(0)}KB, 레코드 ${meta.records}개)
${d.slack ? `- 슬랙: 채널 ${d.slack.channel} · 스레드 ${d.slack.threadTs} · 요청자 ${d.slack.requester}\n` : ""}- 레코드 분포: ${Object.entries(
    d.counts,
  )
    .map(([k, v]) => `${k} ${v}`)
    .join(" / ")}
- 도구 호출: ${toolLine || "(없음)"}
${d.prLinks.length ? `- PR: ${d.prLinks.join(" , ")}\n` : ""}
## 요청 (${d.requests.length}건)

${
  d.requests.length === 0
    ? clip(d.firstRequest, 800)
    : d.requests
        .slice(0, MAX_REQUESTS)
        .map((q, i) => `${i + 1}. ${clip(q, 300).replace(/\n/g, " ")}`)
        .join("\n") +
      (d.requests.length > MAX_REQUESTS ? `\n…(${d.requests.length - MAX_REQUESTS}건 더)` : "")
}

## 마지막 답변

${clip(d.lastAssistant, 2000)}

---
도구 **출력**은 일부러 담지 않는다 — 원본에는 DB 행·권한 응답이 평문으로 들어 있었고,
접는 목적 중 하나가 그 평문을 없애는 것이다. 전체가 필요하면 원본이 지워지기 전에 떠야 한다.
`;
}

// ────────────────────────────────────────────────────────────────────
// 부작용부
// ────────────────────────────────────────────────────────────────────

function listSessions(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      return { path, dir, sessionId: f.replace(/\.jsonl$/, ""), size: st.size, mtime: st.mtimeMs };
    });
}

function readRecords(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 마지막 줄이 쓰이는 중이면 깨질 수 있다 — 한 줄 버리고 계속한다.
    }
  }
  return out;
}

/** 아카이브한 세션을 가리키던 매핑 행을 지운다. 파일과 DB 중 하나만 정리하지 않기 위해서다. */
function dropSessionRows(sessionIds, dry) {
  if (sessionIds.length === 0) return [];
  if (!existsSync(DB_PATH)) {
    // 조용히 넘어가면 파일만 지워지고 매핑이 죽은 세션을 계속 가리킨다. 정합성이 걸린
    // 단계라 반드시 드러낸다(워크트리에서 실행하면 var/ 가 없어 여기 걸린다).
    console.warn(`  ⚠️ DB 없음 — 매핑 정리 건너뜀: ${DB_PATH}`);
    return [];
  }
  const db = new DatabaseSync(DB_PATH);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const sel = db.prepare("SELECT thread_key FROM sessions WHERE session_id = ?");
    const del = db.prepare("DELETE FROM sessions WHERE session_id = ?");
    const dropped = [];
    for (const id of sessionIds) {
      const row = sel.get(id);
      if (!row) continue;
      dropped.push({ threadKey: row.thread_key, sessionId: id });
      if (!dry) del.run(id);
    }
    return dropped;
  } finally {
    db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const dirs =
  args.dirs.length > 0 ? args.dirs : [projectDirFor(ROOT), projectDirFor(join(ROOT, "workspace"))];

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;
let archived = 0;
let freed = 0;
const archivedIds = [];

for (const dir of dirs) {
  const files = listSessions(dir);
  if (files.length === 0) {
    console.log(`· ${dir} — 세션 없음`);
    continue;
  }
  const { total, victims } = selectVictims(files, args, Date.now());
  console.log(`· ${dir} — ${files.length}개 / ${mb(total)} (상한 ${args.maxMb}MB)`);
  if (victims.length === 0) {
    // "왜 안 접었나"를 정확히 말한다. 상한 미만인 것과, 넘었는데 전부 보호에 걸린 것은
    // 전혀 다른 상태다 — 뭉뚱그리면 다음 사람이 상한만 만지며 엉뚱한 데를 판다.
    console.log(
      total <= args.maxMb * 1024 * 1024
        ? "  상한 이하 — 접을 것 없음"
        : `  상한 초과지만 대상 없음 — 최근 ${args.keep}개 보호 + 최근 ${args.minAgeHours}시간 이내는 제외`,
    );
    continue;
  }
  if (!args.dry) mkdirSync(ARCHIVE_DIR, { recursive: true });

  for (const f of victims) {
    const records = readRecords(f.path);
    const d = digest(records);
    const day = new Date(f.mtime).toISOString().slice(0, 10);
    const out = join(ARCHIVE_DIR, `${day}-${f.sessionId.slice(0, 8)}.md`);
    const body = renderArchive({ ...f, records: records.length }, d);
    console.log(
      `  접기 ${f.sessionId.slice(0, 8)} ${mb(f.size)} → ${out.replace(ROOT, ".")} (${body.length}B)`,
    );
    if (!args.dry) {
      writeFileSync(out, body);
      rmSync(f.path);
    }
    archived += 1;
    freed += f.size;
    archivedIds.push(f.sessionId);
  }
}

const dropped = dropSessionRows(archivedIds, args.dry);
for (const d of dropped) console.log(`  매핑 삭제 ${d.threadKey} → ${d.sessionId.slice(0, 8)}`);

console.log(
  archived === 0
    ? "\n변경 없음."
    : `\n${args.dry ? "[--dry] " : ""}${archived}개 접음 · ${mb(freed)} 확보 · 매핑 ${dropped.length}건 정리`,
);
