# Task 6 Visual Reservoir Report

Date: 2026-08-26

## Scope Completed

- Implemented `GET /api/visual-assets/:id` as a detail endpoint with bbox, nearby text, rights basis, latest auto suggestion, latest user-verified analysis, relations, and extraction-run context.
- Implemented `PATCH /api/visual-assets/:id/analysis` so `accept` and `edit` append `USER_VERIFIED` rows instead of mutating `AUTO_SUGGESTION`, and `dismiss` only changes the auto-suggestion review state.
- Implemented `PATCH /api/visual-assets/:id/assignment` with source existence and active-version validation.
- Implemented `PATCH /api/visual-assets/:id/rights` with `PERMITTED` basis enforcement and rights review timestamp recording.
- Implemented `POST /api/visual-assets/:id/retry` across transform, analysis, and extraction recovery paths using the existing research job dedupe key behavior.
- Implemented `POST /api/visual-assets/:id/storage-transition` for `ARCHIVAL -> CAPSULE` and `CAPSULE -> TEXT_ONLY` with `USER_VERIFIED` gating, capsule/original presence checks, and `visual_asset_operations` journaling.
- Corrected review provenance so accept rows use the current AUTO_SUGGESTION base while edit rows use the immediately prior AUTO_SUGGESTION or USER_VERIFIED row on the current capsule version; repeated edits therefore form a concrete parent-analysis chain. Detail, analysis retry, dismiss, and storage verification remain scoped to the current capsule version.
- Corrected HTML extraction retry to reuse the supplied `extractionRunId` and process only failed/non-terminal units, including units outside the initial candidate window; PDF run provenance validation is aligned with the same guard.
- Corrected assignment to join the source's active version back to that source in the guarded update, with optional stale-version rejection and no partial parent/status update.
- Corrected storage failure handling so a deletion followed by DB-finalization failure leaves a failed operation plus pending state for recovery instead of claiming the old bytes remain.

## Files Changed

- `worker/src/visual/store.ts`
- `worker/src/routes/visualAssets.ts`
- `worker/src/visual/extraction/run.ts`
- `web/src/lib/visualAssets.test.ts`
- `.superpowers/sdd/task-6-visual-reservoir-report.md`

## Verification

- `pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/lib/ingestion.test.ts`
- `pnpm typecheck`

Results:

- Focused Vitest passed: 56 tests, including repeated-edit provenance coverage.
- Workspace typecheck passed for `shared`, `worker`, and `web`.
- `git diff --check` passed.

## Limitations

- `storage-transition` still performs the delete and finalization inline; a separate background reconciler is out of Task 6 scope. When finalization is uncertain, the pending marker and failed operation make the transition retryable and prevent a false retained-bytes state.
- HTML retry resolves the persisted candidate key against the immutable source HTML because the existing unit schema stores candidate keys rather than a full candidate snapshot; it does not broaden the retry to a new candidate scan/window.
