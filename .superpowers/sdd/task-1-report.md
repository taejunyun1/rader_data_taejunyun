# Task 1 implementation report

## Status

DONE

## Implementation

- Added a `FULLTEXT` + `REVIEW` blocked-action classifier in `ReservoirView`.
- The quality-review state now presents `품질 다시 검사` and routes that action to the existing reanalysis endpoint.
- Acquisition-blocked states retain the existing refetch CTA and canonical-URL guard.
- Added a focused UI regression test proving that `FULLTEXT` + `REVIEW` does not present `원문 수집 필요`.

## Verification

- TDD red run: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx` failed as expected because the CTA was `원문 다시 가져오기`.
- Green run: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx` — PASS (41 tests).
- Typecheck: `pnpm --filter @radar/web run typecheck` — PASS.
- `git diff --check` — PASS.

## Changed files

- `web/src/views/ReservoirView.tsx`
- `web/src/views/ReservoirView.test.tsx`

## Commit

- `d7e9b2674c189b93fe408a567bb8c4cdacff50cc` (`260828: 심층 정리 품질 검토 CTA 분리`)

## Concerns

- None.

## Review follow-up: visual extraction CTA

- Added a focused regression test covering a web source (`URL_HTML`) with `FULLTEXT` + `REVIEW`; the test failed before the fix because the visual status panel exposed `원문 다시 가져오기`.
- Updated `ReservoirView` to omit the visual-status acquisition callback while `FULLTEXT` quality is under review. Acquisition refetch remains available for other blocked web states.
- Focused test: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx -t "does not offer web-source visual refetch"` — PASS (1 test).
- Full `ReservoirView` suite: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx` — 42 passed, 1 pre-existing PDF recovery failure.
- Web typecheck: `pnpm --filter @radar/web run typecheck` — PASS.
- `git diff --check` — PASS.
- Follow-up commit: `c448dec` (`260828: 품질 검토 자료 재수집 CTA 차단`).
