# Backend Remediation Report — 2026-08-26

## Scope

Implemented the seven backend Important findings from the final review on `main`. No deployment was performed, no user-facing setting was added, and no UI modal source or test file was modified.

## Remediations

1. **SSRF / DNS rebinding / redirects**
   - Enabled Cloudflare's `global_fetch_strictly_public` compatibility flag so the platform validates the actual connection target of Worker subrequests.
   - Removed the separate DNS-over-HTTPS validation path and its validation/fetch TOCTOU window.
   - Kept lexical scheme, credential, localhost, and literal private-address rejection.
   - Kept redirects manual and validates every redirect URL before the next platform-enforced fetch.
   - Added direct rebinding rejection, rebound redirect, public redirect-hop, and configuration regression tests.

2. **Rights defaults and archival evidence**
   - Ordinary URL, embedded-image, and PDF extraction now creates `UNKNOWN`/`LINK_ONLY` metadata with null rights basis/review time and no persistent crop bytes.
   - The existing explicit personal image upload boundary alone records `PERSONAL`, `user_personal_upload`, and review time automatically.
   - `PERSONAL` and `PERMITTED` updates require a non-empty `rightsBasis`; archival storage transitions also require basis plus review time.

3. **PDFs larger than 40 pages**
   - The browser continues rendering/uploading chunks while `hasMore` is true instead of finalizing after the first 40 pages.
   - Server totals use monotonic maximums, preserving the declared page count across checkpoints, finish, cancellation, and resume.
   - Added a 41-page continuation test and an 85-page declared-total checkpoint test.

4. **VISUAL_EXTRACTION budget and call cap**
   - Added one extraction-wide budget reservation derived from the existing `$0.01` visual reservation and the internal 80-call ceiling.
   - Every extraction vision invocation uses one shared request gate; workflow-step retries reuse that gate.
   - Budget or cap denial prevents the model call, leaves the candidate in `REVIEW`, and records attempted/completed/failed/blocked/cap usage diagnostics.
   - Reservations are released on success and failure; a budget denial does not block the extraction job.

5. **Cumulative retry accounting**
   - Retry results rebuild selected/review/filtered/unavailable and duplicate/rights outcomes from persisted assets and units.
   - Run counters no longer collapse to retry-only values.
   - Prior successful extraction diagnostics are merged with current retry diagnostics, retaining earlier limit maxima and accumulating vision usage.

6. **Atomic assignment eligibility**
   - Assignment uses one conditional D1 update and accepts only `PERSONAL_UPLOAD`, `UNASSIGNED`, null-parent assets with no analyses.
   - Already assigned, extracted-origin, parented, analyzed, and stale concurrent attempts return `409` without mutation.

7. **R2 compensation for PDF page uploads**
   - If D1 unit recording fails after the temporary PDF page is written, the R2 object is deleted before the original D1 error is rethrown.
   - Cleanup failure is logged without replacing the primary persistence error.

## Changed files

### Runtime

- `worker/wrangler.jsonc`
- `worker/src/analysis/budgetReservation.ts`
- `worker/src/ingestion/acquireRemoteSource.ts`
- `worker/src/ingestion/fetchRemoteDocument.ts`
- `worker/src/lib/rss.ts`
- `worker/src/routes/visualAssets.ts`
- `worker/src/routes/visualExtraction.ts`
- `worker/src/visual/analyzer.ts`
- `worker/src/visual/store.ts`
- `worker/src/visual/extraction/filter.ts`
- `worker/src/visual/extraction/run.ts`
- `worker/src/visual/extraction/store.ts`
- `worker/src/visual/extraction/visionBudget.ts`
- `worker/src/workflows/researchJob.ts`
- `web/src/lib/pdfVisualExtraction.ts`

### Focused tests

- `web/src/lib/deepAnalysis.test.ts`
- `web/src/lib/discoveryProviderResults.test.ts`
- `web/src/lib/pdfVisualExtraction.test.ts`
- `web/src/lib/remoteAcquisition.test.ts`
- `web/src/lib/visualAssets.test.ts`

### Design and execution records

- `docs/superpowers/specs/2026-08-26-backend-remediation-final-review-design.md`
- `docs/superpowers/plans/2026-08-26-backend-remediation-final-review.md`
- `.superpowers/sdd/backend-remediation-report.md`

## Verification

- Focused backend/web Vitest suites: passing.
- Workspace typecheck (`shared`, `worker`, `web`): passing.
- `git diff --check`: passing.
- Full web Vitest suite: 393 passed, 4 failed in the unchanged `src/views/DiscoverView.test.tsx` modal flow. Running that file alone reproduces the same four failures. Those UI failures are outside this backend remediation scope and were not modified.

## Limitations and operational notes

- No deploy, D1 migration application, live R2 operation, or live Cloudflare subrequest was performed.
- `global_fetch_strictly_public` is covered by configuration and fetch-boundary tests; live platform enforcement requires the next authorized deployment/runtime verification.
- Extraction still processes at most 40 PDF page units per invocation. Pages beyond that limit remain represented by the preserved total/checkpoint and stay retryable; the client now uploads all chunks instead of silently truncating after page 40.
- Independent subagent review was unavailable in this session; the scoped diff received a manual security and Cloudflare Workers best-practices review.

## Preserved unrelated worktree changes

The pre-existing `.superpowers/sdd/task-2-report.md` modification is explicitly excluded from staging and commit. Other pre-existing untracked files/directories remain untouched and unstaged; the final handoff lists their exact paths from `git status`.
