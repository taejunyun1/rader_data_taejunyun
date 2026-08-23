# Task 9 Report — Bounded Discovery Backfill

## Outcome

- Added pure `selectDiscoveryBackfillSources()` selection for `discovery:*` sources whose active version is not `FULLTEXT` or has fewer than 1,000 characters.
- Added an explicit, enqueue-only backfill bounded to 10 sources per request. Canonical HTTP(S) URLs are normalized before creating `SOURCE_ACQUISITION` requests.
- Reused the existing active-job dedupe convention. New jobs increment `enqueued`; active dedupe hits and missing/invalid canonical URLs increment `skipped`; enqueue failures increment `errors`.
- Added protected `POST /api/settings/backfill-discovery`, returning `202` with `{ selected, enqueued, skipped, errors }`.
- Added the Settings action `발견 자료 원문 다시 가져오기` and helper copy explaining the 10-source bound and preservation of existing originals/versions.
- Added no cron behavior. Selection and enqueue perform no source/version updates or deletes, and both SQL and the pure selector exclude manual/non-discovery sources.

## TDD evidence

- RED: the worker backfill suite initially failed because `backfillDiscovery.ts` did not exist.
- RED: the Settings component test failed because the preservation helper and action were absent.
- RED: the Worker app route test returned `404` before the Settings route was connected; the same test confirmed the existing Access middleware returned `401` first in production mode.
- GREEN: `pnpm --dir web exec vitest --root .. run worker/test/backfillDiscovery.test.ts worker/test/settingsBackfillRoute.test.ts` — 2 files, 5 tests passed.
- GREEN: `pnpm --dir web exec vitest run src/views/SettingsUsageView.test.tsx` — 1 file, 4 tests passed.

## Verification

- `pnpm --filter @radar/worker typecheck` — passed.
- `pnpm --filter @radar/shared typecheck` — passed.
- `pnpm --filter @radar/web typecheck` — still exits 2 for pre-existing Node ambient type omissions and direct Worker-source test imports/`Env` visibility; no Task 9 source or test error was reported.

## Files

- `worker/src/ingestion/backfillDiscovery.ts`
- `worker/src/routes/settings.ts`
- `worker/test/backfillDiscovery.test.ts`
- `worker/test/settingsBackfillRoute.test.ts`
- `web/src/views/SettingsView.tsx`
- `web/src/views/SettingsUsageView.test.tsx`
- `.superpowers/sdd/task-9-report-acquisition.md`

## Residual concerns

- The standalone web typecheck remains blocked by the existing project-wide test/ambient type configuration noted above. The focused Settings test passes.
- Historical Discovery records without a valid canonical HTTP(S) URL are intentionally counted as skipped and require manual provenance correction before acquisition can be queued.
