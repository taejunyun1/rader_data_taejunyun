# 발견 검색 계획과 후보 진단 설계

작성일: 2026-08-23

## 1. 목적

발견 실행이 `새 후보 0개`로 끝났을 때 사용자가 그 이유를 이해하고 다음 행동을 결정할 수 있게 한다. 동시에 현재 검색어 변환의 약점과 기존 OpenAlex 후보가 다음 실행에서 사라지는 접근 상태 재평가 오류를 바로잡는다.

핵심 원칙은 다음과 같다.

> 후보 0개는 허용하되, 이유 없는 0개는 허용하지 않는다.

이 변경은 후보 수를 억지로 채우기 위한 필터 완화가 아니다. 기존 관련도·접근성·출처 quota 정책을 유지하면서 검색 계획과 후보 탈락 과정을 관측 가능하게 만드는 작업이다.

## 2. 기존 설계와의 관계

이 문서는 다음 기존 결정을 보완한다.

- `docs/SPEC.md`의 OpenAlex + arXiv + 큐레이션 RSS/Atom 공급자 구성
- `docs/PROJECT_CONTEXT.md`의 관련도 `0.65`, 무료 원문/PDF, 공학 중심 차단 정책
- `2026-08-22-discovery-lanes-background-jobs-design.md`의 오리지널·카운터 레이어, 탐색 강도, 최대 8개, 지속 작업 설계

제품 요구사항은 `docs/spec-v0.1.txt`와 `docs/SPEC.md`를 함께 따르며 충돌 시 `docs/SPEC.md`가 우선한다. `docs/PROJECT_CONTEXT.md`는 현재 구현·운영·provenance 참조이고, 기존 확정 설계와 이 문서는 그 하위 설계 기록이다. 이 문서에서는 다음 정책을 변경하지 않는다.

1. 최종 후보는 관련도 `0.65` 이상이어야 한다.
2. 최종 후보는 `PDF` 또는 `FREE_FULLTEXT`여야 한다.
3. 공학 중심 자료는 비평적·시각문화 연구 맥락이 없으면 제외한다.
4. 회당 최대 8개와 공급자 quota `OpenAlex 4 / arXiv 2 / RSS 2`를 유지한다.
5. 적합한 후보가 부족하면 빈 슬롯을 유지한다.
6. 외부 검색 SaaS나 신규 유료 AI 호출을 추가하지 않는다.

## 3. 현재 문제

### 3.1 하나의 `0개`가 서로 다른 상태를 숨긴다

현재 provider adapter는 HTTP 오류, timeout, parse 오류를 모두 빈 배열로 반환한다. 실행 결과는 최종 `collected`만 기록하므로 다음 상태가 모두 `새 후보 0개`로 합쳐진다.

- provider가 정상 응답했지만 결과가 없음
- provider 요청이 실패함
- 결과는 있었지만 OA/PDF 링크가 없음
- 연구 anchor가 없어 탈락함
- 공학 중심 또는 관련도 기준 미달로 탈락함
- 기존 후보와 중복됨

### 3.2 저장 문장과 provider 검색어가 분리되지 않는다

오리지널·카운터의 저장값은 연구 방향 provenance이면서 동시에 외부 provider 검색어로 사용된다. `사진`, `이미지`, `네트워크`, `데이터`처럼 현재 사전에 등록된 단어가 없는 한국어 문장은 원문 그대로 OpenAlex에 전달된다.

특히 카운터 방향은 완성된 주장이나 방법론 문장이 많다. 이 문장을 독립 검색어로 보내면 현재 연구축과의 연결이 사라지고 provider 검색 품질이 낮아진다.

### 3.3 arXiv 실행 여부가 변환 전 문자열에 의존한다

arXiv 검색은 provider용으로 변환된 검색어가 아니라 사용자가 저장한 원문에 `photograph`, `visual`, `image`, `사진`, `이미지`가 있는지로 결정된다. 따라서 변환 후에는 시각·이미지 연구 검색어가 되더라도 arXiv가 실행되지 않을 수 있다.

### 3.4 기존 OpenAlex 후보의 접근 상태가 손실된다

신규 OpenAlex 후보는 `open_access.oa_url`을 근거로 `FREE_FULLTEXT`로 저장된다. 그러나 다음 발견 실행에서 기존 후보를 재평가할 때 URL 문자열 휴리스틱이 OpenAlex를 `UNKNOWN`으로 분류한다. 해당 후보는 `ACCESS_UNKNOWN`으로 탈락하고 `IGNORED`가 될 수 있다.

## 4. 선택한 접근

### 4.1 검토한 대안

#### 대안 A: 접근 상태 버그와 로그만 수정

- 장점: 변경량이 작고 빠르다.
- 단점: 사용자는 여전히 화면에서 `0개`의 원인을 알 수 없고 검색어 품질 문제도 남는다.

#### 대안 B: 검색 계획 + 단계별 진단 + 접근 상태 수정

- 장점: 품질 기준을 유지하면서 검색 recall과 설명 가능성을 함께 개선한다.
- 단점: shared contract, provider adapter, Worker orchestration, UI를 함께 변경해야 한다.

#### 대안 C: AI 기반 검색어 생성과 후보 판정

- 장점: 긴 연구 문장과 의미적 변형을 유연하게 처리할 수 있다.
- 단점: 비용, 비결정성, 모델 의존성이 증가하며 Cloudflare-first·model-agnostic 원칙과 맞지 않는다.

### 4.2 결정

대안 B를 채택한다. 검색 계획은 결정론적 bilingual concept mapping으로 만들고, 기존 assessment hard gate는 그대로 유지한다. AI는 사용하지 않는다.

## 5. 목표 데이터 흐름

```text
DiscoveryProfile + momentum + legacy queries
→ 검색 계획 생성
→ provider별 검색
→ 접근성 검사
→ 관련성 assessment
→ 기존 ID·정규화 제목 dedup
→ lane·provider quota 선택
→ discovery_candidates 저장
→ 실행 진단을 research_jobs.result_json에 저장
→ 발견 화면에서 후보와 실행 요약 표시
```

각 단계는 입력 수, 출력 수, 탈락 사유를 실행 단위로 집계한다. 신규 탈락 후보의 제목이나 초록 전체는 진단 목적으로 별도 저장하지 않는다.

## 6. 검색 계획

### 6.1 저장 문장과 실행 검색어 분리

저장 키워드는 사용자 언어와 provenance를 보존한다. 외부 provider에는 별도 `providerQuery`를 전달한다.

```ts
export type DiscoveryQueryPlanStatus = "READY" | "UNSUPPORTED";

export interface DiscoveryQueryPlanItem {
  sourceQuery: string;
  providerQuery: string | null;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  concepts: string[];
  providers: Array<"openalex" | "arxiv">;
  status: DiscoveryQueryPlanStatus;
  selected: boolean;
  unsupportedReason: "NO_MAPPABLE_CONCEPT" | null;
}
```

`sourceQuery`는 UI와 후보 provenance에 사용하고 `selected = true`인 항목의 `providerQuery`만 외부 요청에 사용한다. 동일한 정규화 `sourceQuery`가 여러 source에 있으면 `오리지널 저장 키워드 → 카운터 저장 키워드 → 홈페이지 → momentum → legacy` 순서에서 첫 항목만 계획에 남긴다. 오리지널과 카운터에 같은 문장이 모두 저장된 경우에는 두 lane의 의도를 보존하기 위해 lane별 한 건씩 허용한다.

### 6.2 context anchor

검색 계획은 오리지널 프로필, 홈페이지 기반 momentum, 기존 저장 검색어에서 현재 연구의 context anchor를 먼저 만든다. 후보 source의 우선순위는 `오리지널 저장 키워드 → 홈페이지 키워드 → 최근 30일 momentum → legacy query`다. 각 source 안에서는 저장·집계 순서를 유지하고, 아래 concept priority에서 처음 발견되는 값을 기본 anchor로 사용한다.

초기 concept group은 다음 범위로 제한한다.

- 사진·이미지·시각문화: `photography`, `image`, `visual culture`, `visuality`
- 기술·알고리즘: `AI`, `algorithm`, `machine vision`, `computer vision`
- 네트워크·데이터: `network culture`, `platform`, `data epistemology`
- 물질성·제작: `materiality`, `tactility`, `print`, `labor`
- 재현·저자성: `representation`, `authorship`, `copyright`, `provenance`
- 증언·기억·맥락: `testimony`, `memory`, `archive`, `context`
- 수용·사용·현장: `reception`, `use`, `field practice`, `site-specific`
- 방법론·검증: `methodology`, `comparison`, `technical variables`, `control`

context anchor concept priority는 `PHOTOGRAPHY → VISUAL_CULTURE → IMAGE → MATERIALITY → NETWORK_DATA → AI_VISUAL`이다. 같은 우선순위에서는 먼저 저장된 source가 이긴다. 기본 anchor 하나로 mapping할 수 없는 세부 modifier는 각 검색 문장에서 별도로 추출한다.

하나의 provider query에는 연구 anchor 1개와 modifier 최대 2개만 사용한다. 모든 저장 단어를 하나의 긴 검색어에 넣지 않는다.

### 6.3 오리지널 검색어

오리지널 검색어는 자신의 concept mapping을 우선 사용한다. mapping 가능한 concept가 없지만 80자 이하의 영어 검색어라면 정규화한 원문을 사용할 수 있다. mapping 불가능한 한국어·혼합 문장은 `UNSUPPORTED`로 기록하고 provider에 보내지 않는다.

예시:

| 저장 문장 | provider 검색어 |
|---|---|
| `AI/알고리즘` | `AI algorithm visual culture` |
| `네트워크-이미지` | `network culture image theory` |
| `데이터` | `data epistemology photography` |
| `사진의 재현` | `photography representation authorship` |

### 6.4 카운터 검색어

카운터 검색어는 단독 검색하지 않는다. 카운터 문장에서 modifier를 추출하고 오리지널 context anchor와 결합한다. 이 방식은 반대 관점의 차이를 유지하면서 후보가 현재 연구와 무관한 영역으로 빠지는 것을 막는다.

예시:

| 저장 문장 | provider 검색어 예시 |
|---|---|
| `기술 변수의 효과가 해석적으로 무의미하거나 불안정함을 블라인드 비교로 검증하기` | `visual culture comparison technical variables` |
| `기술 조건의 엄격한 통제와 현장 선택의 우선성` | `photography field practice technical control` |
| `느린 재방문과 제한된 맥락 안의 사진적 증언` | `photography testimony context` |
| `수용·사용·증언의 사건을 이미지 의미의 주된 설명 단위로 삼기` | `visual culture reception testimony` |

오리지널 context anchor를 만들 수 없고 카운터 문장 자체에도 시각 연구 concept가 없으면 해당 검색어는 `UNSUPPORTED`로 기록한다.

### 6.5 provider 선택

- OpenAlex: `READY`이면서 `selected = true`인 검색 계획을 사용한다.
- arXiv: `READY`이면서 `selected = true`이고 변환된 concept에 `IMAGE`, `PHOTOGRAPHY`, `AI_VISUAL`, `MACHINE_VISION` 중 하나가 있을 때만 사용한다.
- RSS: 사용자 검색어와 독립적으로 저장된 공개 feed를 수집하며 `ORIGINAL/FEED` provenance를 유지한다.

검색 계획은 각 레이어의 저장 후보 전체를 먼저 mapping한 뒤, 기존 source 우선순위에서 `READY`인 항목을 탐색 강도의 query limit만큼 `selected = true`로 표시한다. `UNSUPPORTED` 항목은 query limit을 소비하지 않으므로 뒤의 `READY` 항목이 빈 실행 슬롯을 채운다. fetch limit은 기존 강도 규칙을 유지한다.

`plannedQueries`는 mapping을 시도한 전체 항목, `readyQueries`는 변환 가능한 전체 항목, `executedQueries`는 `selected = true`인 실제 외부 검색어를 뜻한다. 기존 `queries` 결과에는 실제 실행한 source query만 넣는다.

## 7. Provider 결과 계약

provider adapter는 빈 배열 대신 상태와 결과를 함께 반환한다.

```ts
export type DiscoveryProviderOutcomeStatus =
  | "OK"
  | "TIMEOUT"
  | "HTTP_ERROR"
  | "PARSE_ERROR";

export interface DiscoveryProviderResult<T> {
  status: DiscoveryProviderOutcomeStatus;
  items: T[];
  errorCode: string | null;
  elapsedMs: number;
}
```

규칙:

- 정상 응답 0건은 `OK + items: []`다.
- timeout은 `TIMEOUT`이며 전체 실행을 즉시 중단하지 않는다.
- HTTP status 전체나 응답 본문은 job 결과에 저장하지 않는다.
- `errorCode`는 `openalex_http_429`, `arxiv_timeout`처럼 공급자와 유형을 식별하는 제한된 값만 허용한다.
- 개별 요청의 error message, URL query parameter, 응답 본문은 사용자 UI에 노출하지 않는다.

## 8. 실행 진단 계약

실행 진단은 신규 D1 테이블을 만들지 않고 `research_jobs.result_json`에 저장한다.

```ts
export interface DiscoveryProviderStats {
  requests: number;
  succeededRequests: number;
  failedRequests: number;
  received: number;
  missingAccess: number;
  rejected: number;
  duplicate: number;
  quotaExcluded: number;
  selected: number;
  errorCodes: string[];
}

export interface DiscoveryRunDiagnostics {
  plannedQueries: number;
  readyQueries: number;
  executedQueries: number;
  unsupportedQueries: number;
  providers: Record<"openalex" | "arxiv" | "rss", DiscoveryProviderStats>;
  rejectedByReason: Partial<Record<DiscoveryDecisionReason, number>>;
  existingReclassified: number;
  incomplete: boolean;
}

export interface DiscoveryRunResult {
  collected: number;
  keptExisting: number;
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
}
```

`queries`는 기존 소비자 호환을 위해 원래 검색어 목록을 유지한다. 상세 변환은 `diagnostics` 내부의 집계로만 제공하고, 첫 구현에서는 전체 query plan을 job 결과에 중복 저장하지 않는다. job input의 profile과 후보의 `query_used`가 provenance 원본이다.

### 8.1 후보 종료 사유 집계 규칙

각 후보는 하나의 종료 지점에서만 집계한다.

1. provider 응답 항목 수를 `received`에 더한다.
2. OA/PDF 증거가 없거나 접근 상태가 허용되지 않으면 `missingAccess`와 해당 `rejectedByReason`에 더하고 종료한다.
3. assessment가 주제·품질 기준에서 탈락하면 `rejected`와 `rejectedByReason[reason]`에 더하고 종료한다.
4. 기존 external ID 또는 제목과 중복이면 `duplicate`에 더하고 종료한다.
5. provider 또는 lane quota를 통과하지 못하면 `quotaExcluded`에 더하고 종료한다.
6. 최종 선택을 통과하면 `selected`에 더한다.

provider 또는 lane quota 때문에 선택되지 않은 통과 후보는 `duplicate`로 합치지 않고 `quotaExcluded`에 기록한다. `errorCodes`는 provider별 unique code 최대 5개만 저장한다.

실행 종료 시 provider별로 `received = missingAccess + rejected + duplicate + quotaExcluded + selected` 불변식을 만족해야 한다. 기존 후보 재평가 수는 이 합계에 포함하지 않고 `existingReclassified`로만 기록한다.

## 9. 기존 후보 재평가

기존 후보는 다음 우선순위로 접근 상태를 결정한다.

1. 저장된 `access_status`가 `PDF` 또는 `FREE_FULLTEXT`이면 해당 provider가 수집 시 제공한 접근 증거로 유지한다.
2. 저장 상태가 없거나 `UNKNOWN`이면 URL 휴리스틱으로 보완한다.
3. `PAYWALLED` 또는 `INSTITUTION`은 자동으로 무료 상태로 승격하지 않는다.

OpenAlex의 `open_access.oa_url`을 근거로 저장된 `FREE_FULLTEXT`는 다음 실행에서 URL 도메인만으로 `UNKNOWN`으로 강등하지 않는다. 이 결정은 현재 접근 가능성을 실시간 보증한다는 뜻이 아니라, 수집 당시 provider가 제공한 OA evidence를 보존한다는 뜻이다.

기존 후보가 새 relevance hard gate 또는 중복 규칙으로 `IGNORED`가 되면 `existingReclassified`를 증가시킨다. 사용자가 이미 `KEPT`, `WATCHED`, `IGNORED`로 판단한 행은 기존처럼 자동 변경하지 않는다.

## 10. 작업 성공·실패 의미

### 성공

하나 이상의 provider 요청이 `OK`이면 후보가 0개여도 Discovery job은 `SUCCEEDED`다. 이때 품질 탈락, 접근성 탈락, 중복 수를 UI에 표시한다.

### 부분 성공

하나 이상의 provider 요청은 `OK`이고 하나 이상은 실패하면 job은 `SUCCEEDED`를 유지하고 `diagnostics.incomplete = true`로 기록한다. 작업센터와 발견 화면은 `일부 출처 확인 실패`를 표시한다.

### 실패

실행된 provider 요청이 모두 실패하면 job을 `FAILED`와 `discovery_providers_unavailable`로 종료한다. 정상 응답 0건과 provider 전체 장애를 구분한다.

### 설정 확인 필요

프로필은 비어 있지 않지만 모든 검색 계획이 `UNSUPPORTED`이고 활성 RSS도 없으면 job을 `BLOCKED`와 `discovery_queries_unusable`로 종료한다. UI는 키워드를 짧은 개념어로 수정하도록 안내한다.

## 11. 발견 화면 UX

### 11.1 배치

실행 요약은 발견 방향 패널 아래, 후보 상태·레이어 필터와 후보 목록 사이에 둔다. 최근 Discovery job의 결과만 표시한다.

- 후보가 1개 이상이면 한 줄 요약을 기본으로 표시하고 상세는 접는다.
- 후보가 0개면 진단 상세를 자동으로 펼친다.
- `incomplete = true`이면 결과 수와 별개로 부분 실패 안내를 표시한다.

### 11.2 요약 예시

```text
새 후보 0개
OpenAlex 20건 · arXiv 8건 · RSS 24건을 확인했습니다.
연구축 표현 부족 31 · 접근 확인 불가 12 · 공학 중심 6 · 중복 3
```

### 11.3 사용자 문구

내부 reason은 다음 사용자 문구로 표시한다.

| 내부 reason | 사용자 문구 |
|---|---|
| `NO_RESEARCH_ANCHOR` | 연구축 표현 부족 |
| `ENGINEERING_ONLY` | 공학 중심 자료 |
| `LOW_SCORE` | 관련도 기준 미달 |
| `PAYWALLED` | 유료 접근 |
| `ACCESS_UNKNOWN` | 접근 확인 불가 |
| `BLOCKED_DOMAIN` | 연구 범위 밖 |

### 11.4 다음 행동

가장 큰 종료 사유에 따라 하나의 행동만 우선 제시한다. 대표 사유는 `provider 전체 실패 → unsupported query → 접근성 탈락 → 품질 hard gate 탈락 → 중복 → quota 제외 → 정상 0건` 우선순위로 정한다. 같은 범주에서는 건수가 큰 항목을 사용하고 동률이면 이 순서를 유지한다.

- provider 응답 자체가 없음: `잠시 후 다시 찾기`
- `UNSUPPORTED` 검색어가 많음: `검색 설정에서 짧은 개념어로 수정`
- 접근성 탈락이 가장 많음: `직접 읽기 출처 확인`
- 품질 hard gate 탈락이 가장 많음: 탈락 기준 요약 표시. 기준 완화 버튼은 제공하지 않음
- 중복이 가장 많음: `보관됨·관찰 중 후보 보기`

실행 진단은 설정을 자동 변경하지 않는다.

## 12. 컴포넌트와 파일 경계

### Shared

- `shared/src/discovery.ts`: 기존 profile, assessment, access, candidate 선택 계약 유지
- 신규 `shared/src/discoveryRun.ts`: query plan, provider result, diagnostics, run result 타입과 사용자 reason label에 필요한 순수 매핑
- `shared/src/index.ts`: 신규 계약 export

`shared/src/discovery.ts`가 이미 후보 판정과 profile 책임을 함께 갖고 있으므로 실행 진단 계약을 같은 파일에 더하지 않는다.

### Worker

- 신규 `worker/src/discovery/queryPlan.ts`: context anchor 추출과 provider query 계획
- 신규 `worker/src/discovery/diagnostics.ts`: 실행 단위 카운터 생성·누적·종료 상태 판정
- `worker/src/lib/openalex.ts`: typed provider result와 OA evidence 반환
- `worker/src/lib/arxiv.ts`: typed provider result와 오류 구분
- `worker/src/lib/rss.ts`: typed provider result와 parse 오류 구분
- `worker/src/discovery/run.ts`: 검색 계획과 provider 결과를 orchestration하고 후보 저장
- `worker/src/workflows/researchJob.ts`: diagnostics를 job result로 전달하고 전체 실패·설정 blocked 상태 처리

### Web

- 신규 `web/src/components/discovery/DiscoveryRunSummary.tsx`: 집계 표시와 다음 행동
- `web/src/views/DiscoverView.tsx`: 최근 job diagnostics 연결과 상태 필터 이동

## 13. 테스트 전략

### 13.1 검색 계획 단위 테스트

현재 발견 화면의 오리지널 4개와 카운터 4개를 고정 회귀 fixture로 사용한다.

검증 항목:

1. 모든 저장 문장이 `READY` 또는 `UNSUPPORTED` 중 하나를 가진다.
2. `READY` 계획은 빈 `providerQuery`를 갖지 않는다.
3. 카운터 계획은 오리지널 context anchor와 counter modifier를 함께 가진다.
4. provider query 길이와 concept 수가 상한을 지킨다.
5. arXiv 여부는 변환된 concept로 결정된다.
6. 강도 `10:90`에서 실제 실행은 오리지널 1개, 카운터 최대 4개이고 나머지 `READY` 항목은 `selected = false`다.

### 13.2 provider adapter 테스트

fetch를 stub해 다음을 검증한다.

- HTTP 200 + 0건은 `OK`
- HTTP 429/500은 `HTTP_ERROR`
- AbortError는 `TIMEOUT`
- 유효하지 않은 XML/JSON은 `PARSE_ERROR`
- raw response body가 `errorCode`에 포함되지 않음

### 13.3 후보 파이프라인 테스트

- OA 없음 → `missingAccess`
- `NO_RESEARCH_ANCHOR` → 해당 reason 1회 증가
- external ID 중복 → `duplicate`
- provider quota 탈락 → `quotaExcluded`
- 선택 후보 → `selected`와 `collected`가 일치
- 하나의 항목이 여러 종료 사유에 중복 집계되지 않음

### 13.4 OpenAlex 회귀 테스트

`FREE_FULLTEXT`로 저장된 기존 OpenAlex `CANDIDATE`를 다음 실행에서 재평가해도 URL 도메인 때문에 `UNKNOWN` 또는 `IGNORED`가 되지 않아야 한다.

### 13.5 UI 테스트

- 후보 0개면 상세가 자동으로 열림
- 일부 provider 실패면 `일부 출처 확인 실패` 표시
- dominant reason에 맞는 행동 하나만 표시
- 중복 dominant action이 기존 상태 필터를 변경함
- diagnostics가 없는 과거 job도 기존 `새 후보 N개` 문구로 안전하게 표시

## 14. 배포와 운영 확인

1. 타입체크, 전체 Vitest, production build, Wrangler dry-run을 통과한다.
2. 운영 배포 후 현재 화면의 `10:90` 프로필로 Discovery를 한 번 실행한다.
3. provider별 requests, received, failedRequests의 합이 실행 흐름과 일치하는지 확인한다.
4. 후보 0개일 경우 종료 사유 합계가 received와 설명 가능한 관계인지 확인한다.
5. 동일 프로필로 두 번째 실행해 기존 OpenAlex 후보가 접근 상태 때문에 사라지지 않는지 확인한다.
6. provider 하나를 의도적으로 timeout시키는 테스트 환경에서 부분 성공 안내를 확인한다.

## 15. 비목표

- 관련도 `0.65` 완화
- 후보 최소 개수 보장
- hard gate를 우회하는 fallback 후보
- LLM 기반 검색어 생성 또는 후보 판정
- 신규 외부 검색 SaaS
- 탈락 후보 전체를 저장하는 새 D1 테이블
- Admin 진단 대시보드
- provider별 사용자가 직접 조절하는 세부 설정
- 자동으로 사용자의 발견 프로필을 수정하는 기능

## 16. 검증 기준

1. `새 후보 0개` 결과가 provider 정상 0건, provider 실패, 접근성 탈락, 품질 탈락, 중복 중 어느 경로인지 화면에서 구분된다.
2. 현재 화면의 카운터 문장이 원문 그대로 provider에 전달되지 않는다.
3. 카운터 provider query는 현재 오리지널 연구축과 counter modifier를 함께 포함한다.
4. arXiv 실행 여부는 변환 후 concept를 기준으로 한다.
5. 일부 provider 실패가 정상적인 빈 결과로 기록되지 않는다.
6. 모든 provider 요청 실패는 job 실패로, 일부 실패는 부분 성공으로 표시된다.
7. 기존 OpenAlex 무료 후보가 다음 실행의 URL 휴리스틱 때문에 `IGNORED`로 바뀌지 않는다.
8. 관련도, 접근성, 공학 중심 차단, lane quota, provider quota는 기존 정책을 유지한다.
9. 신규 DB migration과 신규 유료 AI 호출이 없다.
10. diagnostics가 없는 과거 job과의 UI 호환성을 유지한다.
