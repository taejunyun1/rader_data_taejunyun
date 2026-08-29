# Research Radar — 내부 참조 가이드

최종 정리: 2026-08-23

이 문서는 다음 작업자가 프로젝트의 기획 의도, 현재 구현, 운영 원칙을 빠르게 이어받기 위한 요약본이다. 요구사항을 새로 정의하지 않으며, 제품 결정은 아래 Source of Truth 문서를 따른다.

## 1. 문서 우선순위

1. `docs/spec-v0.1.txt` — 원본 제품·기술·운영 스펙
2. `docs/SPEC.md` — V0 확정 결정사항. 1번과 충돌하면 이 문서 우선
3. `docs/DEV_PLAN.md` — 구현 순서와 acceptance criteria
4. `docs/V1_GUIDE.md` — 이미 추가된 V1/V2 기능과 운영 설명
5. 이 문서 — 위 문서를 실제 작업에 적용하기 위한 현재 상태·주의점 요약

기능을 추가할 때는 먼저 어느 문서의 어느 결정에 근거하는지 확인한다. 문서에 없는 범위 확장이나 중요한 설계 변경은 구현 전에 사용자에게 이유·대안·영향을 제시한다.

## 2. 제품 정체성

Research Radar는 사진작가 윤태준의 개인 연구 편집 도구다. 챗봇이 아니며, 핵심 자산은 AI 출력이 아니라 Reservoir다.

핵심 사이클:

```text
입력 → 원본 R2 보존 → D1 Reservoir → 저비용 분석/인덱싱
     → 사용자 신호 → Distill → Critic/Counter
     → 인간 선택 → 다음 연구 방향
```

중요 원칙:

- Reservoir First: 자료가 먼저 축적되고 AI는 그 위에서 작동한다.
- Provenance First: 원본과 출처를 잃지 않는다. 합성·해석·제안은 원본과 구분한다.
- Cloudflare-first / serverless-first / external-minimal
- 사용자가 직접 조정하는 공개 파라미터는 5개뿐이다.
- UI는 한국어 중심으로 제공한다. 원문·논문 제목·저자·출처명과 내부 파이프라인 명칭은 원어를 보존하거나 병기한다.
- 모델명은 코드에 고정하지 않고 `wrangler` vars로 관리한다.
- V0에서 챗봇, 멀티유저, Admin, Knowledge Graph UI, Google Drive, 로컬 Obsidian 상시 싱크, Semantic Search는 기본 범위가 아니다.

## 3. 현재 구현 기준

저장소는 `main` 단일 브랜치를 기준으로 운영한다.

- `worker/`: Hono API, cron, D1/R2/Workers AI/AI Gateway
- `web/`: Vite + React SPA
- `shared/`: Worker와 Web의 공통 타입
- `worker/migrations/0001~0016`: 초기 스키마, Queue 검증, V1 기능, topic, snapshot synthesis, 수신 자료 버전·정규화 검수, inbox exclusions, distill counter 옵션, research jobs/discovery lanes, `discovery_candidates.source_id` + `discovery_field_signals`, 원격 원문 provenance + `SOURCE_ACQUISITION`, `ai_budget_reservations`
- 배포 대상: `radar.taejunyun.com`
- 패키지 매니저: `pnpm@11.21.0`

현재 기능 묶음:

| 영역 | 현재 상태 | 기준 |
|---|---|---|
| Ingestion/Reservoir | 텍스트·URL·MD·PDF·홈페이지 import, dedup, R2 원본 보존, Discovery Keep 원격 HTML/PDF 수집, active-version provenance/plain-text 원문 | V0 필수 + 원격 수집 보강 |
| Analysis | 기본 Workers AI 분류·요약·키워드·질문·fragment·topic + 사용자 요청 심층 정리(source_analysis deep) | V0 + 확장 |
| Search | D1 키워드/메타 검색 + Vectorize semantic search | Semantic은 V1 확장 |
| Distill | context selection, Distill/Critic/Counter, Re-distill, 비용 원장 | V0 필수 |
| Reading Queue | OpenAlex 존재 검증과 verified 표시 | V0 필수 |
| Radar | 주/월/년 통계·합성 UI, 주간 snapshot cron | V0 필수 |
| Discovery | 홈페이지·읽을거리 시드 + OpenAlex + arXiv + 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic) + 현장 신호 RSS(CAA News, Association for Art History, ICP) + 출처 디렉터리 | RISS·KCI·Google Scholar·Scopus·Web of Science와 기타 미술관·사진기관은 공식 API/RSS가 검증되기 전 자동 수집하지 않음 |
| Obsidian | CLI sync와 버전 히스토리 | V1 확장, V0 아님 |
| Usage | 월 비용·목적·모델·일별 차트 | V2 확장 |
| Export | JSON/Markdown/CSV 및 R2 원본 백업 | V0 필수 |

Discovery 읽을거리는 제목·초록·RSS 요약에 연구 기준어가 실제로 포함되고 관련도 0.65 이상일 때만 등록한다. OpenAlex는 OA URL, arXiv는 PDF, RSS HTML은 검증된 출처의 `FREE_FULLTEXT` 정책이 필요하다. Artforum·ARTnews·기관 인증 링크·접근 미확인 HTML은 후보에서 제외한다. 실행 상한은 8건(OpenAlex 4·arXiv 2·RSS 2)이며 RSS는 1차로 출처별 한 건씩 선택한다. 기본 읽을거리 피드는 KV fallback이 아니라 정적 레지스트리에서 매 실행 구성하고, KV에는 레지스트리에 없는 사용자 커스텀 피드만 최대 6개 저장한다. RISS·KCI·Google Scholar·Scopus·Web of Science 결과 페이지를 크롤링하지 않는다.

Discovery 현장 신호는 CAA News·Association for Art History·ICP 공식 RSS를 읽을거리와 별도로 수집한다. 관련도 0.55, 회당 최대 12건, 출처당 최대 4건이며 `NEW`·`SAVED`·`DISMISSED` 상태를 사용한다. 오래된 게시물은 `STALE`, 마감·행사가 지난 항목은 `EXPIRED`로 제외한다. Save는 Reservoir source를 만들지 않는다. 실행 결과는 읽을거리 `diagnostics`와 현장 신호 `fieldSignalDiagnostics`를 함께 보존하며, 출처별 요청·성공·실패·수신·관련성 탈락·오래됨·종료됨·중복·quota·선정 수를 구분한다. 정상 응답 후 0건은 오류가 아닌 유효한 빈 결과다.

### 3-1. 현재 UI 읽기 흐름

전체 UI는 `레이더 → 발견/저장소에서 읽기 → 판단/분류 → 착즙 → 다시 읽기` 순서를 우선한다.

- 레이더는 `선택 기간 정량 요약 → 해석 서사 → 지금 직접 읽기와 다음 행동 → 상세 연구 정보` 순서다. 신규 키워드·판단·자료 구성은 최상단에 한 번만 표시하고, 자료 구성은 전체 누적임을 명시한다. 장기 연구 지형은 접힌 상세 영역으로 제공한다.
- 발견과 저장소는 목록·읽기·판단을 한 작업공간에 배치한다. 후보의 실제 링크와 접근 상태를 함께 표시한다.
- 발견과 저장소의 데스크톱 읽기 작업공간은 목록과 읽기 pane을 동시에 유지하고 각각 독립적으로 스크롤한다. 자료를 바꾸면 읽기 pane만 맨 위로 이동하며 목록 위치는 보존한다. 필터 응답은 해당 목록 세대의 권위 있는 결과이며, 선택 자료가 결과에서 빠지면 상세·판단을 함께 해제한다. 짧은 화면에서 작업공간이 아직 화면 밖이면 기본 pane 높이를 유지하고, 화면에 들어온 뒤 남은 높이에 맞춘다. 900px 이하에서는 목록과 읽기를 한 번에 하나만 표시하고 `목록으로`로 돌아간다. 자료 선택은 읽기만 열고, 판단 바텀시트는 `판단하기` 또는 `판단 변경`을 눌렀을 때만 연다.
- 저장소에서 `보관하기` 또는 `발전시키기`를 누른 자료는 다음 착즙 실행 전까지 `다음 리서치` 마크로 유지한다. 다음 착즙 컨텍스트에서 우선 포함하고, 이후에는 자동으로 다음 사이클 마크에서 빠진다. `관찰하기`·`제외하기`를 나중에 누르면 해당 마크를 해제한다.
- 저장소 판단은 목록 배지와 상세 바텀시트의 현재 상태로 즉시 확인한다. `제외하기` 자료는 기본 목록에서 숨기되 삭제하지 않고 `제외됨` 필터에서 복구·판단 변경할 수 있으며, `관찰 중` 자료는 기본 목록에 남긴다.
- 착즙은 문서 목차와 읽기 큐를 제공하며, OpenAlex 검증 전 큐 항목의 저장소 승격을 막는다. `반대 관점 포함`은 기본 켜짐이고 실행 전에 끌 수 있으며, 켜진 Counter는 정면 반대 명제와 정합성 검증 상태를 함께 표시한다.
- 받은편지함은 메모·URL·파일을 원본 보존 우선으로 접수하고 처리 실패를 재시도 가능하게 표시한다.
- 받은 자료는 `수신 경로(MANUAL/OBSIDIAN/DISCOVERY/HOMEPAGE)`와 `입력 형식(플레인 텍스트/마크다운/Obsidian/PDF/URL 등)`을 별도로 기록한다. 원본(R2), 추출문, 정규화문을 분리하고 품질 상태(`검수 전/분석 가능/검토 필요/읽을 텍스트 없음/처리 실패`)를 표시한다.
- Discovery Keep은 먼저 metadata-only source/version을 보존하고, usable HTTP(S) URL이 있으면 `원문 수집` background job을 시작한다. 완료된 job의 Reservoir 결과는 외부 접근 상태와 별도로 `TextScope`·추출 방식·품질·글자 수를 표시하며, 저장된 normalized text는 plain text로만 연다.
- Inbox에서 자료를 선택하면 원본 열기, 정규화 품질 리포트, 버전 이력, 다시 추출·다시 정규화·다시 분석·버전 승격을 한 흐름으로 확인한다. 기존 자료는 백필 API를 최대 20건씩 실행해 정규화한다.
- Obsidian 자동 동기화는 현재 활성 버전이 수동 편집본이면 새 버전을 `검토 대기`로 보존하고 자동 승격하지 않는다. 사용자가 버전을 확인·승격해야 한다.
- 설정과 사용량은 한국어 운영 문구와 월 예산 상태(NORMAL/WARNING/BLOCKED)를 사용한다.

## 4. 데이터와 provenance 규칙

자료 입력의 표준 순서는 다음과 같다.

```text
식별 → DOI/URL/title+author/hash dedup → R2 원본 저장
→ 추출 텍스트 저장 → Workers AI 해석 저장
→ keywords/questions/fragments 인덱싱 → 필요 시 embedding → indexed
```

- `sources`는 자료의 정체성·상태·출처를 가진다.
- `source_versions`는 R2 object와 추출 텍스트의 버전 기록이다.
- `source_analysis`는 `INTERPRETATION` 성격이며 기본 분석(`basic`)과 심층 정리(`deep`)를 분리한다. Distill/Radar 결과는 `SYNTHESIS` 성격으로 취급한다.
- 자동 Discovery 후보는 사용자가 Keep하기 전 Reservoir 핵심 자료로 승격하지 않는다.
- OpenAlex에서 검증되지 않은 Reading Queue 항목을 실존 자료처럼 표시하거나 Reservoir로 가져오지 않는다.
- 중복이면 새 source를 만들지 않고 기존 source에 재수입 provenance를 기록한다.

### 4-1. Discovery 원격 원문 수집 계약

```text
사용자 Keep → DISCOVERY_METADATA / METADATA_ONLY version
→ SOURCE_ACQUISITION job(usable URL이 없으면 LINK_ONLY)
→ 공유 public URL·DNS·redirect·timeout·body-size safety boundary 검증
→ raw HTML/PDF R2 PUT
→ HTML_STATIC 또는 PDF_REMOTE_TO_MARKDOWN
→ normalize + TextScope/quality 판정
→ 새 source_version 추가 → 품질 향상 시에만 active 승격
```

- Inbox URL 수집, `POST /api/inbox/:sourceId/reextract`, query 없는 legacy retry, `POST /api/inbox/retry/:sourceId?fetch=1`, Discovery Keep acquisition, RSS fetch는 모두 같은 public HTTP(S) URL/DNS/redirect/timeout/body-size safety boundary를 공유한다. HTML/PDF 본문 상한은 20 MiB, RSS/XML 본문 상한은 2 MiB다.
- 업로드 PDF는 기존 `BROWSER_PDFJS`, 발견 원격 PDF만 Workers AI `env.AI.toMarkdown`을 사용한다. 정적 HTML만 추출하며 JS 렌더링, 로그인/유료 콘텐츠 우회, headless browser는 사용하지 않는다.
- 개인 업로드 PDF는 텍스트·작은 미리보기와 함께 비공개 R2 원본을 `source_versions.r2_key`에 보존한다. 활성 PDF의 원본 key와 R2 object가 모두 확인될 때만 브라우저 페이지 단위 시각 추출을 시작하며, 원본이 없는 레거시 자료는 같은 자료에 PDF를 다시 첨부해 `REEXTRACT` 버전으로 복구한다. PDF 원본은 자동 삭제하지 않는다.
- 원격 HTML/PDF는 변환 전에 raw body를 먼저 R2에 보존한다. `text/html`·`application/xhtml+xml`·`text/plain`은 URL 확장자보다 우선해 `.pdf` URL이어도 `HTML_STATIC`으로 처리한다. PDF 변환은 (a) `application/pdf` 응답이면서 첫 1 KiB 안의 `%PDF-` magic signature가 있거나, (b) `application/octet-stream`이지만 최종 URL이 PDF-like이고 같은 signature가 있을 때만 `toMarkdown`을 사용한다. `application/pdf`의 signature 불일치도 raw object는 남긴 채 `PDF_SIGNATURE_INVALID`로 실패한다.
- `TextScope`: `FULLTEXT`, `PARTIAL`, `METADATA_ONLY`, `EMPTY`, `UNKNOWN`. 품질: `UNREVIEWED`, `READY`, `REVIEW`, `EMPTY`, `FAILED`. 현재 gate는 의미 글자 0자=`EMPTY`, discovery metadata/200자 미만=`METADATA_ONLY`, 1,000자 미만 또는 warning 존재=`PARTIAL`, 그 외=`FULLTEXT + READY`다. 레거시 활성 버전의 `PARTIAL/METADATA_ONLY/EMPTY + UNREVIEWED` 불일치는 `0026_legacy_acquisition_quality.sql`에서 보정하며, 저장소 API도 같은 규칙으로 방어한다.
- 심층 정리 gate는 active version의 `FULLTEXT + READY`, `char_count >= 1000`, non-empty `normalized_text`를 모두 요구한다. 실패 응답은 HTTP 422 `deep_analysis_text_not_ready`와 `textScope`, `qualityStatus`, `charCount`다. 월 예산 차단은 별도로 HTTP 429 `monthly_budget_exhausted`다.
- `DEEP_ANALYSIS`는 route의 빠른 월 사용량 체크와 별도로 workflow 실행 시 D1 `ai_budget_reservations` reservation을 더한 월 budget을 최종 판정으로 사용한다. reservation은 `research_job_id` 기준 retry-safe/idempotent하며, 성공 completion step과 실패 handler 모두에서 release되고 실제 확정 비용은 기존 `ai_usage`에 남는다.
- `GET /api/reservoir/:sourceId/original-text`는 active version의 `normalized_text`만 최대 500,000자까지 `text/plain; charset=utf-8`와 `X-Content-Type-Options: nosniff`로 반환한다. raw HTML/PDF는 R2 provenance이며 이 endpoint에서 렌더링하지 않는다.
- 재처리 구분: `POST /api/inbox/retry/:sourceId?fetch=1`은 canonical URL을 새 `SOURCE_ACQUISITION` job/version으로 다시 가져오고, `?analyze=1`은 현재 active version만 다시 분석한다. query 없는 legacy retry와 `POST /api/inbox/:sourceId/reextract`도 같은 안전 수집 경계를 거친다.
- job 상태는 `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`다. 원격 수집 오류는 `FETCH_TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`, `UNSUPPORTED_CONTENT_TYPE`, `SIZE_LIMIT`, `REDIRECT_BLOCKED`, `PDF_SIGNATURE_INVALID`, `EXTRACTION_EMPTY`, `PDF_CONVERSION_FAILED`; version 저장 오류는 `source_version_store_failed`; 품질 미달 processing 오류는 `text_not_ready`다. Workflow의 일반 실패 `error_code`는 `workflow_runtime_failed`이고 원래 원인은 job error와 `processing_jobs.error`에 남는다. fetch/extraction이 version 추가 전에 실패하면 실패용 `source_version`을 만들거나 active로 승격하지 않으므로, Reservoir는 기존 `DISCOVERY_METADATA/METADATA_ONLY` active version과 심층 정리 차단 상태를 그대로 표시한다.
- RSS title/summary는 `cleanDiscoverySourceText`에서 CDATA wrapper, XML entity, HTML tag, 중복 공백을 정리한 뒤 관련성·중복 판정에 사용한다. 사용자 custom feed는 저장 시점에도 같은 public URL boundary를 거쳐 localhost/private/non-HTTP(S)/malformed 값을 거부하고, 본문 2 MiB 초과 feed는 `SIZE_LIMIT`로 처리한다.
- historical web backfill은 `POST /api/settings/backfill-discovery`로만 실행한다. `origin LIKE 'discovery:%'` 또는 `origin = 'homepage-reading'`이고 active version이 `FULLTEXT`가 아니거나 1,000자 미만인 자료를 오래된 순으로 회당 최대 10건 선택하며, canonical URL이 없거나 active dedupe job이 있으면 skip한다. 공개 정적 HTML/PDF는 raw를 R2에 먼저 보존한 뒤 본문을 추출하며, JS 렌더링·로그인·paywall 우회는 하지 않는다. 이 backfill과 Keep acquisition에는 자동 cron이 없다. 기존 주간 Discovery 후보/현장 신호 수집 cron은 그대로 별도 운영한다.
- 홈페이지 읽을거리 R2 sync의 curated summary는 `HOMEPAGE_JSON / METADATA_ONLY / DISCOVERY_METADATA / REVIEW`다. 기존 `FULLTEXT / MANUAL_TEXT` 초기 summary는 `0024_homepage_summary_scope.sql`에서 text·hash·R2 key·version identity를 바꾸지 않고 provenance만 보정한다.
- remote 4xx 진단은 기존 `HTTP_4XX` code 아래 status와 `ACCESS_CHALLENGE` detail을 보존한다. Workflow `error_code`는 계속 `workflow_runtime_failed`이며 Job Center는 raw exception 대신 영구 접근 제한과 일시 실패를 구분한다.

### 4-2. Visual Reservoir 추출·권리·보존 경계

- 시각 추출 대상은 세 종류뿐이다. 저장된 원격 HTML source는 `HTML_STATIC`, 저장된 원격 PDF source는 `PDF_REMOTE_TO_MARKDOWN`, 개인 업로드 이미지는 `PERSONAL_UPLOAD` provenance로 취급한다. JS 렌더링 웹페이지, 로그인 우회, live browser scraping, 외부 작품 이미지의 임의 영구 저장은 Task 10 범위가 아니다.
- HTML 시각 추출은 이미 raw body를 R2에 보존한 source version에서만 시작한다. `<img>`/`<picture>` 등 정적 후보만 다루며, 광고·tracking pixel·반복 로고·장식 이미지는 기본 목록에서 제외할 수 있지만 원본 provenance와 제외 이유는 남긴다. “0건”은 정상 결과이고 실패와 같은 상태로 합치지 않는다.
- PDF 시각 추출은 page 단위 unit, crop temp object, bbox provenance를 유지한다. 진행 상태는 page checkpoint 기준으로 이어지며, page/crop temp object는 성공 직후 즉시 삭제를 시도하고 남은 terminal-run temp object는 24시간 cleanup 대상이다. 활성 run 또는 최근 run의 temp object는 정리 대상이 아니다.
- 개인 이미지는 업로드 raw object를 원본으로 보존한 뒤 분석/요약/연결을 진행한다. 실패한 개인 이미지는 같은 asset/job에서 retry할 수 있지만, retry가 새 권리나 새 source 연결을 자동 생성하지는 않는다.
- rights gate의 실제 `rights_status` enum은 `PERSONAL`·`PERMITTED`·`PUBLIC_LINK`·`UNKNOWN`·`RESTRICTED`다. `PERSONAL`은 사용자 소유/개인 작업의 권리 상태이고 별도의 `USER_OWNED` 값은 없다. 외부 권리 불명·제한 또는 증빙 없는 자산(`UNKNOWN`·`RESTRICTED`·`PUBLIC_LINK`)은 기본적으로 `storageState=LINK_ONLY`이며 persistent visual bytes를 자동 보존하지 않는다. `PERMITTED` 전환에는 명시적 근거가 필요하고, 근거 없이 deep visual analysis나 장기 보존을 허용하지 않는다.
- `storage_state`와 asset version variant는 서로 다른 namespace다. `storage_state`의 실제 enum은 `ARCHIVAL`·`CAPSULE`·`TEXT_ONLY`·`LINK_ONLY`이며, `ORIGINAL`은 storage state가 아니라 `visual_asset_versions.variant` 값(`ORIGINAL`·`CAPSULE`·`SVG_SOURCE`)이다. 따라서 `storageState=ARCHIVAL`에서 `ORIGINAL` variant를 보존할 수 있고, `storageState=CAPSULE`은 원본 삭제 후 `CAPSULE` variant만 남기는 보존 상태를 뜻한다. 개인/허용 자산은 권리와 확인 범위 안에서 `ORIGINAL` + `CAPSULE` variant를 유지할 수 있지만, `TEXT_ONLY` 전환은 명시 확인이 필요하고 외부 rights-gated 자산에는 허용되지 않는다. delete/transition 실패는 operation log와 기존 asset state를 남겨 복구·재시도 가능해야 한다.
- suggestion 상태는 `AUTO_SUGGESTION`과 `USER_VERIFIED`를 분리 저장한다. 사용자의 검토 없이 모델 제안을 확정 상태로 덮어쓰지 않는다. source assignment도 미연결 asset을 특정 source에 연결하는 조작일 뿐, 권리 상태나 provenance를 묵시적으로 바꾸지 않는다.
- retry 경계는 단계별이다. 개인 이미지 retry는 실패 asset/job를 다시 처리하고, PDF/HTML extraction retry는 기존 stored source를 다시 추출한다. fetch retry, analyze retry, visual retry를 혼동해 한 번의 버튼으로 원격 재수집·재분석·권리 전환을 모두 수행하지 않는다.
- filter 경계는 기본 노출 목록을 안전하게 줄이기 위한 UX 계약이다. 광고·tracking·중복·장식으로 분류된 후보는 기본 리스트에서 숨길 수 있지만, 복구 경로와 필터 이유를 제공해야 한다. 필터는 source provenance를 삭제하지 않으며, 사용자가 복구한 자산은 이후 review/assignment 흐름에 정상 진입해야 한다.
- 운영 진단은 정상 0건, 일부 unit 실패, 권리 차단, 월 예산 차단, filtered recovery, cleanup failure를 서로 다른 상태로 설명해야 한다. Job Center/inspection payload에는 run 상태, 추출/중복/filtered/rights-gated/cleanup-failure count, bbox/page provenance, retry 가능 단계가 남아야 한다. 월 예산 차단은 `monthly_budget_exhausted`, 심층 분석 gate 미충족은 `deep_analysis_text_not_ready` 또는 visual review fallback으로 분리 기록한다.

## 5. 작업 시 반드시 확인할 설계 경계

### Radar synthesis 실행 주체

기획 문서와 운영 가이드의 기본 결정은 “snapshot은 cron, synthesis는 사용자 실행”이다. 자동 주간 synthesis를 추가하거나 유지하려면 비용·사용자 통제·실패 재시도 정책을 먼저 확정한다.

### Reading Queue → Reservoir 승격

승격 기능은 단순히 source를 만드는 것만으로 완료되지 않는다. 다음 상태가 함께 추적되어야 한다.

- 원 queue item과 생성/중복 source의 명시적 연결
- import 완료/실패 상태와 재시도 가능성
- OpenAlex verified 여부
- 검증되지 않은 항목의 승격 차단
- 정확한 OpenAlex ID 매칭. 검색 결과의 임의 첫 항목을 fallback으로 사용하지 않는다.

### V1/V2 기능의 취급

Semantic Search, Obsidian CLI, arXiv/RSS, Usage dashboard는 이미 구현된 확장 기능이지만 V0 스펙을 조용히 변경한 것으로 취급하지 않는다. 수정 시 V0 필수 흐름을 깨지 않고, 관련 문서에 확장 범위를 남긴다.

## 6. AI와 비용 정책

- Workers AI: 분석·분류·embedding 등 저비용 작업
- AI Gateway → OpenAI: Distill/Critic/Counter/Radar synthesis
- 모델명은 `MODEL_HIGH`, `MODEL_LOW` 등 config에서 주입
- 설정 → AI 모델 역할에서 `기본 모델`과 `상위 통합·반론 검증 모델`을 선택할 수 있다. 모델 목록은 서버가 OpenAI 모델 목록 API에서 가져오되 `MODEL_CURATED_IDS_JSON`에 등록한 검증된 대표 모델만 노출한다. 저장값은 `ai_model_roles_v1` KV에 보관한다. 연결 시험을 통과한 이후의 호출부터 적용하고, 설정이 없거나 목록 조회가 실패하면 `MODEL_HIGH`·`MODEL_DEEP`로 복귀한다.
- 긴 자료 심층 정리는 청크 읽기·초벌 정리에 기본 모델을 사용하고, 최종 통합에 상위 모델을 사용한다. Distill은 초안은 기본 모델, Critic·Counter 검증·실패한 Counter 재검토·Radar 합성은 상위 모델을 사용한다.
- `ai_usage`에 호출별 token/cost/purpose를 기록
- 월 예산은 기본 `$10`, 80% 경고, 100% Distill 중단
- 자동 작업을 추가할 때도 예산 초과 가능성과 guardrail 적용 범위를 확인한다.
- OpenAI 호출은 `ai_call_attempts` 원장에서 결정적 idempotency key로 예약·호출·정산 상태를 추적한다. 실제 token usage만 `ai_usage`에 기록하며 정산 실패는 `usage_settlement_required`로 성공을 막는다. Workers AI 시각 호출은 실제 비용을 임의로 청구하지 않고 0달러로 원장에 정산한다.
- 예약 원장에는 stale lease 회수 경계가 있으며, terminal job의 오래된 예약만 회수한다. 실행 중인 job의 예약은 cron이 임의로 해제하지 않는다.

### 6-1. 예약 작업과 인증 경계

- cron은 `0 * * * *` 시각 임시 파일·dispatch pending·안전한 AI 예약 정리, `0 1 * * *` homepage reading 동기화, `0 3 * * 1` snapshot 통계·Discovery만 담당한다. 주간 cron은 AI Radar synthesis를 호출하지 않으며 synthesis는 명시적인 사용자 작업으로만 실행한다.
- 모든 cron 실행은 `system_runs`의 `(kind, window_key)` 유일 키로 중복 전달을 흡수하고, 형제 작업 하나가 실패해도 다른 결과를 보존한 채 `PARTIAL`로 기록한다. 알 수 없는 cron 문자열은 no-op으로 종료한다.
- production에서 Cloudflare Access domain/audience가 없으면 API는 fail closed한다. local development/test에서만 명시적으로 우회하며, 사용자 식별자는 검증된 Hono identity에서 읽는다.
- API JSON 본문은 선언된 `Content-Length`와 chunked reader 양쪽에서 상한을 검사하고, multipart 업로드도 파일 상한 전에 요청 길이를 검사한다. API 오류는 request id를 포함한 `{ error, requestId, details? }` 형태로 반환한다.
- Workflow dispatch는 job id를 Workflow instance id로 사용하며, enqueue 경쟁에서 partial unique index의 승자를 반환한다. dispatch 실패는 `QUEUED + dispatch_pending`으로 남겨 동일 job id를 reconciliation에서 재시도하고, terminal job 상태는 compare-and-set으로 stale replay가 덮어쓰지 못한다.

## 7. 작업·검증·배포 규칙

```bash
pnpm i
pnpm typecheck
pnpm build
pnpm dev
pnpm db:migrate
pnpm deploy
```

코드 변경 전후 순서:

1. 이 문서와 `AGENTS.md`, 관련 SPEC/DEV_PLAN 절을 읽는다.
2. 작업트리와 `main`/`origin/main` 상태를 확인한다.
3. 스키마 변경이면 migration을 추가하고 원격 적용 순서를 기록한다.
4. `pnpm typecheck && pnpm build`를 통과시킨다.
5. `git diff --check`와 실제 변경 목록을 확인한다.
6. 커밋 메시지는 `YYMMDD: 변경 내용 요약` 형식을 사용한다.
7. 배포가 필요한 경우 코드 push와 원격 D1 migration 적용을 별도 단계로 확인한다.

현재 저장소는 `main`을 최신 기준선으로 유지하며, 작업용 브랜치를 별도로 남기지 않는다. 브랜치 삭제 전에는 원격 목록과 미병합 커밋을 확인하고 `main` 및 보호 대상은 삭제하지 않는다.

## 8. 빠른 참조 경로

- API 진입점: `worker/src/index.ts`
- ingestion/provenance: `worker/src/ingestion/`
- 활성 버전 정책: `worker/src/ingestion/versioning.ts`
- AI 분석: `worker/src/analysis/`
- Distill: `worker/src/distill/`
- Radar: `worker/src/radar/`
- D1 migration: `worker/migrations/`
- 주요 UI: `web/src/views/`
- 운영 변수: `worker/wrangler.jsonc`, secrets는 `wrangler secret put`으로 관리
