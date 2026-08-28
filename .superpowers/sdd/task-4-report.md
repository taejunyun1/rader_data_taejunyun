# Task 4 — Previewable reservoir refresh Worker API

## Outcome

Implemented a bounded, deterministic repository refresh API with preview/apply modes and a duplicate review queue. Refresh preserves every source, source version, R2 object, provenance record, and source quality state. It does not call AI or the existing retag endpoint.

## Changes

- Added `worker/src/reservoir/refresh.ts`:
  - scans at most 50 unmerged sources ordered by source ID;
  - reads only active-version metadata/text hashes and source identity fields;
  - stores normalized DOI, canonical URL, raw hash, normalized-text hash, and normalized Obsidian-origin fingerprints;
  - evaluates pairs with the Task 3 `evaluateDuplicate` contract;
  - stores candidate score/reason summaries and run counters/cursor/lifecycle timestamps;
  - keeps preview candidates non-merged;
  - on apply, creates logical groups only for pending `AUTO_MERGE` assessments;
  - selects the canonical source by engagement, ready full text, text length, age, then ID;
  - supports explicit `MERGE` and `SEPARATE` candidate resolution without deleting or rewriting source data.
- Added Worker routes:
  - `POST /api/reservoir/refresh`;
  - `GET /api/reservoir/refresh/:runId`;
  - `GET /api/reservoir/duplicates?status=PENDING`;
  - `POST /api/reservoir/duplicates/:candidateId`.
- Added focused real-D1 Worker tests and included them in `worker/vitest.config.ts`.

## TDD record

1. Added route/service tests before production implementation.
2. The first sandboxed run could not start Miniflare because loopback binding and Wrangler log writes were denied; the same command was re-run with the required local-test permission.
3. RED was observed:
   - `refresh.test.ts` failed because `./refresh` did not exist;
   - all three route cases failed because refresh returned 404 and no candidate was created.
4. Added the minimum service and route implementation.
5. GREEN was observed: 2 files and 4 tests passed.

## Verification

- `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/refresh.test.ts src/routes/reservoir.test.ts`
  - PASS: 2 files, 4 tests.
- `pnpm --filter @radar/worker run typecheck`
  - PASS: `tsc --noEmit` exited 0.
- `git diff --check` on Task 4 implementation/config files
  - PASS: no whitespace errors.

## Harness adaptation

The plan named `vitest.route.config.ts`, but that config is a Node shim with no D1 binding and only includes two legacy `worker/test/*` files. The repository's established real Worker/D1 harness is `vitest.config.ts`. The two focused Task 4 tests were therefore added to that config's explicit include list and run there, avoiding a fake SQL implementation.

## Preservation and scope audit

- No deploy or remote D1 migration command was run.
- No AI, retag, R2 delete, source delete, source-version delete, or quality-state update exists in the refresh service.
- The pre-existing PDF visual-extraction edits in `worker/src/routes/reservoir.ts` remain in the working tree exactly as found and are excluded from the Task 4 commit.
- No `AcquisitionColumns` compatibility correction was necessary; Worker typecheck passed without it.

## Remaining scope

The bounded run is executed during the accepted POST request and persisted as completed before the 202 response. A later workflow/queue integration can move the same bounded service behind `waitUntil` or a dedicated Worker workflow if multi-batch background continuation is required; Task 4 adds no new workflow binding.
