# 발견 후보 원문 수집·심층 읽기 신뢰성 설계

- 날짜: 2026-08-23
- 상태: 설계 초안
- 범위: 발견 탭에서 보관한 웹/PDF 후보의 원문 수집, Reservoir 표시, 심층 정리 진입 조건
- 승인된 방향: 단계형 수집(후보 저장 → 원본 보존 → 추출 → 품질 판정 → 분석)

## 1. 문제 정의

현재 발견 후보를 보관하면 제목과 링크가 Reservoir 자료처럼 등록되지만, 실제 URL/PDF 원본을 가져오지 않는다. 그 결과 다음 문제가 함께 발생한다.

- 발견 후보가 제목만 가진 40~90자 자료로 저장된다.
- 심층 분석은 40자 이상이면 실행되어 메타데이터만으로 분석될 수 있다.
- URL 자료의 접근 배지는 canonical URL만 보고 판단하므로, 실제로 저장된 원문 상태와 화면 표시가 다르다.
- 정적 HTML 추출기가 본문 영역을 구분하지 않아 메뉴·푸터·보일러플레이트가 본문에 섞인다.
- RSS CDATA가 제목에 남아 발견 자료의 표시와 중복 제거 품질을 떨어뜨린다.

핵심 원칙은 “분석 가능”과 “링크가 존재함”을 분리하는 것이다. 링크만 있는 자료는 후보로 보존하되, 원문을 읽었다고 표시하거나 심층 분석하지 않는다.

## 2. 목표와 비목표

### 목표

1. 발견 후보의 Keep 동작이 실제 URL/PDF 수집 작업을 시작한다.
2. 수집 원본은 추출 전에 R2에 보존한다.
3. HTML과 PDF를 서로 다른 추출 경로로 처리하고, 추출 결과의 범위와 방법을 provenance로 남긴다.
4. 원문이 충분하지 않은 자료의 심층 분석을 서버에서 차단한다.
5. Reservoir에서 원문 수집 상태, 본문 글자 수, 품질, 재시도 가능 여부를 명확히 보여준다.
6. 실패한 수집은 삭제하지 않고 원래 링크·메타데이터·실패 이유와 함께 재수집할 수 있게 한다.

### 비목표

- 이번 범위에서 브라우저 렌더링/헤드리스 브라우저를 추가하지 않는다.
- 유료·로그인 필요 콘텐츠를 우회하지 않는다.
- Google Scholar 결과 페이지 크롤링을 추가하지 않는다.
- 기존 PDF 업로드의 브라우저 pdf.js 경로를 제거하지 않는다.
- 의미 검색, 멀티유저, 챗봇을 추가하지 않는다.

## 3. 제안 아키텍처

```text
Discovery Keep
    │
    ├─ source + METADATA_ONLY version 생성
    └─ SOURCE_ACQUISITION workflow 등록
             │
             ├─ URL/Content-Type 확인·리다이렉트 검증
             ├─ 원본 바이너리/HTML을 R2에 먼저 저장
             ├─ HTML 본문 추출 또는 PDF → Workers AI toMarkdown
             ├─ normalize + quality gate
             ├─ 새 source_version 생성(이전 버전 보존)
             ├─ FULLTEXT + READY일 때만 active version 승격
             └─ 승격된 자료만 basic/deep analysis 대상
```

수집 오케스트레이션은 기존 `research_jobs`/`ResearchJobWorkflow`를 확장한다. 별도 Queue나 외부 SaaS를 도입하지 않고, 기존 재시도·진행률·실패 진단 UX를 재사용한다. 자료별 원본 수집 상태는 기존 `processing_jobs`에 `stage = 'acquisition'`으로 기록한다.

### PDF 결정

발견된 원격 PDF는 다음 순서로 처리한다.

1. PDF 응답을 제한된 크기까지 읽고 R2에 원본을 저장한다.
2. Cloudflare Workers AI `toMarkdown()`으로 텍스트/Markdown을 추출한다.
3. 추출 결과를 `PDF_REMOTE_TO_MARKDOWN` 방법으로 저장한다.
4. 변환 실패·스캔 PDF·본문 부족은 `REVIEW` 또는 `EMPTY`로 남기고 심층 분석을 차단한다.

이 결정은 기존 D5의 “업로드 PDF는 브라우저 pdf.js”를 유지하면서 “발견 원격 PDF는 Worker에서 변환” 경로를 추가하는 것이다. 브라우저 렌더링은 사용하지 않는다.

## 4. 데이터 모델과 provenance

다음 마이그레이션을 추가한다.

### `source_versions` 추가 필드

- `text_scope`: `FULLTEXT | PARTIAL | METADATA_ONLY | EMPTY | UNKNOWN`
- `extraction_method`: `MANUAL_TEXT | BROWSER_PDFJS | HTML_STATIC | PDF_REMOTE_TO_MARKDOWN | DISCOVERY_METADATA | LEGACY`
- `extraction_error`: 사용자에게 노출 가능한 짧은 오류 코드
- `content_type`: 최종 응답의 MIME type
- `final_url`: 리다이렉트가 끝난 URL
- `acquired_at`: 원문 수집 완료 시각

수집 결과마다 새 `source_version`을 만들고 이전 버전은 삭제하지 않는다. `parent_version_id`로 메타데이터 버전에서 원문 버전으로 이어지는 관계를 유지한다.

`sources.quality_status`는 계속 active version의 품질을 요약하는 값으로 사용한다. 수집 범위·추출 방식의 진실한 값은 version에 둔다. 따라서 같은 자료도 재수집 전후의 차이를 확인할 수 있다.

### 상태 판정

| 조건 | `text_scope` | `quality_status` | 분석 허용 |
|---|---|---|---|
| 의미 있는 본문 1,000자 이상, 추출 경고 없음 | `FULLTEXT` | `READY` | basic/deep 허용 |
| 200~999자, 초록·요약·부분 본문 | `PARTIAL` | `REVIEW` | deep 차단 |
| 제목·저자·링크 중심 | `METADATA_ONLY` | `REVIEW` | deep 차단 |
| 본문 없음 또는 PDF 변환 실패 | `EMPTY` | `EMPTY`/`FAILED` | deep 차단 |

1,000자와 200자는 초기 운영 기준이며, 정량 로그를 모은 뒤 조정한다. 단순 글자 수만으로 `FULLTEXT`를 판정하지 않고 반복 라인 비율, 추출된 본문 비중, JS shell 의심 여부도 함께 본다.

## 5. 수집 흐름

### 5.1 Discovery Keep

`POST /api/discover/candidates/:id/keep`는 다음만 동기 처리한다.

- 후보 상태를 `KEPT`로 변경한다.
- 후보 메타데이터와 링크를 가진 `DISCOVERY` source를 생성한다.
- 원문이 아직 없으므로 초기 version은 `METADATA_ONLY`로 저장한다.
- `storedOriginal = null`로 제목 문자열을 원본 파일처럼 R2에 저장하지 않는다.
- `SOURCE_ACQUISITION` 연구 작업을 등록하고 `202`와 `sourceId`, `jobId`를 반환한다.

후보별 수집 URL은 provider에 따라 결정한다. OpenAlex는 OA URL/PDF URL을 우선하고, arXiv는 PDF URL을 우선한다. 최종 선택 URL과 후보의 외부 링크는 모두 metadata/provenance에 남긴다.

### 5.2 URL 안전성·수집

수집기는 다음을 공통 적용한다.

- `http`/`https`만 허용한다.
- localhost, loopback, link-local, 사설 IP와 금지된 리다이렉트 목적지를 차단한다.
- 요청 timeout, 응답 바이트 상한, 리다이렉트 횟수를 제한한다.
- `Content-Type`과 URL 확장자를 함께 사용해 HTML/PDF/지원 불가 유형을 판정한다.
- R2 저장 성공 전에는 추출·분석을 시작하지 않는다.
- 실패 코드는 `FETCH_TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`, `UNSUPPORTED_CONTENT_TYPE`, `SIZE_LIMIT`, `REDIRECT_BLOCKED`, `EXTRACTION_EMPTY`, `PDF_CONVERSION_FAILED`처럼 결정론적으로 기록한다.

### 5.3 HTML 추출

정규식으로 전체 HTML을 평탄화하는 현재 구현을 교체한다.

- `script`, `style`, `nav`, `footer`, `header`, `aside`, `noscript`와 명백한 쿠키/공유/광고 영역을 제거한다.
- `article`, `main`, `[role=main]`, 본문 class 후보를 수집한다.
- 후보별 텍스트 길이·문단 수·링크 비율·반복 라인 비율을 점수화해 본문 영역을 선택한다.
- 선택 결과가 없으면 body fallback을 쓰되 `fallback_body` 경고를 기록한다.
- title, description, site name, final URL을 version metadata에 저장한다.
- 짧은 JS shell은 `PARTIAL` 또는 `EMPTY`로 판정하고 “페이지는 열렸지만 본문을 가져오지 못함”으로 표시한다.

### 5.4 PDF 추출

- 응답 원본을 R2에 `originals/{sourceId}/v{n}.pdf`로 보존한다.
- `env.AI.toMarkdown()`에 PDF Blob을 전달한다.
- 변환된 Markdown을 `extracted_text`로 저장하고 기존 PDF 정규화 규칙을 적용한다.
- 이미지·스캔 중심으로 텍스트가 부족하면 원본은 보존하되 `PDF_CONVERSION_FAILED` 또는 `EMPTY`로 끝낸다.
- 변환 결과가 충분하면 새 version을 active로 승격하고 그 version id를 모든 basic/deep 분석에 연결한다.

## 6. 분석 진입 조건

`analyzeDeepSource()`는 본문 길이 40자 확인을 제거하고, active version을 다음 조건으로 검증한다.

```sql
v.text_scope = 'FULLTEXT'
AND s.quality_status = 'READY'
AND v.normalized_text IS NOT NULL
AND v.char_count >= 1000
```

조건 미충족 시 `deep_analysis_text_not_ready`와 현재 `text_scope`, `quality_status`, `char_count`를 반환한다. UI는 이를 오류가 아니라 “원문 수집이 끝나야 심층 정리를 시작할 수 있음” 상태로 표시한다.

basic 분석도 Discovery 자료에 대해서는 FULLTEXT 승격 이후에만 자동 실행한다. `PARTIAL`/`METADATA_ONLY`의 제목·초록은 후보 메타데이터로만 사용하고, 분석 결과처럼 저장하지 않는다.

분석 저장 시 `version_id`를 명시적으로 기록하고, 분석 응답 meta에 `textScope`, `charCount`, `extractionMethod`, `versionId`를 포함한다.

## 7. Reservoir UI/API

Reservoir 목록과 상세 API는 active version에서 다음 값을 반환한다.

- `textScope`
- `extractionMethod`
- `qualityStatus`
- `charCount`
- `contentType`
- `finalUrl`
- `acquiredAt`
- `acquisitionError`
- 원본 R2 존재 여부와 원문 보기/다운로드 가능 여부

접근 상태와 수집 상태를 분리해서 표시한다.

- `원문 저장됨 · 32,739자`
- `부분 본문 · 612자`
- `메타데이터만 저장됨`
- `원문 수집 실패 · PDF_CONVERSION_FAILED`
- `원본 보존됨 · 다시 가져오기`

기존의 URL만 보고 “접근 여부 미확인”을 표시하는 로직은 제거한다. 원문 보기에서는 HTML을 그대로 삽입하지 않고, 정규화된 텍스트를 안전한 plain text로 보여준다. 원본 파일/스냅샷은 별도 다운로드 링크로 제공한다.

`심층 정리하기` 버튼은 `FULLTEXT + READY`가 아닐 때 비활성화하고, 필요한 조건을 짧게 안내한다. `다시 분석하기`와 `다시 가져오기`를 분리한다. 다시 분석하기는 기존 본문을 재분석하고, 다시 가져오기는 URL/PDF 수집부터 새 version을 만든다.

## 8. 기존 자료 보정

배포 후 기존 `origin LIKE 'discovery:%'` 자료 중 active version이 `METADATA_ONLY` 또는 200자 미만인 자료를 대상으로 일회성 재수집을 실행한다.

- 기존 version과 분석 결과는 삭제하지 않는다.
- 새 수집이 성공하고 품질이 좋아질 때만 active version을 변경한다.
- 실패한 자료는 링크·제목·실패 코드가 남은 상태로 유지한다.
- RISS 등 외부 수신 확인은 별도 인증/공식 API 수집 문제가므로, 이번 범위의 일반 URL/PDF 수집기와 분리된 provider adapter 작업으로 남긴다.

RSS 파서에는 CDATA 제거를 추가한다. 예: `<![CDATA[Title]]>` → `Title`. 이 정규화는 표시, 제목 dedup, 후보 저장 전에 한 번만 적용한다.

## 9. 검증 계획

### 단위 테스트

- HTML에서 article/main 선택과 nav/footer 제거
- JS shell, body fallback, 반복 라인 경고
- PDF `toMarkdown()` 성공/실패/빈 결과
- content scope·quality 판정 경계값
- CDATA title/summary 정규화
- SSRF·리다이렉트·응답 크기 제한

### 통합 테스트

- Discovery Keep가 metadata-only source와 acquisition job을 만든다.
- HTML 후보 성공 시 R2 원본 + 새 version + active 승격이 발생한다.
- PDF 후보 성공 시 PDF 원본 + Markdown version + provenance가 남는다.
- 수집 실패 시 source는 삭제되지 않고 deep job은 차단된다.
- 제목만 있는 기존 source가 심층 분석을 통과하지 못한다.
- 기존 수동 URL 자료의 재분석 동작은 원문 재수집과 혼동되지 않는다.

### 수동 회귀 확인

- 실제 HTML article 1개
- 실제 PDF 논문 1개
- JS shell 페이지 1개
- PDF 변환이 실패하는 스캔 문서 1개
- 현재 Reservoir의 `Photography & Automation — A Detailed Timeline` 자료

마지막 자료는 이미 32,739자 원문이 있는 정상 케이스이므로, 이번 변경 후에도 원문 표시·심층 정리·version provenance가 유지되는지 확인한다.

## 10. 문서 반영 순서

구현 완료 시 다음 문서를 함께 갱신한다.

1. `docs/SPEC.md`: D5에 발견 원격 PDF의 Worker `toMarkdown` 경로 추가
2. `docs/DEV_PLAN.md`: 새 migration, `SOURCE_ACQUISITION`, 품질 gate, UI/API acceptance criteria 추가
3. `docs/PROJECT_CONTEXT.md`: 실제 운영 상태와 실패 코드·재수집 절차 기록

이 문서 승인 후에만 세부 구현 계획을 작성하고, 그 다음 구현 단계로 이동한다.
