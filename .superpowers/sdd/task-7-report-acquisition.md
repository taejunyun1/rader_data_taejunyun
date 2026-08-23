# Task 7 Report — Reservoir provenance and safe original text

Date: 2026-08-24
Commit message: `260824: Reservoir 원문 상태와 안전한 원문 보기 추가`

## Outcome

- Reservoir detail now joins the active source version and returns a stable `acquisition` object containing text scope, extraction method, source quality, recorded character count, Korean acquisition label, deep-analysis readiness, optional acquisition error, and a safe stored-text URL when text exists.
- `GET /api/reservoir/:sourceId/original-text` returns only the active normalized text, with extracted-text fallback, as `text/plain; charset=utf-8` plus `nosniff`, capped at 500,000 characters.
- The existing `GET /api/inbox/:sourceId/original` R2 binary endpoint was left unchanged.
- Reading types keep local acquisition provenance separate from external `SourceAccess`.
- Reservoir maps the returned acquisition object into `ReadingPane`, which shows a separate acquisition badge and fetches stored text only after the `<details>` section opens.
- Stored text is rendered in `<pre>` as React text content, includes a new-window text link, and never uses `dangerouslySetInnerHTML`.

## TDD evidence

### RED

Added the full-text, metadata-only, lazy-fetch, plain-text response, missing-text, and 500,000-character-cap contracts first.

```text
pnpm --dir web exec vitest run src/components/reading/ReadingPane.test.tsx src/lib/reservoirAcquisition.test.ts
```

Result: exit 1 — 2 test files failed, 6 expected new-test failures, and 3 existing tests passed. The failures showed the missing `acquisition` response, missing original-text route, and missing acquisition UI.

### GREEN and regression verification

```text
pnpm --dir web exec vitest run src/components/reading/ReadingPane.test.tsx src/lib/reservoirAcquisition.test.ts src/views/ReservoirView.test.tsx src/lib/deepAnalysis.test.ts
```

Result: exit 0 — 4 test files passed, 25 tests passed.

```text
pnpm --filter @radar/worker typecheck
pnpm --filter @radar/shared typecheck
```

Result: both exited 0 with `tsc --noEmit`.

## Files

- `worker/src/routes/reservoir.ts`
- `web/src/components/reading/types.ts`
- `web/src/components/reading/SourceAccessBadge.tsx`
- `web/src/components/reading/ReadingPane.tsx`
- `web/src/components/reading/ReadingPane.test.tsx`
- `web/src/styles/reading.css`
- `web/src/views/ReservoirView.tsx`
- `web/src/lib/reservoirAcquisition.test.ts`
- `.superpowers/sdd/task-7-report-acquisition.md`

`web/src/views/ReservoirView.tsx` received only the minimal response-to-`ReadingDocument` mapping needed for the Task 7 acquisition UI to appear in the actual Reservoir flow.

## Residual concerns

- No schema changes, migrations, deploys, or remote operations were needed.
- The plain-text endpoint intentionally falls back to the active version's extracted text only when normalized text is unavailable; it still returns `text/plain` with `nosniff`, so markup is displayed literally rather than executed.
- Pre-existing unrelated untracked directories were not modified or staged.
