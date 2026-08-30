# Reservoir deletion claim serialization implementation plan

> **For agentic workers:** use `superpowers:subagent-driven-development`. Execute one bounded task at a time with a fresh implementer and a separate reviewer. Record each task's report and verification in `.superpowers/sdd/progress.md`.

**Goal:** D1 claim과 DB/write guard로 저장소 영구 삭제의 R2↔D1 경쟁 조건을 차단하고, R2/D1 실패 후 안전한 재시도를 제공한다.

**Architecture:** `source_deletion_claims`가 source별 단일 lease를 소유한다. 삭제 서비스가 claim을 선점한 뒤 기존 R2-first/D1-batch 흐름을 실행하고, migration trigger와 중앙 enqueue/R2 writer guard가 claim 중 신규 source-owned 작업을 거부한다. claim 상태는 R2 실패·D1 실패 모두 보존되며 source 삭제 성공 시 FK cascade로 제거된다.

**Tech stack:** TypeScript 5.9, Hono 4, Cloudflare Workers/D1/R2, React 19, Vitest 4, pnpm workspaces.

## Constraints

- 기준 문서: `docs/superpowers/specs/2026-08-29-reservoir-permanent-source-deletion-design.md`와 이 addendum.
- 기존 삭제 확인 UI/API와 병합·historical fingerprint 안전장치를 유지한다.
- claim metadata 외 원문, R2 key, SQL 전문을 응답·로그에 노출하지 않는다.
- 새 migration은 로컬 코드와 테스트에만 추가한다. `pnpm db:migrate`, deploy, push는 실행하지 않는다.
- 사용자 작업트리의 기존 변경은 건드리지 않는다.
- 커밋은 `260830: 주요 내용` 형식으로 task 단위로 만든다.

## Task 1 — claim schema, helper, and DB guards

**Files:**

- Create `worker/migrations/0027_source_deletion_claim.sql`
- Create `worker/src/reservoir/deletionClaim.ts`
- Create `worker/src/reservoir/deletionClaim.test.ts`
- Modify `worker/vitest.config.ts` only if the suite include requires it

Implement the table, indexes, ownership triggers, lease-aware acquire/renew/state/error helpers, and focused tests. Acquisition must reject a live `R2_COMPLETE` claim with no error, allow immediate rotation only when `last_error_code = 'source_delete_d1_failed'`, and retain expiry-based recovery for abandoned claims. Verify trigger JSON predicates are safe for invalid/non-source job input. Commit only this task.

## Task 2 — enqueue and source/version writer guards

**Files:**

- Modify `worker/src/jobs/enqueue.ts`
- Modify `worker/src/jobs/store.ts` only if stable error propagation needs it
- Modify `worker/src/ingestion/store.ts`
- Modify `worker/src/ingestion/versioning.ts`
- Modify `worker/src/routes/sync.ts`
- Add/extend focused worker tests

Resolve source ownership from direct `sourceId`, `sourceVersionId`/`versionId`, and visual asset inputs. Guard before R2 puts and D1 writes; map claim conflicts to stable errors. Test both direct and duplicate/re-import paths plus unrelated-source writes. Commit only this task.

## Task 3 — visual/extraction worker R2 and dependency guards

**Files:**

- Modify `worker/src/visual/store.ts`
- Modify `worker/src/visual/transform.ts`
- Modify `worker/src/routes/visualExtraction.ts`
- Modify `worker/src/visual/extraction/run.ts`
- Modify `worker/src/visual/extraction/store.ts` only where a source-owned insert needs explicit handling
- Add/extend focused worker tests

Add immediate pre-put claim checks for visual originals, capsules, PDF page/crop objects, and extraction artifacts. Ensure cleanup deletes still run and claim errors are not swallowed as generic candidate failures. Verify an in-flight worker cannot add a new R2 key after claim acquisition.

## Task 4 — deletion service claim lifecycle and API contract

**Files:**

- Modify `worker/src/reservoir/deleteSource.ts`
- Modify `worker/src/routes/reservoir.ts`
- Modify `worker/src/reservoir/deleteSource.test.ts`
- Modify `worker/src/routes/reservoir.test.ts`

Acquire claim before plan, release only preflight failures, preserve claim on R2/D1 failures, renew/mark states, and make the D1 batch prove claim ownership. Add tests for live conflict, retry after each failure class, and no intervening write. Keep the existing merge/historical behavior intact. Commit only this task.

## Task 5 — UI retry/in-progress treatment

**Files:**

- Modify `web/src/views/ReservoirView.tsx`
- Modify `web/src/components/reservoir/SourceDeleteDialog.tsx`
- Modify corresponding tests/styles only as needed

Map `source_delete_in_progress` to a readable locked/retry state, preserve the existing confirmation contract, and ensure a failed R2/D1 retry does not silently navigate away. Add focused tests; no new force-unlock control.

## Task 6 — documentation, broad verification, and final review

**Files:**

- Modify `docs/PROJECT_CONTEXT.md`
- Modify `docs/DEV_PLAN.md` only if its phase status references the old no-migration boundary
- Add `.superpowers/sdd/progress.md` entries/reports if missing

Run focused tests after each task, then `pnpm verify`. Perform a fresh broad review against both design docs, migration ordering, trigger coverage, R2 failure behavior, and existing user changes. Resolve findings before completion. Do not claim production migration/deploy.

## Verification commands

```bash
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/deletionClaim.test.ts
pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/deleteSource.test.ts src/routes/reservoir.test.ts
pnpm --filter @radar/worker typecheck
pnpm verify
```
