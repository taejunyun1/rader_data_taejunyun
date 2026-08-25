# Backend Final Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all seven backend Important findings with focused regression tests and no UI modal changes.

**Architecture:** Use Cloudflare's public-only global fetch boundary, rights-first visual persistence, durable PDF checkpoints, a request-scoped vision budget/call gate, persisted-state retry summaries, conditional assignment, and R2 compensation. Existing Worker routes, D1 tables, R2 bucket, Workflows, and Vitest fixtures remain the integration boundaries.

**Tech Stack:** Cloudflare Workers/Hono, D1, R2, Workers AI, TypeScript, React utility code, Vitest, pnpm workspaces.

## Global Constraints

- Work on the user-approved `main` branch and preserve unrelated dirty files.
- Do not touch UI modal files or add user-facing settings.
- Use a fixed internal extraction vision cap of 80.
- Ordinary URL/PDF rights default to `UNKNOWN`/`LINK_ONLY`; only explicit personal upload receives `user_personal_upload` automatically.
- Do not deploy.
- Produce `.superpowers/sdd/backend-remediation-report.md` and one final commit named `260826: backend remediation for final review`.

---

### Task 1: Platform-enforced public fetch

**Files:** Modify `worker/wrangler.jsonc`, `worker/src/ingestion/fetchRemoteDocument.ts`, `worker/src/ingestion/acquireRemoteSource.ts`, `worker/src/lib/rss.ts`; test `web/src/lib/remoteAcquisition.test.ts`.

- [ ] Add failing tests proving no DNS preflight occurs, runtime DNS-rebinding rejection is blocked, and each redirect target is validated/fetched manually.
- [ ] Run `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts` and confirm the new tests fail for the expected DoH/TOCTOU behavior.
- [ ] Enable `global_fetch_strictly_public`, remove the resolver API and DoH implementation, and keep URL/redirect/timeout/size validation.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Rights-first PDF and personal-upload evidence

**Files:** Modify `worker/src/visual/store.ts`, `worker/src/visual/extraction/run.ts`, `worker/src/routes/visualAssets.ts`; test `web/src/lib/visualAssets.test.ts`.

- [ ] Add failing tests for ordinary PDF `UNKNOWN`/`LINK_ONLY`, required basis for `PERSONAL|PERMITTED`, and automatic `user_personal_upload` only at explicit personal upload.
- [ ] Run the focused rights tests and confirm expected failures.
- [ ] Implement explicit rights resolution and archive guards with no persistent crop on unknown rights.
- [ ] Re-run focused rights tests.

### Task 3: Multi-chunk PDF checkpoints

**Files:** Modify `web/src/lib/pdfVisualExtraction.ts`, `worker/src/routes/visualExtraction.ts`, `worker/src/visual/extraction/store.ts`; test `web/src/lib/pdfVisualExtraction.test.ts` and `web/src/lib/visualAssets.test.ts`.

- [ ] Add failing tests for 85-page client continuation and declared-total preservation through finish/resume.
- [ ] Run focused PDF tests and confirm one-chunk/total-collapse failures.
- [ ] Loop while `hasMore`, preserve maximum declared totals, and retain resumable checkpoint state.
- [ ] Re-run focused PDF tests.

### Task 4: Extraction vision reservation and cap

**Files:** Modify `worker/src/analysis/budgetReservation.ts`, `worker/src/workflows/researchJob.ts`, `worker/src/visual/analyzer.ts`, `worker/src/visual/extraction/run.ts`; test `web/src/lib/deepAnalysis.test.ts` and `web/src/lib/visualAssets.test.ts`.

- [ ] Add failing tests for extraction reservation, zero calls on budget block, cap 80, REVIEW fallback, and truthful diagnostics.
- [ ] Run focused budget/extraction tests and confirm failures.
- [ ] Add a request-scoped vision gate passed to every extraction vision call and release reservations on all outcomes.
- [ ] Re-run focused budget/extraction tests.

### Task 5: Cumulative retry accounting

**Files:** Modify `worker/src/visual/extraction/run.ts`, `worker/src/visual/extraction/store.ts`; test `web/src/lib/visualAssets.test.ts`.

- [ ] Add failing retry tests with prior successful assets, failed units, and prior diagnostics.
- [ ] Run the focused retry tests and confirm retry-only counts replace cumulative values.
- [ ] Recompute counts/outcomes from D1 and merge earlier diagnostic maxima with current diagnostics.
- [ ] Re-run focused retry tests.

### Task 6: Atomic assignment eligibility

**Files:** Modify `worker/src/routes/visualAssets.ts`; test `web/src/lib/visualAssets.test.ts`.

- [ ] Add failing tests for already assigned, extracted-origin, analyzed, and concurrent stale assignment attempts.
- [ ] Run focused assignment tests and confirm unsafe updates succeed.
- [ ] Add all eligibility predicates to the single conditional update and return a stable 409 conflict.
- [ ] Re-run focused assignment tests.

### Task 7: R2 compensation and final verification

**Files:** Modify `worker/src/routes/visualExtraction.ts`; test `web/src/lib/pdfVisualExtraction.test.ts`; create `.superpowers/sdd/backend-remediation-report.md`.

- [ ] Add a failing test where D1 unit recording fails after R2 put and assert compensating delete.
- [ ] Run the focused test and confirm the orphan remains.
- [ ] Implement awaited compensating delete with structured failure logging.
- [ ] Run all focused tests, `pnpm typecheck`, and `git diff --check`.
- [ ] Review the scoped diff, write the report, stage only remediation files, and commit `260826: backend remediation for final review`.
