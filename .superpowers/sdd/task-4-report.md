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

## Review fix — 2026-08-29

### Outcome

- Refresh now reads the latest completed run cursor for the same mode and scans with `s.id > cursor`, requesting 51 rows to process a maximum of 50 and expose a persisted `hasMore` continuation contract.
- A final batch stores a null continuation cursor; a later call begins a new bounded cycle. PREVIEW and APPLY keep independent cursor progress, so applying does not accidentally inherit preview traversal state.
- Exact fingerprint matches can cross a 50-source boundary: the current batch is joined against persisted `source_fingerprints`, capped at 200 reference pairs per invocation.
- Candidate construction uses exact fingerprint and normalized-title bigram blocks. Only evaluator results that are real `AUTO_MERGE` or `REVIEW` candidates are persisted; unrelated `SEPARATE` comparisons no longer create D1 rows.
- Fingerprints and candidates use multi-row statements, with statement and D1 batch chunk limits. Candidate status is reloaded in bounded pair chunks so existing manual resolutions remain authoritative.
- Added route coverage proving `POST /api/reservoir/duplicates/:candidateId` with `MERGE` creates a `MANUAL` logical group, returns `MERGED`, and retains both source rows.

### TDD evidence

1. RED: focused tests reported missing `hasMore` and 1,225 candidate INSERT preparations for a 50-source run.
2. RED: the cross-boundary DOI case returned no candidate before the persisted-fingerprint lookup.
3. RED mutation check: temporarily disabling the existing MERGE branch made the new manual action route test fail with HTTP 404 instead of 200; the branch was immediately restored before implementation verification.
4. GREEN: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/refresh.test.ts src/routes/reservoir.test.ts` passed 2 files and 6 tests.
5. GREEN: `pnpm --filter @radar/worker run typecheck` completed with `tsc --noEmit` exit 0.
6. `git diff --check` passed for the scoped Task 4 files and this report.

### Preservation audit

- No deploy or remote migration command was run.
- No source, source-version, R2, provenance, or quality-state mutation was added.
- The PDF visual-extraction route work already present in `worker/src/routes/reservoir.ts` was not modified or staged by this review fix.
- Unrelated dirty reports and untracked workspace artifacts were left untouched and excluded from the commit.

## Re-review fix — 2026-08-29

- `selectCanonicalSourceId` now queries source IDs in fixed 90-ID chunks, then combines all chunk candidates using the original deterministic ranking (signals, full text, text length, creation time, ID).
- Added APPLY regression coverage with 101 connected source IDs and verified the scoped refresh suite: 44 tests passed.
- No deploy, migration, push, R2, or AI operation was performed.

## Second re-review fix — 2026-08-29

### Outcome

- Replaced the weak large-component APPLY assertion with 101 sources sharing one normalized DOI, including persisted fingerprints across the 50-source scan boundary. The regression now requires exactly one active merge group containing all 101 sources.
- `createLogicalMerge` now checks source existence and active memberships in fixed 90-ID chunks, keeping every source-ID `IN (...)` query below D1's 100-bound-parameter limit.
- The service test directly creates a reversible 102-source logical group, verifies duplicate/canonical IDs are deduplicated to one canonical membership, and proves reversal preserves every source row.
- Added later-chunk validation cases proving a missing source or an active membership is still rejected before any new group is written.

### TDD evidence

1. RED: `refresh.test.ts` and the direct `mergeGroups.test.ts` both failed with `D1_ERROR: too many SQL variables` at the unchunked source existence query.
2. RED: later-chunk missing-source and active-membership tests failed with the same D1 error instead of the established validation errors.
3. GREEN: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/mergeGroups.test.ts src/reservoir/refresh.test.ts` passed 2 files and 8 tests.
4. GREEN: `pnpm --filter @radar/worker run typecheck` completed with `tsc --noEmit` exit 0.

### Preservation audit

- Group and member writes remain in the existing single D1 batch, so validation happens before the atomic write and reversal continues to mark only the group while retaining source/member rows.
- No deploy, remote migration, push, source deletion, R2 mutation, or AI call was performed.
- Unrelated dirty reports and untracked workspace artifacts were left untouched and excluded from the commit.
