# 받은 자료 수신·정규화·재검수 설계 사양

작성일: 2026-08-22  
상태: 사용자 방향 승인 후 상세 설계  
대상: `받은 자료` 화면, Inbox API, Obsidian sync, ingestion versioning

## 1. 목적

`받은 자료`를 단순한 입력 목록에서 **원본 보존과 AI 입력 품질을 함께 검증하는 수신 작업공간**으로 확장한다.

사용자는 다음 질문에 화면만 보고 답할 수 있어야 한다.

1. 이 자료는 어디에서 어떤 형식으로 들어왔는가?
2. 원본은 보존되었는가?
3. AI가 실제로 읽을 텍스트는 무엇인가?
4. 텍스트가 비어 있거나 깨졌거나 불필요한 문구로 오염되지 않았는가?
5. 문제가 있으면 수정, 재추출, 재분석 중 무엇을 해야 하는가?
6. Obsidian 원문이 바뀌었을 때 기존 수동 보정본이 유지되는가?

핵심 원칙은 기존 제품의 Reservoir First와 Provenance First를 유지하는 것이다. 원본은 R2에 불변으로 보존하고, 추출·정규화·수동 수정 결과는 버전으로 쌓는다. AI 분석은 명시적으로 활성화된 버전만 사용한다.

## 2. 현재 상태와 문제

현재 구현은 다음 기반을 이미 갖고 있다.

- 원본: R2 `originals/{sourceId}/...`
- 자료 정체성: D1 `sources`
- 추출 텍스트와 버전: D1 `source_versions.extracted_text`
- 처리 상태: D1 `processing_jobs`
- Obsidian 변경: 새 `source_versions` 행으로 보존
- 분석: 최신 `source_versions.extracted_text`를 읽어 Workers AI 실행

그러나 현재 `받은 자료` 화면에서는 다음 정보가 보이지 않는다.

- `PDF`, `웹 링크`, `Obsidian Markdown`, `직접 입력` 같은 수신 형식
- 수신 경로와 연구 자료 유형의 차이
- 실제 AI 입력 텍스트
- 추출 글자 수, 스캔 PDF, 깨진 문자, 반복 문구 같은 품질 신호
- 원본·추출본·수동 보정본의 버전 관계
- 새 Obsidian 버전과 기존 수동 보정본의 충돌
- 재추출 결과를 확인한 뒤 채택하는 과정

현재 목록의 초록색 점은 `extracted`, `analyzed`, `indexed`를 모두 비슷하게 보여주므로, “제대로 들어왔는지”와 “분석까지 끝났는지”를 구분하기 어렵다. 입력 화면의 `메모·텍스트 / 웹 주소 / 파일`도 실제 탭이 아니라 한 폼 안의 시각적 라벨이다.

## 3. 확정 범위

### 3.1 포함

- 받은 자료 입력 방식을 실제 탭으로 분리
- 수신 경로와 파일·콘텐츠 형식을 별도 분류
- 기존 자료와 새 자료 모두 검수 목록에서 조회
- 원본 정보, 추출 텍스트, AI 입력용 정규화 텍스트 비교
- 정규화 텍스트 직접 수정 후 새 버전 저장
- URL·PDF·Markdown·Obsidian 자료의 재추출 또는 재정규화
- 활성 버전에 대한 재분석
- Obsidian 재동기화 시 수동 보정본 보호
- 처리 상태와 별도의 텍스트 품질 상태
- 기존 100개 이상 자료의 무손실 backfill

### 3.2 제외

- 스캔 PDF OCR
- Radar에서 Obsidian 파일을 수정하는 양방향 동기화
- Google Drive 연동
- AI가 원문을 자의적으로 다시 쓰는 자동 교정
- 여러 버전을 동시에 병합하는 Git 수준의 merge editor
- Admin dashboard 또는 대량 삭제
- 원본 R2 객체 덮어쓰기

스캔 PDF는 원본을 보존하고 `텍스트 없음 · 검토 필요`로 표시한다. 사용자는 핵심 문장을 직접 입력해 수동 보정본을 만들 수 있다.

## 4. 핵심 용어와 분류

### 4.1 수신 경로와 연구 자료 유형을 분리한다

`sources.kind`는 자료가 연구에서 무엇인지를 나타낸다.

- 개인 텍스트
- 논문
- 작가·작업
- 웹 자료
- 메모

새로운 `ingest_channel`과 `input_format`은 자료가 어떻게 들어왔는지를 나타낸다.

| 필드 | 값 | 사용자 표시 |
|---|---|---|
| `ingest_channel` | `MANUAL` | 직접 입력 |
|  | `OBSIDIAN` | Obsidian 동기화 |
|  | `DISCOVERY` | 발견에서 가져옴 |
|  | `HOMEPAGE` | 홈페이지 동기화 |
| `input_format` | `PLAIN_TEXT` | 텍스트 |
|  | `MARKDOWN` | 마크다운 |
|  | `OBSIDIAN_MARKDOWN` | Obsidian 문서 |
|  | `URL_HTML` | 웹 링크 |
|  | `PDF_TEXT` | PDF |
|  | `PDF_SCAN` | 스캔 PDF |
|  | `HOMEPAGE_JSON` | 홈페이지 프로젝트 |
|  | `DISCOVERY_LINK` | 발견 링크 |

예를 들어 Obsidian에서 들어온 작업노트는 다음처럼 표시된다.

```text
Obsidian 동기화 · Obsidian 문서 · 개인 텍스트
```

PDF 논문은 다음처럼 표시된다.

```text
직접 입력 · PDF · 논문
```

### 4.2 세 종류의 텍스트를 구분한다

1. **원본**: R2에 보존된 PDF, HTML, Markdown, plain text. 수정하지 않는다.
2. **추출 텍스트**: PDF·HTML·Markdown에서 기계적으로 꺼낸 텍스트. 원본 버전과 함께 보존한다.
3. **AI 입력용 텍스트**: 추출 텍스트를 규칙 기반으로 정규화하거나 사용자가 수정한 텍스트. 분석은 이 텍스트만 사용한다.

화면에서는 `AI 입력용 텍스트`라는 사용자 언어를 사용하고, 내부 필드명은 `normalized_text`로 통일한다.

## 5. 화면 정보 구조

### 5.1 페이지 상단

페이지 헤더 아래에 행동이 필요한 상태만 요약한다.

```text
검토 필요  6     처리 실패  2     AI 입력 준비  92
```

- 숫자는 현재 전체 수신 자료를 기준으로 한다.
- 각 숫자는 필터 버튼으로 작동한다.
- `AI 입력 준비`는 성공 상태 확인용이므로 색을 강하게 쓰지 않는다.
- `검토 필요`와 `처리 실패`만 경고색을 사용한다.
- `검토 필요`에는 `REVIEW`, `EMPTY`, `UNREVIEWED`, 새 버전 대기 항목을 포함한다.

### 5.2 최상위 작업 전환

`받은 자료` 안에서 두 작업을 분리한다.

- `자료 받기`
- `수신 자료 검수`

기본 진입은 `수신 자료 검수`다. 사용자가 새 자료를 넣으려 할 때만 `자료 받기`로 이동한다.

### 자료 받기

입력 유형을 실제 탭으로 제공한다.

1. `메모·텍스트`
2. `웹 링크`
3. `PDF`
4. `마크다운·옵시디언`

한 탭에서는 해당 입력에 필요한 필드와 CTA만 보여준다. 현재처럼 한 화면에 모든 입력을 세로로 나열하지 않는다.

CTA는 결과를 설명한다.

- `메모 원본 보존하기`
- `웹 원문 가져오기`
- `PDF 원본과 텍스트 보존하기`
- `마크다운 보존하기`

Obsidian CLI 상태는 `마크다운·옵시디언` 탭에 읽기 전용으로 표시한다.

```text
최근 동기화 2026.08.22 17:03 · 54개 문서 · 검토 필요 2개
```

### 5.3 수신 자료 검수 목록

데스크톱에서는 왼쪽 목록, 오른쪽 검수 상세의 split workspace를 사용한다. 모바일에서는 목록과 상세를 별도 화면처럼 전환한다.

목록 상단 필터:

- 수신 형식: 전체 / Obsidian / PDF / 웹 링크 / 텍스트 / 마크다운
- 품질 상태: 전체 / 검토 필요 / 텍스트 없음 / AI 입력 준비 / 처리 실패
- 버전 상태: 전체 / 최신 / 새 버전 검토 필요 / 수동 보정본
- 분석 상태: 전체 / 분석 최신 / 재분석 필요

목록 항목은 다음 순서로 표시한다.

```text
[Obsidian] [검토 필요]
여러 문장
개인 텍스트 · 1,284자 · v3 · 2026.08.22 17:03
새 Obsidian 버전이 들어왔습니다
```

초록색 점 하나로 전체 파이프라인을 표현하지 않는다. 상태 문구와 배지를 함께 사용한다.

### 5.4 검수 상세

상단:

- 제목
- 수신 경로 / 입력 형식 / 연구 자료 유형
- 원본 보존 상태
- 활성 버전과 버전 출처
- 처리 상태와 품질 상태
- 현재 분석이 활성 버전을 사용했는지 여부

본문:

- 데스크톱: `추출 텍스트`와 `AI 입력용 텍스트`를 나란히 표시
- 모바일: `추출 텍스트 / AI 입력용 텍스트` 탭 전환
- 원본이 URL이면 `원문 열기`
- 원본이 PDF이면 `PDF 원본 열기`
- 원본이 Markdown이면 `원본 Markdown 보기`

텍스트 상단에는 품질 요약을 제공한다.

```text
AI 입력 준비 · 1,284자
제목 3개 · 목록 4개 · 깨진 문자 0개 · 미해결 첨부 1개
```

하단 고정 행동:

- `수정본 새 버전 저장`
- `다시 정규화` 또는 `다시 추출`
- `다시 분석`

`다시 분석`은 활성 버전에 AI 입력용 텍스트가 있고 품질 상태가 `READY`일 때만 활성화한다. `REVIEW` 상태에서는 사용자가 `이 텍스트 사용`을 명시적으로 눌러 활성 버전으로 채택한 뒤 분석할 수 있다.

### 5.5 버전 비교

버전 목록은 최신순으로 표시한다.

```text
v4  Obsidian 동기화     검토 필요
v3  수동 보정           현재 AI 입력
v2  Obsidian 동기화
v1  최초 수신
```

두 버전을 선택하면 줄 단위로 다음만 보여준다.

- 추가된 줄
- 제거된 줄
- 변경되지 않은 문맥 한 줄

복잡한 병합 UI는 제공하지 않는다. 비교 후 `새 버전 채택`, `기존 보정본 유지`, `수정본 만들기` 중 하나를 선택한다.

## 6. 정규화 규칙

정규화는 우선 결정적 규칙으로 처리한다. AI를 이용한 문장 재작성은 하지 않는다. 같은 입력은 같은 결과를 생성해야 한다.

### 6.1 공통

- UTF-8 기준으로 Unicode NFC 정규화
- CRLF/CR을 LF로 통일
- null 문자와 제어문자 제거
- 연속 공백과 과도한 빈 줄 축소
- U+FFFD 대체문자 수 기록
- 내용 없는 링크·이미지 자리표시는 경고로 기록
- 원문의 문단, 제목, 목록 순서를 유지

### 6.2 Markdown·Obsidian

- YAML frontmatter는 본문에서 분리해 metadata에 저장
- Markdown 제목, 목록, 인용, 코드 블록은 유지
- `[[대상|표시명]]`은 `표시명`으로 변환
- `[[대상]]`은 `대상`으로 변환
- `![[첨부파일]]`은 `[첨부: 첨부파일]`로 변환하고 미해결 첨부 수를 기록
- Obsidian callout은 일반 인용문과 제목으로 변환
- HTML 주석은 AI 입력용 텍스트에서 제거
- Dataview·Templater 실행 코드는 제거하지 않고 `[실행 블록 제외: 종류]`로 치환
- 태그는 frontmatter와 inline tag를 metadata에도 기록하되 본문에 의미가 있으면 유지

원본 Markdown은 R2에 그대로 남긴다.

### 6.3 URL·HTML

- 기존 `fetchAndExtract`가 반환한 본문을 기준으로 정규화
- 내비게이션, 쿠키 안내, 반복 footer 등 추출기 잔여 문구를 규칙 기반으로 표시
- 제목과 문단 순서를 유지
- 링크는 URL 자체보다 링크 라벨을 우선 보존
- 원문 URL과 최종 URL을 metadata에 함께 보존

재추출 실패 시 기존 활성 버전은 유지한다.

### 6.4 PDF

- 브라우저 pdf.js 추출 경로를 유지한다.
- 페이지 경계 `[page N]`은 보존한다.
- 줄 끝 하이픈으로 끊긴 단어는 다음 줄과 결합한다.
- 반복되는 header/footer 후보를 품질 보고서에 기록한다.
- 페이지당 의미 문자 수를 계산한다.
- 의미 문자가 20자 미만인 PDF는 `PDF_SCAN`과 `REVIEW`로 분류한다.
- 서버 OCR은 수행하지 않는다.

### 6.5 Plain text

- 공통 정규화만 적용한다.
- 원문의 줄 순서와 문단을 유지한다.
- 제목이 없으면 첫 번째 의미 문장을 후보 제목으로 사용하되 원본 본문은 수정하지 않는다.

## 7. 품질 상태

처리 상태와 텍스트 품질 상태를 분리한다.

### 7.1 처리 상태

기존 상태를 유지한다.

```text
received → stored → extracted → analyzed → indexed
                                     ↘ failed
```

### 7.2 텍스트 품질 상태

| 상태 | 사용자 표시 | 기준 |
|---|---|---|
| `UNREVIEWED` | 검수 전 | 아직 정규화·품질 판정을 실행하지 않음 |
| `READY` | AI 입력 준비 | 메모·Markdown은 의미 문자 40자 이상, URL·PDF는 200자 이상이며 hard warning 없음 |
| `REVIEW` | 검토 필요 | 형식별 최소 문자 미달, 스캔 PDF, 높은 반복률, 깨진 문자, 미해결 실행 블록 등 |
| `EMPTY` | 텍스트 없음 | 정규화 결과 의미 문자 0자 |
| `FAILED` | 처리 실패 | 추출·정규화 실행 자체가 실패 |

품질 상태는 AI가 아니라 결정적 지표로 계산한다.

짧은 개인 메모도 연구 신호가 될 수 있으므로 URL·PDF와 같은 200자 기준을 강제하지 않는다. 40자 미만 메모도 삭제하지 않고 `REVIEW` 상태에서 사용자가 채택할 수 있다.

품질 보고서에는 다음 값만 저장한다.

- `extractedChars`
- `normalizedChars`
- `meaningfulChars`
- `replacementCharCount`
- `repeatedLineRatio`
- `unresolvedEmbedCount`
- `pageCount`
- `textPages`
- `warnings[]`

임계값은 내부 상수로 관리하며 사용자 설정에는 추가하지 않는다.

## 8. 버전·충돌 정책

### 8.1 불변 원칙

- `source_versions` 행은 생성 후 본문을 수정하지 않는다.
- 사용자가 텍스트를 고치면 새 버전을 생성한다.
- R2 원본은 덮어쓰지 않는다.
- AI 분석은 `sources.active_version_id`가 가리키는 버전만 사용한다.
- 새 후보 버전의 실패가 현재 활성 버전에 영향을 주지 않는다.

### 8.2 버전 출처

`version_origin`은 다음 값 중 하나다.

- `INITIAL_INGEST`
- `OBSIDIAN_SYNC`
- `REEXTRACT`
- `RENORMALIZE`
- `MANUAL_EDIT`

### 8.3 Obsidian 충돌

1. 첫 동기화 버전은 자동 활성화한다.
2. 활성 버전이 이전 Obsidian 동기화본이고 수동 보정 이력이 없으면 새 동기화본을 자동 활성화한다.
3. 활성 버전이 `MANUAL_EDIT`이면 새 Obsidian 버전을 `PENDING_REVIEW`로 저장한다.
4. 기존 수동 보정본은 계속 AI 입력으로 사용한다.
5. 사용자는 비교 후 새 버전 채택, 기존 보정본 유지, 새 수정본 만들기 중 하나를 선택한다.

Radar에서 수정한 내용은 Obsidian 파일로 역동기화하지 않는다.

### 8.4 재추출·재정규화

- 사용자가 실행하면 새 후보 버전을 만든다.
- 성공해도 즉시 활성화하지 않고 결과를 먼저 보여준다.
- 사용자가 `이 텍스트 사용`을 눌렀을 때 활성 버전을 변경한다.
- 실패하면 후보 버전에 오류를 남기고 기존 활성 버전은 유지한다.

## 9. 데이터 모델 설계

기존 테이블을 확장하고 별도 관리 시스템을 만들지 않는다.

### 9.1 `sources` 추가 필드

```text
ingest_channel     TEXT NOT NULL DEFAULT 'MANUAL'
input_format       TEXT NOT NULL DEFAULT 'PLAIN_TEXT'
active_version_id  TEXT NULL
quality_status     TEXT NOT NULL DEFAULT 'UNREVIEWED'
```

`quality_status`는 현재 활성 버전의 텍스트 품질만 요약한다. 새 후보 버전의 검토 대기 여부는 `source_versions.review_status`로 분리하고 목록 조회 시 계산한다.

### 9.2 `source_versions` 추가 필드

```text
content_hash               TEXT NULL
normalized_text            TEXT NULL
normalization_status       TEXT NOT NULL DEFAULT 'PENDING'
normalization_report_json  TEXT NULL
version_origin             TEXT NOT NULL DEFAULT 'INITIAL_INGEST'
parent_version_id          TEXT NULL
review_status              TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
reviewed_at                TEXT NULL
```

`extracted_text`는 추출 결과를 유지하고, `normalized_text`가 AI 입력 후보가 된다.

수동 보정 버전은 부모 버전의 `extracted_text`와 `r2_key`를 참조하고, 사용자가 바꾼 내용만 `normalized_text`에 저장한다. 원본과 추출 결과를 복제하거나 덮어쓰지 않는다.

`normalization_status` 값:

- `PENDING`: 정규화 전 또는 실행 중
- `READY`: 정규화 결과와 품질 보고서 생성 완료
- `FAILED`: 정규화 실패

`review_status` 값:

- `ACTIVE`: 현재 AI 입력 버전
- `PENDING_REVIEW`: 검토 후 채택할 후보
- `SUPERSEDED`: 과거 활성 버전
- `REJECTED`: 사용자가 채택하지 않은 후보

버전 활성화는 한 transaction에서 이전 `ACTIVE`를 `SUPERSEDED`로 바꾸고, 선택 버전을 `ACTIVE`로 바꾸며, `sources.active_version_id`와 `sources.quality_status`를 함께 갱신한다.

### 9.3 제약과 인덱스

- `(source_id, version)` unique index
- `(source_id, content_hash)` index
- `sources(ingest_channel)` index
- `sources(input_format)` index
- `sources(quality_status)` index
- `sources(active_version_id)` index

기존 데이터에 중복 버전 번호가 있는지 migration 전에 읽기 전용 검사한다.

## 10. API 설계

### 10.1 목록과 요약

```http
GET /api/inbox?channel=&format=&quality=&versionState=&limit=&cursor=
```

응답:

```json
{
  "summary": {
    "reviewRequired": 6,
    "failed": 2,
    "ready": 92
  },
  "items": [],
  "nextCursor": null
}
```

목록은 기본 50개, 최대 100개를 반환한다. 현재의 고정 `LIMIT 100`은 cursor pagination으로 교체한다.

### 10.2 상세와 버전

```http
GET /api/inbox/:sourceId
GET /api/inbox/:sourceId/versions/:versionId
GET /api/inbox/:sourceId/original
```

상세 응답은 다음을 포함한다.

- source identity
- ingest channel과 input format
- 원본 접근 정보
- 처리 상태와 텍스트 품질 상태
- active version id
- 버전 목록
- 선택 버전의 extracted text
- normalized text
- normalization report
- 현재 분석이 참조한 version id
- `analysisFresh`: 최신 source analysis의 version id와 active version id가 같은지 여부

`original` endpoint는 Cloudflare Access 인증 뒤 R2 객체를 stream한다. 원본 MIME type과 안전한 다운로드 filename을 응답 header에 포함하고, 공개 URL을 만들지 않는다.

### 10.3 수정본 저장

```http
POST /api/inbox/:sourceId/versions
```

요청:

```json
{
  "parentVersionId": "version-id",
  "normalizedText": "사용자가 보정한 텍스트",
  "activate": true
}
```

서버는 `MANUAL_EDIT` 버전을 생성하고 원본 버전을 수정하지 않는다.

### 10.4 재처리

```http
POST /api/inbox/:sourceId/reextract
POST /api/inbox/:sourceId/renormalize
POST /api/inbox/:sourceId/versions/:versionId/activate
POST /api/inbox/:sourceId/analyze
```

- `reextract`: URL은 Worker가 원문을 다시 가져온다. PDF는 브라우저 pdf.js가 R2 원본을 읽어 추출한 `extractedText`, `pageCount`를 이 endpoint에 전송한다. 서버 PDF parser는 추가하지 않는다.
- `renormalize`: 기존 extracted text에 최신 결정적 규칙 적용
- `activate`: 검토한 버전을 AI 입력 버전으로 채택
- `analyze`: active version의 normalized text만 분석

기존 `/retry/:sourceId?analyze=1`은 호환성을 위해 유지하되 UI는 명시적인 새 endpoint를 사용한다.

## 11. 처리 흐름

### 11.1 새 자료

```text
자료 수신
→ R2 원본 저장
→ sources + source_versions 생성
→ 추출
→ 정규화
→ 품질 판정
→ 첫 수신 버전을 active_version으로 지정
→ READY이면 분석·인덱싱
→ REVIEW/EMPTY이면 원본을 보존하고 사용자 검수 대기
```

원본 저장에 실패하면 source를 성공 처리하지 않는다. 추출 이후가 실패하면 원본과 source는 남기고 `처리 실패` 또는 `검토 필요`로 표시한다.

### 11.2 수동 수정

```text
활성 버전 열기
→ AI 입력용 텍스트 편집
→ MANUAL_EDIT 새 버전 생성
→ 새 버전 활성화
→ 이전 분석은 유지하되 “이전 버전 분석” 표시
→ 사용자가 다시 분석 실행
```

수정본 저장만으로 AI 비용을 발생시키지 않는다.

### 11.3 Obsidian 새 버전

```text
CLI sync
→ content hash 비교
→ 변경된 원본 R2 보존
→ OBSIDIAN_SYNC 버전 생성
→ 정규화·품질 판정
→ 수동 보정본 존재 여부 확인
   ├─ 없음: 새 버전 활성화 후 분석 예약
   └─ 있음: PENDING_REVIEW, 기존 활성 버전 유지
```

## 12. 오류 처리와 복구

| 상황 | 사용자 표시 | 복구 행동 |
|---|---|---|
| URL fetch 실패 | 원문을 가져오지 못함 | 다시 추출 |
| PDF 텍스트 없음 | 스캔 PDF · 텍스트 없음 | 직접 텍스트 입력 |
| 정규화 실패 | AI 입력 텍스트 생성 실패 | 다시 정규화 |
| 분석 실패 | 분석 실패 · 원본/텍스트 보존됨 | 다시 분석 |
| Obsidian 충돌 | 새 버전 검토 필요 | 버전 비교 |
| 수동 수정 저장 실패 | 저장되지 않음 | 편집 내용을 화면에 유지하고 재시도 |
| 재추출 결과 품질 저하 | 새 결과 검토 필요 | 기존 버전 유지 |

오류 메시지는 원본 보존 여부를 함께 말한다. 예: `분석은 실패했지만 원본과 AI 입력용 텍스트는 보존되었습니다.`

## 13. 접근성·반응형

- 탭은 `button`과 `aria-selected`를 사용한다.
- 상태는 색만으로 표현하지 않고 텍스트 배지를 제공한다.
- split workspace의 각 pane에 제목을 제공한다.
- 텍스트 비교의 추가·삭제는 색과 `추가됨/삭제됨` 라벨을 함께 사용한다.
- 키보드만으로 목록 선택, 버전 선택, 편집, 저장, 재처리가 가능해야 한다.
- 저장 후 초점은 상태 메시지로 이동하지 않고 편집 영역 또는 결과 CTA에 유지한다.
- 모바일에서는 상세 진입 후 명확한 `검수 목록으로` 버튼을 제공한다.

## 14. 기존 데이터 backfill

기존 자료를 삭제하거나 다시 수집하지 않는다.

1. additive migration으로 새 필드를 nullable/default 상태로 추가한다.
2. `origin`을 기준으로 `ingest_channel`과 `input_format`을 채운다.
3. 각 source의 최신 source_version을 임시 active version으로 지정한다.
4. `extracted_text`를 입력으로 결정적 정규화를 실행한다.
5. 한 번에 20개씩 처리하고 진행 상태를 기록한다.
6. 정규화 결과가 비었거나 경고 기준을 넘으면 `REVIEW`로 남긴다.
7. backfill에서는 AI 분석을 자동 재실행하지 않는다.

대표 origin 매핑:

| origin pattern | channel | format |
|---|---|---|
| `obsidian:*` | `OBSIDIAN` | `OBSIDIAN_MARKDOWN` |
| `upload:pdf` | `MANUAL` | `PDF_TEXT` 또는 metadata 기반 `PDF_SCAN` |
| `upload:md` | `MANUAL` | `MARKDOWN` |
| `manual` | `MANUAL` | `PLAIN_TEXT` |
| `url` | `MANUAL` | `URL_HTML` |
| `discovery:*` | `DISCOVERY` | `DISCOVERY_LINK` |
| `homepage*` | `HOMEPAGE` | `HOMEPAGE_JSON` |

## 15. 테스트 설계

### 15.1 정규화 단위 테스트

- YAML frontmatter가 metadata로 분리되고 본문에서 제거되는가
- Obsidian wikilink label이 보존되는가
- embed가 대체 표기와 warning으로 남는가
- code block 내용이 보존되는가
- PDF 페이지 경계와 문단이 유지되는가
- 스캔 PDF가 `REVIEW`로 판정되는가
- 같은 입력이 항상 같은 normalized text와 report를 만드는가

### 15.2 Worker 통합 테스트

- 새 source 생성 시 원본·추출·정규화·active version이 연결되는가
- 수동 수정 시 기존 버전이 바뀌지 않고 새 버전이 생성되는가
- Obsidian 수동 보정본 이후 새 sync가 active version을 바꾸지 않는가
- 재추출 실패 시 기존 active version이 유지되는가
- analyze가 최신 버전이 아니라 active version을 읽는가
- content hash가 같은 Obsidian sync가 중복 버전을 만들지 않는가
- 필터별 목록과 summary 수치가 일치하는가

### 15.3 Web 테스트

- 네 입력 탭이 실제로 전환되는가
- 형식·품질·버전 배지가 분리되어 보이는가
- 목록 클릭 시 원본과 AI 입력용 텍스트가 나타나는가
- 수정본 저장 후 새 버전과 현재 AI 입력 배지가 즉시 갱신되는가
- 다시 추출 결과가 자동 채택되지 않는가
- 품질이 `REVIEW`일 때 다시 분석 CTA가 비활성화되는가
- 오류 메시지가 원본 보존 여부를 설명하는가

### 15.4 핵심 E2E

```text
Obsidian 문서 최초 sync
→ AI 입력 준비 확인
→ 텍스트 수동 수정·새 버전 저장
→ Obsidian 원문 변경 후 재-sync
→ 새 버전 검토 필요 확인
→ 두 버전 비교
→ 기존 보정본 유지
→ 다시 분석
→ 저장소에서 새 분석 확인
```

## 16. 관측과 운영

- 로그에는 source id, version id, 단계, 상태, 글자 수, warning code만 기록한다.
- 원문과 normalized text 본문을 로그에 남기지 않는다.
- 재처리 횟수는 기존 `processing_jobs.retry_count`를 사용한다.
- 분석 비용은 기존 `ai_usage` 정책을 따른다.
- 정규화와 품질 판정은 LLM을 사용하지 않아 비용 guardrail에 영향을 주지 않는다.
- backfill 완료 수, 검토 필요 수, 실패 수는 받은 자료 상단 요약에서 확인한다.

## 17. 성공 기준

- 모든 받은 자료가 수신 경로, 입력 형식, 연구 자료 유형으로 구분된다.
- 사용자가 원본·추출 텍스트·AI 입력용 텍스트의 차이를 확인할 수 있다.
- 사용자가 텍스트를 직접 수정해 원본을 훼손하지 않고 새 버전으로 저장할 수 있다.
- 재추출·재정규화 결과가 검토 전 현재 AI 입력을 교체하지 않는다.
- 수동 보정 이후의 Obsidian sync가 보정본을 자동 덮어쓰지 않는다.
- AI 분석은 명시적으로 활성화된 버전만 사용한다.
- 기존 자료를 다시 업로드하지 않고 backfill할 수 있다.
- 처리 실패와 텍스트 품질 문제를 서로 구분해 복구할 수 있다.
- UI가 새로운 사용자 설정 항목을 요구하지 않는다.
- 원본 R2 보존, D1 version history, provenance 규칙이 유지된다.

## 18. 구현 경계

이 설계는 기능과 인터페이스를 확정하지만 실제 코드, migration, 배포는 포함하지 않는다. 구현계획은 사용자 검토 이후 별도 문서에서 파일 단위·테스트 우선 순서로 작성한다.
