/**
 * `archive-sessions.mjs` 의 순수 함수부 타입 선언.
 *
 * 스크립트 본체를 .mjs 로 두는 것은 레포 관례다(`push-manifest.mjs` 와 같음 — 빌드 없이 바로
 * 실행). 다만 이 스크립트는 **원본 트랜스크립트를 지우므로** 선정·요약 로직만은 테스트가
 * 붙잡아야 하고, 그 테스트가 `any` 위에서 돌면 계약을 못 붙잡는다. 그래서 여기만 타입을 준다.
 */

export interface SessionFile {
  path: string;
  dir: string;
  sessionId: string;
  size: number;
  /** epoch ms */
  mtime: number;
}

export interface ArchiveOptions {
  maxMb: number;
  keep: number;
  minAgeHours: number;
}

export interface ParsedArgs extends ArchiveOptions {
  dry: boolean;
  dirs: string[];
}

export interface SlackCoords {
  channel: string;
  threadTs: string;
  requester: string;
}

export interface Digest {
  /** 레코드 type 별 개수 (user/assistant/attachment/…) */
  counts: Record<string, number>;
  /** 도구 이름 → 호출 횟수. **출력은 담지 않는다.** */
  tools: Record<string, number>;
  firstRequest: string | null;
  /** 이 세션에서 사람이 던진 요청 전부(중복 인접 제거). 긴 스레드의 아카이브 가치는 여기 있다. */
  requests: string[];
  slack: SlackCoords | null;
  lastAssistant: string | null;
  prLinks: string[];
}

export interface ArchiveMeta {
  sessionId: string;
  path: string;
  size: number;
  mtime: number;
  records: number;
}

export function projectDirFor(cwd: string, home?: string): string;
export function parseArgs(argv: string[]): ParsedArgs;
export function selectVictims(
  files: SessionFile[],
  options: ArchiveOptions,
  now: number,
): { total: number; victims: SessionFile[] };
export function digest(records: unknown[]): Digest;
export function renderArchive(meta: ArchiveMeta, digest: Digest): string;
