# Task 5 Report — Discovery Keep acquisition handoff

Date: 2026-08-24
Commit: `260824: Discovery Keep 원문 수집 연결과 RSS CDATA 정리`

## Scope

Implemented only the Task 5 Discovery Keep acquisition handoff and RSS CDATA normalization.

- Discovery Keep now creates a metadata-only `DISCOVERY` source with `storedOriginal: null`, empty extracted text, `METADATA_ONLY`, and `DISCOVERY_METADATA`.
- OpenAlex Keep resolves `openAccessUrl` first and falls back to the candidate `external_url`.
- arXiv Keep uses a candidate PDF URL, deriving `https://arxiv.org/pdf/<id>.pdf` from an arXiv `/abs/` candidate when necessary.
- A usable URL enqueues the existing `SOURCE_ACQUISITION` workflow and returns `sourceId`, `jobId`, and `acquisitionStatus: "QUEUED"`.
- A candidate without a usable URL remains kept as `LINK_ONLY` with no acquisition job.
- RSS title/summary normalization now performs XML entity decoding before idempotent wrapping CDATA removal, then stores cleaned text.
- Discover UI reports queued/link-only feedback, refreshes candidates, and navigates to Reservoir when an acquisition result completes.
- Existing access-label and field-signal behavior remains unchanged.

## TDD Record

### RED

Added focused assertions first:

- `web/src/views/DiscoverView.test.tsx`: a Keep response with `jobId` must show the pending acquisition message.
- `web/src/lib/discoveryFilter.test.ts`: entity-decoded wrapping CDATA must normalize to plain text.

Commands and expected failures:

```text
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
```

Result: exit 1, 12 tests with 1 failure. The new test could not find `/원문 수집을 시작했습니다/` because the UI still emitted the generic Keep message.

```text
pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts
```

Result: exit 1, 23 tests with 1 failure. `cleanDiscoverySourceText("&lt;![CDATA[At This Year's Rencontres d'Arles]]&gt;")` returned `""` instead of the expected plain title because CDATA stripping happened before entity decoding.

## GREEN

Focused verification after the minimal implementation:

```text
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx src/lib/discoveryFilter.test.ts src/lib/discoveryProviderResults.test.ts
```

Result: exit 0 — 3 test files passed, 39 tests passed.

```text
pnpm --filter @radar/worker typecheck
pnpm --filter @radar/shared typecheck
```

Result: both exit 0 — `tsc --noEmit` passed for worker and shared.

```text
git diff --check
```

Result: exit 0 — no whitespace errors.

## Files changed

- `worker/src/routes/discover.ts`
- `worker/src/lib/rss.ts`
- `shared/src/discovery.ts`
- `web/src/views/DiscoverView.tsx`
- `web/src/views/DiscoverView.test.tsx`
- `web/src/lib/discoveryFilter.test.ts`
- `.superpowers/sdd/task-5-report-acquisition.md`

## Self-review

- No schema or migration changes were made.
- No title text is passed as extracted content; the title is used only as source metadata/hash input.
- `storedOriginal: null` prevents an R2 original object for the metadata-only version.
- URL validation accepts only absolute HTTP(S) URLs before enqueueing, preventing invalid acquisition jobs.
- Keep still persists the candidate/source path when no acquisition URL exists and returns an explicit link-only status.
- RSS normalization is centralized through `cleanDiscoverySourceText`; wrapping CDATA removal is anchored and idempotent.
- Existing DiscoverView access-link, field-signal, and develop-to-Reservoir tests remain passing.
- Unrelated untracked directories and files were not modified or staged.

## Concerns

- No dedicated Hono/D1 route integration test exists in the current worker test harness; route behavior was verified by the focused UI contract, worker typecheck, and direct code-path review.
- A standalone `pnpm --filter @radar/web typecheck` still reports pre-existing environment/test typing issues (`node:*` and `process` types, worker `Env` bindings, and an unrelated existing `versioning.ts` result type). The requested worker/shared typechecks pass, and the new DiscoverView union-narrowing issue was fixed.
- arXiv PDF derivation is intentionally limited to arXiv `/abs/` URLs; already-formed PDF URLs and other HTTP(S) candidate URLs are preserved as supplied.

## Review-fix addendum — Keep job status refresh regressions

Date: 2026-08-24
Commit: `260824: Discovery Keep 작업 상태 갱신 회귀 수정`

### Findings fixed

- P1: DiscoverView now remembers only the `jobId` returned by the current Keep response. Its acquisition completion effect ignores unrelated historical `SOURCE_ACQUISITION` jobs, waits for that exact job to become `SUCCEEDED`, then clears the remembered ID before navigating to Reservoir.
- P2: When Keep returns a `jobId`, DiscoverView records it and awaits `onJobCreated?.()` before running the existing candidate refresh. This makes the queued acquisition visible to Job Center and starts its normal polling path.

### Focused regression coverage

- Added a reopen regression proving an unrelated completed acquisition does not interrupt normal Discovery browsing.
- Added the current-Keep transition regression proving no navigation occurs while its exact job is `QUEUED`, followed by one Reservoir navigation when it becomes `SUCCEEDED`.
- Added an ordering regression proving candidate refresh waits until the Job Center refresh callback completes.

TDD RED:

```text
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
```

Result: exit 1 — 14 tests, 2 expected failures. The existing effect navigated for the unrelated completed job, and Keep never called `onJobCreated`.

TDD GREEN and related verification:

```text
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx src/lib/discoveryFilter.test.ts src/lib/discoveryProviderResults.test.ts
```

Result: exit 0 — 3 test files passed, 41 tests passed.

```text
pnpm --filter @radar/worker typecheck
pnpm --filter @radar/shared typecheck
```

Result: both exit 0 — `tsc --noEmit` passed for worker and shared.

The standalone web typecheck still exits 2 only for the pre-existing issues already listed above; after correcting the new test helper annotation, it reports no `DiscoverView` or `DiscoverView.test.tsx` errors.
