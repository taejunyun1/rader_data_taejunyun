# Task 2 Report

## Status
- Completed Task 2 in the current workspace.
- Code commit created: `50660f7` (`260824: Inbox URL 수집 안전 경계 적용`)
- Report written locally after the code commit.

## Scope Completed
- Moved legacy URL inbox extraction onto the shared remote-fetch safety boundary by changing `fetchAndExtract()` to use `fetchRemoteDocument()`.
- Preserved legacy `ExtractedPage` fields: `html`, `title`, `text`, `siteName`, `description`, `finalUrl`, `warnings`, `scope`, `method`.
- Preserved legacy inbox caller contracts for:
  - `POST /url` failed-source `200` payload behavior
  - `POST /:sourceId/reextract` URL reextract flow
  - queryless `POST /retry/:sourceId` synchronous legacy retry flow
  - `POST /retry/:sourceId?fetch=1` background `SOURCE_ACQUISITION` enqueue behavior
- Did not implement RSS or budget work.

## Commits
- Base already present from Task 1: `fa4225b`
- Task 2 code commit from this run: `50660f7`

## Changed Files
- `worker/src/ingestion/extractUrl.ts`
- `web/src/lib/remoteAcquisition.test.ts`
- `web/src/lib/deepAnalysis.test.ts`

## Verified Unchanged But Checked
- `worker/src/routes/inbox.ts`
  - Verified it still routes `/url`, `/:sourceId/reextract`, and sync `/retry/:sourceId` through `fetchAndExtract()`
  - Verified `?fetch=1` still enqueues `SOURCE_ACQUISITION`
  - Verified no raw external fetch path was added there

## TDD Record
1. Added the required tests first in `web/src/lib/remoteAcquisition.test.ts` and `web/src/lib/deepAnalysis.test.ts`.
2. Ran the focused red command before production edits.
3. Confirmed red failures were isolated to the intended raw-fetch gaps after fixing two incorrect test assumptions:
   - `.pdf` HTML fixture length was too short for `FULLTEXT`
   - retry/reextract R2 assertions incorrectly assumed deterministic acquisition keys/version ids
4. Implemented the minimal adapter change in `worker/src/ingestion/extractUrl.ts`.
5. Re-ran the focused tests to green.
6. Ran workspace typecheck and the raw-fetch grep guard.

## Exact Test Outcomes
### Red verification
Command:
```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/deepAnalysis.test.ts
```

First red run result:
- Exit code `1`
- `src/lib/remoteAcquisition.test.ts`: 3 failed
- `src/lib/deepAnalysis.test.ts`: 2 failed
- Two failures were test issues, not product issues:
  - `.pdf` HTML fixture produced `PARTIAL` instead of `FULLTEXT`
  - retry/reextract assertions expected fixed acquisition keys/version ids

Second red run result after correcting those test assumptions:
- Exit code `1`
- `Test Files  1 failed | 1 passed (2)`
- `Tests  2 failed | 39 passed (41)`
- Expected raw-fetch failures:
  - `blocks direct private network targets before issuing a request`
    - expected `REDIRECT_BLOCKED`
    - received `raw_fetch_called`
  - `fails oversized HTML bodies with SIZE_LIMIT before calling response.text()`
    - expected `SIZE_LIMIT`
    - received `raw_text_called`

### Green verification
Command:
```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/deepAnalysis.test.ts
```

Result:
- Exit code `0`
- `Test Files  2 passed (2)`
- `Tests  41 passed (41)`

### Typecheck
Command:
```bash
pnpm typecheck
```

Result:
- Exit code `0`
- `shared typecheck: Done`
- `worker typecheck: Done`
- `web typecheck: Done`

### Static guard
Command:
```bash
rg -n "fetch\\(.*canonical_url|fetch\\(url|redirect: \"follow\"|res\\.text\\(\\)" worker/src/ingestion/extractUrl.ts worker/src/routes/inbox.ts
```

Result:
- Exit code `1`
- No matches

## Implementation Notes
- `fetchAndExtract()` no longer owns its own `AbortController`, direct `fetch`, redirect-following, content-type gate, or `res.text()` handling.
- `fetchAndExtract()` now:
  - calls `fetchRemoteDocument(url)`
  - rejects non-HTML remote documents with `RemoteFetchError("UNSUPPORTED_CONTENT_TYPE")`
  - decodes `remote.body` via `TextDecoder`
  - extracts static HTML using `remote.finalUrl`
- Existing error message behavior remains stable because `RemoteFetchError` messages are the fetch error codes already used by failed-source and retry error recording.

## Concerns
- The required code commit uses the user-requested prefix `260824:` even though the current local date is Sunday, August 23, 2026.
- `worker/src/routes/inbox.ts` did not require source changes for Task 2; it was verified instead of modified.
- The report file was written after the code commit and is not included in commit `50660f7`.
- Unrelated untracked workspace items were left untouched:
  - `.playwright-cli/`
  - `.pnpm-store/`
  - `.superpowers/brainstorm/`
  - `docs/superpowers/plans/2026-08-24-remote-fetch-safety-and-ai-budget-guard-plan.md`
  - `output/`
  - `web/test-results/`

## Follow-up Fix Report

### Files
- `web/src/lib/ingestion.test.ts`
- `.superpowers/sdd/task-2-report.md`

### Commit
- Pending at report write time. This follow-up should be committed with prefix `260824:`.

### Exact Test Outcomes
- Red verification before the fixture change:
  - Command: `pnpm --dir web exec vitest run src/lib/ingestion.test.ts -t "keeps the final response url after redirects"`
  - Exit code: `1`
  - Result: `1 failed | 18 skipped`
  - Failure: `RemoteFetchError: REDIRECT_BLOCKED`
- Green verification after the fixture change:
  - Command: `pnpm --dir web exec vitest run src/lib/ingestion.test.ts -t "keeps the final response url after redirects"`
  - Exit code: `0`
  - Result: `1 passed | 18 skipped`
- Task 2 focused suites:
  - Command: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/deepAnalysis.test.ts`
  - Exit code: `0`
  - Result: `2 passed`, `41 passed`
- Typecheck:
  - Command: `pnpm typecheck`
  - Exit code: `0`
  - Result: `shared typecheck: Done`, `worker typecheck: Done`, `web typecheck: Done`

### Concerns
- The regression was in test setup only. Production code was left unchanged as requested.
- The requested commit prefix `260824:` is one day ahead of the current local date, Sunday, August 23, 2026.
