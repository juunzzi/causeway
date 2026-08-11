/**
 * 수치 계약 — 선행 봇 실전 사고에서 도출된 값.
 *
 * 각 상수의 주석이 "왜 이 값인가"의 근거다. 값을 바꾸려면 docs/porting-contract.md 의
 * 해당 항목과 constants.test.ts 를 함께 수정해야 한다 — 의도된 마찰이다.
 */
export const CONTRACT = {
  /** Slack chat.update 진행 카드 갱신 최소 간격(ms). 이보다 짧으면 rate-limit에 걸린다. */
  PROGRESS_UPDATE_INTERVAL_MS: 1_500,

  /** 최종 응답 chunk 분할 상한(자). Slack 본문 한도 아래 여유 + 코드펜스 경계 보전 전제. */
  MESSAGE_CHUNK_CHARS: 2_800,

  /**
   * markdown 블록 최종 답변 chunk 분할 상한(자). Slack `markdown` 블록은 ≈12,000자에서
   * msg_too_long 으로 거절된다(12,012자 실측 거절, 2026-07-21) — 그 아래로 안전 여유를 둔 값.
   * 표/코드블록/링크 경계를 지켜 분할하므로 mrkdwn 경로(2,800)보다 크게 잡아도 절단 위험이 없다.
   */
  MARKDOWN_BLOCK_CHUNK_CHARS: 11_000,

  /** 진행 카드 truncate 상한(자). msg_too_long 거절 → 진행 메시지 동결(실사고)의 구조적 예방. */
  PROGRESS_TRUNCATE_CHARS: 2_900,

  /** 이 시간(ms) 동안 이벤트가 없으면 좀비 소켓 의심 → 능동 probe 시작. */
  ZOMBIE_PROBE_IDLE_MS: 5 * 60_000,

  /**
   * 소프트 재연결 후 "실제 이벤트 유입"을 재확인하는 지연(ms).
   * '재연결 완료' 로그는 가짜 성공일 수 있다 — 연결 상태가 아니라 수신 사실로 판정한다.
   */
  RECONNECT_RECHECK_MS: 45_000,

  /** wall-clock gap이 이 값(ms)을 넘으면 절전에서 깬 것 — 스케줄러 tick 강제 + 소켓 재연결. */
  WAKE_GAP_THRESHOLD_MS: 120_000,

  /**
   * probe 실패 strike 상한. 도달 시 fast-exit → 프로세스 재시작.
   * 재시작 우선 기조: in-process 재연결은 실측(example-sustain-bot 4/4)에서 복구 무효였고,
   * 큐 기반이라 재시작이 무손실이므로 복구 전략을 공격적으로 가져간다.
   */
  ZOMBIE_STRIKE_LIMIT: 2,

  /**
   * 무이벤트가 이 시간(ms)을 넘고 probe 가 '유실 없음'으로 판정하면(=Slack API 는 정상)
   * 예방적 소프트 재연결을 1회 한다.
   *
   * **실사고 2026-07-28**: 호스트 DNS 장애(≈36분) 중 WS 가 끊긴 뒤 복구 후에도 재연결되지
   * 않아 DM 이 4시간 무수신. probe 는 '대상 채널의 유실'만 볼 수 있어, 아직 아무도 말을 걸지
   * 않은 좀비 소켓은 '조용함'과 구분되지 않는다 — RS-01(무유실 시 무동작)의 사각지대다.
   * 45분은 "DM 을 이 이상 방치하면 사람이 먼저 알아챈다"는 상한이고, 조용한 워크스페이스에서도
   * 하루 ~32회라 churn 이 낮다.
   */
  ZOMBIE_IDLE_RECONNECT_MS: 45 * 60_000,

  /** inflight 잡이 이 시간(ms) 동안 progress step이 없으면 watchdog이 운영 채널에 1회 통보. */
  WATCHDOG_STALL_MS: 3 * 60_000,

  /**
   * Slack Web API 개별 요청 타임아웃(ms). @slack/web-api 7.19.0 의 WebClient 기본값은
   * `timeout = 0`(무제한)이라, 소켓이 한 번 멎으면 호출자가 영영 매달린다.
   *
   * **실사고 2026-07-30**: 배포 재시작 후 프로세스가 online 인 채 **로그 한 줄 없이** 31초를
   * 멈춰 부팅 판정(30s)을 넘겼고, 멀쩡한 커밋이 부팅 실패로 오판돼 롤백+격리됐다. 첫 로그
   * 이전 구간의 유일한 블로킹 I/O 가 `auth.test()` 였다. 재시도 정책(기본 10회/약 30분)은
   * 그대로 두고 개별 요청만 끊는다 — 런타임 게시의 회복력은 유지하면서 무한 대기만 없앤다.
   */
  SLACK_REQUEST_TIMEOUT_MS: 10_000,

  /**
   * 부팅 `auth.test` 의 전체 마감(ms) — 재시도까지 포함한 상한이라 위 요청 타임아웃보다 크다.
   * `scripts/restart.sh` 의 부팅 판정 창(`CAUSEWAY_BOOT_TIMEOUT`, 기본 30s)보다 **작아야** 한다.
   * 그래야 무음으로 창을 넘겨 오판·롤백되는 대신, 에러 로그를 남기고 죽어 진짜 원인이 보인다.
   */
  BOOT_AUTH_DEADLINE_MS: 15_000,
} as const;
