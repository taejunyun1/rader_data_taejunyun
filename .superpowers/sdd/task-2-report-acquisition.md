# Task 2 Report: Source Acquisition Provenance and Version Writer

Date: 2026-08-23
Task brief: `.superpowers/sdd/task-2-brief.md`

## Scope

Task 2 covers:

- `worker/migrations/0015_source_acquisition.sql`
- `worker/src/ingestion/store.ts`
- `worker/src/ingestion/versioning.ts`
- `worker/src/routes/inbox.ts`
- `web/src/lib/ingestion.test.ts`

The instruction was to preserve the uncommitted Task 2 work left by the previous agent, inspect the current diff, complete or correct only Task 2, verify the requested test/typecheck commands, then commit the Task 2 files.

## What I inspected

I reviewed the Task 2 brief and the current implementations in the five Task 2 files, plus the related schema history in:

- `worker/migrations/0001_init.sql`
- `worker/migrations/0008_ingestion_review.sql`
- `worker/migrations/0013_discovery_lanes_jobs.sql`
- `shared/src/ingestion.ts`

I specifically checked that the current diff satisfies the brief:

1. Migration adds the six provenance columns on `source_versions`.
2. Migration backfills `text_scope` and `extraction_method` using the required deterministic rules.
3. Migration rebuilds `research_jobs` with the same column set and includes `SOURCE_ACQUISITION` in the `kind` check.
4. `createSource` accepts provenance metadata, defaults metadata-only/fulltext behavior from extracted text, and does not store a fake original when `storedOriginal: null`.
5. `appendAcquisitionVersion` exists, writes normalized text and content hash, and only auto-activates according to the Task 2 rules.
6. Inbox URL/re-extract/retry flows use acquisition classification and the new append writer.
7. Tests cover provenance constants, metadata-only storage, and activation rules for partial/empty acquisition results.

## Result

The existing uncommitted Task 2 diff already satisfied the Task 2 brief. I did not need to modify the implementation files further after inspection.

The behavior present in the current diff is consistent with the brief:

- metadata-only discovery creation leaves `r2_key` null and skips R2 original storage
- manual text imports default to `FULLTEXT` + `MANUAL_TEXT`
- acquisition appends compute normalized text/content hash and gate activation by scope and quality
- partial acquisition can replace the active version only when it has more meaningful text
- empty acquisition does not replace a usable active version

## Verification

I ran the exact commands requested:

```bash
pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts
pnpm --filter @radar/shared typecheck
pnpm --filter @radar/worker typecheck
```

Observed results:

- Vitest: `2` test files passed, `17` tests passed
- Shared typecheck: passed (`tsc --noEmit`)
- Worker typecheck: passed (`tsc --noEmit`)

## Commit contents

The commit includes the Task 2 files and this report:

- `worker/migrations/0015_source_acquisition.sql`
- `worker/src/ingestion/store.ts`
- `worker/src/ingestion/versioning.ts`
- `worker/src/routes/inbox.ts`
- `web/src/lib/ingestion.test.ts`
- `.superpowers/sdd/task-2-report-acquisition.md`

Commit message:

```text
260823: 원문 수집 provenance migration과 version writer 추가
```

## Concerns

No Task 2 blocking issues remain after the requested verification.

Residual note:

- I verified the migration by code inspection and surrounding schema history, not by executing a separate D1 migration dry-run command, because the explicit user verification scope for this task was limited to the two Vitest files and the shared/worker typechecks.

## Review Fix Update

Date: 2026-08-23

The original review finding was valid. Replaying `worker/migrations/0015_source_acquisition.sql` from base commit `66fc254` against SQLite with `PRAGMA foreign_keys=ON` and an existing `retry_of` row reproduced the failure:

- `FOREIGN KEY constraint failed`
- the rebuild then aborted before `research_jobs_new` could be renamed cleanly

The first uncommitted fix changed the rebuilt table to `retry_of REFERENCES research_jobs_new(id)` and copied retry chains in dependency order. That addressed the normal parent/child retry case, but it still dropped a literal self-reference row such as `retry_of = id` if such legacy data existed from a prior foreign-key-off state.

I corrected the migration by wrapping it in a transaction, enabling `PRAGMA defer_foreign_keys = ON`, and copying all `research_jobs` rows directly into `research_jobs_new` before dropping/renaming the table. That keeps enforcement active at commit time while preserving:

- normal retry chains
- literal self-references
- the rebuilt self-referential foreign key after rename

I added a focused regression test in `web/src/lib/ingestion.test.ts` that executes the real `0015_source_acquisition.sql` through `sqlite3` against a seeded database containing both:

- `job-2.retry_of = job-1`
- `job-3.retry_of = job-3`

The test asserts:

- the migration completes with foreign keys enabled
- `PRAGMA foreign_key_check` returns no violations
- all seeded rows remain present with their retry links intact

I also reviewed the acquisition version reservation flow. The current `appendAcquisitionVersion` and inbox re-extract/retry paths are safe because they now reserve a stable `versionId` first, derive the acquisition R2 key from that UUID, and retry only the D1 `version` number on unique-conflict. The existing/new test coverage in `web/src/lib/ingestion.test.ts` verifies that a version reservation retry:

- preserves the same acquisition `versionId`
- preserves the same UUID-derived R2 key
- advances only the D1 numeric `version`

Final verification run on 2026-08-23:

```bash
pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts
pnpm --filter @radar/shared typecheck
pnpm --filter @radar/worker typecheck
pnpm --dir web exec vitest run src/lib/ingestion.test.ts -t "migrates research_jobs retry chains and self-references with foreign keys enabled"
```

Observed results:

- Vitest targeted suite: `2` files passed, `20` tests passed
- Shared typecheck: passed
- Worker typecheck: passed
- Focused migration regression: `1` test passed
