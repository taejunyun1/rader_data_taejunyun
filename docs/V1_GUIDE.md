# Research Radar — V1 가이드 및 기술 작동 방식

최종 업데이트: 2026-08-19 · 라이브: https://radar.taejunyun.com

---

## 1. 시스템 개요

Research Radar는 사진작가 윤태준의 연구 자료를 축적·분석하여 새로운 연구 방향을 찾도록 돕는 개인 연구 시스템이다. 챗봇이 아니라 **연구 편집 도구**이며, 핵심 자산은 AI가 아니라 **Research Reservoir**(연구 저수지)다.

```
[입력]                      [축적]                  [착즙]                    [기록]
Obsidian 상시싱크 ──┐                              ┌─ Distill (편집본 생성)
PDF/MD/URL/노트 ────┤  R2 원본보존 → D1 Reservoir ─┤─ Critic (논리검증, 자동)   ── 사용자 선택
홈페이지 프로젝트 ───┤  → 자동분석 → 임베딩        ├─ Counter (반대축, 자동)    (Keep/Watch/
Discovery 탐색 ─────┘                              └─ Radar (주/월/년 합성)     Develop/Ignore)
                                                                              ↓
                                                                    관심 신호가 다음 Distill에 반영
```

## 2. 변경 이력

### V0 (250818) — 스펙 전 범위 구현
- Phase 0: Cloudflare 인프라 — Access 인증(PIN), D1, R2 2버킷, AI Gateway, 주간 cron, radar.taejunyun.com
- Phase 1: Ingestion 코어 — dedup 체인(DOI→URL→제목+저자→해시), R2 원본 보존, 텍스트/URL/MD/PDF(pdf.js 브라우저 추출)/홈페이지 10개 작품 import, Inbox UI
- Phase 2: Workers AI 자동 분석(분류/요약/키워드/질문/프래그먼트 — 유형별 유연 추출), D1 검색, Reservoir UI + 시그널, Settings 5파라미터+프리셋
- Phase 3: Distill/Critic/Counter 파이프라인, Re-Distill(요소 선택 유지), 월 $10 guardrail
- Phase 4: 주간 스냅샷 cron, Radar 합성(Weekly/Monthly/Yearly), Reading Queue OpenAlex 존재 검증, Radar UI
- Phase 5: Discovery(OpenAlex), 후보 풀 Keep/Watch/Ignore, 커스텀 쿼리
- Phase 6: Export(JSON/Markdown/CSV), R2 원본 백업, README

### V1 (250819)
| 기능 | 내용 |
|------|------|
| **Obsidian 상시 싱크** | 로컬 볼트 ↔ Radar 자동 동기화. launchd로 맥 부팅 시 백그라운드 상시 가동(30초 스캔). 변경 파일만 버전 히스토리로 업로드 |
| **CLI 인증** | `CLI_TOKEN` Bearer + Cloudflare Access Service Token(`radar-cli`) 이중 인증. Bypass 정책으로 CLI 경로만 관문 통과 |
| **시맨틱 검색** | Cloudflare Vectorize(`research-radar-embeddings`, bge-m3 1024차원). 분석 완료 후 자동 임베딩, 키워드+의미 병합 검색 |
| **Discovery 확장** | 홈페이지 프로젝트·읽을거리 키워드 시드 + OpenAlex + **arXiv**(모멘텀 키워드) + **RSS/Atom 피드**(최대 6개, 사용자 지정). 읽을거리 스냅샷은 일일 cron으로 Reservoir에 반영 |

### V2 (250819)
| 기능 | 내용 |
|------|------|
| **Usage 대시보드** | USAGE 탭 — 월 예산 게이지, 목적별/모델별 비용, 일별 지출 차트, 월 히스토리, Distill 평균 단가 (`/api/usage/summary`) |
| **Distill 프롬프트 A/B** | DISTILL 탭 — 프롬프트 변형 선택(v1 standard / v2-terse). 세션에 `prompt_version` 기록되어 결과 비교 가능 |
| **스캔 PDF 감지** | 텍스트 레이어 없는 PDF 업로드 시 원본 보존 + 명시적 안내("핵심 구절을 노트로 추가하세요"), `scannedPdf` 메타데이터 기록 |

---

## 3. 일상 사용 가이드

### 매일 아무것도 안 해도 되는 것
- Obsidian에 노트 쓰기/고치기 → 30초 내 자동 업로드 + AI 분석 + 임베딩
- 매일 01:00 UTC(한국 10:00) cron → homepage_artist 읽을거리 R2 스냅샷을 Reservoir에 업서트
- 매주 월요일 03:00 UTC(한국 12:00) cron → Reservoir 스냅샷 + Discovery 3소스 수집(최대 20건)

### 직접 하는 행동
| 행동 | 어디서 | 효과 |
|------|--------|------|
| 자료 추가 | INBOX — 노트/URL/MD/PDF | 즉시 저장+분석 |
| 자료 평가 | RESERVOIR 상세 — KEEP/WATCH/DEVELOP/IGNORE | 관심 신호 기록(Develop>Keep>Select>View) |
| 착즙 | DISTILL — Run Distill (~30-60초, 비용은 사용 모델·Counter 토글에 따라 변동) | 키워드/생각/질문/읽을거리/갭/방향 + Critic + 기본 켜짐 Counter |
| 재착즙 | DISTILL — 요소 체크 후 Re-distill | 선택 요소 유지, 나머지 신선하게 |
| 읽을거리 검증 | DISTILL — Verify via OpenAlex | 논문 실존 확인(책은 미검증 정상) |
| 레이더 | RADAR — Run Radar synthesis | 주/월/년 리포트 + Bias watch |
| 외부 탐색 | DISCOVER — Run discovery / 후보 처리 | Keep 시 Reservoir 승격 |
| 백업 | SETTINGS — Export 3종 + Backup originals | 벤더 비종속 보존 |

### Obsidian 싱크 관리
```bash
# 상태 확인
launchctl list | grep radar-sync
# 실시간 로그
tail -f /tmp/radar-sync.log
# 중지 / 재시작
launchctl bootout gui/$(id -u)/com.taejunyun.radar-sync
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.taejunyun.radar-sync.plist
```
- 설정 파일: `~/Library/LaunchAgents/com.taejunyun.radar-sync.plist` (볼트 경로/토큰 변경 시 수정 후 재시작)
- 상태 파일: 볼트 내 `.radar-sync.json` (삭제하면 다음 실행 때 전체 재검사 — 중복 업로드 없음, 해시 비교로 unchanged 처리)
- 제외: `.obsidian`, `.trash` 등 숨김/설정 폴더, `.md` 외 파일

## 4. 기술 아키텍처

### 구성
```
radar.taejunyun.com
 └─ Cloudflare Access (Google 계정, taejun.foto@gmail.com만 허용)
     └─ Worker "research-radar" (Hono, TypeScript strict)
         ├─ Static Assets: web/dist (Vite+React SPA)
         ├─ D1 "research-radar-db" — 메타데이터 19 테이블 + kv
         ├─ R2 "reservoir-originals" — 원본 보존 (originals/<id>/v<N>)
         ├─ R2 "reservoir-exports"  — 백업 스냅샷
         ├─ Workers AI — llama-3.3-70b(분석) + bge-m3(임베딩)
         ├─ Vectorize "research-radar-embeddings" — 1024d cosine
         └─ AI Gateway "research-radar" → OpenAI (gpt-5-mini/nano)
              · Authenticated Gateway(cf-aig-authorization) + vault OpenAI 키
외부: OpenAlex / arXiv API / RSS 피드
```

### 인증 (2계층)
1. **브라우저**: Access → 로그인 페이지 → JWT(RS256/ES384 지원, aud 배열 검증)를 Worker에서 직접 검증 (`src/lib/access.ts`)
2. **CLI**: `Authorization: Bearer CLI_TOKEN`(상수시간 비교) + Access Service Token 헤더(`CF-Access-Client-Id/Secret`)로 Bypass 정책 통과

### D1 스키마 (migrations/0001~0004)
```
sources / source_versions / source_analysis / source_embeddings(신규)
keywords / questions / fragments / threads / thread_links / directions
user_signals / radar_snapshots / distill_sessions / reading_queue(verified 추가)
research_gaps / discovery_candidates(provider, external_url 추가)
processing_jobs / ai_usage / kv
```

### API 라우트 (worker/src/routes/)
| 라우트 | 기능 |
|--------|------|
| `/api/inbox` | POST text/url/file, retry(+?analyze=1 재분석) |
| `/api/sync/obsidian` | POST 업서트(경로 매칭·버전증가), GET status — CLI 전용 |
| `/api/reservoir` | 목록(kind/status 필터), 상세(분석/키워드/질문/버전/시그널) |
| `/api/search` | GET q= 병합 검색, POST embed-backfill(백필) |
| `/api/distill` | run / sessions / select / verify-queue / budget |
| `/api/radar` | stats / snapshots / synthesize(period) |
| `/api/discover` | run / candidates/:id/:action / queries / feeds |
| `/api/settings` | params GET/PUT, import-homepage |
| `/api/signals` | POST 기록, GET summary |
| `/api/usage` | GET summary — 월별 비용 집계 (V2) |
| `/api/export` | json/csv/markdown 다운로드, originals-to-r2 백업 |

### Ingestion 파이프라인 (스펙 3문서의 순서 그대로)
```
INPUT → 식별 → dedup(DOI→canonical URL→title+author→SHA-256) → R2 원본 보존
      → 텍스트/메타 추출 → 분류(kind/reliability 자동, 승격은 신뢰 origin만)
      → Workers AI 분석(INTERPRETATION로 저장, 유형별 유연 필드)
      → 인덱싱(keywords/questions/fragments) → bge-m3 임베딩 → indexed
```
- 실패 시 `processing_jobs.failed` + Inbox에서 Retry
- R2 customMetadata는 ASCII만 허용 → 비ASCII는 생략(한글 경로 문제 해결)
- 중복 재수입: sources 1건 유지 + origins에 경로 추가

### Distill 파이프라인
1. **Context Selection** (`distill/context.ts`): 최근 60일 모멘텀 키워드 + 미해결 질문 + 90일 내 Keep/Develop/Select 소스 + 키워드 매칭 소스. 최대 12소스/26k chars — **Reservoir 전체를 넣지 않음**(스펙 원칙)
2. **Distill** (환경변수 모델, JSON 모드): keywords 5-7 / thoughts 3-5 / questions ~3 / read_next 3-5 / gaps 1-3 / research+artwork directions ~2 / 소실험. 프로세스 파라미터(familiarity/divergence 등)가 프롬프트에 반영
3. **Critic** 자동: 8개 경고 카테고리 + 학술적 근거부족 ↔ 예술적 실행가능성 구분
4. **Counter** 기본 켜짐: 토글이 켜진 착즙에서 키워드/미학의 정면 반대 명제를 동적 생성하고, 실존 작가·기법으로 근거를 보강한 뒤 정합성 검증. counterStrength는 반대 여부가 아니라 실행 방향의 급진성과 낯섦을 조절
5. **세션 저장**: input_context/sources_used/output/critic/counter/모델+프롬프트 버전/비용 전부 기록
6. **Reading Queue 검증** (waitUntil 백그라운드): OpenAlex 제목 유사도 매칭 → verified/openalex_id/링크
- 잘린 JSON 복구 파서 내장(truncation 대응)

### Radar
- **일일 cron**(10:00 KST): homepage_artist가 R2에 올린 읽을거리 JSON을 원본 스냅샷으로 보존하고 WEB 소스로 업서트·분석
- **주간 cron**(월 12:00 KST): 순수 SQL 집계 스냅샷(6일 내 중복 스킵) + Discovery(홈페이지 키워드 시드+OpenAlex+arXiv+RSS, 최대 20건/회)
- **합성은 사용자 실행**: SQL 통계 + 전체 키워드(편향 비교용) + 최근 Distill → 주/월/년 섹션 리포트 + biasWatch
- 시간정책: 오래된 자료는 버리지 않고 현재 관심과 연결되면 Resurface

### 비용 관리
- **원장**: ai_usage 테이블에 호출별 토큰·비용 기록(게이트웨이 경유 전 호출)
- **월 $10 guardrail**: 80% 경고/100% Distill 차단(DISTILL 탭 배지)
- **2계층 모델**: Workers AI(무료할당)=분석/임베딩, OpenAI mini=착즉. 실측: Distill 1회 ≈ $0.015
- 모델명은 wrangler vars(MODEL_HIGH/MODEL_LOW)로 관리 — 하드코딩 없음

### 모니터링
- `wrangler tail` 실시간 로그(JSON 구조화), Workers Observability 활성
- D1 직접 조회: `pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --remote --command "..."`

## 5. 시크릿·환경변수

| 키 | 용도 |
|----|------|
| `OPENAI_API_KEY` | 게이트웨이 vault와 동일 키(직접 호출 대비) |
| `CF_AIG_TOKEN` | AI Gateway 인증 토큰 |
| `CLI_TOKEN` | Obsidian 싱크 CLI Bearer |
| vars `MODEL_HIGH/MODEL_LOW` | gpt-5-mini / gpt-5-nano |
| vars `MONTHLY_BUDGET_USD` | 10 |
| vars `ACCESS_TEAM_DOMAIN/AUD` | taejunyun.cloudflareaccess.com / AUD |

로컬 개발: `worker/.dev.vars`에 `ENVIRONMENT=development` → Access 우회.

## 6. 운영 체크리스트
- [x] launchd 싱크 상시 가동 확인 (`launchctl list | grep radar-sync`)
- [ ] 신규 소스 늘면 SETTINGS → Build semantic index 로 백필 (남은 수 표시됨)
- [ ] DISCOVER → RSS 피드 등록(저널/블로그) 시 탐색 다양화
- [ ] 월 1회 Export(JSON) + Backup originals to R2
- [ ] 크레딧/비용: DISTILL 탭 budget 배지로 상시 확인

## 7. 알려진 제약·후보
- PDF가 스캔(텍스트 레이어 없음)이면 원본만 보존되고 분석은 수동 노트로 대체
- 책(Flusser 등)은 OpenAlex 검증 대상 밖 → unverified 배지는 정상
- Distill 문장 품질은 Reservoir 크기에 비례 — 지금은 개인 작업 중심 편향(Radar가 감지 중). 논문 PDF를 계속 넣으면 Counter/Distill 품질 상승
- 후보(V3): 게이트웨이 로그 GraphQL 연동(Workers AI 무료분까지 포함한 전체 비용), Distill 자동 A/B 비교 뷰, Google IdP(현재 PIN 유지)
