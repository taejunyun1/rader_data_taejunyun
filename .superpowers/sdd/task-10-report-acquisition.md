# Task 10 Report — Acquisition pre-deploy verification

Date: 2026-08-23
Scope: Task 10 pre-deploy only. Deployment and protected-production mutation/smoke checks were intentionally not run.

## Implemented

- Updated `docs/SPEC.md`, `docs/DEV_PLAN.md`, and `docs/PROJECT_CONTEXT.md` with the actual Discovery Keep acquisition contract: metadata-first source, raw R2 before extraction, static HTML/remote PDF paths, TextScope/quality gate, safe Reservoir plain-text endpoint, retry separation, RSS cleanup, bounded manual backfill, status/error codes, and no automatic Keep-acquisition/backfill cron.
- Added visible active-version acquisition provenance to the reading panel, including `textScope`, `extractionMethod`, and `qualityStatus`.
- Extended the existing core Playwright fixture flow for HTML `HTML_STATIC`, PDF `PDF_REMOTE_TO_MARKDOWN`, and failed JS-shell Job Center recovery plus metadata-only deep-gate behavior. No unsupported live external fixture was introduced.
- Excluded Vitest source files from the production Web TypeScript project so `pnpm -r typecheck` checks deployable source while Web Vitest remains the test-suite verifier.
- Made `0015_source_acquisition.sql` compatible with Wrangler D1 migration execution by removing explicit `BEGIN/COMMIT`; added a regression assertion while preserving the existing retry-chain/FK migration test.

## TDD / regression evidence

- RED: `ReadingPane.test.tsx` could not find `원문 범위 FULLTEXT · 수집 방식 HTML_STATIC · 품질 READY`.
- GREEN: focused ReadingPane Vitest passed 5/5 after provenance rendering.
- RED: migration compatibility test detected explicit `BEGIN/COMMIT`; local Wrangler also rejected the migration with the same transaction error.
- GREEN: focused ingestion Vitest passed 19/19 and local Wrangler applied `0015_source_acquisition.sql` after the wrapper removal.
- Focused Playwright fixture flow passed 5/5 after correcting test-only accessible-name matching and dialog assertion order.

## Development D1 check

- Target: Wrangler `--local` database only; root `pnpm db:migrate` was not used because its current script has no `--local` and could target the configured remote database.
- Before migration: sources 14, active versions 14, source versions 15, research jobs 0.
- Applied: `0015_source_acquisition.sql`, 8 commands successful.
- After migration: sources 14, active versions 14, source versions 15, research jobs 0.
- `research_jobs` schema contains `SOURCE_ACQUISITION`; provenance distribution is `FULLTEXT/LEGACY=4`, `PARTIAL/LEGACY=11`; `PRAGMA foreign_key_check` returned no rows.

## Deployment boundary

- `pnpm deploy`, remote D1 migration, Access-protected production checks, real candidate Keep, real arXiv PDF conversion, and production regression source checks were not run, per the explicit pre-deploy request.

## Final verification

- `pnpm -r typecheck`: PASS — shared, worker, and web all completed with exit code 0.
- `pnpm --dir web exec vitest run`: PASS — 32 files, 203 tests.
- `pnpm --dir web exec playwright test tests/e2e/core-reading-flow.spec.ts`: PASS — 5 tests in 5.1 seconds.
- `pnpm build`: PASS — shared, worker, and web completed with exit code 0; Vite built 62 modules.
- `pnpm exec wrangler d1 migrations list research-radar-db --local`: PASS — no migrations to apply after `0015`.
- Local D1 integrity/query check: PASS — 14 sources, 14 active versions, 15 source versions, 0 research jobs; `FULLTEXT/LEGACY=4`, `PARTIAL/LEGACY=11`; `SOURCE_ACQUISITION` accepted; no foreign-key violations.
- `git diff --check`: PASS — no whitespace errors.

## Blockers

- No pre-deploy implementation or local-verification blocker remains.
- Production-only checks remain intentionally deferred until deployment is explicitly authorized.

## Review fix addendum

- Corrected the JS-shell fixture so `EXTRACTION_EMPTY` belongs only to the failed `SOURCE_ACQUISITION` job shown in Job Center. The Reservoir fixture now keeps the real active `DISCOVERY_METADATA/METADATA_ONLY` version without inventing an `extraction_error` or failed active version.
- Strengthened the E2E contract around the stable behavior: the metadata-only provenance remains visible, no stored original text is offered, retry remains available, and deep analysis stays disabled before any paid analysis request.
- Aligned this report and the source-of-truth update stamps with the Task 10 plan date, `2026-08-23`. No schema or error-persistence feature was added.
- RED/GREEN: the new Reservoir-badge assertion first failed with `title="EXTRACTION_EMPTY"`, then the corrected JS-shell fixture passed 1/1.
- Review-fix verification: focused acquisition/Reservoir/Job Center Vitest passed 31/31; the full core Playwright fixture flow passed 5/5; the document date/contract scan and `git diff --check` passed.
- Final review fix: aligned the mocked acquisition source and job lifecycle timestamps to `2026-08-23`; fixture behavior is unchanged, and the focused core Playwright flow passed 5/5.
