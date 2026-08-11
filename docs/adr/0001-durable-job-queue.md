# ADR-0001: 단일 SQLite 내구 잡 큐를 시스템의 척추로

- 상태: 채택 (2026-07-13)

## 결정

모든 작업(@멘션/DM 대화 포함)을 단일 SQLite `jobs` 테이블의 잡으로 통일한다.
Ingress는 enqueue만 하고, 레인 3분할(interactive/automation/write) dispatcher가 실행한다.
`dedup_key UNIQUE`가 멱등성의 근원이다.

## 근거

선행 봇 운영 사고(좀비 소켓 유실, 절전 cron 누락, 재시작 상태 소실, 중복 트리거)의
공통 근본원인이 "수신 즉시 실행"이었다. 선행 구현의 잡 큐 계약(멱등 enqueue →
claim → settle/requeue → 부팅 recoverInflight)을 일반화하면 재시작 내구성이 잡 종류와
무관하게 따라오고, coalesce/misfire 보정/fire 감사/중복 게이트가 전부 테이블의 성질
(SELECT)로 환원된다.

## 결과 및 한계

- 재시작이 무손실 → 좀비 소켓 등 복구 전략을 "재시작 우선"으로 공격적으로 가져갈 수 있다.
- 단일 프로세스 + `BEGIN IMMEDIATE` claim은 다중 프로세스 안전하지 않다. FE 챕터 규모에서는
  충분하며, 스케일아웃이 필요해지는 시점이 큐 백엔드(예: PG/Redis) 교체 지점이다.
- payload는 잡 타입별 zod 스키마 + `schema_version` — 구버전 프로세스가 만든 잡을
  신버전 코드가 못 읽으면 failed + 통보로 처리한다(침묵 금지).
