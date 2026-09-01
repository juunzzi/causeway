#!/usr/bin/env bash
# causeway 재시작 + 부팅 정상성 판정 (OPS-02).
#
# "재시작했는데 실은 죽어 있음"을 자동 감지한다. PM2 restart 후 로그를 폴링해
#   - 성공 신호("Socket Mode 시작") → exit 0
#   - 실패 신호(env 검증 실패·EADDRINUSE·tsc/컴파일 에러·부팅 실패) → exit 1
#   - 제한 시간 내 어느 신호도 없음 → exit 1 (조용한 미기동도 실패로 간주)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── PM2 앱 이름·로그 경로는 ecosystem.config.cjs 에서 읽는다 ────────────────────
# 여기 값을 따로 적어 두면 안 된다. 이 봇을 자기 이름으로 바꿔 쓰는 포크(docs/EXTENDING.md §1)
# 에서 한쪽만 남으면 `pm2 restart --only <옛이름>` 이 **아무것도 재시작하지 않은 채 exit 0** 으로
# 끝나고, 뒤이은 폴링은 새 로그가 없으니 "부팅 신호 없음"으로 실패한다. 재시작이 조용히 no-op
# 이 되는 것이라 원인을 찾기 어렵다.
#
# 앱 이름과 로그 경로가 **서로 다른 필드에서 온다**는 것도 함정이다(name vs error_file/out_file).
# 이름만 바꾸고 로그 파일명을 안 바꾸면 폴링이 엉뚱한 파일을 본다. 둘 다 같은 파일에서 읽으면
# 어긋날 자리가 없어진다.
_eco() {
  node -e '
    const app = require(process.argv[1]).apps[0];
    if (!app) { process.exit(2); }
    process.stdout.write(String(app[process.argv[2]] ?? ""));
  ' "$ROOT/ecosystem.config.cjs" "$1" 2>/dev/null
}

APP="$(_eco name)"
if [[ -z "$APP" ]]; then
  echo "❌ ecosystem.config.cjs 에서 apps[0].name 을 읽지 못했다 — 재시작 대상을 특정할 수 없다" >&2
  exit 1
fi
# error_file/out_file 이 없으면 PM2 기본 경로가 아니라 앱 이름 규약으로 되돌아간다.
ERR_LOG="$ROOT/$(_eco error_file)"
OUT_LOG="$ROOT/$(_eco out_file)"
[[ "$ERR_LOG" == "$ROOT/" ]] && ERR_LOG="$ROOT/var/log/${APP}.err.log"
[[ "$OUT_LOG" == "$ROOT/" ]] && OUT_LOG="$ROOT/var/log/${APP}.out.log"
# 성공하면 즉시 빠져나오므로 이 값은 "정상 부팅 시간"이 아니라 **오판 방지 여유**다.
# 30s 였을 때 부팅이 무음으로 31s 멈춘 것을 실패로 판정해 멀쩡한 커밋을 롤백+격리한 적이 있다
# (2026-07-30 9cc1ca2). 지금은 부팅 인증에 15s 마감(CONTRACT.BOOT_AUTH_DEADLINE_MS)이 걸려
# 있어 그 경우 에러 로그를 남기고 죽지만, 마감을 거의 다 쓰고 성공하는 경우까지 담으려면
# 판정 창은 그보다 넉넉해야 한다.
TIMEOUT_SEC="${CAUSEWAY_BOOT_TIMEOUT:-60}"

PM2="${PM2_BIN:-pm2}"
command -v "$PM2" >/dev/null 2>&1 || PM2="$ROOT/node_modules/.bin/pm2"

# 폴링 기준선: 재시작 이전 로그를 성공/실패로 오판하지 않도록 현재 줄 수를 기록.
_lines() { { cat "$ERR_LOG" "$OUT_LOG" 2>/dev/null || true; } | wc -l | tr -d ' '; }
BASELINE=$(_lines)

echo "🔄 $APP 재시작 (부팅 판정 타임아웃 ${TIMEOUT_SEC}s)"
# 등록 여부를 먼저 본다. `pm2 restart … --only <없는이름>` 은 **exit 0 으로 조용히 끝나고**,
# 그 뒤 폴링은 새 로그가 없으니 "부팅 신호 없음"으로 실패한다 — 원인이 이름 불일치인지
# 진짜 부팅 실패인지 구분되지 않는다. 여기서 갈라 놓는다.
if ! "$PM2" describe "$APP" >/dev/null 2>&1; then
  echo "❌ PM2 에 '$APP' 앱이 없다 — 재시작할 대상이 없다." >&2
  echo "   먼저 설치하거나(bin/<앱> install), ecosystem.config.cjs 의 apps[0].name 을 확인한다." >&2
  exit 1
fi

"$PM2" restart "$ROOT/ecosystem.config.cjs" --only "$APP" --update-env >/dev/null

# 성공/실패 신호 정규식.
SUCCESS_RE="Socket Mode 시작"
FAIL_RE="env 검증 실패|EADDRINUSE|Cannot find module|SyntaxError|TSError|부팅 실패|auth\.test"

# 성공 신호가 실패 신호를 이긴다 — 그리고 실패는 **마감까지 기다린 뒤에만** 확정한다.
#
# 실패 신호를 보자마자 exit 1 하면 직전 프로세스의 잔여 출력에 속는다. `pm2 restart` 는 옛
# 프로세스를 죽이고 새로 띄우는데, 죽어가는 쪽의 stderr 가 기준선 뒤로 흘러든다 — 특히 직전
# 배포가 깨져 크래시 루프 중이었으면 그 에러가 계속 쏟아진다. 2026-08-03 롤백에서 정확히 이걸
# 밟아, 13초 뒤 멀쩡히 뜬 봇을 두고 "롤백도 실패, 봇이 내려가 있을 수 있음" 을 호출자가
# 운영자에게 쐈다. 거짓 실패의 대가는 잘못된 호출만이 아니다 — 호출자가 롤백(`reset --hard`)
# 까지 실행한다.
#
# 대신 진짜 실패는 최대 TIMEOUT_SEC 를 기다렸다 확정된다. 드물게 일어나는 일이라 그 지연은
# 오판 비용보다 싸다.
deadline=$(( $(date +%s) + TIMEOUT_SEC ))
fail_hit=""
while [[ $(date +%s) -lt $deadline ]]; do
  # 기준선 이후 새로 추가된 로그만 검사.
  new=$({ cat "$ERR_LOG" "$OUT_LOG" 2>/dev/null || true; } | tail -n +"$((BASELINE + 1))")
  if grep -qF "$SUCCESS_RE" <<<"$new"; then
    [[ -n "$fail_hit" ]] && echo "   (앞선 실패 신호는 직전 프로세스의 잔여 출력으로 판단 — 무시)"
    echo "✅ 부팅 정상 — '$SUCCESS_RE' 확인"
    exit 0
  fi
  if [[ -z "$fail_hit" ]] && grep -qE "$FAIL_RE" <<<"$new"; then
    fail_hit=$(grep -nE "$FAIL_RE" <<<"$new" | head -5)
    echo "⚠️  실패 신호 감지 — 마감(${TIMEOUT_SEC}s)까지 성공 신호가 없으면 실패로 확정한다:"
    printf '%s\n' "$fail_hit"
  fi
  sleep 1
done

if [[ -n "$fail_hit" ]]; then
  echo "❌ 부팅 실패 — 실패 신호 후 마감(${TIMEOUT_SEC}s)까지 성공 신호 없음:"
  printf '%s\n' "$fail_hit"
else
  echo "❌ 부팅 판정 타임아웃 (${TIMEOUT_SEC}s) — 성공 신호 없음. 죽었을 가능성이 높다:"
fi
"$PM2" describe "$APP" 2>/dev/null | grep -E "status|restarts" || true
tail -n 20 "$ERR_LOG" 2>/dev/null || true
exit 1
