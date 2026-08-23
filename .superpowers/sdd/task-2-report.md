# Task 2 Report

## Status
- Completed Task 2 only on commit `e54241349315ff897f619d0240ff221ea6113f88`

## Changed Files In Commit
- `shared/src/discovery.ts`
- `worker/src/lib/rss.ts`
- `worker/src/discovery/run.ts`
- `worker/src/routes/discover.ts`
- `web/src/views/DiscoverView.tsx`
- `web/src/lib/discoveryFilter.test.ts`
- `web/src/lib/discoveryPipelineAccounting.test.ts`
- `web/src/lib/discoveryProviderResults.test.ts`
- `web/src/views/DiscoverView.test.tsx`

## What Changed
- Added source-aware RSS selection metadata with `sourceId` propagation and curated/custom feed resolution.
- Preserved exact RSS `publishedAt` timestamps while still deriving `year`.
- Changed custom feed storage to custom-only normalization so curated defaults are rebuilt at runtime and legacy curated values are removed.
- Applied curated source access policy when classifying RSS candidate access.
- Added source-balanced RSS lane selection without changing existing provider quotas.
- Updated Discover source labels and custom feed editor copy/save behavior to distinguish automatic curated feeds from user-added feeds.

## TDD Record
1. Added failing tests for:
   - curated reading feed provenance and curated/custom feed merging
   - exact RSS publication timestamps
   - DiscoverView source/status labeling
   - RSS source balancing by source
2. Ran the red test command and confirmed failures against the old contract.
3. Implemented the minimal production changes for Task 2.
4. Ran focused tests and full typecheck to confirm green status.

## Exact Test Commands And Results
### Red verification
Command:
```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryProviderResults.test.ts
```
Result:
- Exit code `1`
- Failed as expected:
  - `accepts a verified free HTML feed and keeps its source provenance`
  - `always merges current curated feeds and removes legacy curated KV values`
  - `preserves exact RSS publication timestamps`

### Green verification
Command:
```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryProviderResults.test.ts src/lib/discoveryFilter.test.ts src/lib/discoverySources.test.ts src/views/DiscoverView.test.tsx
```
Result:
- Exit code `0`
- `Test Files  5 passed (5)`
- `Tests  39 passed (39)`

### Workspace typecheck
Command:
```bash
pnpm typecheck
```
Result:
- Exit code `0`
- `shared`, `worker`, `web` typecheck passed

## Self-Review
- Confirmed Task 2 stayed within the required files and behavior scope.
- Did not modify plan docs or `.superpowers/sdd/progress.md`.
- Did not deploy or run remote migrations.
- Preserved unrelated untracked files in the working tree.
- Added one extra targeted regression test in `web/src/lib/discoveryFilter.test.ts` to cover source-balanced RSS selection because Task 2 changes selection behavior directly.

## Concerns
- The Task 2 brief's sample `git add` list did not include `web/src/lib/discoveryFilter.test.ts`; I included it in the commit because it is the regression test that proves the new source-balancing behavior.
- The requested report file is intentionally not included in commit `e54241349315ff897f619d0240ff221ea6113f88`; it was written after the commit to avoid amending the verified code commit.

## Follow-up Fix (2026-08-23)

### Reason
- Review required the RSS source-balance regression test to live in the Task 2-listed `web/src/lib/discoveryPipelineAccounting.test.ts` instead of `web/src/lib/discoveryFilter.test.ts`.

### Changes
- Removed `selectDiscoveryCandidatesByLane` import from `web/src/lib/discoveryFilter.test.ts`.
- Removed the RSS source-balance regression test block from `web/src/lib/discoveryFilter.test.ts`.
- Added `selectDiscoveryCandidatesByLane` import to `web/src/lib/discoveryPipelineAccounting.test.ts`.
- Added the same RSS source-balance regression test block to `web/src/lib/discoveryPipelineAccounting.test.ts`.
- Left Task 1 production files untouched in the follow-up.

### Follow-up Verification
Command:
```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryProviderResults.test.ts src/lib/discoveryFilter.test.ts src/lib/discoverySources.test.ts src/views/DiscoverView.test.tsx
```
Result:
- Exit code `0`
- `Test Files  5 passed (5)`
- `Tests  39 passed (39)`

Command:
```bash
pnpm typecheck
```
Result:
- Exit code `0`
- `shared`, `worker`, `web` typecheck passed

### Follow-up Files
- `web/src/lib/discoveryFilter.test.ts`
- `web/src/lib/discoveryPipelineAccounting.test.ts`
- `.superpowers/sdd/task-2-report.md`
