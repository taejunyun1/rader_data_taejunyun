# AGENTS.md — Research Radar (rader_data_taejunyun)

## Source of Truth
- 제품 요구사항: `docs/spec-v0.1.txt` (원본 스펙) + `docs/SPEC.md` (v1.0 확정 결정, 충돌 시 우선)
- 개발 계획: `docs/DEV_PLAN.md`
- 현재 구현·운영·provenance 참조: `docs/PROJECT_CONTEXT.md`
- 문서에 없는 기능을 임의로 확장하지 않는다. 중요한 설계 변경은 임의 결정 금지 — 변경 이유와 대안을 사용자에게 먼저 제시한다.

## 원칙
- Cloudflare-first / External-minimal / Serverless-first / Reservoir-first / Model-agnostic
- AI보다 Reservoir와 provenance 우선. 원본은 항상 R2 보존 후 처리.
- 사용자에게 과도한 설정·선택을 요구하지 않는다 (5 파라미터만 노출).
- V0 비목표(챗봇/멀티유저/Admin/Knowledge Graph UI/Fine-tuning/Google Drive/시맨틱 검색) 추가 금지.
- 모델명 하드코딩 금지 — wrangler vars로 관리.

## 구조
- `worker/` — Hono API + cron (D1/R2/Workers AI/AI Gateway)
- `web/` — Vite + React SPA (Workers Static Assets)
- `shared/` — 공통 TypeScript 타입
- 패키지 매니저: pnpm workspaces

## 명령 (Phase 0 스캐폴드 후 확정)
- 설치: `pnpm i`
- 개발: `pnpm dev`
- 배포: `pnpm deploy`
- D1 마이그레이션: `pnpm db:migrate`

## 커밋 규칙
- 커밋 메시지에 해당 날짜 표시 + 업데이트 주요 내용 축약. 예: `250818: Phase 1 ingestion 코어 - dedup/R2 보존`
