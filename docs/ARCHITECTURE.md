# causeway 아키텍처

> 이 문서는 **현재 머지된 동작만** 담는다. 구현이 문서와 어긋나면 문서가 틀린 것이므로 같은 PR 에서 고친다.

## 0. 설계 철학: "모든 것은 잡이다"

슬랙 봇의 운영 사고 대부분 — 좀비 소켓으로 인한 메시지 유실, 재시작 시 인메모리 상태 소실,
중복 트리거 — 은 **"수신 즉시 실행"** 이라는 한 가지 구조에서 나온다. 그래서 이 봇은 처리 전에
먼저 저장한다:

- **Ingress(생산자)는 절대 실행하지 않는다.** 정규화 → 멱등 enqueue만.
- **@멘션/DM 대화까지 전부 `jobs` 테이블의 행 하나다.** 스케줄 발화도 같은 테이블로 들어온다.
- **중복 방지는 휴리스틱이 아니라 스키마다.** `dedup_key UNIQUE` 가 이벤트 재전송·probe replay·
  스케줄 따라잡기를 전부 구조적으로 no-op 으로 만든다.
- **프로세스는 언제 죽어도 된다.** 부팅 시 `recoverInflight` 가 중단 잡을 복구한다.
- **순수 함수와 부작용의 물리적 분리 + 의존성 주입**이 기본 규율이다. 가드·파서·요약이 전부
  순수 함수여야 테스트가 계약을 붙잡는다.

이 보일러플레이트에 **없는 것**과 그 이유:

| 없는 것 | 왜 |
|---|---|
| 채널 워처·백필 | 트리거는 사람(@멘션·DM)과 스케줄뿐이다. 자동 수집 채널이 없으니 백필할 대상도 없다 |
| 도메인 도구 | 조직마다 다르다. 붙이는 **자리와 규율**만 남겼다(§4) |
| 쓰기 전용 프로파일·worktree 잡 | 아무도 부르지 않는 bypassPermissions 빌더를 남기는 것은 다음 사람에게 초대장이다 |

```
[Slack 리스너(app_mention · message.im)]   ← Ingress: enqueue만
        └────── normalize → enqueue (dedup_key UNIQUE) ──────┐
                                                             ▼
                SQLite 내구 잡 큐 (pending → inflight → done/failed)
                                │ claimNext (BEGIN IMMEDIATE)
                          interactive lane
                    (thread_key별 직렬 · 스레드 간 병렬 N=3 · 즉시 wakeup)
                                │
                    Runner (Agent SDK · CHAT 프로파일 · 가드 훅)
                                │
                Egress — Slack 송신 유일 경로
                (mask → mrkdwn → chunk → 멘션 게이트 → post)
```

## 1. 기술 스택

| 항목 | 결정 | 근거 |
|---|---|---|
| 언어 | TypeScript (ESM, strict) | 유지보수 인원이 곧 작성자다. 타입이 유일한 안전망 |
| 런타임 | Node ≥ 22 (`node:sqlite`) | 네이티브 바인딩 없이 큐/세션 영속화 |
| Slack | @slack/bolt Socket Mode + **xoxb 봇 토큰** | `app_mention` + `message.im` 두 이벤트가 요구사항과 정확히 일치 |
| 에이전트 | @anthropic-ai/claude-agent-sdk (모델 opus-5) | CLI spawn 의 stderr drain hang·stream-json 파싱 지뢰 제거. 단 `tools:[]` 만 유효(`allowedTools:[]` 는 no-op)라는 footgun 은 그대로. 모델은 사용자가 Claude Code 에서 쓰는 것과 맞춘다 |
| 테스트 | vitest + `:memory:` SQLite | 큐 상태 전이·파서·도구 가드를 실제 계약으로 회귀 테스트 |
| 배포 | 상시 구동 호스트 + PM2, `bin/causeway` CLI | 절전이 좀비 소켓의 상류 원인. wakeDetector 는 darwin 이면 기본 on |

## 2. 핵심 모듈

```
src/
├── core/queue/        # ★ 척추: jobStore(enqueue/claimNext/settle/recoverInflight), dispatcher, lease
├── core/constants.ts  # 수치 계약 (근거 주석 필수)
├── ingress/           # slackListeners · normalize · ingressDedup — enqueue 까지만
├── jobs/chat/         # 유일한 잡. 스레드=세션, 컨텍스트 조립, 프롬프트 빌드
├── runner/            # Agent SDK 래퍼(유일한 세션 스폰 지점), profiles(READONLY/AUX),
│                      #   hooks(secretPathGuard/backgroundAgentGuard)
├── sessions/          # thread_key(channel:thread_ts) ↔ session_id + last_seen_ts
├── egress/            # poster·progress·chunker·mrkdwn·reactions — Slack 송신 유일 경로
├── security/          # acl(access.json), maskSecrets, sanitize
├── resilience/        # socketHealth(probe→replay→strike-exit), wakeDetector, watchdog, friction
├── mcp/               # in-process MCP 도구 4종 + slackRead + 외부 배선(memory stdio · analytics http)
└── skills/            # 도구가 아닌 조회원의 **배선 판정만**(warehouse: 호스트 CLI 실재 여부).
                       #   절차·가드는 아래 repo 루트 skills/ 가 갖는다
skills/                # 절차서·도메인 맥락(SKILL.md) — 세션이 Read 로 읽는다. 도구 1개 = 스킬 1개가
                       #   기본이고, 도구 없는 도메인 맥락도 같은 자리에 둔다
                       #   (게이트는 자격증명 · 참조 체크아웃 · 호스트 CLI 존재 여부).
                       #   실행 헬퍼(.mjs)도 여기 둔다 — warehouse/dbx.mjs 처럼 가드가 코드일 때
config/                # channels.yaml(논리명·role), access.json
```

### 잡 핸들러 계약

```ts
interface JobHandler<P> {
  type: string;
  lane: "interactive" | "automation" | "write";
  maxAttempts: number;
  payloadSchema: z.ZodType<P>;            // payload에 schema_version 포함
  run(job: Job<P>, ctx: JobContext): Promise<JobResult>;  // deps는 ctx 주입 → 테스트 가능
  onExhausted?(job: Job<P>, ctx: JobContext): Promise<void>;  // silent cap 금지
}
```

레인 3종은 큐 구현에 그대로 남아 있다(automation·write 는 현재 사용자가 없다). 두 번째 잡이
생길 때 등록 지점이 어디인지 코드가 스스로 말하도록 `jobs/index.ts` 는 배열이 하나여도 남겨 뒀다.

### 동시성

- **interactive**: 병렬 최대 3 — 단 같은 thread_key 는 직렬(순서 보장). 워크트리 없음
  (READONLY, cwd = 공용 `workspace/`).

## 3. 사람 인터페이스: @멘션 + DM only

- `app_mention` + `message.im` 두 이벤트가 전부. prefix 트리거 없음, 페르소나 없음.
- **스레드 = 세션**: `thread_key ↔ session_id` 영속, resume + `last_seen_ts` 이후 증분 컨텍스트 주입.
  세션 키에 user 를 넣지 않는다 — 한 스레드에서 여러 사람이 이어 묻는 것이 기본이다.
- 응답 도중 크래시 → 부팅 시 recoverInflight 가 재시도(attempts<2) + 스레드에 안내.
- 커맨드(`/status /cancel /queue /allow /help`)는 잡이 아니라 즉시 처리.
- **중단은 리액션으로도 된다**: 봇이 ⏳ 옆에 🛑 를 미리 달아 두고(어포던스), 그걸 누르거나
  사람이 직접 🛑/⏹️/⏹/❌ 중 아무거나 달면 `reaction_added` → `runningTasks.cancelByMessage` 로 `/cancel` 과
  같은 종착지에 닿는다. 버튼이 아닌 이유는 진행 표시가 Slack agent plan 카드(스트리밍)라
  Block Kit 버튼을 실을 자리가 없어서다 — 스레드에 버튼 메시지를 따로 띄우면 대화마다
  부산물이 하나씩 남는다. 리액션 이벤트는 `item.{channel,ts}` 만 싣고 thread_ts 를 주지
  않으므로, 진행 중 작업이 자기 좌표(트리거 ts·threadTs·진행카드 ts)를 들고 매칭한다.

## 4. 도구 — 이 봇의 본체

네 도구 전부 **in-process MCP**(`createSdkMcpServer`)다. 자격증명은 봇 프로세스 env 에만 있고,
세션 env 는 `profiles.ts` 의 `SENSITIVE_ENV_PATTERNS`(`/^SLACK_/`·`/^AWS_/`·도구별 접두 등)로
스크럽되므로 **세션은 키를 볼 수 없다.** 이게 중요한 이유는 단순하다: 세션이 키를 보면 도구를
우회해 직접 호출할 수 있고, 그 순간 아래 가드가 전부 무의미해진다.

| 도구 | 결정론 가드(코드) |
|---|---|
| `mytool_admin` | realm `example-internal` 고정 · 쓰기는 `allowWrite`(access.json admins) · `default-roles-*` 조작 원천 차단 |
| `mytool_query` | **메서드가 스키마에 없다(GET 고정)** · 서비스 화이트리스트 · 경로에서 절대경로/스킴/`..`/쿼리 거부 · 쿼리는 구조화 맵으로만 |
| `mytool_query` | SELECT 계열 첫 키워드 검사(주석 제거 후) · 단일 문장 강제 · `INTO OUTFILE`/`FOR UPDATE` 거부 · prd opt-in + reader 전용 표 · LIMIT 강제 |
| `mytool_query` | 읽기 엔드포인트만 · 식별자 인코딩 · 프로젝트 스코프 링크 고정 |

두 가지 규율이 모든 도구에 공통이다:

1. **경계는 프롬프트가 아니라 코드다.** "쓰기 하지 마"를 모델 순응도에 맡기지 않는다 —
   입력 스키마에서 표현 자체를 불가능하게 만든다.
2. **도구가 없으면 안내도 없다.** 배선되지 않은 도구의 절차서(SKILL.md)·프롬프트 가이드는
   함께 빠진다. 도구 없는 절차서는 세션이 "조회했지만 0건" 같은 거짓 결론을 만들게 한다.

### in-process 인스턴스는 세션당 하나다

`context.ts` 는 manifest 를 배열이 아니라 **팩토리**로 잡 deps 에 넘기고, 잡은 run 마다 그것을
호출해 그 세션 전용 manifest 를 만든다. 부팅 때 만든 인스턴스를 공유하면 세션이 겹치는 순간
나중 세션의 `instance.connect` 가 `Already connected` 로 실패하는데, SDK 는 그 실패를 debug 로그로
삼키고 **그 서버만 조용히 뺀다** — 세션은 에러 없이 도구 없는 상태로 진행하고 모델은 "도구가
연결되어 있지 않다"고 답한다(실측).

## 5. 세션 능력과 경계

설계 목표는 **Claude Code 와 같은 능력**이다 — 슬랙에서 묻든 Claude Code 에서 묻든 답이 같아야
한다. 조회 전용 제약은 그래서 의도적으로 걷어냈다.

| | 조회 전용으로 좁혔다면 | causeway 기본값 |
|---|---|---|
| 도구 | Read/Glob/Grep + `Bash(git …)` 접두만 | 전체 — Bash·Edit/Write·**WebSearch/WebFetch**·Task |
| 호스트 설정 | `settingSources: []`(미상속) | `["user","project","local"]` — CLAUDE.md·스킬·플러그인 상속 |
| 쓰기 | Edit/Write/NotebookEdit disallow | 허용 |
| 가드 훅 | bash·secretPath·cwdScope·backgroundAgent | **secretPath·backgroundAgent 만** |

좁히고 싶으면 `SESSION_ALLOWED_TOOLS`(profiles.ts)를 줄이면 된다. 다만 그때는 경계가 다시
도구 목록으로 돌아오므로, `settingSources` 상속과 함께 재검토해야 한다.

### 경계는 사라진 게 아니라 옮겨졌다

능력을 열면 "무엇을 할 수 있는가"로는 더 이상 방어가 안 된다. 그래서 경계가 **`config/access.json`
의 `allowed`** 로 옮겨졌다 — 누가 이 봇을 부를 수 있는가가 유일한 관문이다.

⚠️ **`allowed: ["*"]` 는 워크스페이스 전원에게 이 호스트의 셸을 여는 것과 같다.** 개인 봇이면
본인 Slack ID 하나만 둔다. 도구를 여는 변경과 allowed 를 좁히는 변경은 같은 PR 에서 함께 간다.

### 그래도 남긴 두 층

능력 제한이 아니라 **되돌릴 수 없는 사고**를 막는 층이라 개방과 무관하게 유지한다.

- **`secretPathGuard`** — `.env`·`.ssh`·`.aws` 등 credential 경로 차단(lexical + realpath 이중
  검사). 슬랙은 사람이 읽는 곳이고, 봇이 자격증명을 읽어 스레드에 붙이면 되돌릴 수 없다.
  이 봇 자신의 `.env`(슬랙 토큰·외부 인증 서비스 시크릿)도 여기 걸린다.
- **`backgroundAgentGuard`** — 백그라운드 에이전트 위임 차단. 세션이 끝난 뒤에도 도는 작업은
  잡 큐가 추적하지 못해 취소·재시도·감사 어디에도 안 잡힌다.

그리고 **Slack 쓰기 도구 disallow**(EG-01)는 그대로다. 이건 능력이 아니라 배관이다 — 게시는
egress 한 곳으로 모아야 병렬 세션이 남의 스레드에 오발송하지 않는다.

## 6. 복원력

- **socketHealth**: idle 이 길어지면 `conversations.history` probe → 유실분 replay(정규화 경로 동일,
  dedup 이 재주입 안전을 보장) → 연속 실패 누적 시 fast-exit(PM2 가 재기동).
- **wakeDetector**: 절전 복귀 감지(darwin 기본 on) → probe 강제.
- **watchdog**: 진행 카드가 멈춘 세션을 감지해 운영 통보.
- **friction**: 세션이 화이트리스트 밖 도구를 시도한 기록을 jsonl 로 남긴다 — 도구 목록을
  넓힐지 판단하는 근거다.

멘션/DM 은 "모든 채널"이 대상이라 커서 백필이 비현실적이다. 오래된 스레드의 답글 멘션은
probe 휴리스틱 밖 사각지대로 **수용**하고, 복구 안내 문구로 사람에게 재멘션을 요청한다
([ADR-0002](./adr/0002-mention-dm-backfill-blindspot.md)).

## 7. 코드의 요구사항 ID 표기

소스 주석에 붙은 `JQ-01`·`SC-03`·`EG-02` 같은 태그는 그 코드가 만족시키는 **요구사항 항목**을
가리키는 추적용 표식이다. 접두는 영역을 뜻한다 — `JQ`(잡 큐)·`SC`(세션)·`EG`(egress)·
`RS`(복원력)·`OPS`(운영). 별도 요구사항 문서를 이 레포에 두지는 않았으니, 새 규칙을 만들 때는
태그를 붙이기보다 **왜 그런지를 주석에 쓰는 쪽**이 낫다.

## 8. 관련 문서

- [ADR-0001 내구 잡 큐](./adr/0001-durable-job-queue.md)
- [ADR-0002 멘션/DM 백필 사각지대](./adr/0002-mention-dm-backfill-blindspot.md)
- [ADR-0004 chat 답변 장황함 린트](./adr/0004-chat-verbosity-lint.md)
- [슬랙 출력 형식](./slack-output-format.md)
- [설치·운영](../SETUP.md)
