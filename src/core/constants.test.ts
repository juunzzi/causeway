import { describe, expect, it } from "vitest";
import { CONTRACT } from "./constants.js";

/**
 * 수치 계약 고정 테스트.
 *
 * 이 테스트가 실패한다면 누군가 계약값을 바꾼 것이다 — 그 자체가 목적이다.
 * 값 변경이 정당하다면 docs/porting-contract.md 의 근거를 갱신하고
 * 이 테스트를 같은 PR에서 함께 수정하라.
 */
describe("수치 계약 (porting-contract §수치 계약)", () => {
  it("진행 카드 / 메시지 한계값", () => {
    expect(CONTRACT.PROGRESS_UPDATE_INTERVAL_MS).toBe(1_500);
    expect(CONTRACT.MESSAGE_CHUNK_CHARS).toBe(2_800);
    expect(CONTRACT.PROGRESS_TRUNCATE_CHARS).toBe(2_900);
    // chunk 상한은 truncate 상한보다 작아야 한다 (chunk가 progress 자리를 교체하므로)
    expect(CONTRACT.MESSAGE_CHUNK_CHARS).toBeLessThan(CONTRACT.PROGRESS_TRUNCATE_CHARS);
  });

  it("markdown 블록 chunk 상한", () => {
    expect(CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS).toBe(11_000);
    // markdown 블록 상한은 msg_too_long 경계(≈12,000)보다 안전 여유를 두고 작아야 한다
    expect(CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS).toBeLessThan(12_000);
    // markdown 블록은 GFM 그대로 실으므로 mrkdwn 경로 상한보다 넉넉하다
    expect(CONTRACT.MARKDOWN_BLOCK_CHUNK_CHARS).toBeGreaterThan(CONTRACT.MESSAGE_CHUNK_CHARS);
  });

  it("좀비 소켓 복구 파라미터", () => {
    expect(CONTRACT.ZOMBIE_PROBE_IDLE_MS).toBe(300_000);
    expect(CONTRACT.RECONNECT_RECHECK_MS).toBe(45_000);
    expect(CONTRACT.ZOMBIE_STRIKE_LIMIT).toBe(2);
    // 재확인은 probe 주기보다 짧아야 한다 (재연결 실패를 다음 probe 전에 감지)
    expect(CONTRACT.RECONNECT_RECHECK_MS).toBeLessThan(CONTRACT.ZOMBIE_PROBE_IDLE_MS);
  });

  it("예방적 재연결 임계", () => {
    expect(CONTRACT.ZOMBIE_IDLE_RECONNECT_MS).toBe(2_700_000);
    // 예방 재연결은 probe 임계보다 한참 뒤여야 한다 — 유실 기반 감지가 항상 먼저 기회를 갖는다
    expect(CONTRACT.ZOMBIE_IDLE_RECONNECT_MS).toBeGreaterThan(CONTRACT.ZOMBIE_PROBE_IDLE_MS);
  });

  it("절전 감지 / watchdog 파라미터", () => {
    expect(CONTRACT.WAKE_GAP_THRESHOLD_MS).toBe(120_000);
    expect(CONTRACT.WATCHDOG_STALL_MS).toBe(180_000);
  });

  it("Slack 요청 / 부팅 마감", () => {
    expect(CONTRACT.SLACK_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(CONTRACT.BOOT_AUTH_DEADLINE_MS).toBe(15_000);
    // 부팅 마감은 재시도까지 포함한 상한이라 개별 요청 타임아웃보다 커야 한다
    expect(CONTRACT.BOOT_AUTH_DEADLINE_MS).toBeGreaterThan(CONTRACT.SLACK_REQUEST_TIMEOUT_MS);
    // 그러나 restart.sh 의 부팅 판정 창(CAUSEWAY_BOOT_TIMEOUT 기본 60s)의 절반 이하여야 한다 —
    // 인증에서 마감을 다 써도 나머지 부팅 예산이 남아야, 무음 초과로 오판·롤백되는 대신
    // 에러 로그를 남기고 죽는다
    expect(CONTRACT.BOOT_AUTH_DEADLINE_MS).toBeLessThanOrEqual(30_000);
  });
});
