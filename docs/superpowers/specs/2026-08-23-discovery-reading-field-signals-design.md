# 발견 읽을거리·현장 신호 분리 설계

작성일: 2026-08-23

## 1. 목적

발견 탭을 다음 두 가지 정보 흐름으로 분리한다.

1. `읽을거리`: 사용자가 실제로 원문을 읽고 Keep/Watch/Ignore를 결정할 논문·비평·인터뷰
2. `현장 신호`: 전시·학회·공모·지원·레지던시·워크숍처럼 연구 환경의 움직임을 알려 주는 시의성 정보

두 흐름은 같은 연구 방향과 출처 레지스트리를 사용하지만 후보 자격, 저장 상태, 수량 상한, 화면 표현은 서로 분리한다. 핵심 목표는 출처를 늘리면서도 `수신했지만 후보 0건`의 원인을 설명 가능하게 유지하고, 뉴스·행사 정보가 읽을거리 후보를 밀어내지 않게 하는 것이다.

## 2. 기존 설계와의 관계

이 설계는 다음 결정 위에 추가된다.

- `docs/spec-v0.1.txt`: Discovery 후보는 바로 Reservoir가 되지 않고 인간이 Keep/Watch/Ignore를 결정한다.
- `docs/SPEC.md` D6: 공개 RSS/Atom 또는 공식 API가 확인된 경로만 자동 수집한다.
- `docs/DEV_PLAN.md` Task 5.1~5.3: OpenAlex·arXiv·큐레이션 피드, 무료 원문/PDF, 강한 자동 수집 상한을 유지한다.
- `docs/PROJECT_CONTEXT.md`: 관련도 `0.65`, 무료 원문/PDF, 공학 중심 차단, provenance와 진단을 유지한다.
- `docs/superpowers/specs/2026-08-23-discovery-observability-query-planning-design.md`: 검색 계획과 provider 진단을 유지한다.

이 설계는 다음 정책을 바꾸지 않는다.

1. 읽을거리 후보 관련도 기준은 `0.65`다.
2. 읽을거리 후보는 `PDF` 또는 검증된 `FREE_FULLTEXT`여야 한다.
3. 읽을거리 후보는 회당 최대 8개다.
4. 자동 발견 결과는 사용자가 보관하기 전 Reservoir 핵심 자료로 승격하지 않는다.
5. 모델명 하드코딩, 신규 외부 검색 SaaS, 검색 결과 페이지 무단 크롤링을 추가하지 않는다.
6. 사용자에게 새 저수준 설정을 노출하지 않는다.

## 3. 조사에서 확인한 문제

### 3.1 출처 URL을 추가해도 무료 HTML이 탈락한다

현재 RSS 후보는 `classifyDiscoveryAccess("rss", item.url)`로 접근 상태를 판정한다. Hyperallergic만 `FREE_FULLTEXT`로 명시되어 있고 Aperture와 새로 조사한 Unthinking Photography는 `UNKNOWN`이 된다. 따라서 피드가 정상 수신되어도 `ACCESS_UNKNOWN`으로 탈락한다.

접근 정책은 URL 문자열 추측이 아니라 검증된 출처 레지스트리에서 공급해야 한다.

### 3.2 RSS 전체 quota가 2건이다

현재 읽을거리 선택은 provider별 `OpenAlex 4 / arXiv 2 / RSS 2` quota를 사용한다. RSS 출처를 여러 개 추가해도 전체에서 2건만 선택되며, 어느 출처가 계속 배제되는지 알기 어렵다.

읽을거리의 총 8건 상한은 유지하되 RSS 내부에서 같은 출처가 2건을 모두 차지하지 않도록 출처 단위 균형을 적용한다.

### 3.3 행사·학회 소식에는 원문 접근성 규칙이 맞지 않는다

현장 신호의 핵심 가치는 무료 전문 여부가 아니라 출처, 행사 유형, 게시일, 행사일, 마감일, 현재 연구 방향과의 관련성이다. 이를 읽을거리와 같은 테이블과 점수로 평가하면 정상적인 CFP나 전시 소식이 `ACCESS_UNKNOWN`으로 탈락하거나 읽을거리 quota를 소비한다.

## 4. 검토한 구조

### 대안 A: 별도 `discovery_field_signals` 테이블

- 읽을거리와 현장 신호의 상태·점수·보존 규칙이 명확하다.
- 기존 `discovery_candidates`와 Keep→Reservoir 흐름을 거의 건드리지 않는다.
- 화면과 API가 두 갈래가 되지만 역할이 분명하다.

### 대안 B: `discovery_candidates`에 `content_kind` 추가

- 테이블 수가 늘지 않는다.
- 접근성, lane, Reservoir 승격, 상태 이름, quota가 하나의 쿼리에 섞인다.
- 기존 읽을거리 회귀 위험이 크다.

### 대안 C: 독립 현장 신호 서비스

- 향후 캘린더·알림 확장에 유리하다.
- 현재 개인용 V0/V1 규모에는 API·cron·운영 복잡도가 과하다.

### 결정

대안 A를 채택한다. RSS 파서와 출처 레지스트리는 공유하고, 정규화 이후의 assessment·quota·persistence·UI를 분리한다.

## 5. 출처 레지스트리

`DiscoverySourcePreset`은 수집 방식뿐 아니라 목적과 자동 수집 여부, 접근 정책을 표현한다.

```ts
export type DiscoveryContentTarget = "READING" | "FIELD_SIGNAL";
export type DiscoverySourceAccessPolicy =
  | "FREE_FULLTEXT"
  | "PAYWALLED"
  | "INSTITUTION"
  | "UNKNOWN";

export interface DiscoverySourcePreset {
  id: string;
  name: string;
  category: "ARTS" | "ACADEMIC" | "EDITORIAL";
  url: string;
  feedUrl: string | null;
  collection: "RSS" | "API" | "SEARCH";
  target: DiscoveryContentTarget;
  autoCollect: boolean;
  accessPolicy: DiscoverySourceAccessPolicy;
  topicAnchors: string[];
  description: string;
}
```

`collection = RSS`는 피드 존재 여부이고 `autoCollect`는 기본 실행 포함 여부다. 두 값을 분리해 Artforum·ARTnews처럼 피드는 살아 있지만 읽을거리 무료 전문 기준을 통과하지 않는 출처를 정확히 표시한다.

### 5.1 1차 자동 읽을거리

| 출처 | 공식 채널 | 접근 정책 |
|---|---|---|
| Unthinking Photography | `https://unthinking.photography/feed` | `FREE_FULLTEXT` |
| Aperture | `https://aperture.org/feed/` | `FREE_FULLTEXT` |
| Hyperallergic | `https://hyperallergic.com/rss/` | `FREE_FULLTEXT` |

Artforum과 ARTnews는 활성 RSS를 출처 디렉터리에 유지하지만 `PAYWALLED`, `autoCollect = false`로 둔다. 사용자가 직접 여는 검색 출처로는 유효하지만 무료 읽을거리 자동 후보로 가장하지 않는다.

### 5.2 1차 자동 현장 신호

| 출처 | 공식 채널 | 중심 역할 |
|---|---|---|
| CAA News | `https://www.collegeart.org/news/feed/` | 학회·CFP·지원·시각예술 전문 소식 |
| Association for Art History | `https://forarthistory.org.uk/feed/` | 미술사 학회·행사·공모 |
| International Center of Photography | `https://www.icp.org/rss.xml` | 사진 전시·교육·기관 프로그램 |

### 5.3 디렉터리 전용 출처

- e-flux Journal·Announcements: 기존 FeedBurner 피드가 오래전에 멈췄으므로 `SEARCH`, `autoCollect = false`
- MoMA Magazine, Fotomuseum Winterthur, Foam, 1000 Words, Getty: 안정적인 공식 피드를 확인하거나 Worker 접근이 가능해질 때까지 `SEARCH`
- RISS, KCI, Scopus, Web of Science, Semantic Scholar, CORE, DOAJ: 공식 키·이용 조건을 충족한 별도 provider 계획 전까지 `API`, `autoCollect = false`
- Google Scholar: 공식 자동 수집 API가 없으므로 `SEARCH`

페이지 HTML selector 기반 수집과 RSSHub 같은 외부 중계 서비스는 이 설계에 포함하지 않는다.

### 5.4 기존 사용자 피드 설정 전환

검증된 기본 피드는 더 이상 `discovery_feeds_v1` KV의 fallback 값으로 저장하거나 읽지 않는다. 실행할 때마다 출처 레지스트리의 `autoCollect = true`, `target = READING` 피드를 기본 집합으로 만들고, KV에는 사용자가 직접 추가한 커스텀 URL만 최대 6개 보존한다.

기존 KV에 Artforum·ARTnews·Aperture·Hyperallergic 같은 과거 기본값이 남아 있으면 레지스트리 URL과 legacy alias를 기준으로 커스텀 목록에서 제거한다. 그 뒤 새 기본값인 Unthinking Photography·Aperture·Hyperallergic를 항상 합친다. 이 전환은 다음 두 문제를 막는다.

1. 과거 저장값이 새 기본 피드 구성을 영구적으로 덮어쓰는 문제
2. `autoCollect = false`로 바꾼 Artforum·ARTnews가 계속 네트워크 요청을 소비하는 문제

레지스트리에 없는 커스텀 피드는 계속 파싱할 수 있지만 접근 정책은 `UNKNOWN`이다. 개별 항목이 PDF URL인 경우를 제외하면 무료 전문 후보로 자동 승격하지 않는다.

## 6. 읽을거리 접근 정책

`classifyDiscoveryAccess`는 선택적으로 출처 정책을 받는다.

```ts
classifyDiscoveryAccess(
  provider: string | null | undefined,
  href: string | null | undefined,
  sourcePolicy?: DiscoverySourceAccessPolicy,
): DiscoveryAccessStatus
```

판정 우선순위는 다음과 같다.

1. `arXiv` 또는 PDF URL → `PDF`
2. 레지스트리에서 검증한 `FREE_FULLTEXT` → `FREE_FULLTEXT`
3. 레지스트리의 `PAYWALLED` → `PAYWALLED`
4. 레지스트리의 `INSTITUTION` → `INSTITUTION`
5. 기존 제한적 URL 휴리스틱
6. 그 외 → `UNKNOWN`

사용자가 직접 추가한 커스텀 피드는 레지스트리에 없으므로 자동으로 무료 전문으로 승격하지 않는다. 수신과 파싱은 하되 접근 상태가 확인되지 않으면 기존 정책대로 읽을거리 후보에서 제외한다.

읽을거리 RSS quota 2건은 유지한다. 단, 최종 선택 시 `sourceId`별 1차 1건씩을 먼저 채우고 남은 자리를 점수순으로 보충한다.

## 7. 현장 신호 데이터 모델

```sql
CREATE TABLE discovery_field_signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  signal_type TEXT NOT NULL,
  published_at TEXT,
  event_at TEXT,
  deadline_at TEXT,
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  relevance_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`source_id`는 정적 출처 레지스트리의 ID를 가리킨다. 외부 DB foreign key는 만들지 않는다. `external_url`은 전역 unique이며 동일 공지가 다음 RSS 실행에서 다시 삽입되지 않게 한다.

상태는 다음 세 가지다.

- `NEW`: 아직 판단하지 않은 신호
- `SAVED`: 사용자가 남겨 둔 신호
- `DISMISSED`: 추천에서는 숨기지만 삭제하지 않은 신호

현장 신호를 저장해도 즉시 Reservoir source를 만들지 않는다. 이후 사용자가 실제 자료나 기록을 Inbox로 가져올 때 기존 ingestion/provenance 흐름을 사용한다.

## 8. 현장 신호 분류와 관련성

유형은 결정론적 용어 규칙으로 분류한다.

```ts
export type DiscoveryFieldSignalType =
  | "CONFERENCE"
  | "CALL_FOR_PAPERS"
  | "EXHIBITION"
  | "GRANT"
  | "RESIDENCY"
  | "WORKSHOP"
  | "INSTITUTION_NEWS"
  | "OTHER";
```

AI 호출은 추가하지 않는다. 제목·요약에서 `call for papers`, `CFP`, `conference`, `symposium`, `exhibition`, `grant`, `fellowship`, `residency`, `workshop` 등의 용어를 매칭한다.

관련성은 다음 요소로 계산한다.

- 출처의 `topicAnchors`
- 오리지널·카운터 프로필의 저장 키워드와 provider용 concept token
- 제목 매칭
- 요약 매칭
- 유형이 `OTHER`가 아닌지
- 게시일이 최근 365일 이내인지

기본 threshold는 `0.55`다. `OTHER`이면서 프로필 명시 매칭이 없는 일반 기관 뉴스는 제외한다. 기준은 내부 정책이며 사용자 설정으로 노출하지 않는다.

게시일이 365일보다 오래된 항목은 `STALE`로 제외한다. 명시된 마감일이 오늘보다 이전이거나, 마감일 없이 행사일만 있고 그 행사일이 오늘보다 이전이면 `EXPIRED`로 제외한다. 날짜가 없으면 최신 feed 상위 항목이라는 사실만 사용하고 감점하며, 날짜를 임의 생성하지 않는다. 행사일·마감일은 명시적인 ISO 날짜 또는 영문 월 이름 패턴이 있을 때만 저장한다.

출처에 `topicAnchors`가 존재한다는 사실만으로 관련성을 부여하지 않는다. 정규화된 제목·요약에서 실제 anchor 용어가 매칭될 때만 출처 문맥 점수를 부여한다.

## 9. 수집 상한과 중복

현장 신호는 읽을거리 quota와 별도로 회당 최대 12건을 저장한다.

- 출처당 최대 4건
- `external_url` 중복 제거
- 정규화 제목 + 날짜 중복 제거
- 점수 내림차순, 명시된 행사·마감일이 가까운 순, 게시일 최신 순

적합한 신호가 부족하면 빈 슬롯을 유지한다. 수량을 채우기 위해 관련성 기준을 완화하지 않는다.

## 10. 실행과 진단

사용자의 `지금 새로 찾기`와 기존 주간 Discovery cron은 읽을거리와 현장 신호를 함께 실행한다.

```text
DISCOVERY_RUN
├─ collectDiscoveryCandidates → discovery_candidates
└─ collectDiscoveryFieldSignals → discovery_field_signals
```

두 수집기는 실패를 독립적으로 기록한다. 읽을거리 수집 일부가 실패해도 현장 신호 결과를 폐기하지 않고, 반대도 동일하다. 양쪽 모두 실행 불가능할 때만 전체 job을 실패시킨다.

현장 신호 진단은 source ID별로 다음을 기록한다.

- 요청·성공·실패
- 수신
- 관련성 탈락
- 오래된 항목
- 마감·행사 종료 항목
- 중복
- quota 제외
- 최종 저장
- 제한된 error code

개별 응답 본문과 검색 파라미터는 `research_jobs.result_json`에 저장하지 않는다.

## 11. API

기존 `/api/discover/candidates`는 읽을거리 전용으로 유지한다.

신규 API:

- `GET /api/discover/signals?status=NEW&type=CONFERENCE`
- `POST /api/discover/signals/:id/save`
- `POST /api/discover/signals/:id/dismiss`
- `POST /api/discover/signals/:id/restore`

목록은 기본 50건으로 제한하고 `status`, `type`만 허용 목록으로 검증한다. 저장·제외·복구는 테이블 상태만 변경하며 외부 요청이나 Reservoir 승격을 수행하지 않는다.

## 12. 발견 화면

발견 방향 패널 아래에 두 개의 상위 전환을 둔다.

- `읽을거리`
- `현장 신호`

읽을거리 화면은 기존 SplitWorkspace와 판단 바텀시트를 유지한다.

현장 신호 화면은 카드 목록으로 표시한다.

- 유형 badge
- 원문 제목과 공식 링크
- 출처
- 게시일
- 확인 가능한 경우 행사일·마감일
- 현재 연구축과 연결된 matched terms
- 짧은 RSS summary
- `저장`, `제외`, 제외 목록에서 `복구`

상태 필터는 `새 신호 / 저장됨 / 제외됨`, 유형 필터는 `전체 / 학회 / CFP / 전시 / 지원 / 레지던시 / 워크숍 / 기관 소식`으로 제공한다. 새로운 사용자 설정은 추가하지 않는다.

## 13. 빈 상태와 오류

- 읽을거리 0건, 현장 신호 N건: job은 성공이며 두 수치를 함께 표시한다.
- 읽을거리 N건, 현장 신호 0건: job은 성공이며 현장 신호의 주요 탈락 사유를 표시한다.
- 한쪽 provider 전체 실패: `일부 출처 확인 실패`
- 양쪽 모두 provider 전체 실패: job `FAILED`
- 적합한 항목이 없음: 오류가 아니라 정상 빈 상태

## 14. 제외 범위

이번 설계에는 다음을 포함하지 않는다.

- e-flux HTML 크롤러
- Google Scholar 결과 크롤러
- RISS·KCI·Scopus·Web of Science API adapter와 인증키 설정 UI
- 이메일 뉴스레터 수집
- 미술관 작품·소장품 API와 작품 카드
- 캘린더 동기화, 푸시 알림, 마감 알림
- 자동 Reservoir 승격
- AI 기반 행사 유형·날짜 추출

이 항목들은 현재 기능의 실제 사용 데이터가 쌓인 뒤 별도 설계로 검토한다.

## 15. 완료 기준

1. Unthinking Photography·Aperture·Hyperallergic의 관련 무료 HTML 항목이 `ACCESS_UNKNOWN`이 아니라 출처 정책으로 평가된다.
2. Artforum·ARTnews가 무료 읽을거리 자동 후보로 잘못 들어오지 않는다.
3. CAA·Association for Art History·ICP의 공식 피드가 현장 신호로만 저장된다.
4. 현장 신호는 읽을거리의 최대 8건과 RSS 2건 quota를 소비하지 않는다.
5. 현장 신호 회당 최대 12건, 출처당 최대 4건, 중복 보존 정책이 동작한다.
6. 사용자가 읽을거리와 현장 신호를 한 번의 발견 실행 후 별도 화면에서 확인한다.
7. 수신 0건·관련성 탈락·오래된 항목·마감/행사 종료·중복·출처 실패가 진단에서 구분된다.
8. 비공식 크롤링이나 신규 유료 AI 호출이 없다.
9. 기존 읽을거리 Keep→Reservoir 흐름과 관련도·접근성 기준이 회귀하지 않는다.
