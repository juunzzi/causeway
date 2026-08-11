/**
 * Slack Agent(plan 카드) 스트리밍 chunk 정의 + SDK 메시지 → chunk 변환기 (선행 구현 이식).
 *
 * Slack streaming API(chat.startStream/appendStream/stopStream)의 chunks 배열에 들어가는
 * chunk 타입을 zod 로 명세하고, @anthropic-ai/claude-agent-sdk 의 raw 메시지를 그 chunk 로
 * 옮긴다. 실제 전송(ChatStreamer.append)은 SlackPort(slackPort.ts)가 담당하고, 이 모듈은
 * **순수하게 chunk 모양과 이벤트→chunk 매핑만** 책임진다(부작용 append 는 주입 콜백).
 *
 * - markdown_text: 본문 텍스트(누적되어 메시지 본문으로 렌더)
 * - task_update:   task 카드(in_progress/complete/error, 같은 id 로 갱신). chunk 자체 256자
 *                  제한이라 title 을 240 으로 클램프한다.
 * - plan_update:   plan 카드 헤더 제목(앵커). task_display_mode="plan" 에서 task_update 들을
 *                  하나의 plan 카드로 그룹 렌더하려면 이 앵커가 함께 와야 한다(없으면 task 들이
 *                  각자 카드로 흩어진다).
 *
 * 이 봇은 chat 을 큐 잡으로 지연 실행하므로 이벤트 바인딩형 sayStream 을 재사용할 수
 * 없다 — egress(SlackPort)가 client.chatStream 을 직접 호출하고, runner 의 raw SDK 메시지를
 * 여기 onEvent 로 흘린다.
 */

import { z } from "zod";

const TASK_STATUS = ["pending", "in_progress", "complete", "error"] as const;

export const MarkdownTextChunk = z.object({
  type: z.literal("markdown_text"),
  text: z.string().min(1),
});

export const TaskUpdateChunk = z.object({
  type: z.literal("task_update"),
  id: z.string().min(1).max(255),
  // Slack task_update chunk 자체 256자 제한 — title 단독으로도 그 한도를 의식한다.
  title: z.string().min(1).max(240),
  status: z.enum(TASK_STATUS),
  details: z.string().max(1000).optional(),
  output: z.string().max(2000).optional(),
});

export const PlanUpdateChunk = z.object({
  type: z.literal("plan_update"),
  // chunk 자체 256자 제한 — title 단독으로 그 한도를 의식한다.
  title: z.string().min(1).max(240),
});

export const Chunk = z.union([MarkdownTextChunk, TaskUpdateChunk, PlanUpdateChunk]);
export type Chunk = z.infer<typeof Chunk>;
export type TaskStatus = (typeof TASK_STATUS)[number];

/** title 256자 chunk 제한 보호 — 240 초과 시 잘라 말줄임한다. */
function clampTitle(title: string): string {
  return title.length > 240 ? `${title.slice(0, 237)}…` : title;
}

export function markdownText(text: string): z.infer<typeof MarkdownTextChunk> {
  return MarkdownTextChunk.parse({ type: "markdown_text", text });
}

export function planUpdate(title: string): z.infer<typeof PlanUpdateChunk> {
  return PlanUpdateChunk.parse({ type: "plan_update", title: clampTitle(title) });
}

export function taskUpdate(args: {
  id: string;
  title: string;
  status: TaskStatus;
  details?: string;
  output?: string;
}): z.infer<typeof TaskUpdateChunk> {
  return TaskUpdateChunk.parse({
    type: "task_update",
    id: args.id,
    title: clampTitle(args.title),
    status: args.status,
    ...(args.details ? { details: args.details } : {}),
    ...(args.output ? { output: args.output } : {}),
  });
}

/**
 * SDK tool_use 의 (name, input) 으로 사람-친화 task 제목을 만든다. task_update chunk 에
 * 넣기 좋게 짧게(~200자) 압축한다. maskSecrets 를 주입하면 파일 경로·명령·쿼리 등 입력값에
 * 섞인 시크릿을 title 저장 전에 마스킹한다(SEC-11 — plan 카드도 egress 이므로 마스킹 대상).
 */
export function describeToolUse(
  name: string,
  input: unknown,
  maskSecrets: (text: string) => string = (text) => text,
): string {
  const summary = (() => {
    if (input === null || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    switch (name) {
      case "Read":
      case "Write":
      case "Edit":
      case "NotebookEdit":
        return typeof record.file_path === "string" ? ` ${record.file_path}` : "";
      case "Bash":
        return typeof record.command === "string" ? `: ${record.command}` : "";
      case "Grep":
        return typeof record.pattern === "string" ? ` "${record.pattern}"` : "";
      case "Glob":
        return typeof record.pattern === "string" ? ` ${record.pattern}` : "";
      case "WebFetch":
        return typeof record.url === "string" ? ` ${record.url}` : "";
      case "WebSearch":
        return typeof record.query === "string" ? `: ${record.query}` : "";
      case "TodoWrite":
        return Array.isArray(record.todos) ? ` (${record.todos.length}개 항목)` : "";
      case "Task":
        return typeof record.subagent_type === "string" ? ` (${record.subagent_type})` : "";
      default:
        return "";
    }
  })();
  const full = maskSecrets(`${name}${summary}`);
  return full.length > 200 ? `${full.slice(0, 197)}…` : full;
}

export interface AgentTaskStreamOptions {
  /** plan 카드 제목. 기본 "작업 진행 중". */
  planTitle?: string;
  /** task 로 노출하지 않을 도구 이름들. */
  hiddenTools?: Set<string>;
  /** describeToolUse title 에 적용할 마스킹(SEC-11). 생략 시 무마스킹. */
  maskSecrets?: (text: string) => string;
}

export interface AgentTaskStream {
  /** runner 의 raw SDK 메시지(assistant/user/result 등)를 그대로 흘린다. */
  onEvent: (message: unknown) => void;
  /** stop 직전 미마감 task 를 complete 로 정리 — Slack 이 stop 후 미마감을 error 로 렌더하는 것 방지. */
  finalize: () => void;
}

/**
 * @anthropic-ai/claude-agent-sdk raw 메시지 → Slack plan 카드 chunk 변환기.
 *
 * assistant 메시지 content[] 의 tool_use{id,name,input} → in_progress task(tool_use_id 매핑),
 * user 메시지 content[] 의 tool_result{tool_use_id,is_error} → 매칭 task 마감(complete/error).
 * append 는 호출부가 실패 가드로 감싼 안전한 콜백이다(부작용 분리). finalize() 는 stop 직전
 * 미마감 task 를 complete 로 정리한다.
 */
export function createAgentTaskStream(
  append: (args: { chunks: Chunk[] }) => void,
  opts: AgentTaskStreamOptions = {},
): AgentTaskStream {
  const planTitle = opts.planTitle ?? "작업 진행 중";
  const hidden = opts.hiddenTools ?? new Set<string>();
  const mask = opts.maskSecrets ?? ((text: string) => text);
  let counter = 0;
  let planAnchorSent = false;
  const byToolUseId = new Map<string, { taskId: string; title: string }>();

  const sendTasks = (tasks: Chunk[]): void => {
    if (tasks.length === 0) return;
    if (!planAnchorSent) {
      // plan_update 앵커를 첫 task 배치 앞에 딱 한 번 — 이후 task 들은 같은 plan 카드로 그룹된다.
      append({ chunks: [planUpdate(planTitle), ...tasks] });
      planAnchorSent = true;
    } else {
      append({ chunks: tasks });
    }
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

  const contentOf = (message: unknown): unknown[] => {
    if (!isRecord(message)) return [];
    const inner = message.message;
    if (!isRecord(inner)) return [];
    return Array.isArray(inner.content) ? inner.content : [];
  };

  const onEvent = (message: unknown): void => {
    try {
      if (!isRecord(message)) return;
      // assistant tool_use → in_progress task 발사 + tool_use_id 매핑
      if (message.type === "assistant") {
        const tasks: Chunk[] = [];
        for (const c of contentOf(message)) {
          if (!isRecord(c)) continue;
          if (
            c.type === "tool_use" &&
            typeof c.id === "string" &&
            typeof c.name === "string" &&
            !hidden.has(c.name)
          ) {
            const taskId = `t${++counter}`;
            const title = describeToolUse(c.name, c.input, mask);
            byToolUseId.set(c.id, { taskId, title });
            tasks.push(taskUpdate({ id: taskId, title, status: "in_progress" }));
          }
        }
        sendTasks(tasks);
        return;
      }
      // tool_result → 매칭 task 마감(complete/error)
      if (message.type === "user") {
        const tasks: Chunk[] = [];
        for (const c of contentOf(message)) {
          if (!isRecord(c)) continue;
          if (c.type === "tool_result" && typeof c.tool_use_id === "string") {
            const meta = byToolUseId.get(c.tool_use_id);
            if (meta) {
              tasks.push(
                taskUpdate({
                  id: meta.taskId,
                  title: meta.title,
                  status: c.is_error === true ? "error" : "complete",
                }),
              );
              byToolUseId.delete(c.tool_use_id);
            }
          }
        }
        sendTasks(tasks);
      }
    } catch {
      // chunk 변환 예외가 세션을 죽이면 안 된다 — 이 이벤트만 건너뛴다(진행 표시는 best-effort).
    }
  };

  const finalize = (): void => {
    const tasks: Chunk[] = [];
    for (const meta of byToolUseId.values()) {
      tasks.push(taskUpdate({ id: meta.taskId, title: meta.title, status: "complete" }));
    }
    if (tasks.length > 0) sendTasks(tasks);
    byToolUseId.clear();
  };

  return { onEvent, finalize };
}
