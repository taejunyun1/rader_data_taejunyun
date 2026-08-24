# Task 4 Report

Date: 2026-08-24
Status: Complete
Commit: `260824: 심층 정리 월 예산 원자 예약`

## Scope Implemented

- Added D1 reservation ledger migration `worker/migrations/0016_ai_budget_reservations.sql`.
- Added `worker/src/analysis/budgetReservation.ts` with:
  - model-aware conservative deep-analysis ceiling
  - one-statement `INSERT ... SELECT` reservation predicate
  - idempotent reuse of existing `RESERVED` rows by `research_job_id`
  - reservation release that leaves `RELEASED` audit rows out of active budget sum
- Updated `worker/src/workflows/researchJob.ts` so deep analysis:
  - no longer uses `monthSpendUsd` as the authoritative workflow check
  - reserves immediately before `analyzeDeepSource`
  - blocks as `BLOCKED/monthly_budget_exhausted` when reservation fails
  - releases in `finally` on success and error
- Preserved the reservoir route response schema and HTTP 429 fast-path guard, with a comment documenting that workflow reservation is the race-safe final check.
- Added reservation and workflow integration coverage in `web/src/lib/deepAnalysis.test.ts`.
- Added a Vitest-only `cloudflare:workers` resolver in `web/vitest.config.ts` so the existing web test runner can import the real workflow module.

## Changed Files

- `.superpowers/sdd/task-4-report.md`
- `worker/migrations/0016_ai_budget_reservations.sql`
- `worker/src/analysis/budgetReservation.ts`
- `worker/src/workflows/researchJob.ts`
- `worker/src/routes/reservoir.ts`
- `web/src/lib/deepAnalysis.test.ts`
- `web/vitest.config.ts`

## TDD Record

1. Added Task 4 tests first in `web/src/lib/deepAnalysis.test.ts`.
2. Ran:

```bash
pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts
```

3. Observed expected RED:
   - suite failed to resolve missing `../../../worker/src/analysis/budgetReservation`
   - no production reservation code existed yet
4. Implemented migration, reservation service, workflow lifecycle hook, route comment, and test shim.
5. Re-ran focused tests until green.

## Exact Outcomes

Initial required migration command in the sandbox:

```bash
pnpm db:migrate
```

Result:

- Failed due to sandbox restrictions:
  - `listen EPERM: operation not permitted 127.0.0.1`
  - failed Wrangler log write under `/Users/taejun-yun/.wrangler/logs`

Escalated rerun:

```bash
pnpm db:migrate
```

Result:

- Passed.
- Local D1 migration `0016_ai_budget_reservations.sql` applied successfully.
- Wrangler reported `3 commands executed successfully`.

Focused tests:

```bash
pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts
```

Result:

- Passed: `1` file, `16` tests.

Typecheck:

```bash
pnpm -r typecheck
```

Result:

- Passed across `shared`, `worker`, and `web`.

## Concerns

- No D1 migration semantic blocker remains; local migration applied successfully after required sandbox escalation.
- `web/vitest.config.ts` changed only to let web Vitest resolve `cloudflare:workers` for real workflow-module tests. This is outside the brief's original file list, but without it the workflow integration fixture cannot import `worker/src/workflows/researchJob.ts` in the web test runner.
- Reservation release is intentionally audit-preserving: active budget only sums `RESERVED`; final spend remains `ai_usage`.
- The reservation ceiling is conservative and model-aware using configured model roles and configured pricing/fallback pricing. It does not hardcode model names or prices.
