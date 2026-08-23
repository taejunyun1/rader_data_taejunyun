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

## Review-fix addendum — 2026-08-24

### Findings resolved

- Reservoir now recognizes the existing structured HTTP 422 `deep_analysis_text_not_ready` response. `METADATA_ONLY`, `PARTIAL`, empty/unknown text, non-ready quality, and sub-1,000-character cases are translated into actionable Korean reasons instead of exposing the API error code.
- After the readiness response, the profile selector and deep-analysis action are disabled, and the action label changes to `원문 수집 필요`. The existing READY path still sends the selected deep-analysis profile unchanged.
- Added direct Hono route regressions for all retry modes without changing backend semantics:
  - plain `POST /retry/:id` performs the legacy synchronous remote refetch/version append path;
  - `?analyze=1` calls `analyzeSource` for the current source without a remote fetch or acquisition enqueue;
  - `?fetch=1` returns HTTP 202 and enqueues `SOURCE_ACQUISITION` without analysis or synchronous fetch.

### Verification

- RED: the new Reservoir blocked-state test failed while the UI displayed `deep_analysis_text_not_ready` and left the action enabled.
- GREEN: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts src/views/ReservoirView.test.tsx` — 4 files, 53 tests passed.
- Typechecks: `pnpm --filter @radar/worker typecheck` and `pnpm --filter @radar/shared typecheck` passed.
- Rendered validation at `http://127.0.0.1:5173/` with a local mock API confirmed the flow `저장소 → 메타데이터 자료 → 심층 정리하기 → 차단 사유`, disabled action/profile controls, and zero browser console warnings or errors.
- An additional `@radar/web` typecheck remains blocked by existing test Node-type and cross-package Worker `Env` errors outside this review-fix diff; the focused Vitest transform and rendered Vite flow both passed.
