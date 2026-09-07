# Technical Audit Remediation Implementation Plan

> **For agentic workers:** Use systematic-debugging and test-driven-development per task; independent domains use dispatching-parallel-agents. Parent integrates and verifies before the user-authorized push and deployment.

**Goal:** Resolve the remaining validated technical audit findings, retain the CSV security fix, and deploy verified changes.

**Architecture:** Repair existing source-version, publication, and workflow invariants without adding product features. Keep raw storage immutable, provenance tied to its input version, and durable side effects idempotent. Preserve existing export fields while including omitted research records and original versions.

**Tech Stack:** TypeScript, Hono, Cloudflare D1/R2/Workflows, React, Vitest, pnpm.

## Global Constraints

- Source of truth: docs/SPEC.md, docs/spec-v0.1.txt, docs/PROJECT_CONTEXT.md.
- Cloudflare-first / External-minimal / Serverless-first / Reservoir-first / Model-agnostic.
- No new models hardcoded; no V0 non-goals added.
- Existing unrelated working tree changes remain unstaged. Parent owns test registration and release.
- Important policy changes require a concrete proposal to the user first; continue independent fixes meanwhile.

## Tasks

### 1. Immutable originals and manual-review policy (T01/T05)
- [ ] Reuse the forced concurrent upload and active manual-version reproductions from the audit.
- [ ] In ingestion/store.ts and routes/sync.ts use per-version immutable R2 identities, owner-only cleanup, and the existing incoming-version activation policy.
- [ ] Assert every persisted raw hash matches R2 bytes and active manual correction survives incoming uploads. Register new Workers regressions.

### 2. Publication contract and lifecycle (T04/T07/T08/T13)
- [ ] Reproduce deletion of published source, withdrawal/republish, and successful client withdrawal parsing.
- [ ] Apply approved publication/source deletion interlock under the shared singleton lease; preserve claim guards.
- [ ] Correct ledger allowed transitions and response-key validation. Apply private IPv6 prefixes only to IP literals.
- [ ] Verify actual D1/R2 publication lifecycle, race ordering and valid/invalid URL contracts.

### 3. Research input and retry invariants (T02/T03/T09/T10/T12)
- [ ] Reproduce latest signal selection, version-specific analysis, provider transient failure retry and persistence retry.
- [ ] Correct signal ordering and match analysis.version_id to active_version_id.
- [ ] Fix immutable analysis input/cache identity and one durable Distill session per job.
- [ ] Separate retryable failed provider calls from monthly budget failures.
- [ ] Review T11 job/call reservation ownership against documented deferred integration policy and present alternatives before changing it.

### 4. Export completeness (T06)
- [ ] Verify JSON includes source_versions, analysis payloads and Distill input/source provenance.
- [ ] Preserve existing JSON keys; include versioned research data and original object references.
- [ ] Back up all referenced retained original versions under unique export IDs, record source keys and copied keys, report missing objects instead of silent success.
- [ ] Test two-version backup, missing originals, and JSON provenance round-trip using local D1/R2.

### 5. Input correctness and PDF early rejection (T14/T15)
- [ ] Add UI tests typing into an initially empty analysis field and uploading an oversized PDF.
- [ ] Materialize the first array entry on first edit; move the 29,000,000-byte check before PDF extraction.
- [ ] Verify ordinary edits and allowed-size PDF uploads retain behavior.

### 6. Integration and release
- [ ] Promote audit regressions to normal tests, run pnpm verify and all nine original audit reproductions.
- [ ] Review the integrated diff, report any unresolved design/operational limits precisely.
- [ ] Check remote branch and Cloudflare deployment/migrations, run Worker dry-run.
- [ ] Commit only this remediation with dated Korean summary, push and deploy the exact verified revision.
- [ ] Verify deployed version and health/auth boundaries; record release evidence and remaining audit follow-ups.
