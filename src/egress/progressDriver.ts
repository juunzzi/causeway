/**
 * 진행 표시 드라이버 — plan 카드(chatStream)와 폴백 텍스트 카드(chat.update)를 한 인터페이스
 * 뒤로 숨긴다. 호출부(chat·자동화 잡)는 이 인터페이스만 쓰고, plan/폴백 분기는 여기에 국소화된다.
 *
 * chat/handler.ts 에서 이전·일반화했다(2026-07: 자동화 잡도 agent plan 카드로 통일). 원래 chat 전용
 * (ChatPayload·ChatTaskHandle 결합)이던 입력을 순수 opts 로 풀어, 자동화(alert-analysis·
 * daily-error-report)도 recipientUserId=owner·recipientTeamId=botTeamId 만 주입해 그대로 쓴다.
 *
 * 제약(회귀 금지): chat 이 의존하던 동작 — plan 우선→폴백, abortStream, finish 최종 교체,
 * setAssistantStatus, 죽은 스트림(#20) freeze 정리, 재시작 폴백카드 ts(onCardTs) — 이 전부가
 * 추출 전과 바이트 동등해야 한다. chat/handler.ts 는 콜백 매핑(setStep→onStep, setProgressTs→
 * onCardTs)만으로 이 모듈을 쓴다.
 */

import { type AgentTaskStream, createAgentTaskStream } from "../slack/agentStream.js";
import { type ChatStreamHandle, isStreamDeadError, type SlackPort } from "./ports.js";
import { buildMarkdownBlockChunks, type OutboundOptions, type Poster } from "./poster.js";
import { createProgressCard, formatStepLabel, splitProgressLine } from "./progress.js";

/**
 * 진행 표시 드라이버 — plan 카드/폴백 카드를 같은 얼굴로 노출한다. 호출부는 이 4개 메서드만
 * 알면 되고, 실제로 어느 경로가 살아 있는지는 드라이버가 감춘다.
 */
export interface ProgressDriver {
  /** runner 의 raw SDK 메시지를 흘린다(plan 경로만 소비, 폴백은 onProgress 를 쓴다). */
  onStreamEvent(message: unknown): void;
  /** runner 의 도구 요약 라인을 흘린다(폴백 경로만 소비). */
  onProgress(line: string): void;
  /** 최종 답변(또는 취소 안내)으로 카드를 종결한다. 멘션 허용 대상·표시명 맵은 그대로 egress 로 흐른다. */
  finish(text: string, opts?: OutboundOptions): Promise<void>;
  /**
   * 재시도 대상 예외(runSession 거절)로 스레드를 떠나기 직전 호출 — plan 스트림을 stop 해서
   * 미마감 카드가 동결/에러로 남지 않게 한다. 폴백 카드 경로에선 no-op(카드 교체는 호출부가 담당).
   */
  abortStream(): Promise<void>;
}

export interface ProgressDriverDeps {
  slack: SlackPort;
  poster: Poster;
  clock?: { now(): number };
  log: (msg: string) => void;
}

export interface ProgressDriverOptions {
  channel: string;
  /** plan 스트리밍은 스레드 답글로 흘린다(chat.startStream 요구). 없으면 폴백 카드도 top-level. */
  threadTs?: string;
  /** 로그 식별용(스레드 키/알람 키 등). 표시엔 안 쓴다. */
  threadKey?: string;
  /**
   * 채널 스트리밍의 recipient_user_id. chat 은 payload.userId, 자동화는 owner(관리자). null/미지정
   * 이면 채널 스트리밍이 거절될 수 있고 그땐 폴백 카드로 강등된다.
   */
  recipientUserId?: string;
  /** 채널 스트리밍의 recipient_team_id — 부팅 auth.test 의 team_id. null 이면 폴백 강등 가능. */
  recipientTeamId: string | null;
  /** plan 카드 헤더 제목. */
  planTitle: string;
  /** plan 카드에 task 로 노출하지 않을 도구(TodoWrite/ExitPlanMode 등). */
  hiddenTools?: ReadonlySet<string>;
  /** plan chunk·폴백 카드 텍스트 마스킹(SEC-11). */
  maskSecrets: (text: string) => string;
  /** 폴백 카드 헤더 회전 문구(statusPool.createStatusPicker). 미지정 시 카드 기본 헤더. */
  headerFn?: () => string;
  /**
   * plan assistant 스레드에 띄울 평문 상태(도구 없는 대화형 답변도 처리 중임을 표시). 미지정이면
   * 상태를 띄우지 않는다 — 자동화 잡은 assistant 스레드가 아니라 상태 표시가 무의미하므로 생략한다.
   */
  statusText?: string;
  /**
   * 죽은 plan 스트림(#20) 정리 문구 — 스트림이 만료돼 stop 으로 못 닫고 재시도/종료로 떠날 때,
   * 얼어붙은 카드를 이 짧은 종결 상태로 chat.update 교체한다. 미지정이면 정리만 하고 문구는 안 바꾼다.
   */
  streamClosedNotice?: string;
  /** watchdog 연동용 — addTool 최근 스텝 문자열을 밖으로 흘린다(chat task.setStep). */
  onStep?: (step: string) => void;
  /**
   * 폴백 카드 ts 가 확정될 때 호출 — chat 은 task.setProgressTs, 자동화는 ctx.persistPayload(cardTs)
   * 에 연결한다. plan 카드 ts 는 재개 불가라 영속 대상이 아니지만, 죽은 스트림 정리로 폴백 ts 를
   * 채택했을 때(#20)와 폴백 카드 start 때 이 콜백이 호출돼 재시작 생존/재시도 안내 교체의 근거가 된다.
   */
  onCardTs?: (ts: string) => void;
  /**
   * 폴백 카드가 이어받을 기존 ts — 재시작 넘은 재시도에서 payload.cardTs 를 넘겨 같은 카드를
   * 이어 쓰고 고아·중복 카드를 막는다. plan 이 살아 시작하면 이 값은 쓰이지 않는다(plan 우선).
   */
  fallbackExistingTs?: string;
}

/**
 * plan 카드 우선, 실패 시 텍스트 카드로 강등하는 드라이버를 만든다.
 *
 * - createStream 예외(앱이 아직 assistant 아님·권한 부족 등) → 즉시 폴백 카드로 시작.
 * - 첫 append 예외(invalid_blocks 등) → 그 시점에 폴백 카드로 강등하고 이후 onProgress 를 카드에.
 *
 * 폴백 카드는 필요할 때만 start 한다(plan 이 끝까지 성공하면 chat.update 를 한 번도 안 쓴다).
 */
export async function createProgressDriver(
  deps: ProgressDriverDeps,
  opts: ProgressDriverOptions,
): Promise<ProgressDriver> {
  // adoptTs: 죽은 plan 스트림의 프리즌 카드 ts 를 그대로 이어받아(existingTs) 그 자리를 일반
  // chat.update 로 정리·교체한다 — 새 답글 카드를 따로 posting 하지 않고 얼어붙은 카드를 갈아끼운다(A 버그).
  // adoptTs 미지정 시엔 fallbackExistingTs(재시작 넘은 재시도)를 채택해 같은 폴백 카드를 이어 쓴다.
  const makeCard = (adoptTs?: string) => {
    const existingTs = adoptTs ?? opts.fallbackExistingTs;
    return createProgressCard(
      {
        slack: deps.slack,
        poster: deps.poster,
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(opts.onStep ? { onStep: opts.onStep } : {}),
        log: deps.log,
      },
      {
        channel: opts.channel,
        ...(opts.threadTs !== undefined ? { threadTs: opts.threadTs } : {}),
        ...(opts.headerFn ? { headerFn: opts.headerFn } : {}),
        ...(existingTs !== undefined ? { existingTs } : {}),
      },
    );
  };

  let mode: "plan" | "card" = "plan";
  let card: ReturnType<typeof makeCard> | null = null;
  let handle: ChatStreamHandle | null = null;
  let agentStream: AgentTaskStream | null = null;

  // 폴백 카드로 강등(또는 처음부터 카드 모드로 시작). 이미 카드가 있으면 no-op.
  // adoptTs 가 주어지면 그 ts 를 이어받아(existingTs) 얼어붙은 plan 카드를 새 카드 posting 없이 교체한다.
  const ensureCard = async (adoptTs?: string): Promise<void> => {
    mode = "card";
    if (card !== null) return;
    card = makeCard(adoptTs);
    await card.start();
    if (card.ts !== undefined) opts.onCardTs?.(card.ts);
  };

  // assistant 스레드 상태 갱신(코스메틱, best-effort). threadTs 가 없는 경우엔 건너뛴다
  // — plan 모드는 항상 threadTs 가 있지만(chat.startStream 요구) 가드로 방어한다.
  const threadTs = opts.threadTs;
  const setStatus = async (status: string): Promise<void> => {
    if (threadTs === undefined) return;
    await deps.slack.setAssistantStatus({ channel: opts.channel, threadTs, status });
  };

  try {
    handle = deps.slack.createStream({
      channel: opts.channel,
      ...(opts.threadTs !== undefined ? { threadTs: opts.threadTs } : {}),
      ...(opts.recipientUserId !== undefined ? { recipientUserId: opts.recipientUserId } : {}),
      recipientTeamId: opts.recipientTeamId,
      planTitle: opts.planTitle,
    });
  } catch (err) {
    deps.log(
      `progressDriver: plan 스트림 생성 실패 — 진행 카드로 폴백 key=${opts.threadKey}: ${String(err)}`,
    );
    await ensureCard();
  }

  if (handle !== null) {
    const activeHandle = handle;
    agentStream = createAgentTaskStream(
      (args) => {
        // append 는 fire-and-forget — 실패하면 폴백 카드로 강등한다(첫 실패 기준).
        void activeHandle.appendChunks(args.chunks).catch((err) => {
          if (mode === "plan") {
            deps.log(
              `progressDriver: plan append 실패 — 진행 카드로 폴백 key=${opts.threadKey}: ${String(err)}`,
            );
            void ensureCard();
          }
        });
      },
      {
        planTitle: opts.planTitle,
        ...(opts.hiddenTools ? { hiddenTools: new Set(opts.hiddenTools) } : {}),
        maskSecrets: opts.maskSecrets,
      },
    );
    // plan 스트림 생성 성공 → 처리 중임을 assistant 상태로 표시(코스메틱, best-effort).
    // 도구를 쓰지 않는 대화형 답변도 이 상태로 처리 중임이 항상 보인다.
    if (opts.statusText !== undefined) await setStatus(opts.statusText);
  }

  return {
    onStreamEvent(message) {
      // plan 모드일 때만 chunk 로 흘린다. 폴백으로 강등된 뒤엔 onProgress 가 카드를 채운다.
      if (mode === "plan") agentStream?.onEvent(message);
    },
    onProgress(line) {
      const { tool, summary } = splitProgressLine(line);
      if (mode !== "card" || card === null) {
        // plan 모드에도 워치독 신호는 흘려야 한다. onStep 이 카드 경로(addTool)에만 있던 동안
        // 정상 경로로 도는 잡은 lastStep 이 영원히 null 이었고, 워치독은 도구가 계속 도는 잡을
        // 전부 `(스텝 없음)` 으로 오탐했다(2026-08-03 실측: 도구 15회 실행 후 stall 통보).
        // 카드를 만들지 않는 게 정상 경로이므로, 여기서 통보를 못 받으면 관측 자체가 없다.
        opts.onStep?.(formatStepLabel(tool, summary));
        return;
      }
      // 진행 카드 갱신은 fire-and-forget — rate-limit·직렬화는 카드 내부 책임 (EG-02).
      // onStep 은 addTool 안에서 부르므로 여기선 중복 호출하지 않는다.
      void card.addTool(tool, summary);
    },
    async finish(text, finishOpts) {
      if (mode === "plan" && handle !== null) {
        // plan 스트림도 폴백 카드와 동일한 egress 파이프라인(mask→멘션게이트→markdown 블록 청크)을
        // 거친다 — appendText 로 원문을 그대로 흘리면 (a) 멘션 게이트(EG-07)가 우회돼 요청자 외
        // <@U> 오멘션 알림이 나가고, (b) 11k 상한 분할이 안 돼 12k 초과 리포트가 msg_too_long 으로
        // 거절된다(정상 경로에서 이 PR 이 막으려던 바로 그 사고). plan markdown_text 는 한 메시지로
        // **누적**되므로(단일 본문), 여러 청크로 쪼개져야 하는 긴 답변은 plan 으로 못 싣는다 — 그땐
        // 폴백 카드/poster 경로로 강등해 여러 답글로 안전 분할·게시한다.
        // assistant 상태 clear 는 append/stop 성패·경로(성공/강등)와 무관하게 항상 필요하므로 진입
        // 시 먼저 한다(abortStream 과 동일 패턴). 이걸 성공 경로에만 두면 stop 실패나 append 실패→폴백
        // 경로에서 "분석 중…" 상태가 영구히 남는다(리뷰 반영).
        await setStatus("");
        const built = buildMarkdownBlockChunks(text, finishOpts);
        if (built.chunks.length > 1) {
          // 11k 초과라 여러 메시지로 나뉜다 — plan markdown_text 는 단일 본문으로 누적되므로 여러
          // 청크를 못 싣는다. 폴백 카드로 강등해 공통 tail 이 poster 파이프라인으로 여러 답글에
          // 안전 분할·게시하게 한다(card 조차 못 만들면 tail 의 poster.postFinal 이 새 답글로 게시).
          deps.log(
            `progressDriver: plan 최종 답변이 ${built.chunks.length}개 청크(>11k) — 폴백 카드로 강등 key=${opts.threadKey}`,
          );
          await ensureCard();
        } else {
          // 단일 청크(≤11k) — 게이트·마스킹을 마친 GFM 을 그대로 plan 본문으로 append 한다.
          // chunks 가 비면(게이트 후 공백) appendText 는 slackPort 에서 no-op 이고 stop 만 남는다.
          const planText = built.chunks[0]?.markdown ?? "";
          // 미마감 task 를 complete 로 정리 → 최종 답변 append → stop (Slack 이 stop 후 미마감을 error
          // 로 렌더하는 것 방지). append 실패만 폴백 카드로 강등한다 — appendText 가 이미 성공한 뒤
          // stop 만 실패하면 최종 답변은 사용자에게 이미 보였으므로, 폴백으로 재게시하면 중복 게시가
          // 된다. 그 경우엔 stop 실패를 로그만 남기고 종결한다(미마감 스트림은 Slack 이 결국 정리한다).
          let appended = false;
          try {
            agentStream?.finalize();
            await handle.appendText(planText);
            appended = true;
            await handle.stop();
            return;
          } catch (err) {
            if (appended) {
              // appendText 성공 후 stop 실패 — 답변은 이미 게시됨. 폴백(재게시) 금지.
              // (stop 만 죽은 스트림이어도 append 로 답변이 렌더됐으므로 프리즌 카드가 아니다 — 정리 불필요.)
              deps.log(
                `progressDriver: plan stop 실패(답변은 게시됨) key=${opts.threadKey}: ${String(err)}`,
              );
              return;
            }
            // append 가 죽은 스트림(message_not_in_streaming_state)에 실패 — 최종 답변이 아직 안 실렸다.
            // 이 경우 얼어붙은 plan 카드(handle.ts)를 이어받아 그 자리를 chat.update 로 정리·교체한다.
            // ts 가 undefined 면(첫 flush 전) 뜬 카드가 없으니 새 카드로 폴백한다(adoptTs 미전달).
            const deadTs = isStreamDeadError(err) ? handle.ts() : undefined;
            deps.log(
              `progressDriver: plan finish 실패 — 진행 카드로 폴백 key=${opts.threadKey}` +
                `${deadTs !== undefined ? ` (죽은 스트림 카드 ts=${deadTs} 정리)` : ""}: ${String(err)}`,
            );
            await ensureCard(deadTs);
          }
        }
      } else {
        // 스트리밍 도중 append 실패로 card 모드로 강등된 경우 — 드라이버 생성 때 띄운 assistant
        // 상태(≠"")가 그대로 남아 있으므로 여기서도 clear 한다. handle===null(처음부터 카드)이면
        // 상태를 애초에 안 띄웠으니 clear 도 건너뛴다(불필요한 setStatus 호출 방지).
        if (handle !== null) await setStatus("");
        await ensureCard();
      }
      // 폴백 카드 경로 — poster 파이프라인(mask→멘션게이트→markdown 블록 청크)으로 최종 답변 게시.
      // card.finish 가 asMarkdownBlock:true 로 게시해 plan 스트림(markdown_text)과 렌더를 일치시킨다(EG-10).
      if (card !== null) {
        await card.finish(text, finishOpts);
      } else {
        // 카드조차 못 만든 극단(둘 다 throw) — 새 답글로라도 최종 답변을 남긴다(GFM markdown 블록).
        await deps.poster.postFinal(text, {
          channel: opts.channel,
          ...(opts.threadTs !== undefined ? { threadTs: opts.threadTs } : {}),
          asMarkdownBlock: true,
          ...finishOpts,
        });
      }
    },
    async abortStream() {
      if (mode !== "plan" || handle === null) return;
      const planHandle = handle;
      // 중단 시에도 assistant 상태를 비운다(코스메틱, best-effort). stop 성패와 무관하게 먼저 clear.
      await setStatus("");
      try {
        agentStream?.finalize();
        // plan 카드 ts 는 재개 불가라(문서 계약) 다음 attempt/재시도는 새 plan 카드를 만든다 —
        // 이 정지 카드를 그대로 두면 "작업 진행 중…" 상태로 얼어붙은 고아 카드가 스레드에 남는다.
        // stop 에 streamClosedNotice(종결 문구)를 실어 정지 카드를 "재시도 중" 같은 종결 상태로
        // 갈아끼운다(자동화 잡 재시도마다 스테일 진행 카드가 쌓이는 것 방지). shutdown 이면 이 문구가
        // 그대로 남고, 재시도면 호출부가 그 위에 재시도 안내를 별도로 게시한다.
        await planHandle.stop(
          opts.streamClosedNotice !== undefined
            ? { markdownText: opts.streamClosedNotice }
            : undefined,
        );
      } catch (err) {
        // 재시도/취소 안내는 호출부가 별도로 게시한다 — 정상 stop 실패는 로그만.
        deps.log(`progressDriver: plan 스트림 중단 실패 key=${opts.threadKey}: ${String(err)}`);
        // 죽은 스트림(message_not_in_streaming_state)은 stop 으로 못 닫는다 — 얼어붙은 plan 카드를
        // 일반 chat.update 로 짧은 종결 상태로 교체하고, 그 ts 를 onCardTs 로 흘려 호출부의
        // 재시도 안내가 새 답글 대신 이 카드를 교체하게 한다(shutdown 이면 이 종결 문구가 그대로 남는다).
        if (isStreamDeadError(err)) {
          const deadTs = planHandle.ts();
          if (deadTs !== undefined) {
            try {
              // streamClosedNotice 가 있으면 그 문구로 교체, 없으면 정리를 건너뛴다(문구 없이 갈아끼울
              // 텍스트가 없다). chat 은 CHAT_STREAM_CLOSED_NOTICE 를 넘긴다.
              if (opts.streamClosedNotice !== undefined) {
                await deps.slack.updateMessage({
                  channel: opts.channel,
                  ts: deadTs,
                  text: opts.streamClosedNotice,
                });
                opts.onCardTs?.(deadTs);
              }
            } catch (updateErr) {
              deps.log(
                `progressDriver: 죽은 plan 카드 정리 실패 ts=${deadTs} key=${opts.threadKey}: ${String(updateErr)}`,
              );
            }
          }
        }
      }
    },
  };
}
