/**
 * 슬래시 커맨드 — 잡이 아니라 즉시 처리 (ARCHITECTURE §3).
 *
 * 범위: /status /queue /cancel /allow /help. 스케줄 잡이 없으므로 `/run` 은 두지 않는다 —
 * 부를 잡이 없는 커맨드는 "등록된 잡 없음"만 반복해 사용자를 헷갈리게 한다.
 * - 파서는 순수 함수, 실행기는 전 부작용 주입 (OPS-07).
 * - 알 수 없는 "/..." 토큰은 커맨드가 아니다 — "/path/to/file 봐줘" 같은 일상 입력을
 *   커맨드 오인으로 막지 않도록 null 을 돌려 chat 잡으로 흘려보낸다.
 */

import { threadKey } from "../sessions/sessionStore.js";

// ────────────────────────────────────────────────────────────────────
// 순수 함수부 — 파서
// ────────────────────────────────────────────────────────────────────

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "queue" }
  | { kind: "cancel" }
  | { kind: "allow"; userId: string | null };

export function isCommandText(text: string): boolean {
  return text.trim().startsWith("/");
}

/** `<@U123>` / `<@U123|name>` / `U123` 전부 허용 — 그 외 형태는 null (오타를 조용히 허용하지 않는다). */
export function parseUserToken(token: string): string | null {
  const mention = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(token);
  if (mention) return mention[1] ?? null;
  if (/^[UW][A-Z0-9]{2,}$/.test(token)) return token;
  return null;
}

export function parseCommand(text: string): ParsedCommand | null {
  const tokens = text.trim().split(/\s+/);
  const head = tokens[0]?.toLowerCase();
  if (!head?.startsWith("/")) return null;
  switch (head) {
    case "/help":
      return { kind: "help" };
    case "/status":
      return { kind: "status" };
    case "/queue":
      return { kind: "queue" };
    case "/cancel":
      return { kind: "cancel" };
    case "/allow":
      return { kind: "allow", userId: tokens[1] ? parseUserToken(tokens[1]) : null };
    default:
      return null;
  }
}

export const HELP_TEXT = [
  "*causeway 커맨드*",
  "• `/help` — 이 도움말",
  "• `/status` — 현재 스레드 세션 정보",
  "• `/queue` — 잡 큐 상태",
  "• `/cancel` — 이 스레드의 진행 중 작업 중단 (요청 메시지에 🛑/⏹️/❌ 를 달아도 같다)",
  "• `/allow <@user>` — 사용자 허용 추가 (admin)",
].join("\n");

// ────────────────────────────────────────────────────────────────────
// 오케스트레이션부 — 주입 실행기
// ────────────────────────────────────────────────────────────────────

export interface CommandContext {
  channel: string;
  threadTs: string;
  userId: string;
}

export interface CommandSessionInfo {
  sessionId: string;
  cwd: string;
  lastSeenTs: string;
}

export interface CommandDeps {
  isAdmin(userId: string): boolean;
  getSession(threadKey: string): CommandSessionInfo | null;
  countJobs(): Record<string, number>;
  /** true = 진행 중 작업에 취소 신호를 보냄. */
  cancelThread(threadKey: string): boolean;
  /** access.json allowed 목록에 추가 — 파일 손상 등 실패는 throw 로 알린다. */
  allowUser(userId: string): void;
  reply(ctx: CommandContext, text: string): Promise<void>;
}

export interface CommandExecutor {
  /** true = 커맨드로 처리됨(세션 실행 스킵). false = 커맨드 아님 — 호출측이 chat 잡으로 진행. */
  handle(ctx: CommandContext, text: string): Promise<boolean>;
}

export function createCommandExecutor(deps: CommandDeps): CommandExecutor {
  return {
    async handle(ctx, text) {
      const parsed = parseCommand(text);
      if (!parsed) return false;

      switch (parsed.kind) {
        case "help": {
          await deps.reply(ctx, HELP_TEXT);
          return true;
        }
        case "status": {
          const info = deps.getSession(threadKey(ctx.channel, ctx.threadTs));
          const body = info
            ? `session_id \`${info.sessionId}\`\ncwd \`${info.cwd}\`\nlast_seen \`${info.lastSeenTs || "(없음)"}\``
            : "세션 없음";
          await deps.reply(ctx, body);
          return true;
        }
        case "queue": {
          const counts = deps.countJobs();
          const line = ["pending", "inflight", "done", "failed", "cancelled"]
            .map((status) => `${status} ${counts[status] ?? 0}`)
            .join(" · ");
          await deps.reply(ctx, `*잡 큐 상태*\n${line}`);
          return true;
        }
        case "cancel": {
          const sent = deps.cancelThread(threadKey(ctx.channel, ctx.threadTs));
          await deps.reply(ctx, sent ? "취소 요청 보냄" : "진행 중인 세션 없음");
          return true;
        }
        case "allow": {
          if (!deps.isAdmin(ctx.userId)) {
            await deps.reply(ctx, "admin 전용 커맨드입니다");
            return true;
          }
          if (!parsed.userId) {
            await deps.reply(ctx, "사용자 ID 필요 — `/allow <@user>`");
            return true;
          }
          try {
            deps.allowUser(parsed.userId);
            await deps.reply(ctx, `허용됨: <@${parsed.userId}>`);
          } catch (err) {
            await deps.reply(ctx, `허용 실패: ${String(err)}`);
          }
          return true;
        }
      }
    },
  };
}
