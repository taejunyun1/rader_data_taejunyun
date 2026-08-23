# Task 8 Report — Reservoir/Discovery actions and job UX

## Outcome

- Kept `다시 분석하기` on the explicit `POST /api/inbox/retry/:sourceId?analyze=1` path and added `다시 가져오기` on the separate `?fetch=1` acquisition path.
- Disabled refetch when the selected source has no canonical URL and displayed the reason without removing the existing external source access link.
- Applied `detail.acquisition.canDeepAnalyze` before any deep-analysis request. Blocked details now preserve `textScope`, `qualityStatus`, and `charCount` in one visible status sentence.
- Preserved the existing `SOURCE_ACQUISITION` → `원문 수집` job label and added a focused JobCenter result test proving the acquisition ref opens by `sourceId` without `analysisId`.
- Preserved Discovery Keep feedback and job refresh ordering. Kept candidates with `sourceId` now skip the metadata-only Discover reading pane and open the exact Reservoir source; their external verification links remain in the candidate index.
- Added the minimal App integration callback required to place the selected Discover source into Reservoir focus state.

## TDD evidence

- Baseline: focused Task 8 suite passed 22 tests before new behavior was added.
- RED: four focused regressions failed for missing refetch UI, missing canonical-url gate, missing acquisition deep gate, and missing kept-candidate source navigation.
- GREEN: `pnpm --dir web exec vitest run src/views/ReservoirView.test.tsx src/views/DiscoverView.test.tsx src/components/layout/JobCenter.test.tsx` — 3 files, 27 tests passed.
- Full web suite: `pnpm --dir web exec vitest run` — 32 files, 201 tests passed.

## Verification

- `pnpm --filter @radar/shared typecheck` — passed.
- `pnpm --filter @radar/worker typecheck` — passed.
- `pnpm --dir web exec vite build` — passed; 62 modules transformed.
- App Browser smoke check at `http://127.0.0.1:5173/` confirmed the `리서치 레이더` page identity, non-blank app shell, Reservoir navigation, no framework overlay, and no console warnings/errors. The local Worker was not running, so data-backed action behavior was verified through the focused Vitest fixtures.
- `pnpm --filter @radar/web typecheck` was run and still exits 2 only for the pre-existing Node ambient types, direct Worker-source test imports, and Worker `Env` visibility issues documented in the Task 5/6 acquisition reports. It reports no Task 8 source or test errors.

## Files

- `web/src/App.tsx`
- `web/src/views/ReservoirView.tsx`
- `web/src/views/ReservoirView.test.tsx`
- `web/src/views/DiscoverView.tsx`
- `web/src/views/DiscoverView.test.tsx`
- `web/src/components/layout/JobCenter.test.tsx`
- `web/src/styles/views.css`

## Residual concerns

- Standalone web typecheck remains blocked by the existing project-wide ambient type configuration described above; production Vite bundling and all web tests pass.
- Browser smoke validation could not exercise data-backed actions without a local Worker/D1 fixture. Exact action URLs, negative cross-action assertions, disabled gates, Keep refresh ordering, and sourceId navigation are covered by focused component tests.
