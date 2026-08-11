#!/usr/bin/env bash
# causeway 자동 업데이트 — origin/main 폴링 → pull → 재시작.
#
# 설계 요지:
#  - "지금 무슨 코드가 돌고 있나"의 기준은 HEAD 가 아니라 var/deployed-sha(= 마지막으로
#    **재시작까지 성공한** 커밋)다. pull 직후 프로세스가 죽어도 다음 tick 이 재시작만 이어서
#    한다(멱등). HEAD 만 비교하면 "pull 은 됐는데 재시작은 안 된" 상태가 영구 고착된다.
#  - **write 레인** inflight 잡이 0 이 될 때까지 기다렸다 재시작한다. 중단된 잡은 부팅 복구로
#    살아나지만(jobStore.recoverInflight) write 만은 PR 게시 도중에 잘리면 중복 PR 위험이 있다.
#    automation·interactive 까지 기다리면 봇이 바쁜 시간대에 배포가 통째로 멈춘다(inflight_count).
#  - 재시작 후 정상성 판정은 scripts/restart.sh 에 위임한다("Socket Mode 시작" 확인, OPS-02).
#    실패하면 직전 배포 커밋으로 되돌리고 그 원격 SHA 를 격리(var/quarantine-sha)해 5분마다
#    같은 깨진 커밋을 다시 배포하는 루프를 막는다. main 에 새 커밋이 얹히면 자동 해제된다.
#  - 배포에 성공하면 그 구간에 머지된 PR 을 근거로 FE 챕터 채널(role: release-notify)에 릴리즈
#    공지를 남긴다. 공지 사유는 "재시작"이 아니라 "변경"이다 — 코드가 안 바뀐 재시작은 애초에
#    이 경로를 안 타고, 바뀌었어도 chore/docs 뿐이면 침묵한다(scripts/releaseNote.ts).
#  - 이 파일은 helper + main() 정의 후 마지막 줄에서 main 을 호출한다. 실행 도중 git pull 이
#    이 스크립트를 갈아끼워도 bash 가 이미 파일 끝까지 읽은 뒤라, 바뀐 바이트 오프셋으로
#    점프해 엉뚱한 코드를 실행하는 사고가 나지 않는다.
#
# 실행: PM2 앱 `causeway-updater` (ecosystem.config.cjs). 수동 1회는 `bin/causeway update`.
#
#  - **모든 외부 명령에 상한을 건다**(with_timeout). 무인 루프에서 상한 없는 네트워크 호출
#    하나가 곧 루프 전체의 영구 정지이고, PM2 는 그걸 `online` 으로 표시한다 — 가장 발견이
#    늦는 고장 형태다. 매 tick 마다 var/updater-heartbeat 를 찍어 `causeway status` 로 드러낸다.
#  - 배포로 진행하지 못한 채 같은 사유가 STALL_AFTER_SEC 만큼 이어지면 1회 통보한다(stall).
#    "실패"만 통보하면 **보류**로 조용히 서 있는 상태를 영영 모른다. 기준이 주기 수가 아니라
#    경과 시간인 이유는 한 주기 길이가 5분~30분으로 들쭉날쭉하기 때문이다(STALL_AFTER_SEC 주석).
#
# env 노브:
#   CAUSEWAY_UPDATE_INTERVAL         폴링 주기 초 (기본 300)
#   CAUSEWAY_UPDATE_IDLE_TIMEOUT     write inflight 0 대기 최대 초 (기본 1800). 초과 시 이번 tick 포기.
#   CAUSEWAY_UPDATE_STALL_AFTER      같은 사유로 이만큼 초가 지나면 정체 통보 1회 (기본 3600)
#   CAUSEWAY_UPDATE_REQUIRE_CI       1 이면 해당 커밋 CI 성공일 때만 배포 (기본 1)
#   CAUSEWAY_UPDATE_BRANCH           추종 브랜치 (기본 main)
#   CAUSEWAY_UPDATE_FETCH_TIMEOUT    git fetch 상한 초 (기본 120)
#   CAUSEWAY_UPDATE_CI_TIMEOUT       gh run list 상한 초 (기본 60)
#   CAUSEWAY_UPDATE_INSTALL_TIMEOUT  pnpm install 상한 초 (기본 600)
#
# set -e 는 쓰지 않는다 — 무인 루프라 개별 실패를 조용히 죽는 대신 로그+다음 tick 으로
# 흘려야 하고, `f || fallback` 문맥에서 함수 내부 set -e 가 무력화되는 함정도 피한다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${CAUSEWAY_UPDATE_BRANCH:-main}"
DB="$ROOT/${CAUSEWAY_DB_PATH:-var/causeway.db}"
DEPLOYED_FILE="$ROOT/var/deployed-sha"
QUARANTINE_FILE="$ROOT/var/quarantine-sha"
CHANNELS_FILE="$ROOT/config/channels.yaml"

INTERVAL="${CAUSEWAY_UPDATE_INTERVAL:-300}"
IDLE_TIMEOUT="${CAUSEWAY_UPDATE_IDLE_TIMEOUT:-1800}"
IDLE_POLL_SEC=15
REQUIRE_CI="${CAUSEWAY_UPDATE_REQUIRE_CI:-1}"
HEARTBEAT_FILE="$ROOT/var/updater-heartbeat"

# 개별 외부 명령 상한. **네트워크를 타는 호출엔 예외 없이 건다** — 무인 루프에서 상한 없는
# 명령 하나가 곧 루프 전체의 영구 정지다(실측: `git fetch` 가 죽은 SSH 커넥션에 19시간 50분
# 물려 자동 업데이트가 무음으로 멈췄고, 그 사이 머지된 커밋이 배포되지 않았다).
FETCH_TIMEOUT="${CAUSEWAY_UPDATE_FETCH_TIMEOUT:-120}"
CI_TIMEOUT="${CAUSEWAY_UPDATE_CI_TIMEOUT:-60}"
INSTALL_TIMEOUT="${CAUSEWAY_UPDATE_INSTALL_TIMEOUT:-600}"

# 같은 이유로 배포에 진행하지 못한 채 이만큼 시간이 지나면 1회 통보한다.
# 게이트는 fail-closed 고(unknown 도 '보류') 브랜치 불일치·로컬 수정·fetch 실패도 전부
# 보류로 끝나므로, 자동 업데이트가 **조용히** 멈추는 게 이 스크립트의 최악 실패 모드다.
# 판정 기준은 **주기 수가 아니라 경과 시간**이다. 한 주기의 길이가 고정이 아니기 때문이다 —
# wait_for_idle 이 최대 IDLE_TIMEOUT(기본 1800s) 을 쓰므로 정체 상황에서는 한 주기가 5분이 아니라
# 30분이 된다. 주기 수로 세면 "12주기 = 1시간" 이라는 의도가 실제로는 **6시간**이 되고, 조용히
# 멈춘 상태를 그만큼 늦게 안다(2026-08-04: idle 교착을 사람이 눈으로 먼저 발견했다).
STALL_AFTER_SEC="${CAUSEWAY_UPDATE_STALL_AFTER:-3600}"
STALL_KEY=""
STALL_SINCE=0
STALL_NOTIFIED=0

# PM2 데몬 env 는 로그인 셸보다 얇을 수 있다 — git·gh·pnpm·sqlite3 를 확실히 찾도록 보강.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# 호스트가 슬립에서 깨면 기존 TCP 커넥션이 죽어 있는데, ssh 는 기본값(ServerAlive 없음)이면
# 그 사실을 영영 모르고 read 에 매달린다 — 위 19시간 정지의 직접 원인이다. ssh 스스로
# 45초 안에 끊게 만든다. with_timeout 과 중복이지만 둘의 목적이 다르다:
# 이건 '커넥션이 죽었음을 감지', with_timeout 은 '무슨 이유든 상한 초과 시 회수'.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3}"
# https 리모트로 바뀌어도 같은 보호가 걸리게(30초 동안 1KB/s 미만이면 중단).
export GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT:-1000}"
export GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME:-30}"

log() { printf '%s\n' "$*"; }

# ── 상한 실행 ─────────────────────────────────────────────────────────────────
# `timeout`(coreutils)은 macOS 기본 환경에 없다 — 순수 bash 로 구현한다(bash 3.2 호환).
# 초과 시 자식 프로세스 **트리**를 회수한다. 부모만 죽이면 오늘처럼 git 밑에 매달린 ssh 가
# 고아로 남을 수 있다. 반환 124 = 시간 초과(coreutils 관례와 동일).
with_timeout() {
  local secs="$1" pid waited=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ $waited -ge $secs ]]; then
      # 블록 전체를 2>/dev/null 로 감싼다 — bash 는 시그널로 죽은 잡을 "다음 명령 직전"에
      # `Terminated: 15` 로 보고하므로, wait 한 줄만 막아선 새어나온다(실측). 로그에 남아야 할
      # 사유는 호출자가 쓰는 "N초 초과" 한 줄이면 충분하다.
      {
        pkill -TERM -P "$pid"
        kill -TERM "$pid"
        sleep 2
        pkill -KILL -P "$pid"
        kill -KILL "$pid"
        wait "$pid"
      } 2>/dev/null
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# ── 정체 통보 ─────────────────────────────────────────────────────────────────
# key 가 바뀌면(= 상황이 달라지면) 시계를 다시 잡는다. 임계를 넘긴 뒤에는 **한 번만** 통보해
# 같은 사유로 주기마다 도배하지 않는다(플래그로 잠근다 — 시간 기준은 "정확히 그 순간" 비교가
# 성립하지 않으므로 카운터 시절의 `==` 판정을 그대로 옮기면 매 주기 통보가 된다).
stall() {
  local key="$1" msg="$2" now
  now=$(date +%s)
  if [[ "$STALL_KEY" != "$key" ]]; then
    STALL_KEY="$key"
    STALL_SINCE="$now"
    STALL_NOTIFIED=0
  fi
  if [[ "$STALL_NOTIFIED" == "0" ]] && (( now - STALL_SINCE >= STALL_AFTER_SEC )); then
    STALL_NOTIFIED=1
    log "  ⏸  '${key}' 사유로 $(( (now - STALL_SINCE) / 60 ))분째 배포 보류 — 운영 통보"
    notify "$msg"
  fi
  return 0
}

# 정상 진행(배포 완료 또는 애초에 할 일 없음) — 정체 시계를 푼다.
clear_stall() {
  STALL_KEY=""
  STALL_SINCE=0
  STALL_NOTIFIED=0
}

short() { git -C "$ROOT" rev-parse --short "$1" 2>/dev/null || printf '%s' "$1"; }

# ── Slack 통보 ────────────────────────────────────────────────────────────────
# 목적지는 channels.yaml 의 role 로만 고른다(SK-04 — 스크립트도 Slack ID 를 직접 들지 않는다).
# 해당 role 선언이 없으면 조용히 건너뛴다(로그만 남음).
channel_by_role() {
  local want="$1"
  [[ -f "$CHANNELS_FILE" ]] || return 1
  awk -v want="$want" '
    /^[[:space:]]*-[[:space:]]*logical:/ { id=""; role="" }
    /^[[:space:]]*id:/   { line=$0; sub(/^[^:]*:[[:space:]]*/,"",line); sub(/[[:space:]]*#.*$/,"",line); gsub(/[[:space:]]/,"",line); id=line }
    /^[[:space:]]*role:/ { line=$0; sub(/^[^:]*:[[:space:]]*/,"",line); sub(/[[:space:]]*#.*$/,"",line); gsub(/[[:space:]]/,"",line); role=line }
    role==want && id!="" { print id; exit }
  ' "$CHANNELS_FILE"
}

# .env 는 반드시 서브셸에서만 읽는다 — 이 프로세스 env 에 토큰이 실리면 곧이어 호출하는
# restart.sh 의 `pm2 restart --update-env` 가 그 값을 봇 프로세스 OS env 로 주입하고,
# index.ts 의 loadEnvFile 은 기존 env 를 덮어쓰지 않으므로 .env 교체가 안 먹히게 된다.
post_slack() {
  local channel="$1" text="$2"
  [[ -n "$channel" && -n "$text" ]] || return 0
  (
    local token payload
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env" 2>/dev/null || exit 0
    set +a
    token="${SLACK_BOT_TOKEN:-}"
    [[ -n "$token" ]] || exit 0
    payload=$(CH="$channel" TEXT="$text" node -e \
      'process.stdout.write(JSON.stringify({channel:process.env.CH,text:process.env.TEXT}))') || exit 0
    curl -sS -m 10 -X POST https://slack.com/api/chat.postMessage \
      -H "Authorization: Bearer $token" \
      -H 'Content-type: application/json; charset=utf-8' \
      -d "$payload" >/dev/null 2>&1
  ) || true
}

# 운영자 앞 신호(실패·정체·롤백). 사람이 읽는 릴리즈 공지가 아니다.
notify() {
  post_slack "$(channel_by_role ops-notify)" "$1"
}

# ── 릴리즈 공지 ────────────────────────────────────────────────────────────────
# 배포에 성공했을 때만, **그 구간에 머지된 PR** 을 근거로 FE 챕터 채널(role: release-notify)에
# 한 줄씩 남긴다. 재시작 자체는 공지 사유가 아니다 — 토큰 교체·크래시 복구처럼 코드가 안 바뀐
# 재시작은 애초에 이 함수를 타지 않고, 코드가 바뀌었어도 chore/docs 뿐이면 releaseNote 가
# 빈 문자열을 돌려줘 아무것도 보내지 않는다.
#
# --first-parent: main 에 실제로 얹힌 커밋(squash 커밋·merge 커밋)만 본다. 이게 없으면 PR
# 브랜치 내부 커밋까지 쏟아져 공지가 커밋 로그 덤프가 된다.
announce_release() {
  local from="$1" to="$2" channel tsx text
  [[ -n "$from" && -n "$to" && "$from" != "$to" ]] || return 0
  channel=$(channel_by_role release-notify) || return 0
  [[ -n "$channel" ]] || return 0

  tsx="$ROOT/node_modules/.bin/tsx"
  if [[ ! -x "$tsx" ]]; then
    log "  ⚠️  tsx 없음 — 릴리즈 공지 건너뜀"
    return 0
  fi

  text=$(git -C "$ROOT" log --first-parent --reverse --format='%H%x1f%s%x1f%b%x1e' "$from..$to" 2>/dev/null |
    "$tsx" "$ROOT/scripts/releaseNoteCli.ts" "$(git -C "$ROOT" remote get-url origin 2>/dev/null)" 2>/dev/null) || text=""

  if [[ -z "$text" ]]; then
    log "  릴리즈 공지 생략 — 사용자에게 보이는 변경 없음"
    return 0
  fi
  post_slack "$channel" "$text"
  log "  📣 릴리즈 공지 게시 — $channel"
}

# ── 게이트 ────────────────────────────────────────────────────────────────────
# echo: success | pending | failed | unknown
ci_status() {
  local sha="$1" verdict
  command -v gh >/dev/null 2>&1 || { printf 'unknown'; return; }
  # gh 도 네트워크 호출이다 — 상한 없이 두면 fetch 와 같은 방식으로 루프를 잠글 수 있다.
  # 타임아웃은 'unknown'(=보류)으로 흡수되고, 계속되면 stall 통보가 대신 울린다.
  verdict=$(with_timeout "$CI_TIMEOUT" gh run list --branch "$BRANCH" --commit "$sha" --limit 20 \
    --json status,conclusion \
    --jq 'if length == 0 then "unknown"
          elif any(.[]; .status != "completed") then "pending"
          elif any(.[]; .conclusion != "success") then "failed"
          else "success" end' 2>/dev/null) || { printf 'unknown'; return; }
  [[ -n "$verdict" ]] || verdict=unknown
  printf '%s' "$verdict"
}

# ── 레포 안전성 ───────────────────────────────────────────────────────────────
# 이 체크아웃은 봇의 **런타임 소스이자 사람이 개발하는 워킹트리**다. 남이 손대고 있는 트리를
# 그대로 띄우면 반쯤 해결된 충돌 파일이 그대로 부팅에 들어간다.
#
# 원래 이 판정은 pull 블록 **안에만** 있었다. 그래서 `head_sha == remote_sha` 인데 배포만
# 뒤처진 경우 — 예를 들어 누군가 `origin/main` 위로 리베이스를 시작해 detached HEAD 가 마침
# remote 와 같아진 순간 — 게이트를 하나도 안 거치고 재시작 경로로 직행했다. 실제로 그렇게
# 충돌 미해결 트리를 배포해 부팅이 깨졌고, 이어진 롤백의 `reset --hard` 가 그 사람의 리베이스
# 작업까지 지웠다(2026-08-03). 그래서 pull 경로와 재시작 경로가 **같은** 게이트를 쓴다.
#
# echo: 보류 사유(비어 있으면 안전).
repo_hold_reason() {
  local gitdir current
  gitdir=$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null) || {
    printf 'git 상태 조회 실패'
    return
  }
  # 진행 중인 git 작업 — 이 상태의 트리는 "누군가의 작업 중간"이지 배포 대상이 아니다.
  [[ -d "$gitdir/rebase-merge" || -d "$gitdir/rebase-apply" ]] && {
    printf 'rebase 진행 중'
    return
  }
  [[ -f "$gitdir/MERGE_HEAD" ]] && {
    printf 'merge 진행 중'
    return
  }
  [[ -f "$gitdir/CHERRY_PICK_HEAD" ]] && {
    printf 'cherry-pick 진행 중'
    return
  }
  [[ -f "$gitdir/REVERT_HEAD" ]] && {
    printf 'revert 진행 중'
    return
  }
  [[ -f "$gitdir/BISECT_LOG" ]] && {
    printf 'bisect 진행 중'
    return
  }
  # detached HEAD 는 `rev-parse --abbrev-ref` 가 "HEAD" 를 돌려주므로 이 비교로 함께 걸린다.
  current=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [[ "$current" == "$BRANCH" ]] || {
    printf "현재 브랜치가 '%s'(%s 아님)" "$current" "$BRANCH"
    return
  }
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    printf 'tracked 파일에 로컬 수정 있음'
    return
  fi
  printf ''
}

# **write 레인만** 센다. 전체 inflight 를 기다리면 봇이 바쁠수록 배포가 아예 멈춘다:
# 재시작 조건이 "완전 유휴 순간"인데, prWatcher 가 3분마다 넣는 리뷰 잡 하나가 3~7분씩 도는 이
# 봇에서는 그 순간이 오지 않는다(2026-08-04 실측: 가동률 100% 구간에서 1초 간격 60회 샘플 전부
# inflight≥1, 1800s 소진 후 '이번 주기 배포 보류' → 다음 주기에 무한 반복. #69·#70 이 이 상태로
# 몇 시간 묶였다). 부하가 임계를 넘는 순간 완만히 느려지는 게 아니라 절벽처럼 멈춘다.
#
# 레인별로 잘렸을 때의 실제 대가가 다르다:
#   - automation(리뷰·알람): recoverInflight 가 pending 으로 되돌리고 워처가 어차피 다시 넣는다.
#   - interactive(대화): 되돌린 뒤 RESTART_RETRY_NOTICE 로 스레드에 재시도 안내가 나간다.
#   - write(PR 생성): `gh pr create` 직전에 잘리면 중복 PR 위험이 있다 — **여기만 기다릴 값어치가 있다.**
# ARCHITECTURE §0 이 "재시작은 무손실"을 전제로 복구를 공격적으로 가져간다고 선언한 그대로다.
# write 잡은 시간당 몇 건 수준이라 가동률과 무관하게 유휴 창이 늘 있다.
inflight_count() {
  local n
  n=$(sqlite3 -readonly "$DB" "SELECT count(*) FROM jobs WHERE status='inflight' AND lane='write';" 2>/dev/null) || n=""
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s' "$n"
}

# inflight 가 0 이 될 때까지 대기. 예산 초과면 1 — 이번 tick 을 포기하고 다음 주기에 재시도한다.
wait_for_idle() {
  local deadline n announced=0
  deadline=$(( $(date +%s) + IDLE_TIMEOUT ))
  while :; do
    n=$(inflight_count)
    [[ "$n" == "0" ]] && { [[ "$announced" == "1" ]] && log "  큐 비었음 — 재시작 진행"; return 0; }
    if [[ $(date +%s) -ge $deadline ]]; then
      log "  ⏳ inflight ${n}건이 ${IDLE_TIMEOUT}s 동안 안 끝남 — 이번 주기 배포 보류"
      return 1
    fi
    [[ "$announced" == "0" ]] && { log "  inflight ${n}건 — 큐가 빌 때까지 대기 (최대 ${IDLE_TIMEOUT}s)"; announced=1; }
    sleep "$IDLE_POLL_SEC"
  done
}

# ── 배포 ──────────────────────────────────────────────────────────────────────
# restart.sh 의 `pm2 restart --update-env` 는 **호출자 env** 를 봇 프로세스에 주입하는데,
# index.ts 의 loadEnvFile 은 이미 존재하는 env 를 덮어쓰지 않는다. PM2 데몬 env 에 남은 옛
# 토큰이 .env 의 새 값을 이기는 사고가 실제로 있었다(2026-07-27 CLAUDE_CODE_OAUTH_TOKEN).
# .env 가 선언한 키를 재시작 직전에 비워, 무인 배포에서는 언제나 .env 가 이기게 한다.
scrub_dotenv_keys() {
  local key
  [[ -f "$ROOT/.env" ]] || return 0
  while IFS= read -r key; do
    [[ -n "$key" ]] && unset "$key"
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ROOT/.env")
}

# 재시작 + 정상성 판정. 성공 시 deployed-sha 갱신.
deploy() {
  local sha="$1"
  # 서브셸에서만 scrub — 업데이터 자신의 env(gh 인증 등)는 건드리지 않는다.
  if (scrub_dotenv_keys && exec "$ROOT/scripts/restart.sh"); then
    printf '%s\n' "$sha" >"$DEPLOYED_FILE"
    return 0
  fi
  return 1
}

# 직전 배포 커밋으로 되돌리고 재시작. 성공하면 그 SHA 로 deployed-sha 를 되돌린다.
rollback() {
  local prev="$1" from hold
  # `reset --hard` 는 되돌릴 수 없다. tick 진입 시 게이트를 통과했더라도 그 뒤 inflight 대기
  # (최대 30분)와 재시작 판정(60s) 동안 사람이 rebase 를 시작할 수 있다 — 그 창에서 reset 이
  # 돌면 남의 작업이 사라진다(2026-08-03 실측). 파괴적 명령 직전에 다시 판정한다.
  hold=$(repo_hold_reason)
  if [[ -n "$hold" ]]; then
    log "  ⛔ 롤백 중단 — ${hold}. reset --hard 로 작업을 지우지 않는다(수동 개입 필요)"
    return 1
  fi
  from=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)
  log "  ↩️  롤백 → $(short "$prev")"
  if ! git -C "$ROOT" reset --hard --quiet "$prev"; then
    log "  ❌ git reset 실패 — 수동 개입 필요"
    return 1
  fi
  sync_deps "$from"
  deploy "$prev"
}

# lockfile 이 바뀌었으면 의존성 재설치. 인자: 비교 기준 SHA(없거나 조회 실패면 무조건 설치).
sync_deps() {
  local base="${1:-}"
  if [[ -n "$base" ]] && git -C "$ROOT" diff --quiet "$base" HEAD -- pnpm-lock.yaml 2>/dev/null; then
    return 0
  fi
  log "  📦 pnpm-lock.yaml 변경 — pnpm install"
  # 레지스트리를 타므로 여기도 상한이 필요하다 — 실패든 시간 초과든 결과는 같다(부팅 판정에 맡김).
  if ! with_timeout "$INSTALL_TIMEOUT" bash -c 'cd "$1" && pnpm install --frozen-lockfile' _ "$ROOT" >/dev/null 2>&1; then
    log "  ⚠️  pnpm install 실패/시간 초과 — 그대로 진행(부팅 판정에서 걸러진다)"
  fi
}

# ── 한 주기 ───────────────────────────────────────────────────────────────────
tick() {
  local head_sha remote_sha deployed quarantined hold subject verdict rc

  # 살아있음의 증거를 매 주기 남긴다 — PM2 의 `online` 은 루프가 도는지를 말해주지 않는다
  # (실측: 프로세스는 online 인 채 20시간 정지). `causeway status` 가 이 값을 읽어 정체를 드러낸다.
  date +%s >"$HEARTBEAT_FILE" 2>/dev/null

  with_timeout "$FETCH_TIMEOUT" git -C "$ROOT" fetch --quiet origin "$BRANCH" 2>/dev/null
  rc=$?
  if [[ "$rc" != "0" ]]; then
    if [[ "$rc" == "124" ]]; then
      log "⚠️  git fetch ${FETCH_TIMEOUT}s 초과 — 강제 회수, 다음 주기에 재시도"
    else
      log "⚠️  git fetch 실패 — 다음 주기에 재시도"
    fi
    stall "fetch" ":hourglass: causeway 자동 업데이트 정체 — \`git fetch\` 가 $((STALL_AFTER_SEC/60))분 넘게 계속 실패하고 있습니다. 네트워크/SSH 키를 확인하세요."
    return 0
  fi

  head_sha=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null) || return 0
  remote_sha=$(git -C "$ROOT" rev-parse "origin/$BRANCH" 2>/dev/null) || return 0

  # 최초 실행: 지금 돌고 있는 프로세스가 HEAD 라고 보고 기준선만 심는다(불필요한 재시작 방지).
  if [[ ! -f "$DEPLOYED_FILE" ]]; then
    printf '%s\n' "$head_sha" >"$DEPLOYED_FILE"
    log "기준선 기록 — deployed=$(short "$head_sha")"
  fi
  deployed=$(cat "$DEPLOYED_FILE" 2>/dev/null || printf '')

  # 할 일 없음 — 대부분의 tick 이 여기서 끝난다(무음).
  [[ "$head_sha" == "$remote_sha" && "$deployed" == "$head_sha" ]] && { clear_stall; return 0; }

  # ── 0) 레포 안전성 게이트 (pull 경로·재시작 경로 공통) ──
  # 여기서 걸러야 할 상태는 "새 커밋이 있는가"와 무관하다 — pull 할 게 없어도 재시작은 남아
  # 있을 수 있고, 그 재시작이 남의 작업 중인 트리를 띄우면 안 된다. 무음 종료(위) 다음에 두어
  # 평소 tick 은 여전히 조용하고 싸다.
  hold=$(repo_hold_reason)
  if [[ -n "$hold" ]]; then
    log "⚠️  ${hold} — 자동 업데이트 보류"
    stall "repo:${hold}" ":hourglass: causeway 자동 업데이트 정체 — 레포가 \`${hold}\` 상태로 $((STALL_AFTER_SEC/60))분째 배포가 보류됩니다. \`git status\` 를 확인하세요."
    return 0
  fi

  # ── 1) pull ──
  if [[ "$head_sha" != "$remote_sha" ]]; then
    quarantined=$(cat "$QUARANTINE_FILE" 2>/dev/null || printf '')
    if [[ -n "$quarantined" && "$quarantined" == "$remote_sha" ]]; then
      return 0 # 이미 이 커밋으로 실패해봤다. main 이 움직일 때까지 조용히 보류(격리 시 이미 통보함).
    fi

    if [[ "$REQUIRE_CI" == "1" ]]; then
      verdict=$(ci_status "$remote_sha")
      case "$verdict" in
        success) clear_stall ;;
        pending | unknown)
          [[ "$STALL_KEY" == "ci:$remote_sha" ]] ||
            log "⏸  $(short "$remote_sha") CI ${verdict} — 다음 주기에 재확인"
          stall "ci:$remote_sha" ":hourglass: causeway 자동 업데이트 정체 — \`$(short "$remote_sha")\` CI 상태가 계속 \`${verdict}\` 입니다. gh 인증/워크플로를 확인하거나, 게이트를 끄려면 \`CAUSEWAY_UPDATE_REQUIRE_CI=0\`."
          return 0
          ;;
        failed)
          log "🚫 $(short "$remote_sha") CI 실패 — 배포 격리"
          printf '%s\n' "$remote_sha" >"$QUARANTINE_FILE"
          notify ":no_entry: causeway 자동 업데이트 보류 — \`$(short "$remote_sha")\` CI 실패"
          return 0
          ;;
      esac
    fi

    subject=$(git -C "$ROOT" log -1 --format=%s "$remote_sha" 2>/dev/null)
    log "⬇️  $(short "$head_sha") → $(short "$remote_sha") — ${subject}"
    if ! git -C "$ROOT" merge --ff-only --quiet "origin/$BRANCH"; then
      log "❌ fast-forward 실패 — 로컬이 갈라졌거나 untracked 파일과 충돌. 수동 개입 필요"
      notify ":warning: causeway 자동 업데이트 실패 — fast-forward 불가(수동 개입 필요)"
      return 0
    fi
    sync_deps "$head_sha"
    head_sha="$remote_sha"
  fi

  # ── 2) 재시작 ──
  [[ "$deployed" == "$head_sha" ]] && { clear_stall; return 0; }
  wait_for_idle || {
    stall "idle" ":hourglass: causeway 자동 업데이트 정체 — inflight 잡이 안 끝나 $((STALL_AFTER_SEC/60))분째 재시작을 못 하고 있습니다. \`causeway err\` 로 멈춘 잡을 확인하세요."
    return 0
  }

  # 게이트 재확인 — wait_for_idle 이 최대 IDLE_TIMEOUT(기본 30분) 을 쓴다. 그 사이 사람이
  # 트리를 만지기 시작했으면 지금 띄우는 건 '남의 작업 중간'이다. 이 주기는 포기한다.
  hold=$(repo_hold_reason)
  if [[ -n "$hold" ]]; then
    log "⚠️  대기 중 레포 상태 변화(${hold}) — 이번 주기 배포 보류"
    return 0
  fi

  subject=$(git -C "$ROOT" log -1 --format=%s "$head_sha" 2>/dev/null)
  if deploy "$head_sha"; then
    clear_stall
    rm -f "$QUARANTINE_FILE"
    log "✅ 배포 완료 — $(short "$head_sha")"
    notify ":rocket: causeway 자동 업데이트 완료 — \`$(short "$head_sha")\` ${subject}"
    # 사람 대상 공지는 운영 통보와 별개 채널·별개 판단이다(변경 없으면 침묵).
    announce_release "$deployed" "$head_sha"
    return 10 # 업데이터 자신도 새 코드로 재기동 (PM2 autorestart)
  fi

  log "❌ $(short "$head_sha") 부팅 실패 — 롤백 시도"
  printf '%s\n' "$head_sha" >"$QUARANTINE_FILE"
  if [[ -n "$deployed" && "$deployed" != "$head_sha" ]] && rollback "$deployed"; then
    notify ":rotating_light: causeway 자동 업데이트 실패 — \`$(short "$head_sha")\` 부팅 불가, \`$(short "$deployed")\` 로 롤백함. 로그: \`causeway err\`"
  else
    notify ":rotating_light: causeway 자동 업데이트 실패 — \`$(short "$head_sha")\` 부팅 불가, **롤백도 실패**. 봇이 내려가 있을 수 있음: \`causeway status\` / \`causeway err\`"
  fi
  return 0
}

main() {
  local once=0 rc
  [[ "${1:-}" == "--once" ]] && once=1

  # gh 는 cwd 의 git remote 로 대상 레포를 추론한다 — 수동 1회 실행에서도 어긋나지 않게 고정.
  cd "$ROOT" || { log "❌ cd $ROOT 실패"; return 1; }
  mkdir -p "$ROOT/var"

  if [[ "$once" == "1" ]]; then
    tick
    rc=$?
    [[ "$rc" == "10" ]] && rc=0
    return "$rc"
  fi

  log "🔭 causeway 자동 업데이트 시작 — origin/${BRANCH}, ${INTERVAL}s 주기, CI 게이트=${REQUIRE_CI}"
  while :; do
    tick
    rc=$?
    # 배포 성공 → 정상 종료해 PM2 가 새 코드로 업데이터를 다시 띄우게 한다.
    [[ "$rc" == "10" ]] && exit 0
    sleep "$INTERVAL"
  done
}

main "$@"
