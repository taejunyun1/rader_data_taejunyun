# Task 3 Visual Reservoir Report

Date: 2026-08-25
Requested commit prefix: `260826`

## Scope implemented

- Extracted the shared SSRF-safe remote byte fetch seam from `worker/src/ingestion/fetchRemoteDocument.ts` so document and image acquisition use the same URL/DNS/redirect/private-network guard.
- Added `worker/src/visual/extraction/fetchImage.ts` for external image fetch with:
  - allowed MIME gate: JPEG/PNG/WebP/GIF/SVG
  - 10 MiB streaming limit
  - final URL capture
  - SHA-256 content hash
  - image-specific errors: `IMAGE_URL_BLOCKED`, `IMAGE_TYPE_INVALID`, `IMAGE_SIZE_LIMIT`
- Added `worker/src/visual/extraction/filter.ts` for deterministic filter outcomes with fixed rule version `visual-filter-v1`:
  - decorative/tracker/repetition rejection before duplicate checks
  - exact duplicate by SHA-256
  - near duplicate by dHash Hamming distance `<= 6`
  - thin-context downgrade to `REVIEW`
  - explicit `UNAVAILABLE` mapping for fetch failures
- Added rights-first LINK_ONLY draft generation for `UNKNOWN|RESTRICTED|PUBLIC_LINK`:
  - no persistent byte storage
  - metadata-only `ORIGINAL` version with `r2Key = null`
  - stable provenance payload with source URL, final URL, caption, nearby text, hash, and selection reason
  - duplicate provenance recorded as `DUPLICATE_OF` relation without delete/merge behavior

## Tests added first and verified

- `web/src/lib/remoteAcquisition.test.ts`
  - private-network image target blocked before fetch
  - content-type/magic mismatch returns `IMAGE_TYPE_INVALID`
  - image body larger than 10 MiB returns `IMAGE_SIZE_LIMIT`
  - valid SVG returns normalized metadata and content hash
- `web/src/lib/visualAssets.test.ts`
  - decorative signals win before duplicate checks
  - exact and near duplicates return deterministic `DUPLICATE` outcomes with `DUPLICATE_OF`
  - thin-context candidates downgrade to `REVIEW`
  - fetch failures map to `UNAVAILABLE`
  - LINK_ONLY drafts create metadata-only `ORIGINAL` versions and do not persist bytes

## Verification

- RED verified first:
  - `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/visualAssets.test.ts`
  - failed because `fetchImage.ts` and `filter.ts` did not exist
- GREEN verified after implementation:
  - `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/visualAssets.test.ts`
  - passed: `65` tests
- Typecheck:
  - `pnpm typecheck`
  - passed

## Notes

- I did not change `.superpowers/sdd/task-2-report.md` or unrelated dirty files.
- I did not introduce any persistent external-image storage path for non-`PERSONAL|PERMITTED` rights states.
- I did not add a new `visualExtraction` route in this task. In the current execution plan, route creation/index wiring for that separate endpoint belongs to Task 4. Task 3 scope here stayed within the exact brief file set and the existing visual-assets routing remains unchanged.
