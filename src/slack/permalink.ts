/**
 * Slack 메시지 주소(permalink)·시각 표기 원시 함수 — 순수.
 *
 * `ingress/forwardMessage.ts` 에 있던 것을 여기로 옮겼다: 전달(게시처 해석)과 조회
 * (`mcp/slackRead.ts` 의 링크 해석)가 **같은 파싱**을 써야 하고, mcp 도구가 ingress 모듈을
 * import 하면 조회 도구가 게시 경로의 모듈 그래프에 묶인다. 원시 함수는 slack 계층에 둔다.
 */

/**
 * Slack permalink → {channel, ts}. `p1754400000123456` 의 마이크로초 6자리가 소수부다.
 * 형식이 어긋나면 null — 오타를 조용히 다른 스레드로 보내지 않는다(parsePrRefToken 과 같은 규율).
 *
 * `?thread_ts=` 쿼리가 붙어 있으면 그쪽을 쓴다: 스레드 답글의 permalink 는 경로가 그 **답글**을
 * 가리키므로, 경로 ts 로 게시하면 답글에 또 스레드를 파는 꼴이 된다(슬랙은 중첩 스레드가 없다).
 * 조회 쪽에서도 같은 이유로 쓸모가 같다 — 답글 링크를 줘도 그 답글이 속한 스레드를 연다.
 */
export function parseSlackPermalink(raw: string): { channel: string; ts: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /\/archives\/([CDG][A-Z0-9]+)\/p(\d{16,})(?:\?(\S*))?/.exec(trimmed);
  if (!m) return null;
  const channel = m[1] as string;
  const digits = m[2] as string;
  const query = m[3] ?? "";
  const threadTs = /(?:^|&)thread_ts=(\d+\.\d+)/.exec(query)?.[1];
  if (threadTs) return { channel, ts: threadTs };
  return { channel, ts: `${digits.slice(0, -6)}.${digits.slice(-6)}` };
}

/**
 * `1754400000.123456` → `16:42` (Asia/Seoul 24시간 고정 — 봇 사용자가 전원 국내 팀이다).
 *
 * **오전/오후 표기를 쓰지 않는 이유는 재현성이다.** ko-KR 의 day-period 문구는 CLDR 판올림에
 * 따라 바뀐다 — ICU 78(node 24)부터 `hour:"numeric"` 의 ko-KR 출력이 `오후 4:42` 에서
 * `PM 4:42` 로 갈렸고, 문자열을 단언하는 테스트가 런타임 ICU 버전에 따라 깨진다(실측). 24시간 표기는 CLDR 변화에 영향받지 않고 오전/오후 오독도 없다.
 */
export function formatSlackTs(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(seconds * 1_000));
}
