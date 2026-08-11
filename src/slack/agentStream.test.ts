import { describe, expect, it } from "vitest";
import {
  type Chunk,
  createAgentTaskStream,
  describeToolUse,
  planUpdate,
  taskUpdate,
} from "./agentStream.js";

/** assistant tool_use 메시지(runner 가 흘리는 raw SDK 모양). */
function assistantToolUse(blocks: Array<{ id: string; name: string; input?: unknown }>): unknown {
  return {
    type: "assistant",
    message: {
      content: blocks.map((b) => ({ type: "tool_use", id: b.id, name: b.name, input: b.input })),
    },
  };
}

/** user tool_result 메시지(성공/에러). */
function userToolResult(results: Array<{ toolUseId: string; isError?: boolean }>): unknown {
  return {
    type: "user",
    message: {
      content: results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.toolUseId,
        is_error: r.isError ?? false,
      })),
    },
  };
}

describe("chunk 빌더", () => {
  it("planUpdate/taskUpdate title 240자 클램프", () => {
    const long = "가".repeat(300);
    expect(planUpdate(long).title).toHaveLength(238); // 237 + "…"
    expect(planUpdate(long).title.endsWith("…")).toBe(true);
    expect(taskUpdate({ id: "t1", title: long, status: "in_progress" }).title).toHaveLength(238);
  });

  it("taskUpdate 240자 이하는 그대로", () => {
    const t = taskUpdate({ id: "t1", title: "Read a.ts", status: "complete" });
    expect(t).toEqual({ type: "task_update", id: "t1", title: "Read a.ts", status: "complete" });
  });
});

describe("describeToolUse", () => {
  it("도구별 대표 입력을 한 줄로 요약", () => {
    expect(describeToolUse("Read", { file_path: "/repo/a.ts" })).toBe("Read /repo/a.ts");
    expect(describeToolUse("Bash", { command: "pnpm test" })).toBe("Bash: pnpm test");
    expect(describeToolUse("Grep", { pattern: "TODO" })).toBe('Grep "TODO"');
    expect(describeToolUse("UnknownTool", { x: 1 })).toBe("UnknownTool");
  });

  it("maskSecrets 주입 시 title 에 적용된다 (SEC-11)", () => {
    // 주입 마스킹 동작만 검증 — 진짜 시크릿 형태 대신 중립 토큰으로(gitleaks 오탐 방지)
    const mask = (t: string): string => t.replace(/PLACEHOLDER-\S+/g, "***");
    const out = describeToolUse("Bash", { command: "curl -H PLACEHOLDER-abc api" }, mask);
    expect(out).toBe("Bash: curl -H *** api");
  });
});

describe("createAgentTaskStream — tool_use → task_update 매핑", () => {
  it("tool_use 2개 → tool_result(성공+에러): plan 앵커 1회 + in_progress→complete/error, id 매핑", () => {
    const batches: Chunk[][] = [];
    const stream = createAgentTaskStream((args) => batches.push(args.chunks));

    stream.onEvent(
      assistantToolUse([
        { id: "tu-A", name: "Read", input: { file_path: "/a.ts" } },
        { id: "tu-B", name: "Bash", input: { command: "pnpm test" } },
      ]),
    );
    stream.onEvent(
      userToolResult([
        { toolUseId: "tu-A", isError: false },
        { toolUseId: "tu-B", isError: true },
      ]),
    );

    // 첫 배치: plan_update 앵커 + in_progress task 2개
    expect(batches[0]?.[0]).toEqual({ type: "plan_update", title: "작업 진행 중" });
    const first = batches[0] ?? [];
    expect(first.slice(1)).toEqual([
      { type: "task_update", id: "t1", title: "Read /a.ts", status: "in_progress" },
      { type: "task_update", id: "t2", title: "Bash: pnpm test", status: "in_progress" },
    ]);

    // 두 번째 배치: 앵커 없이 마감 (A complete, B error) — 같은 taskId 로 갱신
    expect(batches[1]).toEqual([
      { type: "task_update", id: "t1", title: "Read /a.ts", status: "complete" },
      { type: "task_update", id: "t2", title: "Bash: pnpm test", status: "error" },
    ]);
    // plan 앵커는 딱 한 번
    expect(batches.flat().filter((c) => c.type === "plan_update")).toHaveLength(1);
  });

  it("planTitle 옵션·hiddenTools 반영", () => {
    const batches: Chunk[][] = [];
    const stream = createAgentTaskStream((args) => batches.push(args.chunks), {
      planTitle: "리서치 중",
      hiddenTools: new Set(["TodoWrite"]),
    });
    stream.onEvent(
      assistantToolUse([
        { id: "tu-A", name: "TodoWrite", input: { todos: [1, 2] } },
        { id: "tu-B", name: "Read", input: { file_path: "/a.ts" } },
      ]),
    );
    // hiddenTools 는 task 로 안 나온다 — Read 하나만 + 앵커 제목은 옵션값
    expect(batches[0]?.[0]).toEqual({ type: "plan_update", title: "리서치 중" });
    expect(batches[0]?.slice(1)).toEqual([
      { type: "task_update", id: "t1", title: "Read /a.ts", status: "in_progress" },
    ]);
  });

  it("finalize: 미마감 task 를 complete 로 정리한다", () => {
    const batches: Chunk[][] = [];
    const stream = createAgentTaskStream((args) => batches.push(args.chunks));
    stream.onEvent(assistantToolUse([{ id: "tu-A", name: "Read", input: { file_path: "/a.ts" } }]));
    // tool_result 없이 finalize → 미마감 A 가 complete 로 마감
    stream.finalize();
    expect(batches.at(-1)).toEqual([
      { type: "task_update", id: "t1", title: "Read /a.ts", status: "complete" },
    ]);
    // 두 번 finalize 해도 재마감 없음(맵 비움)
    const before = batches.length;
    stream.finalize();
    expect(batches).toHaveLength(before);
  });

  it("maskSecrets 가 task title 에 적용된다", () => {
    const batches: Chunk[][] = [];
    const mask = (t: string): string => t.replace(/PLACEHOLDER-\S+/g, "***");
    const stream = createAgentTaskStream((args) => batches.push(args.chunks), {
      maskSecrets: mask,
    });
    stream.onEvent(
      assistantToolUse([{ id: "tu-A", name: "Bash", input: { command: "echo PLACEHOLDER-x" } }]),
    );
    const task = batches[0]?.[1];
    expect(task).toEqual({
      type: "task_update",
      id: "t1",
      title: "Bash: echo ***",
      status: "in_progress",
    });
  });

  it("매칭 안 되는 tool_result 나 tool_use 없는 배치는 append 를 유발하지 않는다", () => {
    const batches: Chunk[][] = [];
    const stream = createAgentTaskStream((args) => batches.push(args.chunks));
    stream.onEvent(userToolResult([{ toolUseId: "unknown" }]));
    stream.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    expect(batches).toHaveLength(0);
  });
});
