# 발견 오리지널·카운터 레이어와 지속 작업 설계

작성일: 2026-08-22

## 1. 목적

발견 탭을 단일 검색어 목록에서 두 개의 명시적 탐색 레이어로 확장한다.

- 오리지널 탐색: 현재 연구 방향을 확장하고 심화한다.
- 카운터 탐색: 현재 관점을 정면으로 반박하거나 다른 계보를 찾는다.
- 각 레이어는 별도 키워드와 탐색 강도를 가진다.
- 저장소·착즙·Counter 결과를 바탕으로 검색어를 추천한다.
- 장시간 실행 버튼은 페이지 이동·새로고침·브라우저 종료와 무관하게 서버에서 지속된다.

이 변경은 발견 품질을 높이고 사용자가 연구 방향의 균형을 통제하도록 하는 것이 목적이다. 일반 챗봇, 자동 연구 에이전트, 무제한 외부 수집은 추가하지 않는다.

## 2. 확정 원칙

1. 기존 관련도 `0.65`, 무료 원문/PDF, 공학 중심 후보 차단, 회당 최대 8개 제한을 유지한다.
2. 기존 검색어는 삭제하지 않고 오리지널 레이어로 이전한다.
3. 추천어 화면 진입만으로 새로운 유료 OpenAI 호출을 만들지 않는다.
4. 오리지널과 카운터 강도는 서로 독립적이다. 둘 다 높이거나 한쪽을 끌 수 있다.
5. 강도는 노출 장식이 아니라 검색 깊이와 최종 후보 배분에 실제 반영한다.
6. 기존 공개 연구 성향 5개는 유지한다. 신규 강도는 발견 탭 안에서만 쓰는 지역 설정이다.
7. `processing_jobs`는 source ingestion 전용으로 유지한다. 사용자 실행 작업은 별도 `research_jobs`에 기록한다.
8. `ctx.waitUntil()`은 장시간 작업 실행 수단으로 사용하지 않는다. 연결 종료 후 보장 시간이 짧기 때문이다.
9. Cloudflare Workflows와 D1을 사용하며 별도 외부 SaaS를 추가하지 않는다.

## 3. 발견 프로필

저장 단위는 D1 `kv`의 `discovery_profile_v2`다.

```ts
export type DiscoveryLane = "ORIGINAL" | "COUNTER";

export interface DiscoveryLaneProfile {
  keywords: string[];
  strength: number; // 0..100
}

export interface DiscoveryProfile {
  original: DiscoveryLaneProfile;
  counter: DiscoveryLaneProfile;
  updatedAt: string;
}
```

검증 규칙:

- 레이어당 키워드 최대 4개
- 앞뒤 공백 제거, 빈 문자열 제거, 대소문자 비민감 중복 제거
- `isUsableDiscoveryQuery`를 통과하지 못한 일반어 단독 키워드 제거
- 강도는 정수 `0..100`으로 clamp
- 두 레이어의 키워드가 모두 비었거나 두 강도가 모두 0이면 실행 차단

기본값:

- 기존 `discovery_queries_v1`이 있으면 오리지널 키워드로 사용
- 오리지널 강도 `70`
- 카운터 강도 `30`
- 카운터 키워드는 자동 선택하지 않고 추천 목록만 제공

## 4. 탐색 강도

강도는 각 레이어의 활성 검색어 수와 공급자별 요청 깊이를 결정한다.

| 강도 | 레이어 상태 | 사용할 키워드 | 공급자별 키워드당 요청 수 |
|---|---|---:|---:|
| 0 | 꺼짐 | 0 | 0 |
| 1~39 | 가볍게 | 상위 1개 | 2 |
| 40~69 | 표준 | 상위 2개 | 4 |
| 70~100 | 깊게 | 최대 4개 | 6 |

최종 후보는 최대 8개다. 활성 레이어별 기본 quota는 강도 비율로 계산한다.

- 두 레이어가 활성화되면 각 레이어 최소 1개를 보장한다.
- `70:30`은 목표 quota `6:2`다.
- 한 레이어에 통과 후보가 부족하면 남은 슬롯을 다른 레이어의 통과 후보로 채운다.
- 공급자 quota `OpenAlex 4 / arXiv 2 / RSS 2`는 전체 결과에 계속 적용한다.

## 5. 검색어 추천

`GET /api/discover/recommendations`가 다음 형태를 반환한다.

```ts
export type DiscoveryRecommendationSource =
  | "SAVED"
  | "MOMENTUM"
  | "DISTILL"
  | "RESEARCH_GAP"
  | "COUNTER"
  | "UNDERREPRESENTED";

export interface DiscoveryKeywordRecommendation {
  keyword: string;
  lane: DiscoveryLane;
  source: DiscoveryRecommendationSource;
  reason: string;
  score: number;
  selected: boolean;
}
```

오리지널 추천 근거:

- 기존 저장 검색어
- 최근 30일 momentum keyword
- 최신 착즙의 `keywords`
- 최신 `research_gaps`
- 홈페이지 자료의 상위 키워드

카운터 추천 근거:

- 최신 검증 Counter의 `opposing_thesis`
- Counter `axes[].to`
- Counter `suggestions[].direction`
- Critic warning
- 전체 저장소에서 비중이 낮은 연구 topic

추천 생성은 기존 D1 JSON과 keyword/topic 집계만 사용한다. 문장형 Counter 항목은 공백 정규화 후 최대 80자로 제한하며 `isUsableDiscoveryQuery`를 통과해야 한다. 추천은 레이어별 최대 8개를 반환하고 동일 키워드는 높은 score 하나만 남긴다.

추천 score 우선순위:

1. 사용자가 저장한 검색어: `1.0`
2. 검증된 Counter 또는 최근 Distill: `0.9`
3. 최근 momentum 또는 research gap: `0.8`
4. underrepresented topic: `0.6`

## 6. 발견 후보

`discovery_candidates`에 다음 필드를 추가한다.

- `discovery_lane`: `ORIGINAL | COUNTER`, 기존 행은 `ORIGINAL`
- `query_source`: `SAVED | RECOMMENDED | MOMENTUM | FEED`

카운터 후보도 기존 `assessDiscoveryCandidate`를 반드시 통과해야 한다. 즉 카운터 검색어 일치만으로 후보가 되지 않는다. 사진·이미지·시각문화 연구 anchor, 접근 가능성, 공학 중심 차단을 동일하게 적용한다.

목록과 상세에는 다음 provenance를 표시한다.

- 오리지널/카운터 배지
- 실제 검색어
- 검색어 출처
- 공급자, 관련도, 접근 상태

후보 화면에는 기존 상태 필터와 별도로 `전체 / 오리지널 / 카운터` 레이어 필터를 둔다.

## 7. 발견 탭 UX

페이지 순서:

1. 제목과 `지금 새로 찾기`
2. 발견 방향 패널
3. 후보 상태·레이어 필터와 실행 요약
4. 후보 목록·읽기 패널
5. 접힌 RSS·출처 설정

발견 방향 패널은 오리지널과 카운터 카드를 나란히 배치한다. 좁은 화면에서는 세로로 쌓는다.

각 카드 구성:

- 레이어 이름과 한 줄 설명
- 탐색 강도 slider와 `꺼짐/가볍게/표준/깊게` 문구
- 저장 키워드 chip, 제거 버튼
- 텍스트 입력과 추가 버튼
- 추천 키워드 chip, 추천 이유

패널 하단에는 `검색 설정 저장` 버튼 하나만 둔다. 저장 성공은 toast로 알리고, 저장하지 않은 변경이 있으면 실행 버튼에 `설정을 먼저 저장하세요` 안내를 제공한다.

## 8. 지속 작업 시스템

### 8.1 대상 작업

첫 구현에서 다음 사용자 실행 작업을 전환한다.

- `DISCOVERY_RUN`
- `DISTILL_RUN`과 다시 착즙
- `RADAR_SYNTHESIS`
- `DEEP_ANALYSIS`

Inbox 정규화·백필, 검색, 판단 저장 같은 짧은 요청은 기존 동기 API를 유지한다.

### 8.2 작업 상태

```ts
export type ResearchJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
export type ResearchJobKind = "DISCOVERY_RUN" | "DISTILL_RUN" | "RADAR_SYNTHESIS" | "DEEP_ANALYSIS";
```

D1 `research_jobs`는 다음을 보존한다.

- job ID와 Workflow instance ID
- kind, status, progress, message
- 입력 JSON, 결과 JSON, 결과 화면 참조
- 오류, 재시도 원본 ID
- 요청 사용자, 생성·시작·완료·갱신 시각
- 사용자가 완료·실패 알림을 닫은 시각 `dismissed_at`
- 중복 실행 차단용 `dedupe_key`

### 8.3 실행 흐름

```text
사용자 클릭
→ API가 D1 QUEUED job 생성
→ 동일 ID로 Workflow instance 생성
→ 즉시 HTTP 202 + job 반환
→ Workflow가 D1 progress 갱신
→ UI 전역 Job Center가 active job polling
→ 완료 시 결과 화면 링크 제공
```

Workflow는 각 작업을 durable `step.do()` 안에서 실행한다. 외부 검색과 AI 호출은 retry 횟수를 1회로 제한해 일시 오류는 복구하되 비용 중복을 제한한다. 기존 함수가 D1에 결과를 저장한 뒤 job에는 결과 ID만 보존한다.

중복 실행 정책:

- 동일 `dedupe_key`의 `QUEUED/RUNNING` job은 하나만 허용한다.
- 중복 클릭 시 새 Workflow를 만들지 않고 기존 job을 `202`로 반환한다.
- 실패 재시도는 새 job ID를 만들고 `retry_of`로 원본을 연결한다.

예산 정책:

- AI 작업은 enqueue 전 1차 예산 검사
- Workflow AI 단계 직전 2차 예산 검사
- 100% 도달 시 `FAILED`가 아니라 `BLOCKED`와 명확한 오류 코드 `monthly_budget_exhausted`로 종료

## 9. 전역 Job Center

기존 브라우저 메모리 기반 `tasks.ts`를 서버 job 기반 client로 교체한다.

- App mount 시 최근 job 목록 로드
- active job이 있을 때만 2초 polling
- 모든 job이 끝나면 polling 중지
- 페이지 이동·컴포넌트 unmount와 무관하게 AppShell에서 유지
- 새로고침 후 D1 상태로 복구
- 완료/실패 작업은 90초 자동 숨김이 아니라 사용자가 닫기 전까지 최근 목록에 유지
- 사용자가 닫으면 API가 `dismissed_at`을 기록해 새로고침 뒤에도 다시 나타나지 않음
- 완료 작업에는 `결과 보기` 액션 제공

결과 화면 매핑:

- Discovery → 발견
- Distill → 착즙 session
- Radar → 해당 period 레이더
- Deep analysis → 해당 source 저장소

## 10. 오류와 복구

- Workflow 생성 실패: D1 job을 `FAILED`로 기록하고 재시도 버튼 표시
- Workflow runtime 오류: outer catch에서 오류를 300자로 제한해 job에 기록하고 다시 throw
- D1이 RUNNING인데 Workflow가 errored/terminated: job 목록 조회 시 instance status를 확인해 보정
- 추천 데이터 없음: 빈 상태와 직접 키워드 입력 제공
- 한 레이어 후보 없음: 다른 레이어로 슬롯 보충하고 실행 결과에 부족 원인 표시
- 두 레이어 모두 비활성: API `400 discovery_profile_empty`

## 11. 비목표

- AI가 사용자의 키워드를 자동 저장하는 기능
- 후보 수 무제한 확대
- 새로운 외부 검색 SaaS
- 일반 작업 스케줄러 UI
- 작업 취소·일시중지 UI
- 여러 사용자의 작업 격리·권한 관리
- 기존 ingestion `processing_jobs` 통합

## 12. 검증 기준

1. 기존 검색어가 오리지널 레이어에서 그대로 보인다.
2. 추천 chip 클릭과 제거가 레이어별 최대 4개 제한을 지킨다.
3. 강도 `70:30`에서 목표 후보 quota가 `6:2`가 된다.
4. 카운터 후보도 무료 접근·연구 anchor·공학 차단 기준을 통과한다.
5. 후보에서 lane과 query provenance를 확인할 수 있다.
6. 발견 실행 후 즉시 다른 페이지로 이동해도 작업이 완료된다.
7. 새로고침 후에도 active job이 복구된다.
8. 같은 실행 버튼을 반복 클릭해도 active job은 하나다.
9. 실패 job은 오류와 재시도 버튼을 제공한다.
10. 기존 월 예산 guardrail, cron, Reservoir provenance가 유지된다.
