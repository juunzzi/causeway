/**
 * access.json 기반 ACL (SEC-19) — 단일 allowed 풀 + admins, fs.watch 핫리로드.
 *
 * fail-closed: 파일 부재·파싱 실패·스키마 위반이면 "아무도 허용되지 않음"이다.
 * 선행 구현은 파일이 없으면 owner 를 기본 허용했지만, 팀 공용 봇은
 * 봇이라 임시 기본 허용이 곧 권한 구멍이다 — 명확한 에러 로그로 대신한다.
 *
 * allowed 에 와일드카드('*')를 두면 워크스페이스 전원 허용으로 전환된다. 이때도 개방
 * 범위는 **봇이 설치된 워크스페이스**까지다 — Slack Connect 공유 채널의 외부 조직
 * 사용자는 팀 ID 로 식별되면 배제한다(아래 isExternalTeam).
 */
import { type FSWatcher, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { type AccessConfig, ALLOW_ALL, loadAccessConfig, type ReadFile } from "../config/loader.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부
// ────────────────────────────────────────────────────────────────────

/** 와일드카드 개방 범위 판정 근거 — ingress 가 이벤트에서 뽑아 넘긴다. */
export interface AclContext {
  /** 발신자의 팀 ID(Slack Connect 는 외부 조직 팀 ID). 미상이면 null. */
  userTeamId?: string | null;
  /** 봇이 설치된 워크스페이스 팀 ID(부팅 auth.test). 미상이면 null. */
  botTeamId?: string | null;
}

/**
 * "명백히 외부 조직인가" — 양쪽 팀 ID 가 모두 있고 서로 다를 때만 true.
 *
 * 판정 근거가 없으면(어느 쪽이든 null) 외부로 보지 않는다. 와일드카드는 명시적 개방
 * 선언이므로, 이벤트 payload 에 team 필드가 없다는 이유로 워크스페이스 구성원을 막으면
 * "전원 허용"이라는 선언과 어긋난다 — 배제는 확실한 신호가 있을 때만 한다.
 */
export function isExternalTeam(ctx?: AclContext): boolean {
  const userTeamId = ctx?.userTeamId ?? null;
  const botTeamId = ctx?.botTeamId ?? null;
  if (userTeamId === null || botTeamId === null) return false;
  return userTeamId !== botTeamId;
}

/**
 * config 가 null(부재/손상)이면 무조건 false — fail-closed. admin 은 allowed 를 함의한다.
 * 명시 등록(allowed/admins)은 팀 무관하게 통과하고, 와일드카드 개방만 팀 범위를 탄다.
 */
export function isAllowedIn(
  config: AccessConfig | null,
  userId: string,
  ctx?: AclContext,
): boolean {
  if (config === null) return false;
  if (config.allowed.includes(userId) || config.admins.includes(userId)) return true;
  return config.allowed.includes(ALLOW_ALL) && !isExternalTeam(ctx);
}

/** admins 에는 와일드카드가 스키마 단계에서 금지된다 — 관리 권한은 언제나 명시 지명이다. */
export function isAdminIn(config: AccessConfig | null, userId: string): boolean {
  if (config === null) return false;
  return config.admins.includes(userId);
}

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 (파일 읽기·fs.watch 부작용)
// ────────────────────────────────────────────────────────────────────

export interface AclLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface Acl {
  isAllowed(userId: string, ctx?: AclContext): boolean;
  isAdmin(userId: string): boolean;
  /** 현재 반영된 config — null 이면 fail-closed 상태. */
  current(): AccessConfig | null;
  /** 파일을 다시 읽어 반영. fs.watch 콜백도 이 함수를 호출한다. */
  reload(): void;
  close(): void;
}

/** 에디터의 atomic rename 저장이 연속 이벤트를 만들므로 짧게 모아서 1회 reload. */
const WATCH_DEBOUNCE_MS = 150;

export function createAcl(options: {
  path: string;
  /** 기본 true. 테스트는 false 로 두고 reload() 를 직접 호출한다. */
  watch?: boolean;
  logger?: AclLogger;
  readFile?: ReadFile;
}): Acl {
  const logger = options.logger ?? console;
  let state: AccessConfig | null = null;

  function reload(): void {
    try {
      state = loadAccessConfig(options.path, options.readFile);
      // 전원 허용은 권한 경계가 바뀌는 상태다 — 숫자가 아니라 그 사실 자체를 로그에 남긴다
      const allowedScope = state.allowed.includes(ALLOW_ALL)
        ? `allowed 워크스페이스 전원('${ALLOW_ALL}')`
        : `allowed ${state.allowed.length}명`;
      logger.info(`acl: access.json 반영 — ${allowedScope}, admins ${state.admins.length}명`);
    } catch (err) {
      // 이전 정상 상태를 유지하지 않는다 — 손상된 파일 아래에서의 허용은 근거 없는 허용이다
      state = null;
      logger.error(`acl: access.json 로드 실패 → fail-closed(아무도 허용되지 않음) — ${err}`);
    }
  }

  reload();

  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  if (options.watch !== false) {
    try {
      // 파일이 아니라 디렉토리를 감시 — atomic rename 저장 시 파일 inode 가 바뀌어도 살아남는다
      watcher = watch(dirname(options.path), (_event, filename) => {
        if (filename !== null && filename !== basename(options.path)) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(reload, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
    } catch (err) {
      logger.error(`acl: fs.watch 시작 실패 — 핫리로드 없이 동작(재시작 필요): ${err}`);
    }
  }

  return {
    isAllowed(userId, ctx) {
      return isAllowedIn(state, userId, ctx);
    },
    isAdmin(userId) {
      return isAdminIn(state, userId);
    },
    current() {
      return state;
    },
    reload,
    close() {
      if (debounce) clearTimeout(debounce);
      watcher?.close();
    },
  };
}
