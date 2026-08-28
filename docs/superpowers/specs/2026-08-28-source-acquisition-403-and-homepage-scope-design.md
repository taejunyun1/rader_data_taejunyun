# Source Acquisition 403 and Homepage Summary Scope Remediation Design

- Date: 2026-08-28
- Status: user-approved
- Scope: homepage-reading summary provenance, remote acquisition failure detail, Job Center recovery UX, and targeted data repair

## Problem statement

The Reservoir entry `Densecap Deepdream` shows `FULLTEXT · REVIEW · 225자` while deep analysis remains blocked. A user-triggered source acquisition for its canonical URL fails with `RemoteAcquisitionError: HTTP_4XX`.

Production evidence separates this into two defects:

1. The canonical Fotomuseum Winterthur URL returns HTTP 403 with `cf-mitigated: challenge`. This is an external access restriction, not an extraction failure. The fetch layer records `HTTP_4XX` and status 403, but the acquisition boundary discards the status and challenge detail before the job reaches the UI.
2. The homepage-reading importer passes a curated title, Korean summary, and tags as non-empty `extractedText`. `createSource` therefore applies its generic non-empty defaults, `FULLTEXT` and `MANUAL_TEXT`, even though the payload is metadata rather than the remote article. The affected active version has 225 stored characters and 178 meaningful characters.

Fetch failure correctly leaves the existing active version in place. The remediation must preserve that Reservoir-first behavior while correcting provenance and recovery guidance.

## Goals

- Classify homepage-reading summaries as metadata, never as acquired full text.
- Repair existing misclassified homepage-reading versions without changing stored content, hashes, version identity, or R2 objects.
- Preserve HTTP status and access-challenge evidence across the remote fetch and acquisition boundaries.
- Keep the public acquisition error taxonomy and workflow error-code contract unchanged.
- Replace raw implementation errors with actionable Korean Job Center guidance.
- Offer retry only for failures that can reasonably succeed on a later attempt.
- Keep raw remote responses in R2 only after a successful document fetch, as required by the existing acquisition contract.

## Non-goals

- Bypassing Cloudflare challenges, login walls, paywalls, robots controls, or other publisher access restrictions.
- Adding headless browser rendering, proxy services, site-specific scrapers, or Fotomuseum-only endpoints.
- Changing the deep-analysis readiness gate of `FULLTEXT + READY + at least 1,000 characters`.
- Reclassifying manual text, uploaded documents, Obsidian notes, or successfully acquired HTML/PDF versions.
- Creating failed source versions for requests that fail before a remote document is obtained.

## Chosen approach

Use a two-layer remediation.

At ingestion time, the homepage-reading caller supplies explicit provenance for its curated summary: `METADATA_ONLY` and `DISCOVERY_METADATA`. The generic `createSource` defaults stay unchanged because they serve manual text and other callers.

At acquisition time, typed remote errors retain their stable code plus optional HTTP status and a narrow reason such as `ACCESS_CHALLENGE`. The workflow continues to use `workflow_runtime_failed` as the research-job `error_code`, and `processing_jobs.error` continues to hold the stable acquisition cause such as `HTTP_4XX`. The richer job error detail is used only for diagnostics and deterministic UI presentation.

## Data flow

### Homepage-reading import

```text
homepage-reading/latest.json in R2
→ normalize article metadata
→ createSource with explicit METADATA_ONLY / DISCOVERY_METADATA
→ preserve JSON snapshot and curated summary
→ active version remains readable as metadata
→ deep analysis remains blocked until a real remote or user-provided full text exists
```

The importer may still run the existing lightweight analysis over the curated summary. Metadata classification controls provenance and deep-analysis eligibility; it does not require deleting the summary or its derived keywords.

### Remote source acquisition

```text
Reservoir “원문 다시 가져오기”
→ SOURCE_ACQUISITION job
→ safe public HTTP(S) fetch
→ HTTP 403 + cf-mitigated: challenge
→ RemoteFetchError { code: HTTP_4XX, status: 403, reason: ACCESS_CHALLENGE }
→ RemoteAcquisitionError preserves those fields
→ processing_jobs.error = HTTP_4XX
→ research_jobs.error_code = workflow_runtime_failed
→ research_jobs.error carries stable diagnostic detail
→ Job Center maps the detail to a Korean recovery message
```

No R2 object or source version is created for this failed request. The existing metadata active version remains selected.

## Error detail contract

`RemoteFetchError` and `RemoteAcquisitionError` keep these internal fields:

- `code`: an existing stable acquisition code such as `HTTP_4XX`, `HTTP_5XX`, or `FETCH_TIMEOUT`
- `status`: the HTTP response status when one exists
- `reason`: `ACCESS_CHALLENGE` only when the response explicitly exposes challenge evidence such as `cf-mitigated: challenge`
- `finalUrl`: the validated public URL that produced the terminal response, when available

The error message must be deterministic and omit response bodies, cookies, credentials, and arbitrary upstream text. This avoids leaking remote content into D1 or the UI.

The existing public error-code list in `docs/SPEC.md` remains authoritative. `ACCESS_CHALLENGE` is diagnostic detail, not a new public acquisition code.

## Retry and recovery behavior

The web client derives a presentation object from a failed research job rather than rendering `job.error` directly.

| Failure | User message | Primary action |
|---|---|---|
| 401, 403 challenge, 404, 410 | Automatic collection is unavailable for this source | Open the validated original URL; do not offer blind job retry |
| 408, 429 | The source is temporarily unavailable or rate-limited | Offer retry |
| `FETCH_TIMEOUT`, `HTTP_5XX` | A temporary network/server failure occurred | Offer retry |
| Unsupported type, invalid PDF, extraction empty | Explain the specific unsupported or empty-result condition | Offer retry only when another attempt could change the result |
| Unknown workflow failure | Generic safe failure message | Preserve existing retry behavior |

For the Fotomuseum challenge, the message directs the user to open the article in a browser and, when full-text analysis is required, add authorized text or a file through Inbox. The application does not claim that the original was stored.

External URL actions must reuse the normalized public HTTP(S) job input or source canonical URL and open with safe external-link attributes. Invalid or missing URLs produce no link action.

## Existing-data repair

Add an idempotent D1 migration that targets versions belonging to sources with:

- `origin = 'homepage-reading'`
- `input_format = 'HOMEPAGE_JSON'`
- `extraction_method = 'MANUAL_TEXT'`
- `version_origin = 'INITIAL_INGEST'`
- `parent_version_id IS NULL`

For matching versions, set `text_scope = 'METADATA_ONLY'` and `extraction_method = 'DISCOVERY_METADATA'`. For sources whose active version matches the repaired cohort, set `quality_status = 'REVIEW'`.

The migration must not modify `extracted_text`, `normalized_text`, hashes, R2 keys, version numbers, review status, acquisition URLs, timestamps, or parent links. Successfully acquired `REEXTRACT` versions remain untouched.

The production audit found one currently affected active source, `Densecap Deepdream` (`73506573-95b6-40b4-93d8-90a7df650a9d`). The migration selects by provenance rather than hard-coding that source ID so the rule also repairs equivalent rows safely.

Implementation also records this homepage-summary provenance rule and the internal 4xx diagnostic detail in `docs/SPEC.md` and `docs/PROJECT_CONTEXT.md`. The documented public acquisition codes remain unchanged.

## UI behavior after remediation

Before a successful full-text acquisition, the Reservoir detail presents the source as metadata-only and keeps deep analysis disabled. It no longer displays `원문 저장됨` for a curated summary.

The Job Center does not expose strings such as `RemoteAcquisitionError: HTTP_4XX`. It displays a user-facing reason, distinguishes permanent access restrictions from transient failures, and avoids a futile “다시 실행” action for a confirmed challenge. The original source link remains available for direct reading.

## Test strategy

Tests are added before implementation and cover four boundaries:

1. Homepage ingestion: curated homepage summaries use `METADATA_ONLY / DISCOVERY_METADATA`; generic manual text retains its existing defaults.
2. Remote fetch and acquisition: a 403 challenge preserves code, status, reason, and final URL; ordinary 404, 429, timeout, and 5xx cases remain distinguishable; no response body enters the error.
3. Persistence: failed acquisition does not append or activate a version; the migration repairs only the homepage-summary cohort and is safe when applied twice.
4. Presentation: Job Center renders Korean guidance, suppresses retry for confirmed permanent access failures, retains retry for transient failures, and offers an original-link action only for a valid public URL.

Existing source-acquisition, version-integrity, Reservoir detail, deep-analysis gate, and Job Center suites remain green. Verification includes worker and web typechecks, focused Vitest suites, the complete Worker and web unit suites, production build, and a local D1 migration smoke check with `PRAGMA foreign_key_check`.

## Rollout and validation

Deploy code that understands both old and enriched error strings before relying on enriched failures. Apply the D1 migration in the normal migration step, then deploy the Worker and static assets. After deployment:

1. Confirm the affected source reports `METADATA_ONLY`, `DISCOVERY_METADATA`, `REVIEW`, and the existing character count.
2. Confirm its active-version ID, stored text, hash, and R2 key are unchanged.
3. Trigger one source-acquisition attempt and verify the 403 challenge is shown as an external access restriction without a blind retry action.
4. Confirm no new source version or R2 original is created by the failed attempt.
5. Confirm a transient acquisition fixture still exposes retry and a successful HTML/PDF acquisition still creates and activates an eligible version.

## Acceptance criteria

- Homepage-reading summaries cannot be labeled as acquired full text on new imports.
- The existing `Densecap Deepdream` version is repaired through a provenance-scoped migration.
- A Cloudflare 403 challenge is identifiable without changing the documented public acquisition error taxonomy.
- Raw exception names and codes are absent from the Job Center.
- Permanent access restrictions do not invite a futile automatic retry; transient failures still do.
- Failed remote fetches preserve the current active version and do not create source versions or R2 originals.
- Deep analysis remains blocked until an actual `FULLTEXT + READY` version of at least 1,000 characters exists.
- All focused and regression verification commands pass before implementation is considered complete.
