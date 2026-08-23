# Task 6 Report — Deep-analysis readiness and acquisition retry

## Outcome

- Exported a pure `isDeepAnalysisReady` gate requiring active-version `FULLTEXT`, source `READY`, recorded `char_count >= 1000`, and non-empty normalized text.
- Added structured `deep_analysis_text_not_ready` results with `textScope`, `qualityStatus`, and `charCount`.
- Applied the gate both before Reservoir workflow enqueue and inside `analyzeDeepSource` before any paid model call or analysis insert.
- Deep analyses now retain the exact active `version_id` read and include `versionId`, `textScope`, and recorded `sourceCharCount` in payload metadata.
- Kept `retry/:sourceId?analyze=1` as current-active-version analysis.
- Added `retry/:sourceId?fetch=1` as a canonical-URL `SOURCE_ACQUISITION` enqueue returning HTTP 202 without calling `analyzeSource`.
- Preserved the existing ready-source deep-analysis enqueue path and made no schema changes.

## TDD evidence

- RED: focused tests failed for the missing gate, missing version provenance, unguarded 202 deep enqueue, and synchronous 200 fetch retry.
- GREEN: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts src/views/ReservoirView.test.tsx` — 4 files, 50 tests passed.
- Typechecks: `pnpm --filter @radar/worker typecheck` and `pnpm --filter @radar/shared typecheck` passed after the focused suite.

## Files

- `worker/src/analysis/deepAnalyze.ts`
- `worker/src/routes/reservoir.ts`
- `worker/src/routes/inbox.ts`
- `worker/src/ingestion/versioning.ts`
- `web/src/lib/deepAnalysis.test.ts`
- `web/src/views/ReservoirView.test.tsx`

## Residual concerns

- The legacy retry request without either query flag still follows its pre-existing synchronous URL refetch path. The explicit `analyze=1` and `fetch=1` contracts are separated; changing the unflagged compatibility path was outside Task 6.
