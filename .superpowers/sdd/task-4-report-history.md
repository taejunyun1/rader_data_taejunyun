# Task 4 Report History

This file preserves the Task 4 budget-reservation report that existed before commit `2c18f4b`, which later replaced the active Task 4 report with reading-workspace follow-ups.

---

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

## Follow-up Fix Report

Date: 2026-08-24
Status: Complete

### Scope

- Moved deep-analysis reservation release out of the paid `execute-deep_analysis` workflow step.
- Added a separate `release-deep-analysis-budget` workflow step that runs only after successful analysis, so release retry does not rerun paid analysis.
- Added failure cleanup for ultimately failed deep-analysis workflows. Cleanup release failures are logged and do not replace the original workflow error or status decision.
- Added regression tests for:
  - failed analysis attempt followed by workflow step retry reusing the same RESERVED row
  - release failure during failure cleanup preserving the primary analysis error

### Exact Commands and Outcomes

RED:

```bash
pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts
```

Outcome:

- Failed as expected: `1` file failed, `2` tests failed, `16` passed.
- Failure 1: retry became `monthly_budget_exhausted`.
- Failure 2: release failure replaced `deep_analysis_invalid_output` with `release_failed`.

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts
```

Outcome:

- Passed: `1` file, `18` tests.

Typecheck:

```bash
pnpm -r typecheck
```

Outcome:

- Passed across `shared`, `worker`, and `web`.

### Concerns

- No migration changes were needed for this follow-up, so `pnpm db:migrate` was not rerun.
- Existing untracked local artifacts were left untouched: `.playwright-cli/`, `.pnpm-store/`, `.superpowers/brainstorm/`, `docs/superpowers/plans/2026-08-24-remote-fetch-safety-and-ai-budget-guard-plan.md`, `output/`, and `web/test-results/`.
