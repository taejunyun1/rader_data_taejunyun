# Backend Final Review Remediation Design

- Date: 2026-08-26
- Status: user-approved
- Scope: seven backend Important findings only

## Security and rights boundaries

All automatic remote document, feed, and image requests use the Worker global `fetch` boundary with manual redirect handling. `global_fetch_strictly_public` is enabled so Cloudflare validates the actual connection target for every request and redirect hop. The separate DNS-over-HTTPS preflight is removed to eliminate validation/fetch TOCTOU. URL parsing continues to reject credentials, unsupported schemes, localhost, and literal private addresses before issuing a subrequest.

Ordinary URL and uploaded-PDF visual extraction defaults to `UNKNOWN` and `LINK_ONLY`. `PERSONAL` and `PERMITTED` require a non-empty explicit `rightsBasis` before persistent visual bytes can be archived. The existing explicit personal-image upload boundary records `user_personal_upload` as its reviewed basis; no other input path receives that basis implicitly.

## PDF checkpoint and storage consistency

The browser processes 40-page chunks until `hasMore` is false, updating its checkpoint after each uploaded page. The server preserves the maximum declared total across create, resume, finish, and cancel operations. A page object written to R2 is deleted if the corresponding D1 unit cannot be recorded.

## Vision budget and retries

`VISUAL_EXTRACTION` reserves budget before entering any vision path and uses a request-scoped 80-call gate derived from 40 page detections plus 40 candidate analyses. Every PDF detection and HTML/PDF candidate analysis consumes the same gate. Budget or call-cap blocks produce deterministic `REVIEW` metadata without pretending that a model ran. Diagnostics expose reservation, attempted/completed/blocked calls, and block reasons; no fabricated `ai_usage` cost is written.

Retry results are rebuilt from persisted extraction units and visual assets. Existing selected/review/filtered/unavailable outcomes and earlier diagnostic maxima are retained while failed units are retried.

## Atomic assignment

Assignment uses one conditional D1 update that accepts only `PERSONAL_UPLOAD`, `UNASSIGNED`, null-parent assets without existing analyses. Already assigned, extracted, or analyzed assets return a conflict without mutation.

## Verification

Focused Vitest coverage exercises DNS rebinding/platform rejection, redirect hops, rights defaults and basis requirements, 80+ page continuation, budget/call-cap fallback, cumulative retry accounting, assignment races, and R2 compensation. Worker/web/shared typecheck and diff checks run before the final commit. UI modal files are out of scope.
