# Task 9 Visual Reservoir Report

Date: 2026-08-26

## Scope Delivered

- retention transition hardening for `CAPSULE` and `TEXT_ONLY`
- operation journaling failure/recovery preservation on storage deletes
- 24-hour PDF temp cleanup with active/recent run protection
- cron-isolated cleanup execution
- shared monthly budget reservation support for `DEEP_ANALYSIS` and `VISUAL_ANALYSIS`
- visual-analysis budget fallback to `REVIEW`
- richer visual extraction outcome counts in workflow results and Job Center

## Changed Files

- `worker/src/visual/cleanup.ts`
- `worker/src/index.ts`
- `worker/src/analysis/budgetReservation.ts`
- `worker/src/routes/visualAssets.ts`
- `worker/src/visual/extraction/run.ts`
- `worker/wrangler.jsonc`
- `worker/src/workflows/researchJob.ts`
- `web/src/lib/researchJobs.ts`
- `web/src/components/layout/JobCenter.tsx`
- `web/src/lib/visualAssets.test.ts`
- `web/src/lib/deepAnalysis.test.ts`
- `web/src/components/layout/JobCenter.test.tsx`

## Verification

- `pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/lib/deepAnalysis.test.ts src/components/layout/JobCenter.test.tsx`
  - passed: `73` tests
- `pnpm typecheck`
  - passed
- `git diff --check`
  - passed

## Notable Results

- `TEXT_ONLY` now requires a second explicit confirmation and rejects external rights-gated assets.
- storage delete failures keep the operation row recoverable and preserve the pre-transition asset state.
- PDF temp cleanup only deletes terminal-run objects older than 24 hours; active or recent runs are skipped.
- cleanup errors are logged separately and do not block homepage/discovery/snapshot cron work.
- visual analysis now shares the same reservation gate as deep analysis and falls back to `REVIEW` instead of blocking the job.
- visual extraction job results now carry duplicate, rights-gated, and cleanup-failure counts for UI summaries.
- successful inline PDF temp deletion now marks the extraction unit `DELETED` in D1; R2 deletion failures leave the unit `SUCCEEDED` with its temp key for retry.
- a dedicated hourly cleanup cron (`0 * * * *`) runs cleanup in isolation and returns before homepage/snapshot/discovery handlers.

## Limitations

- the visual-analysis reservation uses a fixed estimate (`$0.01`) rather than a provider-reported actual cost.
- existing `ai_usage` accounting remains authoritative for realized spend; visual-analysis reservations are a guardrail, not a new ledger entry.
- cleanup logs are structured and privacy-safe, but there is no separate admin UI for cleanup history in Task 9 scope.

## Task 9 Review Fixes

- inline cleanup tests cover D1 `DELETED` marking, no later cleanup recount, and cleanup retry after an R2 delete failure.
- schedule tests cover the hourly Wrangler trigger and isolation from the other cron handlers.
