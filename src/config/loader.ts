/**
 * 선언 config 검증 로더 — channels.yaml · access.json.
 *
 * - 코드/SKILL.md 는 Slack ID 를 직접 들지 않는다 — 논리 채널명 간접화 + 부팅 시
 *   중복 fail-fast (SK-04). 미선언 논리명 참조도 즉시 실패다.
 * - 스키마는 strict — 키 오타가 조용히 무시되면 role·access 같은 보안 경계가
 *   증발한다 (SEC-14 계열의 상류 방어).
 * - import side-effect 없는 순수 로더 (SEC-20): 파일 읽기는 명시 호출로만.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 스키마·파싱·해석
// ────────────────────────────────────────────────────────────────────

export class ConfigError extends Error {}

function fail(context: string, issues: z.ZodError): never {
  const detail = issues.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new ConfigError(`${context} 스키마 위반 — ${detail.join("; ")}`);
}

// --- channels.yaml ---

/**
 * - ops-notify: 운영자 앞 신호(워치독·재시도 소진·배포 실패). 보통 owner DM.
 * - release-notify: 자동 업데이터의 릴리즈 공지 게시처(scripts/auto-update.sh). ops-notify 와
 *   나눈 이유는 독자가 다르기 때문 — 이쪽은 봇을 쓰는 사람들이고, 실패·정체가 아니라
 *   "무엇이 바뀌었는지"만 간다.
 *
 * `watcher`·`report-target`·`forward-target` 같은 role 은 두지 않았다 — 자동 수집 채널도
 * 자동 게시처도 없어서, 선언할 수 있는데 아무 데도 안 쓰이는 role 은
 * "이걸 쓰면 뭔가 된다"는 오해만 남긴다.
 */
export const channelRoleSchema = z.enum(["ops-notify", "release-notify"]);
export type ChannelRole = z.infer<typeof channelRoleSchema>;

export const channelSchema = z.strictObject({
  logical: z.string().min(1),
  id: z.string().regex(/^[CDG][A-Z0-9]{6,}$/, "Slack 채널 ID 형식이 아니다"),
  role: channelRoleSchema,
});
export type ChannelDecl = z.infer<typeof channelSchema>;

const channelsFileSchema = z.strictObject({ channels: z.array(channelSchema) });

export function parseChannelsConfig(yamlText: string): ChannelDecl[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError(`channels.yaml 파싱 실패 — ${err}`);
  }
  const parsed = channelsFileSchema.safeParse(raw);
  if (!parsed.success) fail("channels.yaml", parsed.error);
  assertNoChannelDuplicates(parsed.data.channels);
  return parsed.data.channels;
}

/** 중복 논리명/ID 는 부팅 실패 — 잘못된 채널로 조용히 게시되는 사고를 구조적으로 막는다. */
export function assertNoChannelDuplicates(channels: readonly ChannelDecl[]): void {
  const logicals = new Set<string>();
  const ids = new Set<string>();
  for (const ch of channels) {
    if (logicals.has(ch.logical)) {
      throw new ConfigError(`channels.yaml 논리명 중복: '${ch.logical}'`);
    }
    if (ids.has(ch.id)) {
      throw new ConfigError(`channels.yaml 채널 ID 중복: '${ch.id}'`);
    }
    logicals.add(ch.logical);
    ids.add(ch.id);
  }
}

export interface ChannelResolver {
  /** 미선언 논리명은 throw — 하드코딩 ID 로의 우회를 유도하지 않기 위한 fail-fast. */
  idOf(logical: string): string;
  get(logical: string): ChannelDecl | null;
  byRole(role: ChannelRole): ChannelDecl[];
  all(): ChannelDecl[];
}

export function createChannelResolver(channels: readonly ChannelDecl[]): ChannelResolver {
  assertNoChannelDuplicates(channels);
  const byLogical = new Map(channels.map((ch) => [ch.logical, ch]));
  return {
    idOf(logical) {
      const ch = byLogical.get(logical);
      if (!ch) throw new ConfigError(`선언되지 않은 논리 채널명: '${logical}'`);
      return ch.id;
    },
    get(logical) {
      return byLogical.get(logical) ?? null;
    },
    byRole(role) {
      return channels.filter((ch) => ch.role === role);
    },
    all() {
      return [...channels];
    },
  };
}

// --- access.json ---

/**
 * allowed 전용 와일드카드 — "봇이 설치된 워크스페이스 전원 허용".
 * admins 에는 금지한다: 관리 커맨드(/run·/allow)는 명시 지명만 받는다.
 */
export const ALLOW_ALL = "*";

/** allowed/admins 두 키 모두 명시 필수 — 키 누락·오타는 파싱 실패 → acl 이 fail-closed 로 흡수(SEC-19). */
export const accessSchema = z.strictObject({
  allowed: z.array(z.string()),
  admins: z.array(z.string()).refine((ids) => !ids.includes(ALLOW_ALL), {
    message: `admins 에 와일드카드 '${ALLOW_ALL}' 는 쓸 수 없다 — 관리 권한은 명시 지명만`,
  }),
});
export type AccessConfig = z.infer<typeof accessSchema>;

export function parseAccessJson(jsonText: string): AccessConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new ConfigError(`access.json 파싱 실패 — ${err}`);
  }
  const parsed = accessSchema.safeParse(raw);
  if (!parsed.success) fail("access.json", parsed.error);
  return parsed.data;
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (파일 읽기 부작용 — readFile 주입 가능)
// ────────────────────────────────────────────────────────────────────

export type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, "utf8");

export function loadChannelsConfig(
  path: string,
  readFile: ReadFile = defaultReadFile,
): ChannelDecl[] {
  return parseChannelsConfig(readText(path, readFile, "channels.yaml"));
}

export function loadAccessConfig(path: string, readFile: ReadFile = defaultReadFile): AccessConfig {
  return parseAccessJson(readText(path, readFile, "access.json"));
}

function readText(path: string, readFile: ReadFile, label: string): string {
  try {
    return readFile(path);
  } catch (err) {
    throw new ConfigError(`${label} 읽기 실패 (${path}) — ${err}`);
  }
}

export interface LoadedConfig {
  channels: ChannelDecl[];
  resolver: ChannelResolver;
  /** null = access.json 부재/손상 — acl 이 fail-closed(아무도 허용 안 됨)로 처리한다. */
  access: AccessConfig | null;
}

/**
 * config 디렉토리 일괄 로드. channels.yaml 은 선택이라 부재를 허용(빈 구성)하되,
 * 존재하면 스키마·중복 위반 시 즉시 throw 한다.
 */
export function loadConfig(dir: string, readFile: ReadFile = defaultReadFile): LoadedConfig {
  const channels = tryLoad(() => loadChannelsConfig(join(dir, "channels.yaml"), readFile)) ?? [];
  const resolver = createChannelResolver(channels);
  let access: AccessConfig | null = null;
  try {
    access = loadAccessConfig(join(dir, "access.json"), readFile);
  } catch {
    access = null;
  }
  return { channels, resolver, access };
}

/** 파일 부재만 허용으로 흡수 — 내용 위반(스키마·중복)은 그대로 fail-fast. */
function tryLoad<T>(load: () => T): T | null {
  try {
    return load();
  } catch (err) {
    if (err instanceof ConfigError && err.message.includes("읽기 실패")) return null;
    throw err;
  }
}
