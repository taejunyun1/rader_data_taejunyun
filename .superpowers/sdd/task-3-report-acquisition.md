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

## Review Fix Follow-up (2026-08-23)

Addressed both Important review findings against commit `9e5de4a` without expanding Task 3 scope.

### 1. Hostname DNS resolution hardening

- `acquireRemoteSource()` now performs a deterministic hostname resolution check before every outbound request, including each redirect hop.
- The request boundary remains `http` / `https` only.
- Literal blocked hosts still fail immediately, and non-literal hostnames now resolve through Cloudflare DNS-over-HTTPS before the fetch proceeds.
- Any lookup failure, unresolved hostname, or A/AAAA answer in blocked ranges now fails closed with `REDIRECT_BLOCKED`.
- Blocked ranges now cover:
  - IPv4 loopback, link-local, RFC1918/private, unspecified, carrier-grade NAT, and benchmark ranges
  - IPv6 loopback, link-local, unique-local, site-local, unspecified, and IPv4-mapped private equivalents
- Added an injectable DNS resolver seam for tests so the acquisition path stays deterministic without live DNS.

### 2. Nested consent/share/ad stripping

- `extractStaticHtml()` still removes the original structural chrome tags, but now also strips nested elements whose `class`, `id`, or ARIA-style attributes clearly mark them as cookie, consent, share/social, subscribe/promo, or ad containers.
- This cleanup happens before candidate scoring and again before fragment text conversion, so those strings do not bleed into the selected article text even when the noisy block sits inside `main`, `article`, or content-hint containers.

### Added Regression Coverage

- Added a hostname-resolution regression proving `https://public.example/...` is rejected when the injected resolver returns `127.0.0.1` / `10.0.0.9`.
- Added an HTML regression proving nested cookie, consent, share, and ad text is removed from extracted article text.

### Final Verification

Ran fresh after the fixes:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts
pnpm --filter @radar/worker typecheck
```

Observed final result:

```text
Test Files  1 passed (1)
Tests       11 passed (11)
tsc --noEmit  -> exit 0
```

## Timeout Fix Follow-up (2026-08-23)

Addressed the remaining Task 3 timeout finding against head `0a7832b`.

### Problem

- The 20-second `AbortController` only covered the content fetch.
- Cloudflare DNS-over-HTTPS lookups inside `createDnsResolver()` ran without the acquisition signal, so a stalled DNS lookup could outlive the intended acquisition boundary.
- Because DNS failures were normalized into hostname-validation outcomes, an abort risked surfacing as `REDIRECT_BLOCKED` instead of deterministic `FETCH_TIMEOUT`.

### Fix

- Threaded the acquisition `AbortSignal` through:
  - `fetchWithRedirects()`
  - `validateRemoteUrl()`
  - `hostnameResolvesPublicly()`
  - `resolveDnsSafely()`
  - `createDnsResolver()` and each Cloudflare DoH fetch
- Applied the same signal on every hostname validation, including redirect hops.
- Preserved abort semantics by rethrowing abort-shaped DNS failures and converting them at the top level into `FETCH_TIMEOUT`.

### Regression Coverage

- Added a focused test proving a DNS resolver that only settles on abort is cut off by the 20-second acquisition timer.
- The test also confirms no content fetch is attempted before the timeout resolves to `FETCH_TIMEOUT`.

### Verification

Ran after the fix:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts
pnpm --filter @radar/worker typecheck
```

Observed final result:

```text
Test Files  1 passed (1)
Tests       12 passed (12)
tsc --noEmit  -> exit 0
```
