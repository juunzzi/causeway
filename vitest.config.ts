import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // skills/ 의 헬퍼(.mjs)도 대상이다 — dbx.mjs 의 조회 구문 가드는 보안 경계라
    // "경계는 프롬프트가 아니라 코드다"(CLAUDE.md)를 테스트가 붙잡아야 한다.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "skills/**/*.test.mjs"],
  },
});
