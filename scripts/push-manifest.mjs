#!/usr/bin/env node
/**
 * config/slack-app-manifest.yaml → Slack 앱에 반영 (apps.manifest.update).
 *
 * 웹 콘솔에 손으로 붙여넣는 대신 쓴다. "레포 파일이 SoT"(SETUP.md §2)를 사람의 성실함에
 * 맡기지 않고 **레포 → 앱 한 방향 경로**를 코드로 만든 것이다. 반대 방향(콘솔에서 고치고
 * 레포에 반영 안 함)은 다음 사람이 레포를 믿고 재설치했다가 기능이 조용히 빠지는 사고가 된다.
 *
 * ── 인증 ──────────────────────────────────────────────────────────────────────
 * 봇 토큰(xoxb)·앱 토큰(xapp) 둘 다 못 쓴다. 이 API 는 **App Configuration Token** 전용이다.
 * 그런데 그 access token 은 **12시간 만료**라, 그것만 쓰면 매니페스트를 고칠 때마다 사람이
 * 콘솔에서 새로 발급해야 한다 — 자동화의 목적이 무너진다. 그래서 refresh token 을 저장해 두고
 * 만료를 만나면 스스로 회전한다(tooling.tokens.rotate).
 *
 * refresh token 은 **1회용**이다. 회전하면 access·refresh 둘 다 새로 나오고 옛 refresh 는
 * 죽는다. 그래서 회전 결과를 반드시 .env 에 되써야 한다 — 안 쓰면 다음 실행에서 영영 못 고친다.
 *
 * 최초 1회만 사람이 한다: https://api.slack.com/apps → Your App Configuration Tokens →
 * Generate Token → 나온 **Refresh Token(xoxe-1-…)** 을 .env 에 넣는다(access 는 없어도 된다).
 *   SLACK_CONFIG_REFRESH_TOKEN=xoxe-1-…
 *
 * 실행: node scripts/push-manifest.mjs [--dry]
 *   --dry: 반영 없이 Slack 의 스키마 검증(apps.manifest.validate)까지만.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const APP_ID = "A0XXXXXXXXX"; // 이 봇의 Slack 앱 ID 로 바꾼다(api.slack.com/apps → Basic Information)

const ACCESS_KEY = "SLACK_CONFIG_ACCESS_TOKEN";
const REFRESH_KEY = "SLACK_CONFIG_REFRESH_TOKEN";

const dry = process.argv.includes("--dry");

// ── .env 읽기/쓰기 ────────────────────────────────────────────────────────────
// 토큰을 CLI 인자로 받지 않는 이유는 셸 히스토리·프로세스 목록에 남기 때문이고,
// 파일에 되쓰는 이유는 회전된 refresh 를 잃으면 복구가 사람 손으로만 가능하기 때문이다.

/** KEY=value 한 줄을 치환하거나 없으면 덧붙인다. 주석·다른 키는 건드리지 않는다. */
function setEnvValue(key, value) {
  const raw = readFileSync(ENV_PATH, "utf8");
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(raw)
    ? raw.replace(re, line)
    : `${raw.endsWith("\n") ? raw : `${raw}\n`}${line}\n`;
  writeFileSync(ENV_PATH, next);
}

async function slack(method, body, token) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

/**
 * 토큰 없이 부르는 폼 인코딩 호출 — `tooling.tokens.rotate` 전용.
 *
 * 이 메서드만 형식이 다르다. 문서는 JSON 도 받는다고 적혀 있지만 실제로는 `invalid_arguments`
 * 로 거절한다(2026-08-10 실측) — 인자를 아예 못 읽었다는 뜻이라, 토큰이 틀린 것과 구분이 안 돼
 * 한참 헤맬 수 있다. refresh token 은 1회용이라 시행착오 비용이 큰 자리다.
 */
async function slackForm(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return await res.json();
}

/**
 * refresh token 으로 access·refresh 를 새로 받고 .env 에 되쓴다.
 * 실패하면 사람이 콘솔에서 다시 발급하는 것 말고는 길이 없으므로 그 안내를 그대로 낸다.
 */
async function rotate(refreshToken) {
  const body = await slackForm("tooling.tokens.rotate", { refresh_token: refreshToken });
  if (!body.ok) {
    console.error(`❌ 토큰 회전 실패: ${body.error}`);
    console.error(
      "   refresh token 이 이미 쓰였거나(1회용) 폐기됐다. 콘솔에서 새로 발급해 .env 의",
      `${REFRESH_KEY} 를 교체한다: https://api.slack.com/apps`,
    );
    process.exit(1);
  }
  setEnvValue(ACCESS_KEY, body.token);
  setEnvValue(REFRESH_KEY, body.refresh_token);
  console.log("🔄 만료된 설정 토큰을 회전했다 (.env 갱신).");
  return body.token;
}

// ── 본문 ──────────────────────────────────────────────────────────────────────

process.loadEnvFile(ENV_PATH);
const manifest = parse(readFileSync(join(ROOT, "config/slack-app-manifest.yaml"), "utf8"));

let access = process.env[ACCESS_KEY];
const refresh = process.env[REFRESH_KEY];

if (!access && !refresh) {
  console.error(
    [
      `❌ ${ACCESS_KEY} · ${REFRESH_KEY} 둘 다 없음.`,
      "",
      "최초 1회만 사람이 한다:",
      "  1. https://api.slack.com/apps → 우측 'Your App Configuration Tokens' → Generate Token",
      "     (해당 워크스페이스를 고른다)",
      `  2. **Refresh Token(xoxe-1-…)** 을 .env 에 직접 붙여넣는다 — 채팅·CLI 인자로 넘기지 말 것:`,
      `       ${REFRESH_KEY}=xoxe-1-…`,
      "  3. 다시 실행. 이후 만료는 이 스크립트가 스스로 회전한다.",
    ].join("\n"),
  );
  process.exit(1);
}
if (!access) access = await rotate(refresh);

/** 만료면 1회 회전 후 재시도한다. 그 외 실패는 그대로 올린다. */
async function callWithRetry(method, body) {
  let res = await slack(method, body, access);
  if (!res.ok && (res.error === "token_expired" || res.error === "invalid_auth") && refresh) {
    access = await rotate(process.env[REFRESH_KEY] ?? refresh);
    res = await slack(method, body, access);
  }
  return res;
}

// 반영 전에 Slack 의 스키마 검증을 먼저 받는다 — 잘못된 매니페스트로 앱 설정을 덮어쓰는 것보다
// 여기서 거절당하는 편이 싸다. display_name 한글처럼 저장 자체가 반려되는 규칙이 여럿 있다.
const validated = await callWithRetry("apps.manifest.validate", { app_id: APP_ID, manifest });
if (!validated.ok) {
  console.error(`❌ 매니페스트 검증 실패: ${validated.error}`);
  if (validated.errors) console.error(JSON.stringify(validated.errors, null, 2));
  process.exit(1);
}
console.log("✅ 매니페스트 검증 통과");

if (dry) {
  console.log("   --dry 라 반영은 건너뛴다.");
  process.exit(0);
}

const updated = await callWithRetry("apps.manifest.update", { app_id: APP_ID, manifest });
if (!updated.ok) {
  console.error(`❌ 반영 실패: ${updated.error}`);
  if (updated.errors) console.error(JSON.stringify(updated.errors, null, 2));
  process.exit(1);
}

console.log("✅ 매니페스트 반영 완료");
console.log(
  updated.permissions_updated
    ? "⚠️  스코프가 바뀌었다 — 앱을 재설치해야 새 스코프가 토큰에 실린다(SETUP.md §2)."
    : "   스코프 변경 없음 — 재설치 불필요.",
);
