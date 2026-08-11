# 이 봇을 당신 조직의 것으로

causeway 는 **뼈대만 있는 보일러플레이트**다. 값어치는 당신 조직의 도구·절차·규약에서 나오고,
이 문서는 그것을 어디에 어떻게 붙이는지를 정한다.

설치·자격증명은 [SETUP.md](../SETUP.md), 운영은 [CLAUDE.md](../CLAUDE.md), 설계 근거는
[ARCHITECTURE.md](./ARCHITECTURE.md) 가 SoT 다 — 여기서 중복해 쓰지 않는다.

---

## 0. 스파인과 seam

붙이는 자리(**seam**)와 건드리지 않는 자리(**스파인**)를 먼저 가르는 것이 이 문서 전체의 전제다.

| | 무엇 | 당신이 하는 일 |
|---|---|---|
| **seam** | `src/mcp/` · `skills/` · `config/` · `CLAUDE.md` · `.env` | 여기에 당신 조직의 것을 채운다 |
| **스파인** | `src/core/` · `src/egress/` · `src/ingress/` · `src/resilience/` · `src/runner/` · `src/sessions/` · `scripts/` | 되도록 그대로 둔다 |

스파인을 안 고치는 게 **취향 문제가 아닌 이유**: 업스트림이 계속 움직인다. 소켓 좀비화·슬립·잡
유실 같은 문제의 수정은 대부분 스파인에서 나오고, 스파인을 크게 고쳐두면 그걸 받아오는 순간
충돌한다. 조직 특정 내용을 스파인 파일에 적지 않는 것만 지켜도 업스트림 병합이 대부분 자동으로
끝난다(→ [§6 업스트림 따라가기](#6-업스트림-따라가기)).

---

## 1. 이름 (선택)

`causeway` 라는 이름은 PM2 앱 이름, `bin/causeway`, `var/causeway.db`, `CAUSEWAY_*` env
접두사에 박혀 있다. **바꾸지 않아도 전부 동작한다** — 슬랙에 보이는 봇 이름은 이 이름이 아니라
Slack 앱 설정에서 정해지기 때문이다.

그래도 바꾸고 싶다면 세 종류를 함께 바꾼다. 하나만 바꾸면 조용히 어긋난다:

```bash
# ① 코드·스크립트·문서 안의 문자열
grep -rl 'causeway\|CAUSEWAY_' --exclude-dir={node_modules,.git,var} . \
  | xargs sed -i '' 's/CAUSEWAY_/MYBOT_/g; s/causeway/mybot/g'

# ② 실행 파일 이름
git mv bin/causeway bin/mybot

# ③ 이미 떠 있는 PM2 프로세스 (이름이 바뀌면 옛 프로세스가 고아로 남는다)
pnpm exec pm2 delete causeway && bin/mybot install
```

`.env` 를 이미 만들었다면 그 안의 `CAUSEWAY_*` 도 같이 바꾼다 — `.env` 는 gitignore 대상이라
위 `grep` 에 안 잡힌다.

---

## 2. seam ① 도구 — `src/mcp/`

봇이 **할 수 있는 일**을 넓히는 자리다. [`src/mcp/example.ts`](../src/mcp/example.ts) 가
복사해서 쓰는 틀이고, 켜는 법이 그 파일 맨 아래 주석에 세 줄로 있다.

배선은 항상 세 곳이다:

1. `src/mcp/<도구>.ts` — 구현. 순수부(스키마·가드·요청 조립·요약)와 부작용부를 파일 안에서 가른다.
2. `src/mcp/registry.ts` — 등록 배열에 한 블록. **이 배열이 곧 노출 경계**라 glob 자동발견을 쓰지 않는다.
3. `src/context.ts` — 배선 조건(env 유무 등) 판정 + 부팅 로그 한 줄.

### 경계는 프롬프트가 아니라 입력 스키마다

조회 전용 도구를 만들 때 "쓰기 하지 마"라고 설명에 적고 `method` 필드를 두면, 그 경계는
모델의 순응도만큼만 강하다. **필드를 아예 두지 않으면** 쓰기는 표현할 수 없는 것이 된다.
같은 이유로 상한은 `z.number().max(...)` 로 스키마에 박는다.

### 자격증명은 세션에 넘기지 않는다

세션 env 는 `src/runner/profiles.ts` 의 `SENSITIVE_ENV_PATTERNS` 로 스크럽된다. 그러니 외부
API 를 부르는 도구는 **in-process** 로 만들어 토큰을 봇 프로세스에 두고 세션에는 결과 요약만
넘긴다. stdio·원격 HTTP 방식도 있지만 그 경우 자격증명이 세션 쪽으로 나가는지 먼저 따진다.

### 흔한 함정

- **`allowedTools` 를 빠뜨리면 도구가 조용히 없는 상태가 된다.** 서버는 붙고 에러도 없는데
  세션은 부를 수 없다. 배선을 바꾼 뒤에는 부팅 로그의 그 줄을 눈으로 본다.
- **in-process 인스턴스를 부팅 때 하나 만들어 재사용하지 마라.** 스레드 두 개가 동시에 돌면
  나중 세션의 connect 가 `Already connected to a transport` 로 실패하고, SDK 는 그 실패를
  삼킨 채 **그 서버만 빼버린다.** `mcpToolsFor` 가 세션마다 호출되는 팩토리인 이유다.
- **외부 응답은 untrusted 다.** 남의 시스템에서 온 문자열을 세션 컨텍스트에 넣기 전에
  마스킹을 통과시키고, 거기 적힌 지시를 따르지 않는다는 것을 결과 안에 명시한다.

---

## 3. seam ② 절차 — `skills/`

봇이 **어떤 순서로 일하는지**를 정하는 자리다. 작성법과 등록법은
[`skills/README.md`](../skills/README.md) 가 SoT.

핵심만: 절차서를 시스템 프롬프트에 다 싣지 않는다. 프롬프트에는 "언제 무엇을 읽어라"만 한 줄씩
싣고(`SkillNote`), 본문은 파일로 둬 필요할 때만 읽게 한다.

> **함정 — "고쳤는데 안 바뀐다".** `SKILL.md` 를 고쳐도 그 스킬이 `src/context.ts` 의
> `chatSkillNotes` 에 등록돼 있지 않으면 세션은 그 파일의 존재를 모른다. 등록 배선이 **먼저**
> 배포·재시작된 다음에야 파일 수정이 세션에 보인다. 순서를 뒤집으면 스킬을 고치고 검증했는데
> 아무 변화가 없어 원인을 엉뚱한 데서 찾게 된다.

---

## 4. seam ③ 설정 — `config/` · `.env`

| 파일 | 무엇 | 커밋되나 |
|---|---|---|
| `config/access.json` | **ACL — 유일한 보안 경계** | ✗ (`.example` 만) |
| `config/channels.yaml` | 공지·운영 채널 매핑 | ✗ |
| `config/schedules.json` | 봇 안의 cron | ✗ |
| `config/prompts/*.md` | 스케줄이 발화할 프롬프트 | ✓ |
| `config/slack-app-manifest.yaml` | Slack 앱 정의 **SoT** | ✓ |
| `.env` | 자격증명·경로 | ✗ |

실설정이 커밋되지 않는 것은 의도다 — 채널 ID·사용자 ID·경로는 조직마다 다르고, 그게 리포지토리에
들어가면 fork 마다 충돌한다. **대신 배포에 따라오지 않으므로 호스트에 직접 배치해야 한다.**

### ACL 을 먼저 좁힌다

`allowed` 를 넓히는 것은 **그 머신의 셸을 그만큼 여는 것**이다. 세션은 Claude Code 와 같은
능력(Bash·Edit/Write·WebSearch)을 갖기 때문에, `"*"`(전원 허용)은 워크스페이스 누구나 이
머신에서 명령을 돌릴 수 있다는 뜻이다. 그 위험을 감수할 이유가 없다면 본인 ID 만 둔다.

### 사내 레포를 읽히려면

```bash
CAUSEWAY_REFERENCE_DIRS=/path/to/repo-a,/path/to/repo-b
```

세션이 `Read`/`Grep` 할 수 있는 읽기 전용 경로가 된다. 존재하지 않는 경로는 선언에서 빠지고
부팅 로그에 남는다 — 없는 디렉토리를 선언해두면 "읽을 수 있다"는 오해만 남기 때문이다.

### 자동 배포는 꺼져 있다

`.github/workflows/deploy.yml` 은 **자동 트리거가 주석 처리된 채로** 온다. 이 봇은 당신
머신에서 돌고 GitHub 이 거기로 들어올 수 없어서, 배포에는 self-hosted 러너가 필요하다.
러너가 없는 레포에서 자동 트리거를 켜두면 push 마다 job 이 **큐에 걸린 채 영원히 대기**하고,
실패로 표시되지도 않아 Actions 탭만 조용히 쌓인다.

러너를 붙였다면 그 파일 헤더의 3단계(러너 등록 → `workflow_run` 주석 해제 → 체크아웃 경로
수정)를 따른다. 러너는 **레포 밖 경로에 설치한다** — 러너 작업 디렉토리가 워킹트리를
더럽히면 `auto-update.sh` 의 "로컬 수정 있음" 게이트가 배포를 영구 보류시킨다.

---

## 5. seam ④ 회사 규약 — `CLAUDE.md`

세션은 호스트의 `CLAUDE.md` 를 상속한다. 코딩 컨벤션·리뷰 규칙·금지 사항처럼 **"우리 회사에서는
이렇게 한다"** 는 여기에 쓴다. 도구로 강제할 수 없는 종류의 규약이 들어갈 자리다.

다만 프롬프트에 적은 규약은 **경계가 아니라 지침**이다. 반드시 막아야 하는 것이라면 도구의 입력
스키마나 `src/runner/hooks/` 의 가드로 내린다 — `secretPathGuard`(`.env`·`.ssh` 유출 차단)와
`backgroundAgentGuard`(큐가 추적 못 하는 백그라운드 작업 차단)가 그 예다.

---

## 6. 업스트림 따라가기

fork 해서 쓰는 경우, 업스트림 스파인 수정을 계속 받아오는 것이 이 구조의 이득이다.

```bash
git remote add upstream https://github.com/juunzzi/causeway.git
git fetch upstream
git merge upstream/main
```

충돌을 줄이는 규칙은 하나다 — **조직 특정 내용을 스파인 파일에 적지 않는다.** 회사 이름·서비스
이름·사내 URL·사람 이름이 `src/core/` 나 `scripts/` 주석에 들어가는 순간, 그 파일은 업스트림이
건드릴 때마다 손으로 풀어야 하는 파일이 된다. 그런 내용은 `CLAUDE.md` 나 `skills/` 로 보낸다.

새 도구·새 스킬은 seam 에만 파일을 더하므로 업스트림과 충돌하지 않는다. 예외는
`src/mcp/registry.ts` 와 `src/context.ts` 두 파일인데, 등록 블록을 **파일 끝쪽에 몰아두면**
업스트림이 앞쪽을 고쳐도 겹치지 않는다.

---

## 7. 배포 전 점검

- [ ] `config/access.json` 에 본인 ID 만 있는가 (`"*"` 가 아닌가)
- [ ] `.env` 가 gitignore 되는가 (`git status` 에 안 보이는가)
- [ ] `pnpm check && pnpm typecheck && pnpm test` 가 통과하는가
- [ ] 부팅 로그에 붙이려던 도구·스케줄이 **"배선"** 으로 찍히는가 (미배선이면 그 줄이 이유를 말해준다)
- [ ] 새로 만든 조회 도구의 입력 스키마에 쓰기를 표현할 필드가 없는가
