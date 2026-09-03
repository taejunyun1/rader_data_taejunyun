# 최신 Distill 홈페이지 `현재 연구` 발행 설계

- 결정일: 2026-09-03
- 상태: 사용자 방향 승인, 구현 전 설계
- 주 시스템: Research Radar (`radar.taejunyun.com`)
- 소비 시스템: 작가 홈페이지 (`www.taejunyun.com/text`)

## 1. 배경

현재 홈페이지의 `읽을거리 → 방문자 반응 → 큐레이션` 흐름은 좋아요 평균과 쿨타임으로 큐레이션 대상을 결정한다. 이를 작가의 연구 판단을 보여주는 구조로 바꾼다.

Radar의 Distill은 Reservoir 자료를 `키워드`, `생각의 조각`, `질문`, `다음 읽기`, `연구 공백`, `연구 방향`, `작업 방향`, `작은 실험`으로 압축한다. 이 결과는 작가의 공개 글 자체가 아니라 AI가 만든 `SYNTHESIS`이므로 원문 전체를 자동 공개하지 않는다.

홈페이지에는 사용자가 명시적으로 승인한 가장 최근 Distill의 공개 가능 부분만 `현재 연구`로 보여준다. 별도의 연구주제 선택이나 `탐색 중/전개 중` 상태 입력은 요구하지 않는다.

## 2. 목표

1. 최신 Distill 결과에서 한 번의 미리보기와 확인만으로 홈페이지를 갱신한다.
2. 홈페이지의 반응 기반 `큐레이션`을 작가 중심의 `현재 연구`로 대체한다.
3. 공개용 데이터와 Radar의 비공개 Reservoir·원문·분석 이력을 물리적으로 분리한다.
4. 새 Distill이나 발행 실패가 기존 홈페이지 공개본을 임의로 바꾸거나 비우지 않게 한다.
5. 사용자에게 질문·자료·상태를 다시 선택하게 하지 않는다.

## 3. 비목표

- Distill 완료 즉시 자동 공개
- 여러 연구주제의 생성·병합·분기 관리
- 연구주제별 수동 상태 선택
- Critic, Counter, 연구 공백, 모델·비용 정보 공개
- 홈페이지 방문자 좋아요를 이용한 공개 콘텐츠 승격
- 첫 배포에서 기존 좋아요·배치 D1 테이블을 삭제하는 작업
- 최종 작품·논문·사업계획서 입력과 연구 종결 처리
- 홈페이지를 Radar의 비공개 API나 D1에 직접 연결

최종 결과물과 연결해 연구를 종결하는 기능은 이 발행 경로가 안정화된 다음 별도 설계로 다룬다.

## 4. 확정 제품 결정

### 4.1 공개 기준

- 홈페이지가 표시하는 것은 **가장 최근에 성공한 Distill**이 아니라 **가장 최근에 사용자가 발행 승인한 Distill**이다.
- 공개 승인 대상은 전체 세션 목록 중 가장 최신의 **발행 가능 Distill** 한 건으로 제한한다. 발행 가능 여부의 정확한 DB 조건은 7.1절을 따른다.
- 새 Distill이 완료되어도 사용자가 `홈페이지에 반영`을 누르기 전까지 기존 공개본을 유지한다.
- 공개된 결과의 상태는 자동으로 `탐색 중`이다. 상태 선택 UI는 제공하지 않는다.

### 4.2 버튼과 확인

Distill 문서에 다음 상태를 갖는 버튼을 둔다.

| 상황 | 버튼/상태 |
|---|---|
| 최신 발행 가능 Distill, 공개본 없음 | `홈페이지에 반영` |
| 최신 발행 가능 Distill, 이전 공개본과 hash가 다름 | `새 결과로 업데이트` |
| 보고 있는 세션이 현재 공개본임 | `현재 홈페이지에 공개 중 · YYYY.MM.DD` |
| hard-purge된 Distill session | 비활성 `공개 삭제됨 · 새 Distill 필요` |
| 요청 처리 중 | `반영 중…` |
| 현재 공개본이 아닌 과거 세션을 보고 있음 | 비활성 `최신 Distill만 반영 가능` |

버튼을 누르면 쓰기 작업 없이 읽기 전용 미리보기를 연다. 미리보기와 발행은 같은 projection builder를 사용하며, 미리보기의 `content`와 `contentHash`는 실제 발행본과 같아야 한다. 발행 시점에만 `publicationId`, `publishedAt`, `updatedAt`을 채운다. 사용자는 필드를 고르거나 상태를 입력하지 않고 `취소` 또는 `공개 반영`만 선택한다.

버튼 상태는 다음 우선순위로 판정한다.

1. hard-purge된 세션이면 새 Distill 필요 상태를 표시한다.
2. 보고 있는 세션이 현재 공개본이면, 더 최신의 미승인 Distill이 있더라도 `현재 홈페이지에 공개 중`을 표시한다.
3. 보고 있는 세션이 최신 발행 가능 Distill이고 current와 hash가 다르면 `새 결과로 업데이트`를 표시한다.
4. 나머지 과거 세션에는 비활성 상태를 표시한다.

### 4.3 홈페이지 정보 구조

`/text`의 탭은 다음 역할을 가진다.

- `받은 글`: 기존 유지
- `쓴 글`: 기존 유지
- `읽을거리`: 외부 자료와 원문 링크, 기존 유지
- `현재 연구`: 기존 반응 기반 `큐레이션`을 대체

`현재 연구`에서는 좋아요, 누적 반응, 평균, 큐레이션 수, 쿨타임, 반응 기반 정렬을 표시하지 않는다. 읽을거리의 원문 클릭 집계는 비공개 운영 지표로 유지할 수 있다.

공개본이 없거나 철회된 경우에도 탭은 유지하고 `현재 공개된 연구가 없습니다.`라는 빈 상태를 보여준다. Radar나 private 데이터의 존재 여부는 노출하지 않는다.

## 5. 공개 콘텐츠 계약

### 5.1 포함 항목

공개 projection은 Distill의 배열 순서를 보존하면서 다음 상한을 적용한다.

- `keywords`: 최대 6개
- `displayTitle`: 별도 AI 호출 없이 첫 번째 `questions`, 첫 번째 `researchDirections`, 고정 문구 `현재 연구` 순서로 선택한 대표 제목. 선택한 문장이 200자를 넘으면 표시용 제목만 200자와 말줄임표로 줄이고 원래 배열 항목은 바꾸지 않는다.
- `thoughts`: `thoughts_fragments` 앞에서 최대 3개
- `questions`: 최대 3개
- `researchDirections`: 최대 2개
- `artworkDirections`: 최대 2개
- `researchMaterials`: 실제 Distill 입력에 사용된 자료 중 현재 `sources`에 존재하고 공개 HTTP(S) URL과 서지정보가 있는 자료 최대 5개
- `distilledAt`, `publishedAt`, `updatedAt`

`small_experiment`는 초기 공개 projection에 포함하지 않는다. 이후 필요하면 별도 설계 변경으로 추가한다.

텍스트와 payload의 상한은 다음과 같이 고정한다.

| 필드 | 상한 |
|---|---:|
| display title | 200자 |
| keyword 한 항목 | 80자 |
| thought 한 항목 | 600자 |
| question 한 항목 | 400자 |
| research/artwork direction 한 항목 | 600자 |
| research material title | 300자 |
| research material author | 200자 |
| research material URL | 2,048자 |
| 직렬화한 전체 JSON | 64 KiB |

문자열은 양끝 공백과 제어문자를 정리한다. 파생 필드인 `displayTitle`만 위의 결정적 축약 규칙을 적용하며, 원본에서 복사하는 다른 필드가 상한을 넘으면 자동으로 잘라내지 않고 preview/publish를 `422 public_projection_invalid`로 거절한다. 사용자는 Distill을 다시 실행하거나 원본 자료의 메타데이터를 수정한다.

현재 `sources_used_json`은 `{id, title}`만 저장하므로 projection builder는 배열 순서를 보존한 채 각 ID를 현재 `sources` 테이블과 join해 제목·`authors`·연도·URL을 얻는다. URL은 유효한 `canonical_url`을 우선하고, 없으면 유효한 DOI로 `https://doi.org/{doi}`를 구성하며, 둘 다 없으면 해당 자료를 제외한다. 삭제된 source는 발행 가능 세션 판정에서 배제한다. 자료 항목은 문장별 인용 근거가 아니므로 홈페이지에는 `Distill에 사용된 자료이며 각 문장의 직접 인용 근거를 뜻하지 않습니다.`를 표시한다.

### 5.2 제외 항목

다음 데이터는 projection 생성기의 allowlist에 없으며 발행 bucket으로 복사하지 않는다.

- `input_context_json`, source fragment, 추출·정규화 원문
- `r2_key`, 내부 source/version ID
- raw user signal, 연구 메모, 파라미터
- 미검증 `read_next`와 Reading Queue 항목
- `research_gaps`
- Critic 경고와 Counter 결과
- model, prompt version, token, 비용
- Cloudflare Access identity 또는 CLI 인증 정보

미리보기에는 운영자 전용 `공개되지 않는 검토 메모` 영역을 두고 Critic 경고 본문을 모두 보여주거나 기존 Critic 섹션으로 바로 이동할 수 있게 한다. 경고 본문은 공개 payload에 포함하지 않는다. 경고 존재만으로 발행을 자동 차단하지 않고 최종 판단은 사용자에게 둔다.

### 5.3 JSON schema

```json
{
  "schemaVersion": 1,
  "kind": "CURRENT_RESEARCH",
  "source": "research-radar",
  "publicationId": "opaque-public-id",
  "state": "EXPLORING",
  "distilledAt": "2026-09-03T00:00:00.000Z",
  "publishedAt": "2026-09-03T00:10:00.000Z",
  "updatedAt": "2026-09-03T00:10:00.000Z",
  "contentHash": "sha256",
  "content": {
    "displayTitle": "string",
    "keywords": [],
    "thoughts": [],
    "questions": [],
    "researchDirections": [],
    "artworkDirections": [],
    "researchMaterials": [
      {
        "title": "string",
        "author": null,
        "year": null,
        "url": "https://example.com"
      }
    ]
  }
}
```

공개본은 위 필드를 모두 요구하는 `state: EXPLORING` 변형이고, `researchMaterials[].author`는 `string | null`, `year`는 `integer | null`이다. 철회본은 아래 `state: WITHDRAWN` 변형이다. 두 변형을 섞거나 필수 필드가 빠진 payload는 유효하지 않다.

`publicationId`는 서버가 만드는 공개용 opaque ID이며 내부 `distill_session_id`를 노출하지 않는다. 내부 연결은 D1 발행 원장에서만 유지한다. `distilledAt`은 `distill_sessions.created_at`이다. `contentHash`는 `{ distilledAt, content }`의 object key를 사전순으로 정렬하고 배열 순서·null을 보존한 UTF-8 JSON에 SHA-256을 적용한 lowercase hex다. 발행할 때마다 달라지는 `publicationId`와 발행 시각은 hash 입력에서 제외한다. `publishedAt`은 edition의 첫 공개 승인 시각, `updatedAt`은 이번 공개·재공개 승인 이벤트의 `pending_event_at`이다. 첫 공개에서는 두 값이 같고, 철회 후 재공개에서는 `publishedAt`을 보존한 채 `updatedAt`만 갱신한다. 실패 재시도는 같은 pending 시각과 history key를 재사용한다.

철회 시 current key에는 다음 tombstone만 둔다.

```json
{
  "schemaVersion": 1,
  "kind": "CURRENT_RESEARCH",
  "source": "research-radar",
  "state": "WITHDRAWN",
  "withdrawnPublicationId": "opaque-public-id",
  "withdrawnContentHash": "sha256",
  "withdrawnAt": "2026-09-03T01:00:00.000Z"
}
```

정상 철회 tombstone의 `withdrawnPublicationId`와 `withdrawnContentHash`는 non-null이다. 공개 이력이 전혀 없는 상태에서 source-delete fencing용으로 current key를 처음 만들 때만 두 값을 `null`로 둔 같은 WITHDRAWN 변형을 허용한다. 공개 endpoint는 어느 WITHDRAWN 변형도 본문으로 전달하지 않고 동일한 404로 처리한다.

### 5.4 홈페이지 표시 순서

`현재 연구`는 하나의 research edition으로 다음 순서에 고정한다.

1. `탐색 중` 상태, `displayTitle`, 마지막 공개 승인 시각
2. 키워드
3. 생각의 조각
4. 질문
5. 연구 방향
6. 작업 방향
7. 연구 자료와 위의 직접 인용 아님 안내
8. `Research Radar에서 정리한 현재 연구` provenance 문구

비어 있는 개별 섹션은 숨긴다. `keywords`, `thoughts`, `questions`, `researchDirections`, `artworkDirections`가 모두 비어 있으면 `displayTitle`이나 자료가 있더라도 `422 public_projection_empty`로 발행하지 않는다.

## 6. 아키텍처

### 6.1 경계

공개 전달용 데이터는 기존 `reservoir-originals`나 `reservoir-exports`와 분리한 **비공개 전용 R2 bucket** `radar-publications`에 둔다. bucket에는 `r2.dev` 또는 custom public domain을 연결하지 않는다.

```text
Radar Distill session (private D1)
  → public projection builder
  → preview (no write)
  → user confirmation
  → Radar publication ledger (private D1)
  → radar-publications R2 bucket
  → taejunyun-reading-api Worker fixed-key read endpoint
  → /text > 현재 연구
```

Radar Worker에는 `PUBLICATIONS`, 홈페이지의 기존 `taejunyun-reading-api` Worker(`wrangler.worker.toml`, `workers/reading-stats/src/index.js`)에는 `HOMEPAGE_PUBLICATIONS` 이름으로 같은 `radar-publications` bucket을 binding한다. 전자는 발행 쓰기를 담당하고 후자는 고정 current key의 `get`만 코드로 허용한다. 홈페이지는 Cloudflare Pages 프런트엔드이며 Radar의 private D1·원본 bucket·전체 export bucket에는 접근하지 않는다. 홈페이지에 전달되는 현재 공개 상태의 최종 source of truth는 R2의 fixed current object다. D1 원장은 감사·상태 복구용이다.

### 6.2 R2 object

- 현재 공개본 wrapper: `homepage/current-research.json`
- 발행 이벤트 보존본: `homepage/history/{publicationId}/{eventAt}.json` (`eventAt = pending_event_at = public updatedAt`)
- 비공개/철회 표시: `homepage/current-research.json` wrapper의 `payload`에 5.3절의 tombstone 저장

고정 key의 R2 object는 `{"storageRevision":"random-uuid","payload":{...5.3절 공개 payload...}}` private storage wrapper다. `storageRevision`은 모든 current PUT마다 새로 만들어 동일 payload를 fencing 목적으로 다시 써도 bytes와 ETag가 반드시 달라지게 한다. 홈페이지 Worker는 wrapper와 payload를 모두 검증한 뒤 `payload`만 반환하며 `storageRevision`은 공개하지 않는다. 64 KiB 상한은 공개 payload에 적용한다.

고정 key를 공개 pointer로 사용하되, 발행 시 먼저 불변 history event object를 쓰고 마지막에 current wrapper를 교체한다. history object 쓰기에 실패하면 current object를 건드리지 않는다. 같은 edition을 철회 후 재발행하면 `publicationId`와 최초 `publishedAt`은 유지하되 새 `eventAt/updatedAt` 경로에 새 이벤트를 기록한다. history key는 어느 공개 API에도 노출하거나 경로 파라미터로 받지 않는다.

### 6.3 Radar D1 발행 원장

새 원장은 최소 다음을 기록한다.

```text
id
distill_session_id
status: PUBLISHING | PUBLISHED | SUPERSEDED | WITHDRAWN | FAILED | PURGING | PURGED
payload_json
content_hash
error_code
approved_by_sub
withdrawn_by_sub
pending_event_at
lease_generation
created_at
updated_at
approved_at
first_published_at
last_published_at
superseded_at
withdrawn_at
```

원장의 `id`가 공개 payload의 opaque `publicationId`다.

`(distill_session_id, content_hash)`에 UNIQUE 제약을 두고, 동일 조합은 철회 후 재발행을 포함해 같은 `publicationId`를 재사용한다. 철회된 조합을 다시 발행하면 `WITHDRAWN → PUBLISHING → PUBLISHED`로 전환하고 `first_published_at`은 보존한 채 `last_published_at`과 `updated_at`을 새 시각으로 갱신하며 새 history event object를 만든다. current인 동안의 동일 재요청은 새 history event를 만들지 않는다. 새 발행이 성공하면 새 행을 `PUBLISHED`로 만들고 이전 `PUBLISHED` 행을 `SUPERSEDED`로 전환하는 작업을 한 D1 batch로 처리한다.

재진입 전이는 다음으로 고정한다.

- 모든 status/mutation 시작 시 현재 active generation이 아닌 orphan `PUBLISHING`을 먼저 검사한다. R2 current의 ID/hash가 해당 행과 같으면 `PUBLISHED`, 다르면 `FAILED`로 reconcile한다. 현재 요청이 그 FAILED 행을 다시 발행하면 새 lease owner가 같은 `pending_event_at`과 history key로 재시도한다.
- `FAILED`: 같은 승인 재시도는 `PUBLISHING`으로 돌아가며 기존 `pending_event_at`을 재사용한다.
- `WITHDRAWN` 또는 다시 최신 발행 가능 후보가 된 `SUPERSEDED`: `PUBLISHING`으로 돌아가되 새 `pending_event_at`을 만든다.
- D1의 `PUBLISHED`와 R2 current가 다르면 먼저 실제 current 기준으로 `SUPERSEDED` 또는 `FAILED`로 reconcile한 뒤 전이한다.
- `PURGING` 또는 `PURGED`: 일반 publish로 재진입하지 않으며, 같은 `distill_session_id`의 모든 projection은 `410 publication_purged`다. 새 Distill session만 새 edition으로 발행할 수 있다.

재발행으로 상태 행의 시각과 actor가 갱신되어도 감사 이력을 잃지 않도록 `homepage_publication_events(id, publication_id, action, actor_sub, occurred_at, error_code)`를 append-only로 기록한다. `PUBLISH`, `REPUBLISH`, `WITHDRAW`, `RECONCILE`, `HARD_PURGE`를 구분하며 공개 payload 본문은 이 이벤트 테이블에 중복 저장하지 않는다.

발행·철회·source 영구 삭제를 직렬화하기 위해 D1에 singleton lease를 둔다. atomic acquire에 성공한 한 요청만 최대 60초간 공개 상태와 관련 source를 변경할 수 있고, 다른 요청은 `409 publication_in_progress`를 받는다. 완료 시 lease를 해제하며 만료된 lease는 다음 요청이 회수할 수 있다.

lease는 owner token과 fencing generation을 가지며 15초마다 갱신한다. 모든 mutation은 R2 current를 읽을 때 얻은 ETag를 기억하고 새 `storageRevision`을 넣은 wrapper를 `put(..., { onlyIf })` 조건부 쓰기한다. 기존 object가 있으면 `etagMatches`, 없으면 `If-None-Match: *`를 적용하며 precondition 실패는 `409 publication_state_changed`로 처리한다. 따라서 lease가 만료된 과거 요청은 새 요청이 current를 건드린 뒤 덮어쓸 수 없다. 이 조건부 쓰기 방식은 [Cloudflare R2 Workers API의 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations)를 따른다.

모든 D1 상태 변경, event 기록, heartbeat, FAILED 처리, lease 해제는 `owner_token + generation + expires_at`을 SQL 조건으로 검사한다. 최종 D1 batch의 guard가 0건이면 stale 요청은 원장을 쓰거나 후속 lease를 해제하지 않고, R2 current가 이미 성공한 경우에만 성공과 `ledgerReconcilePending: true`를 반환한다. reconciliation도 새 lease를 획득한 뒤 수행한다.

## 7. API 계약

### 7.1 Radar 내부 API

- `GET /api/distill/sessions/:id/homepage-preview`
  - 최신 발행 가능 세션 여부와 output schema를 검증한다.
  - 공개 `content`, `distilledAt`, `contentHash`, 현재 공개본 대비 변경 여부와 opaque `currentRevision`을 반환한다.
  - Critic 경고는 hash 대상이 아닌 `privateReview` 필드로 분리하며 이 내부 응답 밖으로 전달하지 않는다.
  - 저장소 쓰기는 하지 않는다.
- `POST /api/distill/sessions/:id/homepage-publish`
  - body에는 preview가 반환한 `expectedContentHash`와 `expectedCurrentRevision`만 받는다.
  - 미리보기와 같은 projection을 서버에서 다시 생성한다.
  - 최신 세션 여부를 재검증한 뒤 재생성 hash가 다르면 `409 preview_stale`다. current의 ID/hash가 `(distill_session_id, content_hash)` 원장 행과 모두 같으면 원장을 복구하고 멱등 성공으로 반환하며, 그렇지 않은데 revision이 다르면 `409 publication_state_changed`로 중단하고 새 미리보기를 요구한다.
  - 클라이언트가 보낸 공개 본문을 신뢰하지 않는다.
- `GET /api/distill/homepage-publication`
  - 현재 발행 상태, 발행일, 반영 가능한 최신 세션 존재 여부를 반환한다.
- `POST /api/distill/homepage-publication/withdraw`
  - 확인 dialog가 본 `expectedPublicationId`, `expectedContentHash`, `expectedCurrentRevision`을 body로 받는다.
  - 세 값이 lease 안에서 다시 읽은 current와 모두 일치할 때만 tombstone을 발행하고 원장을 `WITHDRAWN`으로 기록한다. 다르면 `409 withdrawal_stale`로 새 확인을 요구한다.
- `GET /api/session/csrf`
  - Access 인증된 브라우저에 `sub`, 무작위 nonce, 15분 만료를 `CSRF_SECRET`으로 HMAC 서명한 token을 `no-store`로 반환한다.

발행 요청 시점의 권위 있는 최신 발행 가능 세션은 다음 조건으로 조회한다.

- `output_json IS NOT NULL`
- `json_valid(output_json)`
- 파싱한 값이 전체 Distill output schema를 통과
- `liveDistillSessionFilter`를 통과해 사용 source가 현재 모두 존재
- 위 조건의 행을 `created_at DESC, id DESC`로 정렬한 첫 행

선택된 최신 세션의 source 중 `source_deletion_claims`가 하나라도 존재하면 일시적으로 이전 세션으로 건너뛰지 않고 `409 source_delete_in_progress`를 반환한다. 발행 current PUT 직전에도 같은 조건을 다시 확인한다.

모든 Radar API는 기존 Cloudflare Access/CLI 인증 경계를 그대로 통과한다. preview와 status 응답에는 `Cache-Control: no-store`를 적용한다. 브라우저의 publish와 withdraw는 Radar origin의 `Origin`, `Sec-Fetch-Site: same-origin`, `X-CSRF-Token`을 모두 검증한다. token의 HMAC·Access `sub`·만료가 일치해야 한다. 승인 주체의 Access `sub`를 publish의 `approved_by_sub`, 철회의 `withdrawn_by_sub`와 append-only event에 기록한다. 인증된 CLI bearer 경로는 브라우저 CSRF 검사에서 명시적으로 면제하되 secret 원문이 아닌 안정적인 `cli:{key-id}` actor를 기록한다.

### 7.2 홈페이지 공개 API

- `GET /api/research/current`
  - `taejunyun-reading-api` Worker가 `HOMEPAGE_PUBLICATIONS`의 고정 R2 key만 읽고 storage wrapper와 payload schema를 검증한 뒤 payload만 반환한다.
  - R2 ETag, version, custom metadata, `storageRevision`은 응답에 전달하지 않는다.
  - 공개 projection 외 다른 key 선택 파라미터를 받지 않는다.
  - v1은 발행·철회를 즉시 반영하도록 정상본, tombstone, 404 모두 `Cache-Control: no-store`를 사용한다.
  - 공개본이 없거나 tombstone이면 `404 current_research_not_published`를 반환한다.
  - current object가 두 schema 변형 중 어느 것도 통과하지 못하면 `502 current_research_invalid`를 반환하고 본문을 그대로 전달하지 않는다.

Cloudflare Pages 프런트엔드는 기존 `VITE_READING_STATS_API_URL` base URL을 사용하되 `fetchCurrentResearch()`라는 별도 익명 GET 함수를 둔다. 모든 요청에 `visitorId`를 붙이는 기존 `requestReadingStats()`를 재사용하지 않으며, 이 조회는 localStorage visitor ID를 생성하거나 전송하지 않는다. 브라우저는 Radar API에 직접 접근하지 않는다.

내부 preview의 `currentRevision`은 current object의 R2 ETag 또는 `MISSING` 표식을 SHA-256한 opaque 값이다. publish는 실제 ETag를 클라이언트에 신뢰시키지 않고 서버에서 다시 읽어 revision 비교와 조건부 PUT에 사용한다.

## 8. 발행 순서와 일관성

`POST .../homepage-publish`는 다음 순서로 처리한다.

1. singleton lease를 획득한다.
2. 요청 세션이 최신 발행 가능 Distill인지 확인한다.
3. allowlist projection을 생성·검증하고 SHA-256 hash를 계산한다.
4. 재생성 hash와 `expectedContentHash`를 비교하고 다르면 중단한다.
5. `(요청 distill_session_id, candidate hash)` 원장 행을 조회한다. 그 행의 `id`와 hash가 current의 `publicationId`와 `contentHash`에 모두 일치하면 D1 원장 불일치를 먼저 reconcile한 뒤 idempotent 성공을 반환한다. 이 판정은 응답 유실 재시도를 위해 revision 검사보다 먼저 한다. 원장 조회 자체가 불가능하면 identity를 추측하지 않고 `503 publication_ledger_unavailable`을 반환한다. 행을 읽었지만 즉시 상태 복구만 실패한 경우 공개 상태는 성공으로 반환하고 `ledgerReconcilePending: true`를 붙인다.
6. 그 외에는 `expectedCurrentRevision`을 현재 revision과 비교하고 다르면 중단한다.
7. D1 원장을 `PUBLISHING`으로 insert 또는 전환하고 `pending_event_at`을 확정한다. `FAILED`와 orphan `PUBLISHING` 재시도는 기존 pending 시각을 재사용하고, `WITHDRAWN` 또는 `SUPERSEDED` 재발행은 새 시각을 만든다.
8. `pending_event_at`으로 정한 이 발행 이벤트의 versioned history object를 R2에 쓴다. 같은 key에 같은 hash가 있으면 성공으로 간주하고, 다른 hash면 무결성 오류로 중단한다.
9. 사용 source에 deletion claim이 없음을 다시 검증하고, preview 때 관찰한 current ETag 조건으로 fixed current wrapper를 R2에 쓴다.
10. 새 행의 `PUBLISHED`와 이전 행의 `SUPERSEDED` 전환을 한 D1 batch로 정리한다.
11. lease를 해제한다.

8~9단계가 실패하면 이전 current object를 유지하고 유효한 lease를 가진 경우에만 새 원장을 `FAILED`로 기록한다. history/current PUT의 응답이 예외나 timeout으로 불확실하면 해당 key를 다시 읽고 ID/hash를 검증한다. current의 ID/hash가 이번 원장 행과 모두 같으면 성공으로 간주해 10단계로 진행하고, 아니면 실패 또는 precondition conflict로 처리한다. 9단계가 성공한 시점부터 홈페이지 발행은 성공한 것으로 판단한다. 이후 10단계의 D1 정리가 실패하면 API는 성공과 함께 `ledgerReconcilePending: true`를 반환하고 background reconciliation을 예약한다. 같은 publication ID/hash 재시도도 5단계에서 D1을 복구한다. 상태 API는 R2 current object의 `publicationId`와 hash를 우선해 원장 불일치를 조정한다. 예외 경로에서도 조건부 lease 해제를 시도하되, 실패한 lease는 만료로 회수한다.

철회도 같은 lease 아래에서 처리한다. Worker는 current를 읽고 이미 같은 ID/hash의 tombstone이면 revision 비교보다 먼저 원장을 reconcile해 idempotent 성공으로 반환한다. 그 외에는 EXPLORING current의 ID/hash/revision이 요청의 expected 값과 모두 일치할 때만 해당 ID/hash를 담은 tombstone wrapper를 current ETag 조건으로 먼저 쓴 뒤, 유효한 lease owner/generation 조건으로 D1 상태와 event를 `WITHDRAWN`으로 갱신한다. tombstone PUT 결과가 불확실하면 current를 다시 읽어 동일 tombstone인지 확인한다. 쓰기가 실제 실패했으면 D1의 공개 상태를 바꾸지 않는다. tombstone 성공 후 D1 갱신이 실패하면 공개 철회 성공과 `ledgerReconcilePending: true`를 반환하며, tombstone의 ID/hash를 이용해 원장을 복구한다. 다른 공개본이나 tombstone이면 `409 withdrawal_stale`다.

## 9. 오류와 빈 상태

| 조건 | 동작 |
|---|---|
| 최신 발행 가능 세션이 아님 | `409 latest_distill_required` |
| Distill 미완료 또는 output 없음 | `422 distill_output_not_ready` |
| 공개 항목이 모두 비어 있음 | `422 public_projection_empty` |
| research material URL 부적합 | 해당 source만 제외하고 미리보기에 제외 수 표시 |
| preview 뒤 공개 후보 내용 변경 | `409 preview_stale`, 새 preview 요구 |
| preview 뒤 current 또는 R2 ETag 변경 | `409 publication_state_changed`, 새 preview 요구 |
| 철회 확인 뒤 current ID/hash/revision 변경 | `409 withdrawal_stale`, 새 확인 요구 |
| 발행/철회가 이미 진행 중 | `409 publication_in_progress` |
| 원장 조회 불가 | `503 publication_ledger_unavailable`, identity 추측 금지 |
| hard-purge된 Distill 재발행 | `410 publication_purged`, 새 Distill 요구 |
| 사용 source 삭제 claim 진행 중 | `409 source_delete_in_progress`, 완료 후 재시도 |
| 동일 결과 재발행 | 기존 publication을 idempotent 성공으로 반환 |
| R2 history/current 쓰기 실패 | 이전 홈페이지 공개본 유지, Radar에 재시도 제공 |
| R2 current 성공 후 D1 정리 실패 | 공개 성공으로 표시하고 원장 reconciliation 예약 |
| 홈페이지 API 일시 실패 | 다른 Text 콘텐츠는 유지하고 `현재 연구를 불러오지 못했습니다`와 다시 시도 표시 |
| 공개 철회 | history는 보존하고 current에는 tombstone 저장 |
| source가 현재 공개본에 사용 중 | source 삭제를 `409 source_in_publication`으로 차단 |

발행 실패가 홈페이지의 정상 공개본을 삭제하거나 빈 JSON으로 덮어쓰면 안 된다.

현재 공개본의 `researchMaterials`에 포함되었거나 해당 공개본의 내부 세션이 사용한 source는 자동으로 숨기거나 바꾸지 않는다. 영구 삭제 service인 `deleteSourcePermanently`도 발행과 같은 singleton lease를 먼저 획득한 뒤 current를 검사하고, 그 안에서 기존 `source_deletion_claims` lease를 획득한다. current가 대상 source를 사용하면 차단하고, 사용자가 먼저 공개 철회를 승인한 뒤 source 삭제를 다시 실행하게 한다. publication lease가 예외적으로 만료되어도 남은 source deletion claim이 새 publish를 차단한다.

삭제 작업은 검사한 payload를 유지하되 새 `storageRevision`을 넣은 current wrapper를 같은 ETag 조건으로 다시 써서 fencing한 뒤에만 D1 source 삭제를 시작한다. current가 아직 없으면 ID/hash가 null인 WITHDRAWN tombstone wrapper를 `If-None-Match: *`로 만든다. 그 사이 stale publish가 먼저 current를 바꾸면 삭제 쪽 conditional PUT이 실패해 다시 검사하고, 삭제 쪽이 먼저 fencing하면 stale publish의 conditional PUT이 실패한다. 삭제의 최종 D1 문장도 유효한 lease owner token을 조건으로 삼는다. 이 규칙으로 발행 projection 생성과 source 삭제 사이의 시간차를 닫는다.

일반 철회는 감사·복구를 위해 private history를 보존한다. 민감정보가 실수로 공개된 경우의 hard purge도 publish/withdraw/source-delete와 같은 singleton lease, owner/generation guard, current ETag CAS를 사용한다. UI가 아닌 운영 runbook에서 별도 사용자 승인과 정확한 `publicationId`를 요구한다.

hard purge는 대상 Distill session에 영구적인 비공개 R2 purge marker를 먼저 기록하고, 해당 session의 모든 sibling publication ID prefix를 범위로 삼는다. runbook은 관련 원장 행을 `PURGING`으로 전환한 뒤 current를 다시 읽어 fencing한다. current가 대상 publication이면 tombstone으로, 다른 publication이면 그 payload와 새 `storageRevision`으로 조건부 PUT하며, current가 없으면 해당 범위의 non-null publication ID/hash를 가진 tombstone을 만든다. source-delete fencing에서 current와 publication/event 이력이 모두 전혀 없을 때만 null-ID/hash tombstone을 `If-None-Match: *`로 처음 만들 수 있다. 이력이 하나라도 있는데 식별 가능한 current가 없으면 `publication_ledger_unavailable`로 fail closed한다.

marker가 있는 동안 모든 publish/republish는 해당 session에 대해 거절되고, runbook은 `PURGING` 상태에서 재개된다. marker 기록 후 대상 session의 모든 sibling history event를 열거·삭제하고, 목록이 0건인지 관찰한다. 최소 60초 뒤 두 번째 독립 관찰에서도 0건이어야만 `payload_json`을 비우고 관련 행을 `PURGED`로 전환하며 내용 없는 `HARD_PURGE` 감사 event만 남긴다. 두 관찰 사이에 late history PUT이 발견되면 다시 `PURGING`으로 남겨 삭제·관찰을 반복한다. marker-bearing `PURGED` 행은 recurring audit/sweep가 재검사하며, 누락 object나 sibling copy가 발견되면 다시 purge한다. 이 marker·session-wide scope·two-pass zero rule로 delayed/concurrent R2 PUT이 purge 뒤 공개 object를 resurrect하는 것을 방지한다.

## 10. 홈페이지 전환 범위

1차 전환에서는 기존 reaction schema를 즉시 삭제하지 않되, `/text`의 `읽을거리`와 기존 `큐레이션` 양쪽에서 방문자 반응 기능은 모두 제거한다.

- `큐레이션` 탭을 `현재 연구`로 변경한다.
- 좋아요 버튼, 반응 카운터·평균·집계 UI를 제거한다.
- 좋아요 cooldown, localStorage 상태, 반응용 1초/15초 polling을 중단한다.
- `curatedAt`와 좋아요 평균 기반 분류·정렬을 사용하지 않는다.
- 기존 reading-card와 원문 클릭 POST 분석만 `읽을거리`에서 비공개로 유지한다.
- 전환 직전 live D1의 실제 `curatedArticles` 전체를 한 번 export해 `src/data/readingLegacyCuration.mjs` 영속 seed로 보존한다. 각 항목은 `status: published`를 채우고 `releaseAt`을 `stats.curatedAt → publishedAt → crawledAt → migration date` 순으로 KST 날짜 정규화해 정한다. `stats`, `curationLane`, `curationScore` 등 반응 파생 필드는 제거한다.
- `readingArticles.mjs`는 generated와 legacy를 URL 우선·ID 차선으로 중복 제거해 일반 `읽을거리`로 병합한다. 중복이면 generated 항목을 승자로 사용하고, crawler가 `readingArticles.generated.mjs`를 다시 만들어도 legacy seed는 덮어쓰지 않는다. 이전 전후의 항목 개수·ID·URL을 검증하고 개수는 하드코딩하지 않는다.
- 홈페이지 배포의 `reading:sync` 호출을 제거하고 `wrangler.worker.toml`의 `READING_REACTIONS_ENABLED=false`에서 공개 reaction endpoint 계약을 `POST /api/reading/:id/click`만 허용하도록 고정한다. `GET /api/reading`, `POST /api/reading/:id/like`, `POST /api/reading/sync`, batch finalization은 `410 reactions_disabled`이며 stats·likes·curatedArticles 본문을 반환하지 않는다. 별도의 홈페이지→Radar reading export는 이 flag와 무관하게 유지한다.
- D1의 vote/batch/curation 컬럼·테이블은 첫 배포에서 남겨 rollback 가능하게 한다.
- 안정화 후 별도 migration으로 사용하지 않는 reaction 데이터를 정리한다.

`현재 연구`는 읽을거리 카드 목록을 재사용하지 않고 공개 projection의 섹션 구조를 렌더링한다. 페이지의 기존 타이포그래피와 timeline 표현은 유지할 수 있지만 데이터 의미는 source card가 아니라 하나의 최신 research edition이다.

## 11. 순환 방지

현재 홈페이지 읽을거리는 `homepage-reading/latest.json`과 `homepage_artist/articles[]` schema를 통해 Radar로 수입된다. 새 공개 연구 결과는 다음 규칙으로 구조적으로 분리한다.

- 서로 다른 R2 binding·key·`CURRENT_RESEARCH` schema를 사용한다.
- `source = research-radar`를 고정한다.
- 홈페이지 읽을거리 export에 `현재 연구` payload를 포함하지 않는다.
- importer가 읽는 고정 key와 schema는 변경하지 않으므로 `CURRENT_RESEARCH`에 접근할 수 없다. 이를 configuration test로 검증한다.
- research material이 과거 homepage-reading에서 유래했더라도 연구 edition 자체를 새 source로 재수입하지 않는다.

## 12. 보안·provenance

- 공개 payload는 서버의 allowlist builder로만 만든다.
- URL은 WHATWG URL parser 기준의 public HTTP(S)만 허용하고 credentials, localhost·`.local`·IP literal private/loopback target을 거부한다. projection 생성 중 원격 URL을 fetch하거나 DNS를 조회하지 않는다.
- 모든 텍스트 필드는 5.1절의 길이 상한을 적용하며 HTML을 허용하지 않는다.
- 홈페이지에는 `Research Radar에서 정리한 현재 연구`임을 표시해 AI 합성과 작가의 최종 저작을 구분한다.
- 공개 확인 행위의 Access `sub`와 시간, 원본 Distill 연결은 private ledger에 남긴다.
- `radar-publications`는 public URL을 갖지 않으며 history key는 Worker 내부에서도 고정 current 조회 API로 노출하지 않는다.
- raw source와 Distill session endpoint는 계속 Access 뒤에 둔다.

## 13. 접근성

- 미리보기는 제목이 있는 dialog이며 열릴 때 첫 heading 또는 `공개 반영`에 focus를 둔다.
- `Escape`와 `취소`로 닫을 수 있고 focus는 원래 버튼으로 돌아간다.
- 진행 상태와 성공·실패는 `aria-live` status로 전달한다.
- 공개 확인과 철회는 서로 다른 버튼 문구와 확인 문장을 사용한다.
- 홈페이지의 `현재 연구`는 heading hierarchy와 source link 이름을 유지한다.

## 14. 테스트 전략

### Radar unit

- 공개 allowlist와 필드별 상한
- raw text, gaps, Critic/Counter, model/cost가 payload에 없는지 검증
- `sources_used_json` → 현재 `sources` metadata join, 삭제 source 배제, URL 정제
- `displayTitle`의 question → research direction → 고정 문구 fallback
- EXPLORING/WITHDRAWN discriminated schema와 nullable author/year
- 동일 input의 안정적 hash

### Radar route/integration

- `output_json`, schema, `liveDistillSessionFilter`, `created_at/id` tie-break를 모두 적용한 최신 발행 가능 세션만 preview/publish 가능
- preview가 D1/R2를 변경하지 않음
- preview와 발행의 `content`, `distilledAt`, `contentHash` 일치
- preview 이후 source metadata 변경 시 `409 preview_stale`, current 변경 시 `409 publication_state_changed`
- 동일 hash idempotency
- 같은 `distilledAt/contentHash`를 가진 서로 다른 session이 publication ID 비교로 구분됨
- idempotent 조기 반환 전에 원장 불일치가 복구됨
- current PUT 성공 뒤 응답 유실 재시도가 old revision에도 멱등 성공함
- 철회한 동일 세션/hash 재발행 시 publication ID·`publishedAt` 보존과 새 `updatedAt`
- 동시 publish/publish와 publish/withdraw 중 하나만 lease를 얻고 current가 뒤섞이지 않음
- 만료된 lease의 늦은 current PUT이 R2 ETag precondition으로 거절됨
- 만료된 owner/generation이 D1 상태를 쓰거나 후속 lease를 해제하지 못함
- 동일 payload fencing도 새 `storageRevision`으로 ETag가 바뀜
- history 성공/current 실패 재시도가 같은 `pending_event_at` key를 재사용함
- orphan `PUBLISHING`, `FAILED`, 다시 최신이 된 `SUPERSEDED`의 재진입 전이
- history write 실패와 current write 실패 시 기존 current 보존
- current 성공 후 D1 reconciliation 재시도
- publish/source-delete 경합의 ETag fencing, 현재 공개본 사용 source 삭제의 409 차단, 철회 후 삭제 허용
- source deletion claim이 남아 있는 동안 최신 세션을 이전 세션으로 건너뛰지 않고 publish를 차단함
- 철회 tombstone 성공 후 D1 실패의 ID/hash 기반 reconciliation
- 이전 철회 dialog의 ID/hash/revision으로 새 current를 철회하지 못함
- hard purge가 같은 lease/CAS로 경합을 차단하고 `PURGING`에서 재개되며 같은 Distill 재발행을 거절함
- Access 인증, actor 기록, browser same-origin/HMAC CSRF, CLI 면제 경계

### 홈페이지 unit/integration

- `현재 연구` projection 렌더링
- 공개본 없음/tombstone의 404, schema mismatch의 502, API 장애 상태
- current API의 모든 응답에 `Cache-Control: no-store`
- 익명 current 조회가 visitor ID를 생성·전송하지 않음
- 좋아요·쿨타임·반응 수치가 `읽을거리`와 `현재 연구` 어디에도 나타나지 않음
- 읽을거리의 원문 링크와 비공개 클릭 집계 회귀 없음
- 정적 후보에 없는 live D1 기존 큐레이션도 `status/releaseAt`이 정규화된 영속 seed를 통해 전환 후 `읽을거리`에 남고, generated 중복이 우선함
- homepage API는 reaction flag가 꺼졌을 때 click만 허용하고 GET stats·like·sync에서 통계 본문을 내보내지 않음
- 홈페이지 배포가 `reading:sync`, batch 확정, 좋아요 평균 계산, `curated_at` 갱신을 실행하지 않음
- homepage-reading importer와 current-research의 binding/key/schema 분리

### end-to-end

1. 최신 Distill에서 preview를 연다.
2. preview의 `content`, `distilledAt`, `contentHash`가 홈페이지 공개 projection과 일치함을 확인한다.
3. 공개 확인 뒤 `/text > 현재 연구`가 새 내용으로 바뀐다.
4. 새 Distill만 실행했을 때 기존 공개본이 유지된다.
5. 새 결과를 승인하면 이전 발행이 superseded된다.
6. 동일 결과 재요청이 중복 history/publication을 만들지 않는다.
7. 철회하면 `현재 연구`가 명시적 빈 상태가 되고 history는 남는다.
8. 철회한 동일 Distill을 다시 승인하면 같은 edition ID와 최초 `publishedAt`을 유지하고 `updatedAt`만 갱신된다.
9. 현재 공개본을 구성한 source는 철회 전 삭제되지 않는다.

## 15. 단계적 출시

0. 구현 전에 이 확정 결정을 Radar의 `docs/SPEC.md`와 `docs/DEV_PLAN.md`에 반영한다.
1. 전용 private R2 bucket, Radar 발행 원장·lease, projection builder, preview/publish API를 추가한다.
2. `taejunyun-reading-api` Worker에 `HOMEPAGE_PUBLICATIONS` binding과 fixed-key 공개 endpoint를 추가한다.
3. live D1 `curatedArticles`를 영속 legacy reading seed로 이전하고 실제 전환 시점의 항목 수·URL·ID를 검증한다.
4. Cloudflare Pages 홈페이지의 `현재 연구` view를 feature flag 아래 연결한다.
5. Radar 버튼과 미리보기 dialog를 연결한다.
6. 배포에서 `reading:sync`를 제거하고 reaction engine을 끈 뒤 end-to-end 확인 후 기존 `큐레이션` UI를 `현재 연구`로 전환한다.
7. 실제 구현·배포·binding 상태를 `docs/PROJECT_CONTEXT.md`에 기록한다.
8. 안정화 기간 뒤 사용하지 않는 reaction client code와 D1 schema 정리를 별도 작업으로 수행한다.

출시 도중 어느 단계가 실패해도 기존 홈페이지 공개본과 기존 Text 콘텐츠는 유지한다.

## 16. 대안과 판단

### A. 최신 Distill 자동 공개

가장 간단하지만 테스트 실행·불완전한 합성·내부 아이디어가 즉시 공개될 위험이 있어 채택하지 않는다.

### B. 홈페이지 build/deploy 트리거

정적 결과와 SEO에는 유리하지만 버튼 클릭마다 GitHub token, build, deploy 성공 여부를 관리해야 하고 반영이 느리다. 현재 연구 한 건의 갱신에는 과하다.

### C. Radar가 홈페이지 D1에 직접 POST

기존 sync token 패턴을 재사용할 수 있지만 두 Worker 사이의 인증·retry·부분 성공을 추가한다. 전용 R2 bucket을 두 Worker가 제한된 binding으로 공유하는 방식이 더 작고 공개/비공개 경계가 명확하다.

따라서 **명시적 미리보기·승인 + 전용 R2 공개 snapshot + 홈페이지 fixed-key read API**를 채택한다.

## 17. 완료 조건

- 최신 발행 가능 Distill에서만 `홈페이지에 반영`이 가능하다.
- 최신 발행 가능 세션의 판정 조건과 동시성 규칙이 DB/API 테스트로 고정된다.
- 미리보기와 실제 공개 payload가 동일한 builder에서 생성된다.
- 사용자는 필드·연구주제·상태를 고르지 않고 공개 여부만 결정한다.
- 기존 공개본은 새 발행 성공 전까지 유지된다.
- 홈페이지의 `큐레이션`은 `현재 연구`로 대체된다.
- 공개 payload에 private Radar 데이터가 포함되지 않는다.
- 홈페이지→Radar reading sync와 Radar→홈페이지 current-research publish가 순환하지 않는다.
- 실패·재시도·중복 발행·철회가 테스트로 검증된다.
- 구현 전 `docs/SPEC.md`·`docs/DEV_PLAN.md`, 구현 후 `docs/PROJECT_CONTEXT.md`가 실제 상태와 일치한다.
