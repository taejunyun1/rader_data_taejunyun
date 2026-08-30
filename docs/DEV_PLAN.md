# Research Radar — V0 개발 계획

스펙: `docs/spec-v0.1.txt` (원본) + `docs/SPEC.md` (v1.0 확정 결정)
원칙: 계획 위반/변경 필요 시 임의 결정하지 말고 사용자에게 제안(D-cide 노트 준수)

## Overview

사진작가 개인 연구 시스템. 자료 수집 → Reservoir(D1/R2) 축적 → 관심 신호 집계 → Distill(OpenAI) → Critic/Counter → 인간 선택 기록의 사이클을 Cloudflare Workers 단일 스택으로 구축. V0는 단일 사용자(윤태준)가 실제로 매일 쓸 수 있는 상태를 목표로 한다.

## Architecture Decisions

- **Worker 단일 앱 + Static Assets**: API(Hono)와 SPA를 한 Worker에서. 별도 Pages 불필요 (D7)
- **D1 텍스트 검색**: FTS 없이 인덱스 컬럼 + LIKE. 개인 규모(수천 건)에서 충분. 병목 시 Vectorize 검토(스펙 명시)
- **원격 원본은 R2 보존 후 처리**: Discovery Keep 원격 응답은 raw HTML/PDF를 R2에 먼저 저장한 뒤 추출하며 extraction 실패 후에도 저장된 raw object를 유지(원격 fetch 자체가 실패한 경우 제외)
- **모델 2계층**: Workers AI(무료할당) = 분류/요약/키워드, AI Gateway→OpenAI = Distill/Critic/Counter/Radar synthesis (D10)
- **PDF는 업로드 시 브라우저 pdf.js, 발견 원격 PDF는 R2 보존 후 Workers AI `toMarkdown`** (D5), **Obsidian은 .md 업로드** (D3), **홈페이지는 소스 데이터 import** (D2)
- **Discovery = 홈페이지 키워드 시드 + 홈페이지 읽을거리 R2 sync + OpenAlex/arXiv/공개 RSS, 주간 후보 탐색 cron, 자동 수집 상한** (D6). 후보 Keep 원문 수집과 historical backfill은 사용자 동작이며 자동 cron이 아니다.

## D1 초기 스키마 (Phase 1 마이그레이션)

스펙 테이블 그대로, 과도한 정규화 금지:

```
sources(id, kind, title, authors, year, canonical_url, doi, file_hash,
        reliability, provenance_class, status, origin, r2_key, created_at)
source_versions(id, source_id, version, r2_key, extracted_text, created_at)
source_analysis(id, source_id, version_id, analysis_type, model, payload_json, created_at)
keywords(id, source_id, keyword, weight, created_at)
questions(id, source_id, question, status, created_at)
fragments(id, source_id, text, context_json, created_at)
threads(id, title, status[SEED|QUESTION|THREAD|DIRECTION|DEVELOPING|ARCHIVED], note, created_at)
thread_links(thread_id, source_id, keyword)
directions(id, thread_id, kind[RESEARCH|ARTWORK], text, status, created_at)
user_signals(id, source_id, action[import|view|select|keep|watch|develop|ignore],
             weight, context, created_at)
radar_snapshots(id, period[WEEKLY|MONTHLY|YEARLY], window_start, window_end,
                stats_json, created_at)
distill_sessions(id, input_context_json, sources_used_json, output_json,
                 critic_output_json, counter_output_json, user_selection_json,
                 redistill_of, model_version, prompt_version, cost_usd, created_at)
reading_queue(id, distill_session_id, title, author, source_url, openalex_id,
              priority[MUST|WORTH|REFERENCE], why_read, related_question, created_at)
research_gaps(id, distill_session_id, gap_text, kind, created_at)
discovery_candidates(id, openalex_id, title, authors, year, abstract, relevance_score,
                     status[CANDIDATE|KEPT|WATCHED|IGNORED], query_used, created_at)
processing_jobs(id, source_id, stage, status[received|stored|extracted|analyzed|indexed|failed],
                error, retry_count, updated_at)
ai_usage(id, month, provider, model, input_tokens, output_tokens, cost_usd, purpose, created_at)
```

## Phase 0 — 인프라 & 스캐폴드

### Task 0.1: 모노레포 스캐폴드
pnpm workspaces — `worker/`(Hono+TS strict), `web/`(Vite+React+TS), `shared/`(타입).
**AC**: `pnpm i && pnpm -r build` 성공, `wrangler dev`에서 `/api/health` 200.
**Files**: 루트 설정 4–5개, 각 패키지 스켈레톤. **Scope: M**

### Task 0.2: Cloudflare 리소스 프로비저닝
D1 생성, R2 버킷(reservoir-originals, reservoir-exports), AI Gateway 생성, Cron Trigger 등록, secrets(`OPENAI_API_KEY`), vars(모델명, 팀 도메인, 예산 $10).
**AC**: `wrangler d1 execute`/`r2 object put` 동작, AI Gateway 프록시로 OpenAI 호출 성공.
**Verify**: 리소스별 1회씩 실제 호출. **Scope: S**

### Task 0.3: Access + 도메인
radar.taejunyun.com 라우팅, Access 셀프호스티드 앱 구성(Google IdP), Worker 미들웨어에서 `Cf-Access-Jwt-Assertion` 검증(팀 공개키).
**AC**: 비로그인 시 Access 리다이렉트, 로그인 후 API/SPA 정상. 검증 실패 시 403.
**Verify**: 시크릿 브라우저로 전체 흐름. **Scope: S**

### Task 0.4: 리포지토리 AGENTS.md + 배포 스크립트
빌드/배포/마이그레이션 명령, 커밋 규칙(날짜+요약), 스펙 SoT 경로 명시.
**Scope: XS**

**Checkpoint P0**: 배포 환경에서 Access 로그인 → 스켈레톤 SPA + `/api/health` 확인.

## Phase 1 — Ingestion & Reservoir 코어

### Task 1.1: D1 마이그레이션 v1
위 스키마 그대로. 인덱스: file_hash, canonical_url, keywords.keyword, user_signals.source_id, processing_jobs.status.
**AC**: 마이그레이션 적용 + 롤백 가능. **Scope: M**

### Task 1.2: 원본 보존 + Dedup 체인
R2 PUT(원본) → 순차 dedup: DOI → canonical URL → title+author → file hash. 중복 시 기존 source에 origin만 추가.
**AC**: 동일 PDF 2회 업로드 시 source 1건 + origin 2건. 원본 R2 보존.
**Files**: `worker/src/ingestion/dedup.ts`, `store.ts`. **Scope: M**

### Task 1.3: 텍스트/노트/URL 입력
- Plain text/note: 그대로 저장
- URL: Worker fetch → readability 추출 → 본문/메타 → R2 snapshot 저장
**AC**: 아티클 URL 입력 시 title/본문 추출, 실패 시 failed 상태 + 재처리 가능. **Scope: M**

### Task 1.4: 파일 업로드 (.md / .pdf)
웹에서 drag&drop. PDF는 pdf.js로 텍스트 추출 후 {원본, extracted_text} 전송. .md는 원본+프론트매터 파싱.
**AC**: PDF 업로드 → R2 원본 + 추출 텍스트 저장. 스���본(추출 0자)은 경고 후 저장. **Scope: M**

### Task 1.5: 홈페이지 PROJECT import
taejunyun.com 소스의 정적 생성 데이터(`scripts/extract-homepage.mjs`) → PROJECT 단위(title/year/url/statement/전시/images[])로 Personal Work 소스 등록. 이미지는 URL reference만(R2 미저장). Settings의 "Sync website" 버튼으로 수동 트리거.
**AC**: 전체 프로젝트가 Personal Work 소스로 등록, 재실행 시 중복 없음. **Scope: M**

### Task 1.6: Inbox UI + processing_jobs
입력 대기열 화면. 상태 received→stored→extracted→analyzed→indexed / failed 표시, 실패 건 재처리 버튼.
**AC**: 모든 입력 경로가 Inbox에 상태와 함께 표시. **Scope: M**

### Task 1.7: 원격 원문 provenance migration + 품질 gate
`0015_source_acquisition.sql`에서 `source_versions`에 `text_scope`, `extraction_method`, `extraction_error`, `content_type`, `final_url`, `acquired_at`을 추가하고 `research_jobs.kind`에 `SOURCE_ACQUISITION`을 허용한다. 원격 raw HTML/PDF는 최대 20 MiB로 제한해 R2에 먼저 저장하고, 정적 HTML은 `HTML_STATIC`, 발견 원격 PDF는 Workers AI `toMarkdown`을 사용한다. 기존 retry chain/self-reference와 active version은 보존한다.

**AC**: development D1 migration 후 기존 source/version/active-version 수가 유지되고 `PRAGMA foreign_key_check`가 비어 있다. `SOURCE_ACQUISITION` CHECK가 존재하며 provenance group 조회가 가능하다. `FULLTEXT + READY + 1,000자 이상 + normalized text`만 심층 정리를 시작하고 나머지는 AI 호출 전에 HTTP 422 `deep_analysis_text_not_ready`로 차단한다. **Scope: M**

**Checkpoint P1**: 텍스트/URL/MD/PDF/홈페이지 5경로 업로드 → R2 원본·dedup·상태 전이 전부 확인.

## Phase 2 — 분석 · 검색 · 사용자 시그널

### Task 2.1: Workers AI 분석 파이프라인
자료 유형별 유연 추출: 분류(kind/reliability 자동 판정), summary, keywords, important_fragments, questions, people/technologies/concepts. 동일 필드 강제 금지(스펙 원칙). 결과는 source_analysis에 INTERPRETATION으로 저장.
**AC**: 샘플 자료 5건 이상에서 유형별 적절한 필드만 추출. **Scope: M**

### Task 2.2: 인덱싱
keywords/questions/fragments를 각 테이블로 정규화 저장, processing_jobs → indexed.
**Scope: S**

### Task 2.3: D1 검색 API
exact title/author → keywords → questions → summary → fragments 순 후보 병합. 결과에 provenance 표시.
**AC**: 스펙 순서대로 랭킹, 빈 쿼리 처리. **Scope: M**

### Task 2.4: Reservoir UI + 시그널 + Settings
- Reservoir 브라우즈(필터: kind/reliability/status) + 상세(원본 링크, 분석, 버전)
- Keep/Ignore/Watch/Develop 버튼 → user_signals 기록(Develop>Keep>Select>View 가중치는 집계 시 적용)
- Settings: 5 파라미터(Familiarity/Research Depth/Divergence/Counter Strength/Technical↔Photographic) + presets(Balanced/Deep Research/Artwork Exploration/Counter-heavy/Technical)
**AC**: 시그널 DB 기록, 최근 판단을 목록·상세 배지로 즉시 표시, `제외됨` 자료는 기본 목록에서 숨기고 필터로 다시 접근, 파라미터 저장·프리셋 로드. **Scope: L → UI 2개로 분리 가능(2.4a 목록/상세, 2.4b Settings)**

**Checkpoint P2**: 자료 업로드 → 자동 분석 → 검색으로 재발견 → 시그널 기록 흐름 완주.

### Task 2.5: Reservoir 심층 정리
저장소 상세에서 `정밀`/`최고 정밀` 품질을 선택해 active version의 긴 본문을 구간별로 읽고 `source_analysis.analysis_type = deep`으로 별도 보존한다. 기존 basic 분석·검색·착즙 컨텍스트를 덮어쓰지 않는다.
동시 실행은 workflow reservation을 포함한 월 예산 상한 안에서만 시작된다.
**AC**: 기본 분석보다 긴 본문을 처리하고, 품질·모델·읽은 글자 수·자료 버전·비용·이력을 확인할 수 있다. **Scope: L**

## Phase 3 — Distill / Critic / Counter

### Task 3.1: Context Selection
입력: 현재 Radar 스냅샷(없으면 최근 신호 집계) + 다음 착즙 전까지 보관 표시된 Keep/Develop 자료 + 관련 thread + 관련 sources(검색 기반) + 과거 Resurface 후보. 저장소에서 `보관하기`/`발전시키기`로 표시한 자료는 다음 착즙 컨텍스트에 우선 포함하고, 착즙 완료 시 다음 사이클 표시에서 해제한다. `관찰하기`/`제외하기`가 뒤에 오면 표시를 취소한다. Reservoir 전체 미포함. 토큰 상한 내 구성.
**AC**: 컨텍스트 구성 결과(사용 source 목록) 로그 출력, 상한 준수. **Scope: M**

### Task 3.2: Distill 실행 + 세션 저장
AI Gateway→OpenAI. 기본 출력: Keywords 5–7 / Fragments 3–5 / Questions ~3 / Read Next 3–5 / Research Gap 1–3 / Research Directions ~2 / Artwork Directions ~2 / (필요시 소실험). `distill_sessions` 전체 기록(input_context, sources_used, model_version, prompt_version, cost).
**AC**: 실행 1회 = 세션 1행 + 비용 1행(ai_usage). **Scope: L → 3.2a 프롬프트/실행, 3.2b 세션 저장소**

### Task 3.3: Critic 자동
Distill 직후 자동 실행. 경고 카테고리 8종(근거부족/논리비약/과도한 일반화/기술오류/용어혼용/출처불일치/진부한 언어/기존 연구 과유사). 학술 근거부족 ↔ 예술적 가능성 구분. 짧게.
**AC**: 모든 Distill 세션에 critic_output 존재(경고 0건이어도 명시). **Scope: M**

### Task 3.4: Counter 토글·정합성 검증
착즙 화면에서 `반대 관점 포함`을 기본 켜짐으로 제공하고 실행 전에 끌 수 있다. 켜진 경우 현재 중심 주장과 동시에 성립할 수 없는 정반대 명제를 생성한 뒤 정면성·내부 정합성·출처 추적·근거 무결성·허수아비 오류를 검증한다. 실패 시 1회 교정하고 최종 실패는 확정 제안으로 표시하지 않는다.
**AC**: 토글을 끄면 Counter 호출·비용·결과가 없고, 켜면 검증 상태와 정반대 명제·근거가 세션에 저장된다. **Scope: L**

### Task 3.5: Re-Distill + 비용 guardrail
부분 선택(요소 단위) 재실행, redistill_of 연결. ai_usage 월 집계 → 80% 경고 배너, 100% 시 Distill 차단(자동 수집·분석은 유지).
동시 실행 요청도 예약/사용량 합산 기준으로 월 예산을 초과하지 않는다.
**AC**: 예산 임계값 테스트에서 차단 동작. **Scope: M**

**Checkpoint P3**: Distill 실행 → Critic/Counter 자동 → 요소 선택 Re-Distill → 세션 이력 확인, 월 비용 집계 확인.

## Phase 4 — Radar / Reading Queue / Research Gap

### Task 4.1: 시그널 집계 + 스냅샷 cron
user_signals·keywords·questions 집계(순수 SQL, LLM 없음). 주간 cron이 stats_json 스냅샷 생성, 월간/연간은 주간 스냅샷 롤업.
**AC**: 스냅샷 수치를 수동 SQL과 대조 일치. **Scope: M**

### Task 4.2: Radar synthesis (사용자 실행)
스냅샷 + 최근 흐름을 LLM으로 종합 — Weekly(새 키워드/반복 질문/새 연결/예상 밖), Monthly(패턴/이동/Thread 후보/과집중), Yearly(장기 궤적/다음 연구 가능성). 편향 감시(키워드 반복) 결과로 Counter 개입 힌트 제공.
**AC**: 3주기 뷰 출력, 스냅샷 없을 때 안내. **Scope: M**

### Task 4.3: Reading Queue + Research Gap
Read Next 후보 전건 OpenAlex 존재 검증(openalex_id 발급된 것만 제시). Must/Worth/Reference 등급 + why_read + related_question. Research Gap 1–3개 Distill 결과 내 표시.
**AC**: 큐의 모든 항목이 실존 검증됨(검증 실패 항목은 자동 탈락). **Scope: M**

**Checkpoint P4**: 주간 스냅샷 생성 → Radar 화면 확인 → Read Next 전건 실존 클릭 확인.

## Phase 5 — Discovery (OpenAlex + curated editorial feeds)

### Task 5.1: 후보 수집 파이프라인
홈페이지 프로젝트·읽을거리 키워드와 최근 모멘텀을 OpenAlex·arXiv 검색 계획으로 변환하고, 검증된 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic)를 함께 수집한다. 읽을거리는 관련도 0.65 이상, `PDF` 또는 검증된 `FREE_FULLTEXT`, 회당 최대 8개(OpenAlex 4·arXiv 2·RSS 2), 정규화 제목 중복 제거를 유지한다. RSS 접근 상태는 출처 레지스트리 정책을 우선하며, RSS 1차 선택은 출처별 한 건씩 균형을 적용한다. Artforum·ARTnews와 접근 미확인 커스텀 HTML은 자동 후보에서 제외한다.
**AC**: cron 1회 실행 후 모든 `CANDIDATE`가 관련도 0.65 이상과 읽기 가능한 접근 상태를 가지며, `source_id`와 provider 진단을 보존한다. 기존 미검토 후보는 재평가하고 탈락 자료는 삭제하지 않고 `IGNORED`로 보존한다. **Scope: M**

운영 보강: Discovery Workflow는 `research_jobs.result_json`에 provider 결과 상태와 후보 terminal outcome 진단을 저장한다. 정상 응답 후 0건은 성공으로 유지하고, 일부 provider 실패는 `incomplete`로 표시하며, 전체 provider 실패와 변환 불가 검색어는 별도 job 상태·error code로 구분한다. 한국어·혼합 검색 문장은 원문 provenance를 보존하고 provider에는 결정론적 concept mapping 결과를 전달한다. 기존 OpenAlex 후보의 수집 시점 OA 증거(`FREE_FULLTEXT`/`PDF`)는 다음 실행의 URL 재평가로 강등하지 않는다.

### Task 5.2: Discover UI
후보 풀 목록 + Keep/Watch/Ignore. Keep는 Reservoir로 승격(DISCOVERY reliability), 자동 수집은 핵심 Reservoir로 직행 금지(스펙 원칙).
**AC**: 승격된 자료만 Reservoir 검색에 등장. **Scope: M**

### Task 5.3: 큐레이션 출처와 학술 연동
출처 레지스트리는 `READING`과 `FIELD_SIGNAL`, 자동 수집 여부, 접근 정책, 주제 anchor를 구분한다. CAA News·Association for Art History·ICP 공식 RSS는 `discovery_field_signals`에 별도 수집하고 회당 최대 12개·출처당 최대 4개를 적용한다. 유형·관련성·게시일·행사일·마감일·종료 여부와 출처별 진단을 기록하며, Save는 Reservoir 승격이 아니라 `SAVED` 상태 변경이다. e-flux와 공식 채널이 확인되지 않은 미술관·사진기관은 검색 링크로 유지한다. RISS·KCI·Scopus·Web of Science는 공식 API 키와 이용 권한을 확보한 뒤 별도 provider adapter로 추가하고, Google Scholar 결과 페이지는 크롤링하지 않는다.

**Checkpoint P5**: 주간 자동 실행 → 읽을거리 후보와 현장 신호가 별도 상한으로 유입 → 읽을거리 Keep 승격과 현장 신호 Save가 서로 다른 저장 동작임을 확인한다.

### Task 5.4: Discovery Keep 원문 수집·Reservoir 복구 흐름
사용자 Keep은 먼저 `DISCOVERY_METADATA/METADATA_ONLY` version을 만든 뒤 읽을 수 있는 URL에 대해서만 dedupe된 `SOURCE_ACQUISITION` background job을 등록한다. 성공하면 HTML/PDF raw R2 object와 provenance가 있는 새 version을 추가하고 품질이 좋아질 때만 active로 승격한다. Reservoir는 active version의 `TextScope`, 추출 방식, 품질, 글자 수와 plain-text 원문 endpoint를 표시한다. 수집이 version 추가 전에 실패하면 기존 metadata-only version을 active로 유지하고, 실패 원인은 Job Center와 `processing_jobs`에서 확인한다. `fetch=1`은 새 원문 수집, `analyze=1`은 현재 active version 분석으로 분리한다.

상태는 `QUEUED/RUNNING/SUCCEEDED/FAILED/BLOCKED`이며 원격 오류는 `FETCH_TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`, `UNSUPPORTED_CONTENT_TYPE`, `SIZE_LIMIT`, `REDIRECT_BLOCKED`, `EXTRACTION_EMPTY`, `PDF_CONVERSION_FAILED`를 보존한다. RSS CDATA/entity/HTML tag는 후보 판정 전에 정리한다. 기존 metadata-only `discovery:*` 및 `homepage-reading` 웹 자료는 설정의 bounded backfill endpoint로 최대 10건씩 수동 처리하며 자동 acquisition/backfill cron은 추가하지 않는다.

**AC**: fixture E2E에서 HTML Keep → 원문 수집 job → Reservoir normalized plain text → 심층 정리 활성화가 이어지고, PDF는 `PDF_REMOTE_TO_MARKDOWN` provenance를 표시한다. JS shell은 Job Center에서 수집 실패/재실행을 표시하되 Reservoir에는 실패용 active version을 만들지 않고, 기존 metadata-only source의 재수집 액션과 비활성화된 심층 정리를 유지한다. 기존 업로드 PDF의 `BROWSER_PDFJS` 경로와 분석 이력은 유지한다. **Scope: M**

## Phase 6 — Export / Backup / 마무리

### Task 6.1: Export
JSON(전체 덤프) / Markdown(자료별) / CSV(목록) + R2 원본 zip. Settings에서 다운로드. 특정 벤더 종속 없음(스펙 원칙).
**AC**: JSON export → 로컬에서 스키마 검증 가능. **Scope: M**

### Task 6.2: 폴리싱
에러/빈 상태 UX, 재처리, 버전 diff 뷰(작업노트 versioning), 라이트하우스급 기본 품질. README(셀프 세팅 가이드).
**Scope: M**

### Task 6.3: Reservoir 영구 삭제 직렬화·복구 경계

저장소에서 자료를 영구 삭제할 때 `source_deletion_claims`로 source별 단일 실행을 보장한다. 정확한 제목 확인 후 claim을 획득하고, claim이 유지되는 동안 source 소유 D1/R2 writer와 병합·중복 후보 writer를 route 검사와 D1 trigger로 차단한다. R2 원본·시각·임시 객체를 먼저 삭제하고, 1,000개 단위 heartbeat로 lease를 갱신한 뒤 동일 claim token·제목·의존성·활성 작업·병합 fingerprint를 검증하는 원자적 D1 batch를 실행한다. R2 실패와 D1 실패는 서로 다른 retry 상태로 남기며, preflight 실패만 claim을 해제한다. 삭제 확인 dialog는 진행 중·R2 실패·D1 실패를 구분하고 재시도 입력을 보존한다.

**AC**: 동시 삭제 요청 중 하나만 R2/D1 mutation을 수행하고 나머지는 HTTP 409 `source_delete_in_progress`를 받는다. R2 실패 시 D1 행이 남고 claim이 보존되며, D1 실패 시 R2 완료 상태와 `source_delete_d1_failed`가 남아 즉시 재시도할 수 있다. claim 중 새 version/visual/extraction/job/merge writer가 차단되고, stale claim guard가 자식 행을 삭제하지 않는다. `0027_source_deletion_claim.sql`은 development에서 검증하되 운영 D1 migration과 배포는 별도 승인 단계로 실행한다. **Scope: M**

**Checkpoint P6(최종)**: 스펙 V0 필수 범위 전 항목 데모 — Inbox/Reservoir/Radar/Distill/Reading Queue/Research Gap/Critic/Counter/검색/시그널/Settings + Export.

## 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| D1 LIKE 검색 품질 부족 | 중 | 개인 규모에선 충분할 가능성 높음. 병목 실증 시 Vectorize semantic layer 제안(스펙에 명시된 확장 경로) |
| Discovery 후보 관련성 낮음 | 중 | 검색어 단독 일반어 차단, 제목·초록·요약 hard gate(0.65), arXiv 카테고리 제한, RSS 접근성·출처별 상한 |
| 스킨 PDF 등 추출 실패 | 하 | failed 상태 + 원본은 보존 + 수동 note 입력 대체 경로 |
| $10 예산 초과 | 하 | ai_usage 원장 + 하드스탑(Task 3.5), Workers AI로 저비용 계층 분리 |
| Access/JWT 검증 구성 오류 | 중 | Phase 0에서 가장 먼저 검증(fail fast) |
| 모델 종속성 | 중 | 모델명 전부 config 관리 + AI Gateway 교체 용이 |
| Distill 프롬프트 품질 | 상 | prompt_version 기록으로 회귀 비교 가능하게, 반복 튜닝을 Phase 3 체크포인트에서 수행 |

## 예상 규모(에이전트 세션 기준)

Phase 0: 1 / Phase 1: 2–3 / Phase 2: 2 / Phase 3: 2–3 / Phase 4: 2 / Phase 5: 1–2 / Phase 6: 1 → 합계 11–14 세션

## Open Questions (구현 중 재확인 대상)

- taejunyun.com 정적 데이터의 실제 형식(JSON/MD 구조) — `scripts/extract-homepage.mjs`가 `homeWorkspace.mjs`/`images.js`를 읽어 추출
- 초기 관심축 키워드(스펙 나열분)를 seeds로 주입할지 — Task 2.1에서 기본값 제안 후 확인
- Distill 기본 모델 선택(mini급 확정이나 구체 모델명은 config로 Phase 3에서 확정)
