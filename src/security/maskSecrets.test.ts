import { describe, expect, it } from "vitest";
import { maskSecrets } from "./maskSecrets.js";

describe("maskSecrets", () => {
  it("KEY=value 할당 마스킹 (대문자 env)", () => {
    const out = maskSecrets("DATADOG_API_KEY=abc123secret 로 설정");
    expect(out).toBe("DATADOG_API_KEY=*** 로 설정");
  });

  it("key: value 콜론 형태 + 소문자 키워드", () => {
    const out = maskSecrets("api_key: 'abc123'");
    expect(out).not.toContain("abc123");
    expect(out).toContain("***");
  });

  it('JSON 형태 "key": "value" — 따옴표로 감싼 키도 마스킹 (API 응답 유출 방지)', () => {
    const out = maskSecrets('{"token": "abcdef123456", "user": "gildong"}');
    expect(out).not.toContain("abcdef123456");
    expect(out).toContain('"user": "gildong"'); // 시크릿 키워드 없는 필드는 보전
  });

  it("JSON 공백 없는 형태와 싱글쿼트 키도 마스킹", () => {
    expect(maskSecrets('{"api_key":"abcd1234"}')).not.toContain("abcd1234");
    expect(maskSecrets("{'password': 'hunter2secret'}")).not.toContain("hunter2secret");
  });

  it("따옴표/앰퍼샌드 경계에서 값만 마스킹", () => {
    const out = maskSecrets("curl 'https://x?api_key=abcd1234&b=2'");
    expect(out).not.toContain("abcd1234");
    expect(out).toContain("&b=2");
  });

  it("Bearer 헤더 — Authorization 키워드 규칙과 겹쳐도 토큰이 남지 않는다", () => {
    const out = maskSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("Token 헤더", () => {
    const out = maskSecrets("헤더 Token abcdefgh1234 사용");
    expect(out).not.toContain("abcdefgh1234");
  });

  it("Slack 토큰 xoxb / xoxp", () => {
    expect(maskSecrets("xoxb-1234567890-abcdefghij")).toBe("***");
    expect(maskSecrets("token=xoxp-9876543210-zyxwvutsrq 입니다")).not.toContain("xoxp-");
  });

  it("Slack app-level 토큰 xapp", () => {
    expect(maskSecrets("xapp-1-A0XXXXX-123456789-abcdef")).toBe("***");
  });

  it("GitHub 토큰 ghp_ / github_pat_", () => {
    expect(maskSecrets(`ghp_${"a".repeat(36)}`)).toBe("***");
    expect(maskSecrets(`github_pat_${"b".repeat(22)}`)).toBe("***");
  });

  it("sk- 계열 키 (Anthropic/OpenAI)", () => {
    expect(maskSecrets("sk-ant-api03-abcdefghijklmnopqrstuvwx")).toBe("***");
  });

  it("단어 내부의 sk- 는 오탐하지 않는다", () => {
    const out = maskSecrets("task-force-1234567890123456 진행");
    expect(out).toContain("task-force-1234567890123456");
  });

  it("Datadog app key", () => {
    expect(maskSecrets("ddapp_abc123def")).toBe("***");
  });

  it("AWS Access Key ID", () => {
    expect(maskSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("***");
    expect(maskSecrets("ASIAIOSFODNN7EXAMPLE")).toBe("***");
  });

  it("Slack incoming webhook 경로", () => {
    const out = maskSecrets("https://hooks.slack.com/services/T000/B000/XXXXYYYY");
    expect(out).toBe("https://hooks.slack.com/services/***");
  });

  it("PEM private key 블록 전체", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAB==\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`앞${pem}뒤`)).toBe("앞***뒤");
  });

  it("여러 패턴 혼재 시 전부 마스킹", () => {
    const out = maskSecrets("SLACK_BOT_TOKEN=xoxb-111-aaaa 그리고 Bearer abcdefgh99");
    expect(out).not.toContain("xoxb-");
    expect(out).not.toContain("abcdefgh99");
  });

  it("시크릿 없는 평문은 그대로", () => {
    const text = "배포 완료. 참조: docs/README.md 확인 바랍니다";
    expect(maskSecrets(text)).toBe(text);
  });

  it("빈 입력은 빈 문자열", () => {
    expect(maskSecrets("")).toBe("");
    expect(maskSecrets(null)).toBe("");
    expect(maskSecrets(undefined)).toBe("");
  });
});
