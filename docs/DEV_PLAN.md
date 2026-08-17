# Research Radar — V0 개발 계획

스펙: `docs/spec-v0.1.txt` (원본) + `docs/SPEC.md` (v1.0 확정 결정)
원칙: 계획 위반/변경 필요 시 임의 결정하지 말고 사용자에게 제안(D-cide 노트 준수)

## Overview

사진작가 개인 연구 시스템. 자료 수집 → Reservoir(D1/R2) 축적 → 관심 신호 집계 → Distill(OpenAI) → Critic/Counter → 인간 선택 기록의 사이클을 Cloudflare Workers 단일 스택으로 구축. V0는 단일 사용자(윤태준)가 실제로 매일 쓸 수 있는 상태를 목표로 한다.

## Architecture Decisions

- **Worker 단일 앱 + Static Assets**: API(Hono)와 SPA를 한 Worker에서. 별도 Pages 불필요 (D7)
- **D1 텍스트 검색**: FTS 없이 인덱스 컬럼 + LIKE. 개인 규모(수천 건)에서 충분. 병목 시 Vectorize 검토(스펙 명시)
- **원본 항상 R2 보존 후 처리**: extraction 실패해도 원본은 남음(provenance 원칙)
- **모델 2계층**: Workers AI(무료할당) = 분류/요약/키워드, AI Gateway→OpenAI = Distill/Critic/Counter/Radar synthesis (D10)
- **PDF는 브라우저에서 pdf.js 추출** (D5), **Obsidian은 .md 업로드** (D3), **홈페이지는 소스 데이터 import** (D2)
- **Discovery = OpenAlex 단일, 주간 cron, 자동 수집 상한** (D6)

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
taejunyun.com 소스의 정적 생성 데이터 → PROJECT 단위(title/year/url/statement/전시/images[])로 Personal Work 소스 등록. 이미지는 URL reference만(R2 미저장). Settings의 "Sync website" 버튼으로 수동 트리거.
**AC**: 전체 프로젝트가 Personal Work 소스로 등록, 재실행 시 중복 없음. **Scope: M**

### Task 1.6: Inbox UI + processing_jobs
입력 대기열 화면. 상태 received→stored→extracted→analyzed→indexed / failed 표시, 실패 건 재처리 버튼.
**AC**: 모든 입력 경로가 Inbox에 상태와 함께 표시. **Scope: M**

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
**AC**: 시그널 DB 기록, 파라미터 저장·프리셋 로드. **Scope: L → UI 2개로 분리 가능(2.4a 목록/상세, 2.4b Settings)**

**Checkpoint P2**: 자료 업로드 → 자동 분석 → 검색으로 재발견 → 시그널 기록 흐름 완주.

## Phase 3 — Distill / Critic / Counter

### Task 3.1: Context Selection
입력: 현재 Radar 스냅샷(없으면 최근 신호 집계) + 최근 Keep/Develop + 관련 thread + 관련 sources(검색 기반) + 과거 Resurface 후보. Reservoir 전체 미포함. 토큰 상한 내 구성.
**AC**: 컨텍스트 구성 결과(사용 source 목록) 로그 출력, 상한 준수. **Scope: M**

### Task 3.2: Distill 실행 + 세션 저장
AI Gateway→OpenAI. 기본 출력: Keywords 5–7 / Fragments 3–5 / Questions ~3 / Read Next 3–5 / Research Gap 1–3 / Research Directions ~2 / Artwork Directions ~2 / (필요시 소실험). `distill_sessions` 전체 기록(input_context, sources_used, model_version, prompt_version, cost).
**AC**: 실행 1회 = 세션 1행 + 비용 1행(ai_usage). **Scope: L → 3.2a 프롬프트/실행, 3.2b 세션 저장소**

### Task 3.3: Critic 자동
Distill 직후 자동 실행. 경고 카테고리 8종(근거부족/논리비약/과도한 일반화/기술오류/용어혼용/출처불일치/진부한 언어/기존 연구 과유사). 학술 근거부족 ↔ 예술적 가능성 구분. 짧게.
**AC**: 모든 Distill 세션에 critic_output 존재(경고 0건이어도 명시). **Scope: M**

### Task 3.4: Counter 자동
Distill 키워드·미학 성향에서 반대축 동적 생성(고정 아날로그 추천기 금지). OpenAlex로 실제 사례(작가/텍스트) 근거 보강. 화면에는 강한 방향 1–2개만.
**AC**: 입력 키워드에 따라 반대축이 매번 다름 + 근거 자료 실존. **Scope: M**

### Task 3.5: Re-Distill + 비용 guardrail
부분 선택(요소 단위) 재실행, redistill_of 연결. ai_usage 월 집계 → 80% 경고 배너, 100% 시 Distill 차단(자동 수집·분석은 유지).
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

## Phase 5 — Discovery (OpenAlex)

### Task 5.1: 후보 수집 파이프라인
모멘텀 키워드(최근 신호 증가분) → OpenAlex 쿼리 생성(AFFINITY/DIVERGENCE 비율은 Divergence 파라미터로 조정) → Workers AI 관련성 필터 → discovery_candidates. 주간 cron, 자동 수집 상한 주 20건.
**AC**: cron 1회 실행 후 candidates 상한 이하 유입, relevance_score 기록. **Scope: M**

### Task 5.2: Discover UI
후보 풀 목록 + Keep/Watch/Ignore. Keep는 Reservoir로 승격(DISCOVERY reliability), 자동 수집은 핵심 Reservoir로 직행 금지(스펙 원칙).
**AC**: 승격된 자료만 Reservoir 검색에 등장. **Scope: M**

**Checkpoint P5**: 주간 자동 실행 → 후보 → Keep 승격 → 검색 노출 확인.

## Phase 6 — Export / Backup / 마무리

### Task 6.1: Export
JSON(전체 덤프) / Markdown(자료별) / CSV(목록) + R2 원본 zip. Settings에서 다운로드. 특정 벤더 종속 없음(스펙 원칙).
**AC**: JSON export → 로컬에서 스키마 검증 가능. **Scope: M**

### Task 6.2: 폴리싱
에러/빈 상태 UX, 재처리, 버전 diff 뷰(작업노트 versioning), 라이트하우스급 기본 품질. README(셀프 세팅 가이드).
**Scope: M**

**Checkpoint P6(최종)**: 스펙 V0 필수 범위 전 항목 데모 — Inbox/Reservoir/Radar/Distill/Reading Queue/Research Gap/Critic/Counter/검색/시그널/Settings + Export.

## 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| D1 LIKE 검색 품질 부족 | 중 | 개인 규모에선 충분할 가능성 높음. 병목 실증 시 Vectorize semantic layer 제안(스펙에 명시된 확장 경로) |
| OpenAlex 후보 관련성 낮음 | 중 | 모멘텀 키워드 품질 선행 확보, 상한 20건/주, Workers AI 필터 |
| 스킨 PDF 등 추출 실패 | 하 | failed 상태 + 원본은 보존 + 수동 note 입력 대체 경로 |
| $10 예산 초과 | 하 | ai_usage 원장 + 하드스탑(Task 3.5), Workers AI로 저비용 계층 분리 |
| Access/JWT 검증 구성 오류 | 중 | Phase 0에서 가장 먼저 검증(fail fast) |
| 모델 종속성 | 중 | 모델명 전부 config 관리 + AI Gateway 교체 용이 |
| Distill 프롬프트 품질 | 상 | prompt_version 기록으로 회귀 비교 가능하게, 반복 튜닝을 Phase 3 체크포인트에서 수행 |

## 예상 규모(에이전트 세션 기준)

Phase 0: 1 / Phase 1: 2–3 / Phase 2: 2 / Phase 3: 2–3 / Phase 4: 2 / Phase 5: 1–2 / Phase 6: 1 → 합계 11–14 세션

## Open Questions (구현 중 재확인 대상)

- taejunyun.com 정적 데이터의 실제 형식(JSON/MD 구조) — Task 1.5 착수 시 소스 확인 필요
- 초기 관심축 키워드(스펙 나열분)를 seeds로 주입할지 — Task 2.1에서 기본값 제안 후 확인
- Distill 기본 모델 선택(mini급 확정이나 구체 모델명은 config로 Phase 3에서 확정)
