# causeway 작업 지침

이 레포에서 작업하는 에이전트가 매번 읽는 맥락이다. 설치·자격증명은 [SETUP.md](./SETUP.md),
설계 근거는 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) 가 SoT — 여기 중복해 쓰지 않는다.

## 이 봇이 무엇인가

Slack ↔ Claude Code 다리. @멘션/DM 으로 물으면 이 머신에서 세션이 돌고 답이 스레드에 달린다.
**세션 능력은 Claude Code 와 같게 열려 있다**(Bash·Edit/Write·WebSearch/WebFetch·호스트
CLAUDE.md·스킬 상속). 그래서 경계는 "무엇을 할 수 있나"가 아니라 **`config/access.json` 의
allowed(누가 부를 수 있나)** 다 — 이 목록을 넓히는 것은 이 머신의 셸을 그만큼 여는 것이다.

## 상시 구동 (PM2)

PM2 는 devDependency 라 `pnpm install` 만 했으면 이미 있다. 전역 설치 불필요.

```bash
bin/causeway install
```

| 명령 | 하는 일 |
|---|---|
| `bin/causeway status` | PM2 상태 + 배포 커밋 + 뒤처짐 + 러너 생존 |
| `bin/causeway err` | 에러 로그 최근 50줄 — **일상 디버깅 진입점** |
| `bin/causeway logs` | stdout/err 실시간 tail |
| `bin/causeway restart` | 재시작 + 부팅 정상성 판정 (실패 시 exit 1) |
| `bin/causeway stop` / `start` | 정상 종료 / 시작 |
| `bin/causeway update` | 배포 1회 수동 실행 |
| `bin/causeway archive` | 오래된 세션 트랜스크립트를 md 요약으로 접기 (`--dry` 로 예행) |

머신 재부팅 후에도 자동 기동하려면 최초 1회 — **sudo 가 필요해 에이전트가 대신 못 한다**:

```bash
pnpm exec pm2 startup      # 출력된 sudo … 명령을 그대로 실행
pnpm exec pm2 save         # 되살릴 프로세스 목록 기록
```

`pm2 startup` 은 **출력만 하고 설치하지 않는다** — 뱉어낸 `sudo …` 줄을 다시 실행해야 한다.
`startup`(부팅 훅)과 `save`(무엇을 되살릴지)는 짝이라 **둘 다** 해야 한다.

### 개발 중에는 PM2 없이

```bash
pnpm dev
```

## 실제로 밟은 함정 (재발 방지)

- **`pkill … && bin/causeway install` 로 이어 붙이지 마라.** 죽일 프로세스가 없으면 `pkill` 이
  exit 1 을 내고 `&&` 가 뒤를 통째로 건너뛴다 — 출력이 한 줄도 없어서 성공한 줄 알게 된다.
- **`claude setup-token` 은 로그인된 상태를 전제한다.** 만료 상태면 브라우저 승인을 해도 토큰이
  안 나온다. `claude auth status --text` 로 먼저 확인.
- **봇 인증은 장수명 토큰으로 사람의 로그인과 분리한다.** 인터랙티브 세션에 얹으면 그게
  만료되는 날 봇이 죽는데, 슬랙에는 `OAuth session expired` 로만 보인다.
- **봇 표시 이름의 비ASCII 는 매니페스트가 아니라 워크스페이스 앱 관리에서 고친다.** 매니페스트의
  `bot_user.display_name` 은 표시 이름과 @핸들을 겸해서 비ASCII 면 `bad_username` 으로 저장이
  거부된다. 워크스페이스 앱 관리 → 봇 사용자 → 편집 쪽은 두 필드가 분리돼 있어 통과한다.
  api.slack.com 쪽 값은 **새 설치용**이라 이미 설치된 봇 이름은 재설치해도 안 바뀐다.
- **`channels.yaml` 에 같은 채널 ID 를 두 role 에 쓰면 부팅이 죽는다**(중복 검증). 개인 봇이라
  ops·release 를 같은 DM 으로 두고 싶어도 스키마가 1채널=1role 이다.
- **DM 입력창이 "메시지를 보내는 기능이 꺼져 있습니다" 로 보이면 먼저 `Cmd+R`.** `chat.postMessage`
  가 성공하는데도 그렇게 보이면 서버가 아니라 Slack 클라이언트 캐시다.

## 스케줄 (봇 안의 cron)

crontab·launchd·GitHub Actions 가 아니라 **봇 프로세스 안**에서 돈다(`src/schedule/`).
`config/schedules.json` 에 한 항목 추가 + 재시작. 실제 설정은 호스트 로컬이라 `.example` 만
커밋한다 — **배포에 안 따라오므로 직접 배치해야 한다.**

- **정각 타이머를 쓰지 않는다.** 머신이 자면 정각 타이머는 통째로 사라진다. 1분 tick 마다
  "지금 기준 지난 발화"를 계산하고, **발화 시각을 dedup_key 로** 쓴다(`schedule:<id>:20260811T0900`).
  늦게 깨어나도 같은 키라 잡히고, 중복은 `jobs.dedup_key` UNIQUE 가 거절한다.
- **새 잡 타입을 만들지 않는다.** 발화기는 스레드 루트를 올리고 그 ts 로 **chat 잡**을 넣는
  트리거일 뿐이다 — 세션 실행·진행 카드·재시도·복구를 복제하지 않으려는 것이다.
- 설정 오류(cron 오타·필드 누락·프롬프트 파일 부재)는 모아서 부팅 로그에 낸다.

## 세션 트랜스크립트 (기록이 쌓이는 곳)

대화 본문은 DB 가 아니라 **Claude Code 트랜스크립트**에 있다. 둘이 짝이다:

- `~/.claude/projects/<cwd-인코딩>/<session-id>.jsonl` — 대화 전문 + **도구 입출력 평문**
- `var/causeway.db` 의 `sessions` — thread_key → session_id 매핑(이어묻기 `--resume` 의 근거)

**한쪽만 지우면 깨진다.** 파일만 지우면 매핑이 죽은 세션을 가리키고, DB만 지우면 파일이 고아가
된다. `bin/causeway archive` 는 접은 세션의 매핑 행을 같은 실행에서 지운다.

- **용량이 트리거다.** 상한 이하면 아무것도 안 한다. 기본 100MB / 최근 5개 보호 / 24시간 이내
  수정분 제외 — 진행 중 대화를 접으면 그 스레드 이어묻기가 그 자리에서 깨진다.
- 요약은 **LLM 이 아니라 추출**이다. 아카이브 요약이 틀리면 없느니만 못하다(원본이 지워진 뒤에
  사람은 그 요약을 믿는다). 파일에 실제로 있는 값만 뽑는다.
- 도구 **출력**은 일부러 안 담는다 — 원본에 외부 API 응답이 평문으로 들어 있어서, 접는 행위
  자체가 민감면을 줄이는 쪽이어야 한다.

## Slack 앱 설정 변경

`config/slack-app-manifest.yaml` 이 SoT 다. **웹 콘솔에서 직접 고치지 않는다** — 파일을 고치고
`node scripts/push-manifest.mjs` 로 반영한다(`--dry` 로 검증만).

- **스코프를 바꿨으면 재설치가 필요하다** — 스크립트가 `permissions_updated` 로 알려준다.
  이벤트 구독만 바꾼 경우는 재설치 없이 즉시 적용된다.
- **봇 이름은 이 파일 밖에서 관리된다**(위 함정 참고). push 가 덮지 않는다.
- **Agent experience 토글도 매니페스트 밖이다**(App 설정 → Agents). 켜져야 슬랙이 "앱"이 아니라
  "에이전트"로 표시하고 `chat.startStream` 이 열린다.
- 이벤트를 추가했으면 `src/index.ts` 의 `app.event(...)` 배선도 함께 있어야 한다. 매니페스트만
  고치면 이벤트는 오는데 아무도 안 받고, 코드만 고치면 이벤트가 아예 안 온다 — **둘 다 조용하다.**

## 코드 규율

- **새 도구 추가** = `src/mcp/<도구>.ts` + `src/mcp/registry.ts` 배열 한 항목 + `src/context.ts`
  배선 판정(+부팅 로그 한 줄). registry 배열이 곧 노출 경계라 glob 자동발견은 쓰지 않는다.
  도구를 여러 방식으로 붙일 수 있다 — in-process(자격증명을 세션에서 감출 때), stdio(외부 CLI),
  원격 HTTP(호스트 OAuth). 어느 쪽이든 `allowedTools` 를 빠뜨리면 도구가 조용히 없는 상태가 된다.
- **새 잡 추가** = `src/jobs/<이름>/` + `src/jobs/index.ts` 한 줄. 같은 이유다.
- **순수부/부작용부를 파일 안에서 물리적으로 가른다.** 도구의 가드·요청 빌드·요약은 전부 순수
  함수여야 테스트가 계약을 붙잡는다.
- **경계는 프롬프트가 아니라 코드다.** "쓰기 하지 마"를 모델 순응도에 맡기지 말고 입력 스키마에서
  표현 자체를 불가능하게 만든다(조회 전용 도구에 `method` 를 두지 않는 이유).
- 커밋 전 `pnpm check && pnpm typecheck && pnpm test` — lefthook 이 pre-commit 에서 강제한다.
- main 직접 push 금지, PR 로만. CI = check + typecheck + test + gitleaks.
