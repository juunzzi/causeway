# SETUP

처음 한 번 하는 설치·자격증명 절차. 상시 구동·운영은 [CLAUDE.md](./CLAUDE.md),
설계 근거는 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## 0. 요구사항

- **Node 24+** — `node:sqlite` 내장을 쓴다. 낮은 버전은 부팅부터 실패한다.
- **pnpm**
- **Claude Code CLI** — 세션 인증에 쓴다.

```bash
node -v      # v24 이상
pnpm install
```

## 1. 무엇이 필수인가

| 값 | 없으면 |
|---|---|
| `SLACK_BOT_TOKEN` (§2) | 부팅 실패 |
| `SLACK_APP_TOKEN` (§2) | 부팅 실패 |
| `CLAUDE_CODE_OAUTH_TOKEN` 또는 `ANTHROPIC_API_KEY` (§3) | 부팅은 되지만 모든 답이 인증 오류 |
| `config/access.json` (§4) | 부팅은 되지만 **아무도 부를 수 없다**(fail-closed) |

나머지는 전부 선택이고, 없으면 그 기능만 조용히 빠진다 — **어느 쪽이든 부팅 로그에 한 줄씩 남는다.**

## 2. Slack 앱

`api.slack.com/apps` → **Create New App** → **From an app manifest** →
`config/slack-app-manifest.yaml` 내용을 붙여넣는다.

만든 뒤:

1. **Install App** → Allow → `Bot User OAuth Token`(`xoxb-…`) → `.env` 의 `SLACK_BOT_TOKEN`
2. **Basic Information** → App-Level Tokens → **Generate** (스코프 `connections:write`) →
   `xapp-…` → `.env` 의 `SLACK_APP_TOKEN`
3. 봇을 부를 채널마다 `/invite @causeway` — **그 초대가 곧 읽기 범위 선언**이다.

### 밟기 쉬운 것들

- **DM 입력창이 "메시지를 보내는 기능이 꺼져 있습니다"로 보이면 먼저 `Cmd+R`.** 매니페스트의
  `app_home` 블록이 있는데도 그렇게 보이면 서버가 아니라 Slack 클라이언트 캐시다.
- **`features.bot_user.display_name` 은 ASCII 만 된다.** Slack 이 이 값에서 봇 username 을
  파생하는데 비ASCII 는 변환에 실패해 **매니페스트 저장 자체가 거부된다**(`bad_username`).
  워크스페이스에 보이는 이름을 한글 등으로 두고 싶으면 매니페스트가 아니라 워크스페이스 앱
  관리에서 고친다: `https://<workspace>.slack.com/marketplace/<APP_ID>-?tab=settings` → 봇 사용자 → 편집.
  (api.slack.com 쪽 값은 **새 설치용**이라 이미 설치된 봇 이름은 안 바뀐다.)
- **Agent 모드(plan 카드 스트리밍)** 는 App 설정 → **Agents** 의 `Agent experience` 토글이 켜져야
  열린다. 이 토글은 매니페스트에 없다. 꺼져 있으면 `chat.startStream` 이 거절되고 진행 카드로
  자동 폴백한다(동작은 하지만 표시가 다르다).

## 3. Claude 인증

```bash
claude auth status --text     # 먼저 확인
claude setup-token            # 장수명 토큰 발급 → .env 의 CLAUDE_CODE_OAUTH_TOKEN
```

- **`claude setup-token` 은 로그인된 상태를 전제한다.** 만료 상태에서 실행하면 브라우저 승인을
  해도 토큰이 안 나온다. Expired 면 `claude auth login` 부터.
- **사람의 인터랙티브 로그인에 얹지 마라.** 그게 만료되는 날 봇이 죽는데, 슬랙에는
  `OAuth session expired` 로만 보여서 원인을 찾는 데 시간이 걸린다.

## 4. 접근 제어 (필수)

```bash
cp config/access.example.json config/access.json
```

```json
{
  "allowed": ["U00000000AA"],
  "admins":  ["U00000000AA"]
}
```

**이 파일이 유일한 보안 경계다.** 세션은 Claude Code 와 같은 능력을 갖기 때문에(Bash 포함),
`allowed` 를 넓히는 것은 **이 머신의 셸을 그만큼 여는 것**이다. `"*"` 는 워크스페이스 전원에게
그걸 여는 뜻이다. 파일이 없으면 아무도 못 부른다(fail-closed) — 그게 안전한 기본값이다.

자기 Slack 유저 ID 는 Slack 프로필 → 더보기 → "멤버 ID 복사".

## 5. 실행

```bash
pnpm dev        # 로그가 터미널에 그대로 흐른다. Ctrl+C 로 종료
```

부팅 로그에서 이 줄이 보이면 성공이다:

```
acl: access.json 반영 — allowed 1명, admins 1명
Socket Mode 시작 — bot=U…
```

DM 으로 아무거나 물어보면 답이 온다. 상시 구동(PM2)은 [CLAUDE.md](./CLAUDE.md).

## 6. 선택 — 스케줄

```bash
cp config/schedules.example.json config/schedules.json
```

`enabled: true` 로 바꾸고 채널·유저 ID·프롬프트 파일을 채운 뒤 재시작한다. cron 문법·따라잡기
동작은 [CLAUDE.md](./CLAUDE.md) 참고.

## 7. 선택 — 알림 채널

```bash
cp config/channels.example.yaml config/channels.yaml
```

`ops-notify`(워치독·재시도 소진 등)와 `release-notify`(배포 공지) 두 role 이 있다.

⚠️ **같은 채널 ID 를 두 role 에 쓸 수 없다** — 부팅 시 중복 검증에 걸려 죽는다. 하나만 쓰려면
하나만 선언한다(미선언 role 은 로그로만 남는다).

## 8. 선택 — 매니페스트 자동 반영

`api.slack.com/apps` → 우측 **Your App Configuration Tokens** → Generate Token →
나온 **Refresh Token**(`xoxe-1-…`)을 `.env` 의 `SLACK_CONFIG_REFRESH_TOKEN` 에 넣는다.

```bash
node scripts/push-manifest.mjs --dry   # 검증만
node scripts/push-manifest.mjs         # 반영
```

access 토큰은 12시간 만료라 스크립트가 스스로 회전하고 `.env` 에 되쓴다. **refresh 토큰은
1회용**이라 회전 결과를 잃으면 콘솔에서 재발급해야 한다.
