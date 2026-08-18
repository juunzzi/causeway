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

/** 검사 대상 — 사람이 읽고 리뷰하는 텍스트 파일. 이미지·폰트 같은 진짜 바이너리는 뺀다. */
const TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
];

const NUL = 0;

function trackedTextFiles(): string[] {
  // -z 로 받는다 — 경로에 줄바꿈이 있어도 안전하다.
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT });
  return out
    .toString("utf8")
    .split(String.fromCharCode(NUL))
    .filter((p) => p !== "" && TEXT_EXTENSIONS.some((ext) => p.endsWith(ext)));
}

describe("소스 위생", () => {
  it("추적 중인 텍스트 파일에 리터럴 NUL 바이트가 없다", () => {
    const offenders: string[] = [];
    for (const path of trackedTextFiles()) {
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
});
