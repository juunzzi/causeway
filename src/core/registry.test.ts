import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnyJobHandler } from "./queue/types.js";
import { buildRegistry } from "./registry.js";

function handler(type: string): AnyJobHandler {
  return {
    type,
    lane: "automation",
    maxAttempts: 1,
    payloadSchema: z.unknown(),
    run: async () => "done",
  };
}

describe("buildRegistry (JQ-09)", () => {
  it("기본 등록 배열 스냅샷 — 새 잡 추가는 이 스냅샷 갱신 PR로 드러난다", () => {
    // Phase 1 core/queue 시점: 핸들러 없음. chat 잡 합류 시 이 배열이 갱신돼야 한다.
    expect([...buildRegistry().keys()]).toEqual([]);
  });

  it("명시 배열의 핸들러를 타입으로 조회한다", () => {
    const chat = handler("chat");
    const registry = buildRegistry([chat, handler("alert-analysis")]);
    expect(registry.get("chat")).toBe(chat);
    expect(registry.size).toBe(2);
  });

  it("등록 핸들러의 payloadSchema가 zod 검증을 수행한다", () => {
    const typed: AnyJobHandler = {
      ...handler("typed"),
      payloadSchema: z.object({ schema_version: z.literal(1) }),
    };
    const registry = buildRegistry([typed]);
    const schema = registry.get("typed")?.payloadSchema;
    expect(schema?.safeParse({ schema_version: 1 }).success).toBe(true);
    expect(schema?.safeParse({ schema_version: 2 }).success).toBe(false);
  });

  it("같은 타입 이중 등록은 부팅 시점에 죽는다", () => {
    expect(() => buildRegistry([handler("dup"), handler("dup")])).toThrow(/중복 등록/);
  });
});
