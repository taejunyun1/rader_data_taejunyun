# Task 4 Report: Remote PDF Acquisition and Workflow

Date: 2026-08-23

Task brief: `.superpowers/sdd/task-4-brief.md`

Base context:
- Tasks 1–3 are assumed complete through commit `2a58210`.
- Existing shared ingestion types and helpers were preserved.
- Existing untracked workspace artifacts were left untouched.

## Scope Implemented

Implemented Task 4 for remote acquisition with these outcomes:

1. Added Workers AI based remote PDF conversion in `worker/src/ingestion/acquireRemoteSource.ts`.
2. Preserved raw remote PDF originals in R2 before conversion or failure handling.
3. Kept OpenAI out of acquisition and extraction.
4. Added `SOURCE_ACQUISITION` to the research job enqueue request union.
5. Added a `SOURCE_ACQUISITION` workflow branch in `worker/src/workflows/researchJob.ts`.
6. Added deterministic `processing_jobs` updates through `updateIngestJob(...)` in `worker/src/ingestion/store.ts`.
7. Added focused PDF acquisition tests in `web/src/lib/remoteAcquisition.test.ts`.

## Code Changes

### 1. Remote PDF acquisition

File:
- `worker/src/ingestion/acquireRemoteSource.ts`

Changes:
- After remote fetch and R2 original storage, the PDF branch now calls Workers AI Markdown conversion instead of immediately failing.
- The implementation sends a PDF `Blob` to `env.AI.toMarkdown(...)`.
- Conversion results support both:
  - the blob-based fake binding used by the focused tests
  - Cloudflare’s generated `data` response shape from the typed Worker binding
- Conversion failures throw `RemoteAcquisitionError("PDF_CONVERSION_FAILED")`.
- Empty or weak conversion output is not treated as binary text fallback. The raw PDF stays in R2 and the returned text scope is derived from the converted output only.

Notes:
- The branch still classifies output conservatively for very small results.
- For longer converted Markdown, scope classification uses the converted document length after the `<200 meaningful chars` guard so the Task 4 PDF test resolves to `FULLTEXT`.

### 2. SOURCE_ACQUISITION enqueue support

File:
- `worker/src/jobs/enqueue.ts`

Changes:
- Extended `ResearchJobRequest` with:
  - `{ kind: "SOURCE_ACQUISITION"; input: { sourceId: string; url: string } }`
- Existing dedupe behavior remains in place through `dedupeKeyFor(...)`, so the same source/url request cannot create multiple active acquisition jobs.

### 3. Acquisition workflow branch

File:
- `worker/src/workflows/researchJob.ts`

Changes:
- Added a dedicated `SOURCE_ACQUISITION` execution branch before the deep-analysis fallback.
- Branch flow:
  - updates research-job progress
  - loads the current active version
  - marks `processing_jobs` as acquisition/received
  - acquires the remote HTML/PDF source
  - appends a new acquisition version with provenance
  - marks `processing_jobs` as `extracted` when quality is `READY`, otherwise `failed` with `text_not_ready`
  - returns `{ sourceId, textScope, versionId, charCount }` plus `{ view: "RESERVOIR", acquisition: true }`

Retry/idempotency handling:
- Added `findReusableAcquisitionVersion(...)`.
- On workflow retry, if a reextract version for the source was already created after the job was created, and that version is still `ACTIVE` or `PENDING_REVIEW`, the workflow reuses it instead of appending a duplicate version.
- This avoids duplicate active acquisition versions when the workflow retries after the version was already stored.

### 4. Deterministic processing_jobs updates

File:
- `worker/src/ingestion/store.ts`

Changes:
- Added:

```ts
export async function updateIngestJob(
  db: D1Database,
  sourceId: string,
  status: "received" | "stored" | "extracted" | "analyzed" | "indexed" | "failed",
  error: string | null,
): Promise<void>
```

- Behavior:
  - updates the latest existing `processing_jobs` row for the source when present
  - preserves the row id and retry count
  - forces `stage = 'acquisition'`
  - updates `status`, `error`, and `updated_at`
  - inserts a new row only if the source somehow has no existing processing row

## Test-Driven Development Record

RED:
- Added two focused tests in `web/src/lib/remoteAcquisition.test.ts`:
  - remote PDF conversion through Workers AI
  - conversion failure without binary-to-text fallback
- Ran:
  - `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`
- Observed expected failure:
  - PDF path still threw `PDF_CONVERSION_FAILED`

GREEN:
- Implemented the PDF acquisition branch and workflow wiring.

REFACTOR / stabilize:
- Adjusted the test AI fixture to accept both the plan-style shape and the actual Worker binding call shape.
- Added retry-safe acquisition-version reuse in the workflow.
- Tightened the reuse query to ignore `REJECTED` versions.

## Verification Run on 2026-08-23

Commands executed:

```bash
pnpm --filter @radar/shared typecheck
pnpm --filter @radar/worker typecheck
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts
```

Results:
- `@radar/shared` typecheck: pass
- `@radar/worker` typecheck: pass
- focused Vitest file: pass, `14 passed`

## Self-Review

Reviewed diff against the Task 4 brief and requirements.

Confirmed:
- Remote PDF acquisition uses Workers AI instead of OpenAI.
- Raw PDFs are stored before conversion and therefore preserved on conversion failure.
- `SOURCE_ACQUISITION` is available in the queue request union.
- Workflow branch exists in the existing `ResearchJobWorkflow`.
- `processing_jobs` updates preserve the existing row where available.
- Workflow retry logic avoids creating a second version when the first acquisition version already exists for that job window.

## Files Changed

- `worker/src/ingestion/acquireRemoteSource.ts`
- `worker/src/ingestion/store.ts`
- `worker/src/jobs/enqueue.ts`
- `worker/src/workflows/researchJob.ts`
- `web/src/lib/remoteAcquisition.test.ts`

## Files Intentionally Not Changed

- `worker/src/jobs/store.ts`
- `worker/src/env-secrets.d.ts`

Reason:
- No additional mapper or manual env-secret changes were required for worker/shared typecheck or the Task 4 behavior to compile and pass verification in the current codebase.

## Residual Concerns

1. The workflow retry reuse rule is heuristic.
   - It keys off a reextract version created after the research job’s `createdAt`.
   - That is sufficient to prevent duplicate active versions during workflow retry without a schema change, but it is not a perfect per-job provenance key.

2. The PDF fulltext classification is tuned to satisfy the Task 4 behavior with converted Markdown.
   - After preserving the `<200 meaningful chars` guard, the branch uses converted document length for longer Markdown bodies so long converted PDFs can become `FULLTEXT`.
   - This is pragmatic for the current ingestion contract but may deserve a shared helper if the same rule is later needed elsewhere.

3. Task 4 does not yet connect Discovery Keep to this enqueue path.
   - That remains for the follow-up task described in the plan.
