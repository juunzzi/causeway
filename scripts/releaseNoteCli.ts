/**
 * releaseNote.ts 의 shell 어댑터. stdin 으로 `git log --first-parent --format=$GIT_LOG_FORMAT`
 * 출력을, argv[2] 로 `git remote get-url origin` 값을 받아 공지문을 stdout 에 쓴다.
 * 알릴 것이 없으면 **아무것도 출력하지 않는다** — auto-update.sh 가 그걸 "공지 안 함"으로 읽는다.
 */
import { readFileSync } from "node:fs";
import { formatReleaseNote, parseGitLog, parseRepoUrl } from "./releaseNote.js";

const raw = readFileSync(0, "utf8");
const remote = process.argv[2] ?? "";
const note = formatReleaseNote(parseGitLog(raw), { repoUrl: parseRepoUrl(remote) });
if (note !== null) process.stdout.write(note);
