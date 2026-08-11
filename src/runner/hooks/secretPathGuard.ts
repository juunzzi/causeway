/**
 * Read/Glob/Grep/Bash 시크릿 파일 접근 가드 (SEC-09).
 *
 * lexical 검사만으로는 symlink 로 우회된다(무해한 경로 → 실체는 ~/.ssh) — 그래서
 * realpath 해석 결과에 같은 lexical 검사를 한 번 더 건다(이중 검사).
 * bashGuard 의 credential 경로 패턴과 일부 겹치지만 의도된 중복이다: 이쪽은 Read/Glob/Grep
 * 도구와 경로 정규화를 커버하고, 그쪽은 명령 문자열 레벨의 최후 보조선이다.
 *
 * Glob/Grep 은 cwdScopeGuard(SEC-23)가 스코프 밖이면 이미 막지만, 이 훅은 스코프 **안**의
 * `.env`/`.ssh` 등 특정 파일명도 무조건 차단한다 — 예: WRITE_PR worktree 안에 실수로 커밋된
 * `.env` 처럼 cwd 안이라 스코프 검사만으론 못 막는 경우의 보완이다. 2026-07-30 코드 리뷰에서
 * matcher 가 "Read|Bash" 뿐이라 Grep 이 이 가드의 사거리 밖이었던 갭이 실측됐다 — 화이트리스트
 * (profiles.ts)엔 Grep 이 무제한 허용돼 있어 host 콘텐츠 검색이 가능했다.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";

// ────────────────────────────────────────────────────────────────────────────
// 순수 함수부 — 판정
// ────────────────────────────────────────────────────────────────────────────

export type SecretPathDecision = { action: "allow" } | { action: "deny"; reason: string };

/** `~` 확장 + 정규화 — lexical 검사는 항상 이 결과에 대해서만 수행한다. */
export function normalizeLexicalPath(rawPath: string, home: string): string {
  let p = rawPath.trim();
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  return path.normalize(p);
}

const SAFE_DOTENV_BASENAMES = new Set([".env.example", ".env.sample"]);

/** 정규화된 경로 하나가 시크릿 자산인지 판정한다. */
export function isSecretLexicalPath(normalizedPath: string): boolean {
  const base = path.basename(normalizedPath);
  const segments = normalizedPath.split(path.sep);
  if (base === ".env" || (base.startsWith(".env.") && !SAFE_DOTENV_BASENAMES.has(base))) {
    return true;
  }
  if (base === ".netrc" || base === ".databrickscfg" || base === "allowlist.json") return true;
  if (segments.includes(".ssh") || segments.includes(".aws")) return true;
  if (normalizedPath.includes(`${path.sep}.config${path.sep}gh${path.sep}`)) return true;
  return false;
}

export interface SecretPathDeps {
  home?: string;
  /**
   * 경로 실체 해석 — 존재하지 않거나 해석 실패면 null 을 반환해야 한다.
   * 부작용(fs)이라 주입 대상: 테스트는 symlink 픽스처를 가짜 함수로 흉내낸다.
   */
  realpath?: (p: string) => string | null;
  /** 봇 private 데이터(SQLite DB/WAL, 메모리 원문 등) 루트 — 호스트가 자기 데이터 디렉토리를 주입한다. */
  extraDenyPrefixes?: readonly string[];
}

function underPrefix(p: string, prefix: string): boolean {
  const rel = path.relative(prefix, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function defaultRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** lexical → realpath 순서의 이중 검사. 어느 층에서든 걸리면 deny. */
export function decideSecretPath(rawPath: string, deps: SecretPathDeps = {}): SecretPathDecision {
  const home = deps.home ?? homedir();
  const resolve = deps.realpath ?? defaultRealpath;
  const prefixes = deps.extraDenyPrefixes ?? [];

  const lexical = normalizeLexicalPath(rawPath, home);
  const candidates = [lexical];
  const real = resolve(lexical);
  if (real !== null && real !== lexical) candidates.push(path.normalize(real));

  for (const candidate of candidates) {
    if (isSecretLexicalPath(candidate)) {
      return {
        action: "deny",
        reason: `Blocked: 시크릿 파일 접근 (${candidate}). .env/credential 저장소는 세션에서 읽을 수 없다.`,
      };
    }
    for (const prefix of prefixes) {
      if (underPrefix(candidate, path.normalize(prefix))) {
        return {
          action: "deny",
          reason: `Blocked: 봇 private 데이터 (${candidate}) 는 세션 접근 범위 밖이다.`,
        };
      }
    }
  }
  return { action: "allow" };
}

/**
 * Bash 명령 문자열에서 경로 후보 토큰만 추출한다.
 * 판정 비용을 낮추기 위해 경로처럼 생긴 토큰(/, ~, . 시작 또는 구분자 포함)만 검사한다.
 */
export function extractPathTokens(command: string): string[] {
  const tokens = command.split(/[\s;&|<>()]+/);
  const out: string[] = [];
  for (const raw of tokens) {
    const t = raw.replace(/^["']|["']$/g, "");
    if (t.length === 0 || t.startsWith("-")) continue;
    if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".") || t.includes("/")) {
      out.push(t);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 오케스트레이션부 — SDK 훅 어댑터
// ────────────────────────────────────────────────────────────────────────────

export interface SecretPathGuardFrictionEvent {
  kind: "secret-path-guard-error";
  error: unknown;
  toolName: string | null;
}

export interface SecretPathGuardHookDeps extends SecretPathDeps {
  onFriction?: (event: SecretPathGuardFrictionEvent) => void;
}

const ALLOW: HookJSONOutput = { continue: true };

function denyOutput(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** 훅 내부 예외는 allow (fail-open, SEC-08 과 동일 계약) + friction 기록. */
export function createSecretPathGuardHook(deps: SecretPathGuardHookDeps = {}): HookCallback {
  return async (input) => {
    let toolName: string | null = null;
    try {
      if (input.hook_event_name !== "PreToolUse") return ALLOW;
      toolName = input.tool_name;
      const toolInput = input.tool_input as Record<string, unknown> | null;

      if (input.tool_name === "Read") {
        const filePath = toolInput?.file_path;
        if (typeof filePath !== "string") return ALLOW;
        const decision = decideSecretPath(filePath, deps);
        if (decision.action === "deny") return denyOutput(decision.reason);
        return ALLOW;
      }

      if (input.tool_name === "Glob" || input.tool_name === "Grep") {
        // path 생략 시 툴 기본값은 세션 cwd — cwd 자체를 시크릿 자산으로 잘못 설정하는 건
        // profiles.ts 배선 오류지 이 훅의 판정 대상이 아니므로 검사 생략(allow).
        const targetPath = toolInput?.path;
        if (typeof targetPath !== "string") return ALLOW;
        const decision = decideSecretPath(targetPath, deps);
        if (decision.action === "deny") return denyOutput(decision.reason);
        return ALLOW;
      }

      if (input.tool_name === "Bash") {
        const command = toolInput?.command;
        if (typeof command !== "string") return ALLOW;
        for (const token of extractPathTokens(command)) {
          const decision = decideSecretPath(token, deps);
          if (decision.action === "deny") return denyOutput(decision.reason);
        }
        return ALLOW;
      }

      return ALLOW;
    } catch (error) {
      try {
        deps.onFriction?.({ kind: "secret-path-guard-error", error, toolName });
      } catch {
        // friction 기록 실패조차 세션을 막으면 안 된다
      }
      return ALLOW;
    }
  };
}

export function secretPathGuardMatcher(deps: SecretPathGuardHookDeps = {}): HookCallbackMatcher {
  return { matcher: "Read|Glob|Grep|Bash", hooks: [createSecretPathGuardHook(deps)] };
}
