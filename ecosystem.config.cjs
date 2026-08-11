/**
 * PM2 프로세스 매니저 계약 (OPS-01, RS-07).
 *
 * - autorestart + exp_backoff_restart_delay: **비정상 종료 시에만** 재기동한다.
 *   fast-exit 자가재시작 패턴(RS-03: 좀비 소켓 strike 도달 → process.exit(1))의 전제 조건.
 * - stop_exit_codes:[0]: 정상 종료(0)는 재기동하지 않는다 — graceful shutdown(SIGTERM)이
 *   0 으로 끝나면 PM2 가 다시 띄우지 않아야 한다. 0 이 아닌 종료(좀비 fast-exit·크래시)만 재기동.
 * - kill_timeout 8000: SIGTERM 후 8s 안에 index.ts 의 graceful shutdown 이 진행 중 스레드
 *   안내(RS-07)를 마치고 스스로 종료할 예산. 이 창을 넘기면 PM2 가 SIGKILL 한다.
 *
 * tsx 로 소스를 직접 실행한다(빌드 산출물 없이 dev/운영 동일 경로). node>=22 의 실험적
 * SQLite·loadEnvFile 를 쓰므로 인터프리터는 반드시 v22+.
 */
module.exports = {
  apps: [
    {
      name: "causeway",
      script: "src/index.ts",
      interpreter: "node_modules/.bin/tsx",
      cwd: __dirname,
      // 크래시·비정상 종료 시 재기동 (OPS-01, RS-03). autorestart 만으로 충분하다:
      // `causeway stop`(pm2 stop) 은 앱을 stopped 로 표시해 코드와 무관하게 재기동하지 않고,
      // graceful shutdown(SIGTERM→exit 0) 도 그 경로로만 일어난다.
      // stop_exit_codes:[0] 은 넣지 않는다 — PM2 가 SIGKILL(OOM·kill -9)을 "code 0"으로
      // 기록하는 탓에, 그 옵션이 있으면 진짜 크래시(SIGKILL)에서 재기동이 취소돼 봇이 죽은 채
      // 방치된다(2026-07-21 실측: "exited with code [0] via signal [SIGKILL]" → waiting restart 고착).
      autorestart: true,
      // 재기동 폭주 방지 throttle — launchd 의 ThrottleInterval 10 과 같은 취지(지수 백오프).
      exp_backoff_restart_delay: 2_000,
      max_restarts: 20,
      min_uptime: "10s",
      // graceful shutdown 예산 (RS-07). index.ts 가 이 안에서 진행 중 스레드에 안내 후 종료.
      kill_timeout: 8_000,
      // SIGTERM 을 받고 스스로 정리하도록 — PM2 의 즉시 SIGKILL 을 막는다.
      windowsHide: true,
      // 로그 — bin/causeway logs/err 의 tail 대상.
      error_file: "var/log/causeway.err.log",
      out_file: "var/log/causeway.out.log",
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};

// 자동 업데이트 상주 앱(`causeway-updater`)은 2026-08-10 에 제거됐다.
//
// 배포는 이제 main CI 성공 직후 self-hosted runner 가 `scripts/auto-update.sh --once` 를
// 부르는 경로 하나다(.github/workflows/deploy.yml). 5분 폴링은 새 커밋이 없으면 무음이었지만
// 상주 프로세스를 하나 더 두는 값을 못 했다 — 배포는 CI 경로가 1분 안에 끝낸다.
//
// 스크립트의 폴링 루프 자체는 남아 있다(인자 없이 실행하면 그 모드다). 러너를 오래 못 살리는
// 상황의 임시 대체 수단이라 지우지 않았다 — 되살리려면 이 파일에 앱을 다시 넣는 게 아니라
// `scripts/auto-update.sh` 를 직접 띄우면 된다(SETUP.md §11).
