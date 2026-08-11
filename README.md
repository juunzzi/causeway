# causeway

Slack ↔ Claude Code 다리. 슬랙에서 `@멘션`이나 DM으로 물으면, 당신 머신에서 Claude Code 세션이
돌고 답이 그 스레드에 달린다.

```
Slack (Socket Mode) → 잡 큐(SQLite) → Claude Agent SDK 세션 → 스레드에 게시
```

**보일러플레이트다.** 쓸 만한 뼈대만 들어 있고 도메인 도구는 없다 — 당신 조직의 도구를 붙이는
자리와 규율이 코드에 표시돼 있다.

## 왜 이게 필요한가

Claude Code를 슬랙에서 부르는 건 어렵지 않다. **어려운 건 그게 며칠 이상 살아 있게 만드는 것**이다.
이 레포는 개인 봇을 몇 달 굴리며 실제로 밟은 함정들에 대한 답으로 이루어져 있다:

- **소켓이 살아 있는 척한다** — Socket Mode는 연결은 붙어 있는데 이벤트만 안 오는 상태가 된다.
  주기 probe로 감지하고, 놓친 메시지를 재주입하고, 연속 실패하면 프로세스를 죽여 PM2가 되살린다.
- **맥이 잔다** — 절전 구간에 정각 타이머는 통째로 사라진다. 스케줄러는 타이머 대신 "지금 기준
  지난 발화"를 계산하고, 발화 시각을 dedup key로 써서 늦게 깨어나도 놓치지 않는다.
- **잡이 증발한다** — 프로세스가 죽으면 처리 중이던 요청이 사라진다. 잡은 SQLite에 먼저 쓰고
  부팅 때 복구하며, `dedup_key UNIQUE`가 재시도·중복 수신을 구조적으로 막는다.
- **자격증명이 샌다** — 세션은 Bash를 갖고 있다. 세션 env를 스크럽하고, 외부 API는 in-process
  MCP 도구로 감싸 **결과 요약만** 넘긴다.
- **실패가 조용하다** — 도구가 안 붙어도, 스케줄이 안 울려도 아무 일도 안 일어난 것처럼 보인다.
  모든 배선 판정을 부팅 로그에 한 줄씩 남긴다.

## 들어 있는 것

| | |
|---|---|
| **잡 큐** | SQLite 내구성 큐 — lease·재시도·부팅 복구·레인 분리 |
| **Socket Mode 복원력** | 헬스 probe → 놓친 메시지 재주입 → strike 후 종료, 슬립 감지, 워치독 |
| **세션** | 스레드↔세션 매핑으로 이어묻기(`--resume`), 세션당 MCP 인스턴스 격리 |
| **egress 일원화** | 게시는 한 경로로만 — 세션에는 Slack 쓰기 도구를 주지 않는다 |
| **취소** | 🛑 리액션 또는 `/cancel` — 둘 다 같은 종착지 |
| **스케줄러** | 봇 안의 cron. 슬립에 강한 따라잡기 + dedup key 멱등성 |
| **ACL** | `config/access.json` 하나가 유일한 경계. 핫리로드 |
| **운영 CLI** | `bin/causeway` — 설치·상태·로그·재시작·배포·아카이브 |
| **자동 배포** | main 추종 + CI 게이트 + 부팅 정상성 판정 실패 시 롤백·격리 |
| **배포 공지** | 그 구간에 머지된 PR을 근거로 슬랙에 한 줄씩 |
| **세션 아카이브** | 오래된 트랜스크립트를 md 요약으로 접기(용량 + 평문 도구출력 둘 다) |

## 빠른 시작

```bash
pnpm install
cp .env.example .env      # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CLAUDE_CODE_OAUTH_TOKEN
cp config/access.example.json config/access.json   # 본인 Slack 유저 ID
pnpm dev
```

Slack 앱은 `config/slack-app-manifest.yaml`을 붙여넣어 만든다. 자세한 절차는
[SETUP.md](./SETUP.md), 상시 구동·운영은 [CLAUDE.md](./CLAUDE.md),
설계 근거는 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## 당신 조직의 것으로 만들기

이 봇의 값어치는 **당신 조직의 도구와 절차**에서 나온다. 붙이는 자리는 넷이고, 전부
[docs/EXTENDING.md](./docs/EXTENDING.md) 에 정리돼 있다:

| seam | 무엇을 정하나 |
|---|---|
| `src/mcp/` | 봇이 **할 수 있는 일** — [`example.ts`](./src/mcp/example.ts) 가 복사해 쓰는 틀 |
| `skills/` | 봇이 **어떤 순서로** 일하는지 — [작성법](./skills/README.md) |
| `config/` · `.env` | 누가 부를 수 있고(ACL), 언제 울리고, 어디에 게시하는지 |
| `CLAUDE.md` | 회사 규약 — 세션이 상속한다 |

새 도구의 배선은 세 곳이다: `src/mcp/<도구>.ts` 구현 → `src/mcp/registry.ts` 등록 →
`src/context.ts` 배선 판정(+부팅 로그 한 줄). registry 배열이 곧 노출 경계라 glob 자동발견을
쓰지 않는다 — 파일 하나 추가했다는 이유로 세션 권한이 넓어지면 그 변경이 diff 에서 안 보인다.

경계는 프롬프트가 아니라 **입력 스키마**로 만든다. 조회 전용 도구라면 `method` 필드를 아예
두지 않는다 — "쓰기 하지 마"를 모델 순응도에 맡기지 않기 위해서다.

fork 해서 쓸 때 업스트림 수정을 계속 받아오는 요령도 같은 문서에 있다: **조직 특정 내용을
스파인 파일에 적지 않는 것** 하나만 지키면 병합이 대부분 자동으로 끝난다.

## 보안 모델

세션은 Claude Code와 같은 능력을 갖는다(Bash·Edit/Write·WebSearch 등). 그래서 경계는
"무엇을 할 수 있나"가 아니라 **"누가 부를 수 있나"** 다:

```json
{ "allowed": ["U…"], "admins": ["U…"] }
```

`allowed`를 넓히는 것은 **그 머신의 셸을 그만큼 여는 것**이다. `"*"`(전원 허용)은 워크스페이스
누구나 이 머신에서 명령을 돌릴 수 있다는 뜻이다. 그 위험을 감수할 이유가 없다면 본인 ID만 둔다.

남은 가드 둘:
- **secretPathGuard** — `.env`·`.ssh` 같은 경로 유출 차단(슬랙은 사람이 읽는 곳이다)
- **backgroundAgentGuard** — 잡 큐가 추적할 수 없는 백그라운드 작업 차단

## 요구사항

- Node 24+ (`node:sqlite` 내장을 쓴다)
- pnpm
- Claude Code CLI (인증용)
- 상시 구동은 PM2 — devDependency라 전역 설치 불필요

## 라이선스

MIT
