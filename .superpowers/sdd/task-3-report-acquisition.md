# Task 3 Report: Static HTML Acquisition Boundary

Date: 2026-08-23
Task: Task 3 from `.superpowers/sdd/task-3-brief.md`
Commit: pending

## Scope

Implemented only the Task 3 scope:

- deterministic static HTML extraction
- safe remote fetch boundary for acquisition
- compatibility refactor for `fetchAndExtract(url)`
- focused regression tests

Did not implement Task 4 workflow or PDF conversion.

## Files Changed

- `worker/src/ingestion/extractHtml.ts`
- `worker/src/ingestion/acquireRemoteSource.ts`
- `worker/src/ingestion/extractUrl.ts`
- `web/src/lib/remoteAcquisition.test.ts`

## TDD Log

1. Added focused tests for:
   - article selection and chrome removal
   - body fallback
   - JS shell warning
   - safe remote HTML acquisition and R2 preservation
   - private-network blocking
   - unsupported content-type rejection
   - `fetchAndExtract` compatibility with preserved legacy fields plus new metadata
2. Ran `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`.
3. Observed RED failure due to missing module:
   - `Failed to resolve import "../../../worker/src/ingestion/extractHtml"`
4. Implemented the minimum production code to satisfy the tests.
5. Re-ran focused tests and fixed one test fixture that was below the existing `FULLTEXT` threshold from Task 1.
6. Re-ran the full Task 3 verification command and confirmed green output.

## Implementation Notes

### `extractStaticHtml`

- Removes `script/style/nav/footer/header/aside/noscript` blocks before scoring.
- Reuses entity decoding through exported `decodeHtmlEntities()` so extraction rules are not duplicated.
- Scores `article`, `main`, `role=main`, and content-hint containers using:
  - meaningful character count
  - paragraph count
  - link density penalty
  - repeated-line penalty
- Falls back to `body` with `fallback_body` when no candidate exceeds the Task 3 threshold.
- Flags root-style JavaScript shells with `js_shell`.
- Uses existing shared normalization and `classifyTextScope()` so Task 1/2 provenance rules remain authoritative.

### `acquireRemoteSource`

- Enforces:
  - `http` / `https` only
  - localhost / loopback / link-local / RFC1918 IPv4 blocking
  - manual redirect handling with a maximum of five redirects
  - 20 second timeout
  - 20 MB response limit
- Normalizes content-type and accepts only HTML/XHTML/plain text or PDF suffix/type at the boundary.
- Stores the raw response in `ORIGINALS` before extraction.
- Returns deterministic acquisition provenance for the HTML branch.
- For PDF, preserves the raw object then stops with `PDF_CONVERSION_FAILED` because Task 4 conversion is intentionally out of scope.

### `fetchAndExtract`

- Preserves existing return fields:
  - `html`
  - `title`
  - `text`
  - `siteName`
  - `description`
  - `finalUrl`
- Adds:
  - `warnings`
  - `scope`
  - `method`
- Delegates text extraction and metadata parsing to `extractStaticHtml`.

## Verification

RED check:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts
```

Observed failure before implementation:

```text
Failed to resolve import "../../../worker/src/ingestion/extractHtml"
```

Final verification:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts && pnpm --filter @radar/worker typecheck
```

Observed final result:

```text
Test Files  1 passed (1)
Tests       9 passed (9)
tsc --noEmit  -> exit 0
```

## Self-Review

- Preserved Task 1/2 provenance additions instead of reintroducing local enums or duplicate classifiers.
- Kept `finalUrl` intact in the compatibility path and in remote acquisition.
- Avoided UI, browser rendering, workflow, or unrelated ingestion changes.
- Centralized entity decoding instead of copying the previous `extractUrl.ts` rules.
- Left PDF conversion deliberately incomplete rather than partially inventing Task 4 behavior.

## Concerns

- `extractStaticHtml` is still regex-based and deterministic, so malformed or deeply nested HTML can score imperfectly. That is acceptable for Task 3 because the brief explicitly constrained this step to static extraction without browser rendering.
- The PDF boundary currently returns `PDF_CONVERSION_FAILED` after raw preservation. Task 4 must replace that with the Workers AI `toMarkdown()` branch.
