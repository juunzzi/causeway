/**
 * 소스 위생 — 사람 눈에 안 보이는 바이트가 커밋되는 것을 막는다.
 *
 * 왜 테스트로 두는가: 조합 키 구분자를 이스케이프가 아니라 **리터럴 NUL 바이트**로 박아
 * 넣으면 결과가 조용하다 — 타입체크·린트·테스트가 전부 통과하고 에디터에서도 안 보인다.
 * 드러나는 곳은 git 뿐이다: 그 파일이 **바이너리로 취급돼** diff 가 `Bin N -> M bytes` 로만
 * 찍혀서 리뷰에서 내용을 볼 수 없게 된다.
 *
 * 제어문자를 문자열에 넣는 것 자체는 정당하다(예: NUL 은 채널 ID 에 절대 없어서 구분자로
 * 안전하다). 금지하는 것은 **표기 방식**이다 — 소스에는 이스케이프로 쓴다.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");

/**
 * 검사에서 빼는 것 — **진짜 바이너리만** 적는다.
 *
 * 처음에는 반대로 텍스트 확장자를 나열했는데, 그러면 확장자 없는 파일이 통째로 빠진다.
 * 실제로 `bin/causeway`(운영 CLI 셸 스크립트)·`.env.example`·`.gitignore` 가 전부 스캔
 * 밖이었다 — 배포·재시작이 걸린 파일이 정작 무방비였다.
 *
 * 그래서 방향을 뒤집는다: **모르는 확장자는 텍스트로 보고 검사한다.** 진짜 바이너리를
 * 커밋해 오탐이 나면 그때 여기 한 줄을 더하는데, 그건 리뷰에 드러나는 명시적 행동이다.
 * 반대 방향의 실수(새 텍스트 파일이 조용히 검사 밖으로 나가는 것)는 아무 흔적도 안 남는다.
 */
const BINARY_EXTENSIONS = [
  // 이미지
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".icns",
  ".bmp",
  // 폰트
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // 문서·압축·미디어
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".mp3",
  ".mp4",
  ".mov",
  ".wav",
  // 데이터베이스·산출물
  ".db",
  ".sqlite",
  ".wasm",
];

const NUL = 0;

function isBinaryPath(path: string): boolean {
  const lower = path.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 추적 중인 파일 전체. `-z` 로 받는 것은 경로에 줄바꿈이 있어도 안전하기 때문이다. */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT });
  return out
    .toString("utf8")
    .split(String.fromCharCode(NUL))
    .filter((p) => p !== "");
}

function scannedFiles(): string[] {
  return trackedFiles().filter((p) => !isBinaryPath(p));
}

describe("소스 위생", () => {
  it("추적 중인 텍스트 파일에 리터럴 NUL 바이트가 없다", () => {
    const offenders: string[] = [];
    for (const path of scannedFiles()) {
      const buf = readFileSync(join(REPO_ROOT, path));
      const at = buf.indexOf(NUL);
      if (at === -1) continue;
      // 몇 번째 줄인지까지 알려준다 — 안 보이는 바이트라 위치가 없으면 찾기가 어렵다.
      const line = buf.subarray(0, at).toString("utf8").split("\n").length;
      offenders.push(`${path}:${line}`);
    }
    expect(
      offenders,
      "리터럴 NUL 이 들어 있다. 소스에는 유니코드 이스케이프로 쓴다 — " +
        "리터럴로 두면 git 이 그 파일을 바이너리로 취급해 diff 가 사라진다:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  /**
   * 위 검사의 **범위**를 붙잡는다. 필터를 다시 좁히면(확장자 allowlist 로 되돌리는 등)
   * 검사는 계속 초록인 채 커버리지만 조용히 줄어드는데, 그게 이 파일이 한 번 겪은 실패다.
   */
  it("확장자 없는 텍스트 파일도 검사 범위에 든다", () => {
    const scanned = new Set(scannedFiles());
    const noExtension = trackedFiles().filter((p) => !p.split("/").pop()?.includes("."));

    expect(
      noExtension.length,
      "확장자 없는 추적 파일이 하나도 없다 — 이 검사가 무의미해졌다",
    ).toBeGreaterThan(0);
    expect(noExtension.filter((p) => !scanned.has(p))).toEqual([]);
  });
});
