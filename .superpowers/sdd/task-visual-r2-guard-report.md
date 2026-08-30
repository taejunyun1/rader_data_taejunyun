# Visual/extraction R2 guard report

## Scope

Added source-deletion claim checks immediately before source-owned R2 writes and made claim failures escape visual extraction candidate/page recovery catches.

## Changes

- `createPersonalVisual` checks the parent source before writing the personal original. Its existing D1-failure compensation still deletes the R2 object, including a late claim-trigger failure.
- `transformVisualAsset` checks the visual asset's source owner before writing a capsule. Its existing D1-failure compensation removes a capsule written before a late trigger rejection.
- PDF page uploads check the source claim before writing the temporary page object. Existing unit-record compensation removes the object if D1 rejects the write.
- HTML/PDF link-only persistence and PDF crop persistence check the source claim before source-owned writes.
- HTML candidate and PDF candidate/page catches rethrow claim errors so a deletion claim stops the extraction instead of being reported as an ordinary unavailable candidate.

## Verification

- `pnpm --filter @radar/worker typecheck` — passed.
- `pnpm --filter @radar/web exec vitest run src/lib/pdfVisualExtraction.test.ts` — passed (14/14).
- `pnpm --filter @radar/web exec vitest run src/lib/visualAssets.test.ts` — 72/73; the existing test fixture omits the new `source_deletion_claims` table and fails in the previously-added enqueue guard path, outside this task's files.
- `pnpm --filter @radar/worker test:run` — blocked by the sandbox (`EPERM` writing Wrangler logs and binding to `127.0.0.1`), not by an assertion failure.
