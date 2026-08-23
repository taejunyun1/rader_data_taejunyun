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
| D5 | PDF 텍스트 추출 | 브라우저 pdf.js로 업로드 시 추출 → 원본(PDF) R2 저장 + 추출 텍스트 전송 | 서버 측 PDF 파서 불필요 |
| D6 | Discovery 소스 | OpenAlex(학술 기본) + arXiv + 큐레이션 RSS/Atom(Artforum, Hyperallergic, ARTnews, Aperture) | e-flux·RISS·Google Scholar·Scopus·Web of Science 및 미술관·학회·사진기관은 출처 디렉터리에 등록하고, 공개 피드 또는 공식 API가 확인된 경로만 자동 후보 수집 |
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

**포함**: Inbox / Reservoir / Reservoir 심층 정리 / Radar / Distill / Reading Queue / Research Gap / Critic / Counter(기본 켜짐 토글) / 기본 검색(D1 텍스트·metadata) / 사용자 선택 기록(user_signals) / Settings(5 파라미터 + presets) / Discovery(OpenAlex, 강한 상한) / Export·Backup

**제외** (v0.1 그대로): 일반 챗봇 / Multi-agent UI / Knowledge Graph 시각화 / 다중 사용자 / Admin Panel / Fine-tuning / 복잡한 권한관리 / 과도한 대시보드 / 불필요한 외부 SaaS / **Google Drive 연동** / **로컬 Obsidian 싱크 CLI** / **시맨틱 검색(Vectorize)** — 검색이 실제 병목일 때 재검토

## 4. 원본 스펙(v0.1) 대비 delta 요약

1. Input Sources 중 Google Drive 제외(D4), Local File/Folder는 브라우저 업로드로 해석(D3)
2. PDF 텍스트 추출 경로를 클라이언트로 확정(D5) — 스펙의 "Text/metadata extraction" 단계 구현 방식 확정
3. 홈페이지 ingestion을 "소스 데이터 직접 import"로 확정(D2) — authoritative personal source 원칙 유지
4. "System Discovery"의 소스를 OpenAlex로 확정(D6)
5. 비용 정책의 "월 AI 사용량 guardrail"을 $10로 구체화(D10)

### Discovery 출처 확장 (2026-08-23)

발견 탭은 출처를 세 가지 방식으로 구분한다.

- `RSS`: 공개 RSS/Atom을 Worker가 자동 수집한다. 현재 기본 피드는 Artforum, Hyperallergic, ARTnews, Aperture다.
- `API`: RISS, Scopus, Web of Science처럼 공식 키·기관 권한이 필요한 출처다. 키 없이 검색 결과 페이지를 크롤링하지 않는다.
- `SEARCH`: e-flux Journal/Announcements, Google Scholar, 미술관·학회·사진기관처럼 실제 검색·읽기 링크를 제공하는 출처다. Google Scholar는 공식 자동 수집 API가 없으므로 자동 후보 provider로 가장하지 않는다.

따라서 출처 디렉터리에 노출되는 것과 자동 후보 수집이 가능한 것은 별개의 상태이며, UI에서 두 상태를 명시한다.
