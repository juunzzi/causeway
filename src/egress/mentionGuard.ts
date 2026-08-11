/**
 * 멘션 게이트 — 순수 함수만 (EG-07 Phase 1).
 *
 * 응답 텍스트의 요청자 외 <@Uxxxx> 멘션을 링크 해제(이름 평문화)해 오멘션 알림 발송을
 * 원천 차단한다. Phase 1 은 평문화까지 — ephemeral 승인 버튼 UI 는 후속 PR.
 * <!channel>/<!here>/<!everyone> 브로드캐스트는 봇 응답에서 항상 의도 밖이므로 무조건 해제.
 */

// <@Uxxxx> 또는 <@Uxxxx|name>, W 프리픽스(Enterprise) 포함
const MENTION_RE = /<@([UW][A-Z0-9]{2,})(?:\|([^>]*))?>/g;
const BROADCAST_RE = /<!(channel|here|everyone)(?:\|[^>]*)?>/g;
/**
 * 모델이 평문으로 적은 raw ID(`@U0DDDDDDDDD`) — 멘션 토큰이 아니라서 Slack 이 링크로도,
 * 이름으로도 못 바꾼다. 아는 이름이 있으면 사람 이름으로 바꾼다(모르면 그대로 둔다).
 * 앞의 `<` 는 제외 — 살아남은 `<@U...>`(허용된 요청자 멘션)를 깨뜨리면 안 된다.
 */
const BARE_ID_RE = /(?<!<)@([UW][A-Z0-9]{6,})\b/g;

export interface MentionGuardOptions {
  /** 알림이 가도 되는 유저 (요청자 등). 이외 멘션은 전부 평문화된다. */
  allowedUserIds: readonly string[];
  /** ID → 표시 이름. 없으면 <@U|name> 의 인라인 이름 → 그마저 없으면 ID 를 평문화한다. */
  nameByUserId?: ReadonlyMap<string, string>;
}

export interface MentionGuardResult {
  text: string;
  /** 평문화된(=차단된) 유저 ID 목록 — 후속 승인 UI 의 입력이 된다. */
  blockedUserIds: string[];
  /** 해제된 브로드캐스트 종류 (channel/here/everyone). */
  blockedBroadcasts: string[];
}

export function guardMentions(text: string, opts: MentionGuardOptions): MentionGuardResult {
  const allowed = new Set(opts.allowedUserIds);
  const blockedUserIds = new Set<string>();
  const blockedBroadcasts = new Set<string>();

  let out = text.replace(MENTION_RE, (full, id: string, inlineName: string | undefined) => {
    if (allowed.has(id)) return full;
    blockedUserIds.add(id);
    const name = opts.nameByUserId?.get(id) ?? (inlineName || undefined) ?? id;
    return `@${name}`;
  });

  out = out.replace(BROADCAST_RE, (_full, kind: string) => {
    blockedBroadcasts.add(kind);
    return `@${kind}`;
  });

  // 평문 raw ID 를 이름으로 — 차단이 아니라 표기 교정이라 blockedUserIds 에 넣지 않는다
  out = out.replace(BARE_ID_RE, (full, id: string) => {
    const name = opts.nameByUserId?.get(id);
    return name ? `@${name}` : full;
  });

  return {
    text: out,
    blockedUserIds: [...blockedUserIds],
    blockedBroadcasts: [...blockedBroadcasts],
  };
}
