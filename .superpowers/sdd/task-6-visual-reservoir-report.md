# Task 6 Visual Reservoir Report

Date: 2026-08-25

## Scope Completed

- Implemented `GET /api/visual-assets/:id` as a detail endpoint with bbox, nearby text, rights basis, latest auto suggestion, latest user-verified analysis, relations, and extraction-run context.
- Implemented `PATCH /api/visual-assets/:id/analysis` so `accept` and `edit` append `USER_VERIFIED` rows instead of mutating `AUTO_SUGGESTION`, and `dismiss` only changes the auto-suggestion review state.
- Implemented `PATCH /api/visual-assets/:id/assignment` with source existence and active-version validation.
- Implemented `PATCH /api/visual-assets/:id/rights` with `PERMITTED` basis enforcement and rights review timestamp recording.
- Implemented `POST /api/visual-assets/:id/retry` across transform, analysis, and extraction recovery paths using the existing research job dedupe key behavior.
- Implemented `POST /api/visual-assets/:id/storage-transition` for `ARCHIVAL -> CAPSULE` and `CAPSULE -> TEXT_ONLY` with `USER_VERIFIED` gating, capsule/original presence checks, and `visual_asset_operations` journaling.

## Files Changed

- `worker/src/visual/store.ts`
- `worker/src/routes/visualAssets.ts`
- `web/src/lib/visualAssets.test.ts`

## Verification

- `pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/lib/ingestion.test.ts`
- `pnpm typecheck`

Results:

- Focused Vitest passed: 52 tests.
- Workspace typecheck passed for `shared`, `worker`, and `web`.

## Limitations

- `storage-transition` performs the guarded delete and operation journal update inline in the route; it does not yet use a separate lifecycle module or background finalization flow.
- `retry` reuses the parent extraction run id for extraction recovery, but the selective failed-unit reuse still depends on the existing extraction workflow behavior rather than a new route-local retry planner.
