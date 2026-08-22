# Research Radar — 내부 참조 가이드

최종 정리: 2026-08-22

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
- `worker/migrations/0001~0006`: 초기 스키마, Queue 검증, V1 기능, topic, snapshot synthesis
- 배포 대상: `radar.taejunyun.com`
- 패키지 매니저: `pnpm@11.21.0`

현재 기능 묶음:

| 영역 | 현재 상태 | 기준 |
|---|---|---|
| Ingestion/Reservoir | 텍스트·URL·MD·PDF·홈페이지 import, dedup, R2 원본 보존 | V0 필수 |
| Analysis | Workers AI 분류·요약·키워드·질문·fragment·topic, indexed 처리 | V0 + 확장 |
| Search | D1 키워드/메타 검색 + Vectorize semantic search | Semantic은 V1 확장 |
| Distill | context selection, Distill/Critic/Counter, Re-distill, 비용 원장 | V0 필수 |
| Reading Queue | OpenAlex 존재 검증과 verified 표시 | V0 필수 |
| Radar | 주/월/년 통계·합성 UI, 주간 snapshot cron | V0 필수 |
| Discovery | 홈페이지 프로젝트·읽을거리 키워드 시드 + OpenAlex + arXiv + RSS/Atom | homepage_artist R2 스냅샷이 일일 cron으로 Reservoir에 반영됨 |
| Obsidian | CLI sync와 버전 히스토리 | V1 확장, V0 아님 |
| Usage | 월 비용·목적·모델·일별 차트 | V2 확장 |
| Export | JSON/Markdown/CSV 및 R2 원본 백업 | V0 필수 |

Discovery 후보는 제목과 초록·RSS 요약에 연구 기준어가 실제로 포함되고 관련도 0.65 이상일 때만 등록한다. `data`·`theory`·`AI` 같은 일반어 단독 검색은 제외하며, 사진·이미지·시각문화 축이 없는 공학 중심 후보(벤치마크·데이터셋·캘리브레이션·인식·검색·파이프라인 등)는 차단한다. arXiv는 시각·이미지·컴퓨터비전 인접 카테고리로 제한하고, OpenAlex는 `open_access.oa_url`이 있는 자료만 받는다. ARTnews·Artforum 같은 구독 가능성 출처, 기관 인증만 필요한 RISS 링크, 접근 미확인 링크는 메인 후보에서 제외한다. 후보는 무료 원문 또는 PDF만 노출하며, 한 번의 실행에서 최대 8개(소스별 OpenAlex 4·arXiv 2·RSS 2), 제목 정규화 중복 제거를 적용한다. 기존 미검토 후보는 다음 Discovery 실행 시 새 기준으로 재평가하며, 탈락 자료는 삭제하지 않고 `IGNORED`로 남긴다.

### 3-1. 현재 UI 읽기 흐름

전체 UI는 `레이더 → 발견/저장소에서 읽기 → 판단/분류 → 착즙 → 다시 읽기` 순서를 우선한다.

- 레이더는 `선택 기간 정량 요약 → 해석 서사 → 지금 직접 읽기와 다음 행동 → 상세 연구 정보` 순서다. 신규 키워드·판단·자료 구성은 최상단에 한 번만 표시하고, 자료 구성은 전체 누적임을 명시한다. 장기 연구 지형은 접힌 상세 영역으로 제공한다.
- 발견과 저장소는 목록·읽기·판단을 한 작업공간에 배치한다. 후보의 실제 링크와 접근 상태를 함께 표시한다.
- 저장소에서 `보관하기` 또는 `발전시키기`를 누른 자료는 다음 착즙 실행 전까지 `다음 리서치` 마크로 유지한다. 다음 착즙 컨텍스트에서 우선 포함하고, 이후에는 자동으로 다음 사이클 마크에서 빠진다. `관찰하기`·`제외하기`를 나중에 누르면 해당 마크를 해제한다.
- 저장소 판단은 목록 배지와 상세 바텀시트의 현재 상태로 즉시 확인한다. `제외하기` 자료는 기본 목록에서 숨기되 삭제하지 않고 `제외됨` 필터에서 복구·판단 변경할 수 있으며, `관찰 중` 자료는 기본 목록에 남긴다.
- 착즙은 문서 목차와 읽기 큐를 제공하며, OpenAlex 검증 전 큐 항목의 저장소 승격을 막는다.
- 받은편지함은 메모·URL·파일을 원본 보존 우선으로 접수하고 처리 실패를 재시도 가능하게 표시한다.
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
- `source_analysis`는 `INTERPRETATION`, Distill/Radar 결과는 `SYNTHESIS` 성격으로 취급한다.
- 자동 Discovery 후보는 사용자가 Keep하기 전 Reservoir 핵심 자료로 승격하지 않는다.
- OpenAlex에서 검증되지 않은 Reading Queue 항목을 실존 자료처럼 표시하거나 Reservoir로 가져오지 않는다.
- 중복이면 새 source를 만들지 않고 기존 source에 재수입 provenance를 기록한다.

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
- `ai_usage`에 호출별 token/cost/purpose를 기록
- 월 예산은 기본 `$10`, 80% 경고, 100% Distill 중단
- 자동 작업을 추가할 때도 예산 초과 가능성과 guardrail 적용 범위를 확인한다.

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
- AI 분석: `worker/src/analysis/`
- Distill: `worker/src/distill/`
- Radar: `worker/src/radar/`
- D1 migration: `worker/migrations/`
- 주요 UI: `web/src/views/`
- 운영 변수: `worker/wrangler.jsonc`, secrets는 `wrangler secret put`으로 관리
