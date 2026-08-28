# Research Radar — 확정 스펙 v1.0

- 원본 스펙: `docs/spec-v0.1.txt` (제품/기술/운영 정의의 Source of Truth)
- 이 문서는 2026-08-18 확정된 V0 구현 결정사항을 기록한다.
- v0.1 본문과 이 문서가 충돌하면 **이 문서가 우선**한다. 단, 제품 원칙(Reservoir First, Provenance First 등)과 비목표(챗봇/멀티유저 등)는 v0.1 그대로 유효하다.

---

## 1. 확정 결정사항 (11항목)

| # | 항목 | 결정 | 구현 영향 |
|---|------|------|-----------|
| D1 | 인프라 | Cloudflare(유료 플랜) + OpenAI API 키 모두 준비됨 | Phase 0에서 계정 리소스만 생성하면 됨 |
| D2 | 홈페이지(taejunyun.com) | 소스 코드 보유 → 정적 생성 데이터를 ingestion에 직접 사용 | HTML 크롤링 없음. PROJECT 단위 구조화 데이터 import |
| D3 | Obsidian 입력 | UI 업로드(V0) — 브라우저에서 .md 파일/폴더 drag&drop | 로컬 싱크 CLI는 V1 후보 |
| D4 | Google Drive | **V0 제외** — 수동 다운로드 후 업로드로 대체 | OAuth 개발 없음 |
| D5 | PDF 텍스트 추출 | 업로드 PDF는 브라우저 pdf.js로 추출하고, 발견 원격 PDF는 raw PDF를 R2에 먼저 보존한 뒤 Workers AI `toMarkdown`으로 변환 | 별도 서버 PDF 파서 없이 입력 경로별 provenance를 보존 |
| D6 | Discovery 소스 | OpenAlex + arXiv + 검증된 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic) + 별도 현장 신호 RSS(CAA News, Association for Art History, ICP) | 읽을거리와 현장 신호는 별도 quota·상태로 저장하며, 공개 피드 또는 공식 API가 확인된 경로만 자동 수집 |
| D7 | 프론트엔드 | Vite + React SPA, Workers Static Assets 배포 | 동일 Worker에서 API + 정적 자산 서빙 |
| D8 | 인증 | Cloudflare Access + Google IdP | Worker에서 Access JWT(Cf-Access-Jwt-Assertion) 검증 |
| D9 | UI 언어 | 한국어 중심. Distill/Critic/Counter 등 내부 파이프라인 명칭과 고유명사는 원어 병기 가능 | 콘텐츠(자료 원문), 논문 제목·저자·출처명은 원어 그대로 |
| D10 | 월 AI 예산 | **$10/월** guardrail | D1에 ai_usage 원장, 80% 경고·100% Distill 중단 |
| D11 | 저장소 | 이 repo에 앱 전체 코드(모노레포: worker + web) | repo명(rader_data_taejunyun) 그대로 사용 |

## 2. 확정 아키텍처

```
radar.taejunyun.com
  → Cloudflare Access (Google IdP)
    → Worker (Hono)
        ├─ Static Assets: Vite+React SPA
        ├─ API routes (ingestion / search / distill / radar / discovery / actions)
        ├─ Scheduled (Cron): Discovery(주 1회), Radar snapshot 준비(주/월/년)
        ├─ D1  — 메타데이터 DB (스펙의 15개 테이블)
        ├─ R2  — 원본 보존 (PDF/MD/웹 snapshot/export)
        ├─ Workers AI — 저비용: 분류/요약/키워드/후보 필터
        └─ AI Gateway → OpenAI — 고품질: Distill/Critic/Counter/Radar synthesis
OpenAlex API — 학술 Discovery 기본 소스 + Reading Queue 존재 검증
```

### 저장소 구조 (모노레포, pnpm workspaces)

```
/
├── AGENTS.md
├── docs/               # spec-v0.1.txt / SPEC.md / DEV_PLAN.md
├── worker/             # Hono API + cron (TypeScript)
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   ├── ingestion/  # dedup, extraction, homepage import
│   │   ├── distill/    # context selection, distill, critic, counter
│   │   ├── radar/      # signal 집계, snapshot, synthesis
│   │   ├── discovery/  # openalex
│   │   ├── lib/        # db, r2, ai(게이트웨이 래퍼), auth, budget
│   │   └── migrations/
│   └── wrangler.jsonc
├── web/                # Vite + React SPA
│   └── src/views/      # Radar / Distill / Reservoir / Inbox / Discover / Settings
└── shared/             # worker·web 공통 TypeScript 타입
```

### 모델·비용 전략 ($10/월)

- Workers AI(무료 할당): 분류, 짧은 요약, 키워드 추출, 후보 필터 → 사실상 $0
- OpenAI via AI Gateway: Distill/Critic/Counter/Radar synthesis와 사용자가 요청하는 Reservoir 심층 정리. 기본·정밀·최고 정밀 품질은 `MODEL_LOW`/`MODEL_HIGH`/`MODEL_DEEP` 환경변수로 해석한다.
- 모든 모델명은 wrangler vars/config로 관리(하드코딩 금지 — 스펙 원칙)
- `ai_usage` 테이블에 호출별 토큰·비용 기록, 월별 집계로 guardrail 적용

## 3. V0 스코프 (재확인)

**포함**: Inbox / Reservoir / Reservoir 심층 정리 / Radar / Distill / Reading Queue / Research Gap / Critic / Counter(기본 켜짐 토글) / 기본 검색(D1 텍스트·metadata) / 사용자 선택 기록(user_signals) / Settings(5 파라미터 + presets) / Discovery(OpenAlex + arXiv + 검증된 읽을거리 RSS + 별도 현장 신호 RSS, 강한 상한) / Export·Backup

**제외** (v0.1 그대로): 일반 챗봇 / Multi-agent UI / Knowledge Graph 시각화 / 다중 사용자 / Admin Panel / Fine-tuning / 복잡한 권한관리 / 과도한 대시보드 / 불필요한 외부 SaaS / **Google Drive 연동** / **로컬 Obsidian 싱크 CLI** / **시맨틱 검색(Vectorize)** — 검색이 실제 병목일 때 재검토

## 4. 원본 스펙(v0.1) 대비 delta 요약

1. Input Sources 중 Google Drive 제외(D4), Local File/Folder는 브라우저 업로드로 해석(D3)
2. PDF 텍스트 추출 경로를 클라이언트로 확정(D5) — 스펙의 "Text/metadata extraction" 단계 구현 방식 확정
3. 홈페이지 ingestion을 "소스 데이터 직접 import"로 확정(D2) — authoritative personal source 원칙 유지
4. "System Discovery"의 소스를 OpenAlex + arXiv + 검증된 읽을거리 RSS + 별도 현장 신호 RSS로 확정(D6)
5. 비용 정책의 "월 AI 사용량 guardrail"을 $10로 구체화(D10)

### Discovery 읽을거리·현장 신호 분리 (2026-08-23)

- 발견 결과는 `읽을거리`와 `현장 신호`로 분리한다.
- 읽을거리는 관련도 0.65, 무료 원문/PDF, 최대 8개 정책을 유지한다.
- 검증된 자동 읽을거리 피드는 Unthinking Photography, Aperture, Hyperallergic다.
- 현장 신호는 CAA News, Association for Art History, ICP 공식 RSS에서 별도 수집하며 회당 최대 12개·출처당 최대 4개다.
- 현장 신호 저장은 Reservoir 승격이 아니라 `SAVED` 상태 변경이다.
- e-flux는 현재 공식 피드가 갱신되지 않아 검색 링크로 유지하며 HTML 페이지를 크롤링하지 않는다.
- 미술관 작품·소장품 API는 별도 향후 설계 범위다.

### Discovery Keep 원문 수집·심층 읽기 품질 규칙 (2026-08-23)

- `CANDIDATE`를 사용자가 Keep할 때만 `METADATA_ONLY` source version을 만든다. 읽을 수 있는 HTTP(S) 주소가 있으면 `SOURCE_ACQUISITION` job을 등록하고, 없으면 `LINK_ONLY`로 남긴다. 자동 후보 생성만으로 원문 수집이나 Reservoir 분석을 시작하지 않는다.
- 원격 응답은 URL/DNS·redirect·Content-Type·20 MiB 상한을 검증하고 raw HTML/PDF를 R2에 먼저 저장한 뒤 처리한다. 정적 HTML은 결정론적 본문 추출(`HTML_STATIC`), 원격 PDF는 Workers AI `env.AI.toMarkdown`(`PDF_REMOTE_TO_MARKDOWN`)을 사용한다. 브라우저 렌더링이 필요한 JS shell은 우회하지 않으며 본문이 없으면 `EXTRACTION_EMPTY`로 실패한다.
- `TextScope`는 `FULLTEXT | PARTIAL | METADATA_ONLY | EMPTY | UNKNOWN`, 품질은 `UNREVIEWED | READY | REVIEW | EMPTY | FAILED`다. 의미 글자 0자는 `EMPTY`, discovery metadata 또는 200자 미만은 `METADATA_ONLY`, 1,000자 미만이나 경고가 있는 본문은 `PARTIAL`, 나머지는 `FULLTEXT + READY`로 판정한다.
- 심층 정리는 active version이 `FULLTEXT + READY`, 1,000자 이상, 비어 있지 않은 normalized text일 때만 가능하다. 불충족 시 유료 AI job을 만들지 않고 HTTP 422 `deep_analysis_text_not_ready`와 `textScope`·`qualityStatus`·`charCount`를 반환한다.
- Reservoir 상세는 active version의 `text_scope`·`extraction_method`·품질·글자 수를 provenance로 표시하고, 해당 version에 저장된 오류가 있을 때만 그 값을 함께 표시한다. fetch/extraction이 version 추가 전에 실패하면 실패용 active version을 만들지 않고 Job Center와 `processing_jobs`에 실패를 남기며, Reservoir는 기존 metadata-only active version을 유지한다. `GET /api/reservoir/:sourceId/original-text`는 normalized text만 `text/plain; charset=utf-8`, `nosniff`, 최대 500,000자로 반환하며 raw HTML을 렌더링하지 않는다.
- 재시도는 `POST /api/inbox/retry/:sourceId?fetch=1`(canonical URL 재수집, 새 version/job)과 `?analyze=1`(현재 active version 재분석)을 분리한다. RSS title/summary는 CDATA·XML entity·HTML 태그를 정리한 뒤 판정한다.
- 기존 `discovery:*` 자료 재수집은 `POST /api/settings/backfill-discovery`의 수동·중복 방지 batch로만 수행한다. active version이 `FULLTEXT`가 아니거나 1,000자 미만인 자료를 오래된 순서로 최대 10건 선택하며 자동 backfill/acquisition cron은 없다. 기존 주간 Discovery 후보 탐색 cron은 별도 동작이다.
- 원문 수집 job 상태는 `QUEUED | RUNNING | SUCCEEDED | FAILED | BLOCKED`다. 원격 수집 원인은 `FETCH_TIMEOUT`, `HTTP_4XX`, `HTTP_5XX`, `UNSUPPORTED_CONTENT_TYPE`, `SIZE_LIMIT`, `REDIRECT_BLOCKED`, `PDF_SIGNATURE_INVALID`, `EXTRACTION_EMPTY`, `PDF_CONVERSION_FAILED`로 기록하고, version 저장 실패는 `source_version_store_failed`, 품질 미달은 `text_not_ready`로 남긴다. Workflow job의 런타임 실패 code는 `workflow_runtime_failed`이며 원래 수집 원인은 error/processing job에 보존한다.
- `homepage-reading` JSON의 제목·요약·태그는 원격 원문이 아니라 큐레이션 metadata다. 초기 version은 글자 수와 관계없이 `METADATA_ONLY + DISCOVERY_METADATA + REVIEW`로 저장하며, 실제 HTML/PDF 수집이나 사용자가 제공한 전문만 full-text readiness 후보가 된다.
- `HTTP_4XX`는 내부 진단에 실제 status와 명시적인 `cf-mitigated: challenge` 여부를 보존할 수 있다. 이 진단은 공개 오류 코드를 늘리지 않으며, challenge·401·403·404·410은 자동 접근 불가로 안내하고 408·429는 재시도를 유지한다.
