# Reservoir permanent deletion claim serialization

## Context

The original permanent-deletion design protects the final D1 batch with a fresh dependency snapshot, but R2 and D1 are separate stores. A new source version, visual asset, or queued visual job can be created after the R2 key list is collected and before the D1 delete batch. If that write succeeds while R2 cleanup is in progress, the delete can either leave an orphaned R2 object or return a failure after already removing older R2 objects.

This addendum supersedes the original design's "no new D1 migration" constraint. The user selected the serialized-claim option because the cross-store race must be closed at the storage boundary, not only by another application-level preflight.

## Goal and invariants

For a source `S`, a permanent delete must satisfy:

1. At most one delete attempt owns `S` at a time.
2. Once the claim is acquired, no new source-owned version, visual dependency, or source-owned research job can be committed.
3. A worker that is already running must re-check the claim immediately before writing a source-owned R2 object.
4. R2 failure never releases the claim if any R2 delete may have succeeded. The claim remains retryable so a writer cannot repopulate data between partial R2 cleanup and a retry.
5. A D1 failure after successful R2 cleanup also keeps the claim. A later retry can repeat idempotent R2 deletes and finish the D1 purge.
6. Only a preflight failure that happened before R2 mutation releases the claim.
7. The source row is deleted last; its foreign-key cascade removes a completed claim.

## Claim model

Migration `0027_source_deletion_claim.sql` adds `source_deletion_claims`:

| Column | Purpose |
| --- | --- |
| `source_id` (PK/FK) | one claim per source; cascades when the source is finally deleted |
| `claim_token` (unique) | proves that the current delete owns the claim during the D1 batch |
| `state` | `R2_PENDING` or `R2_COMPLETE` |
| `lease_expires_at` | permits recovery if a process dies before it can finish the R2 phase |
| `created_at`, `updated_at` | recovery and operator diagnostics without storing source content |
| `last_error_code` | bounded retry state (`source_delete_r2_failed` or `source_delete_d1_failed`) |

Acquisition is one atomic D1 operation:

- no row: insert a new `R2_PENDING` claim;
- live `R2_PENDING` row: return `source_delete_in_progress`;
- live `R2_COMPLETE` row with no error: return `source_delete_in_progress` while its owner is performing the D1 batch;
- live `R2_COMPLETE` row with `last_error_code = source_delete_d1_failed`: atomically rotate the token and lease so the failed finalization can be retried immediately;
- an expired claim remains recoverable regardless of state/error;
- the claim is never silently replaced while another live lease owns it.

The claim helper owns token generation, lease renewal, state transitions, and bounded error recording. Callers never construct claim SQL themselves.

## Delete lifecycle

1. Validate source existence and the exact title without mutating anything.
2. Acquire the claim before loading mutable dependency state. If another live attempt owns it, return `409 source_delete_in_progress`.
3. Run active-work, dependency, merge, and R2-key preflight under the claim. If this stage fails, delete the claim row and return the existing safe `409` error.
4. Re-read the plan and renew the lease immediately before R2 deletion.
5. Delete the collected R2 keys. On any failure, record `source_delete_r2_failed`, keep the claim in `R2_PENDING`, and return `502`. No D1 source data is deleted.
6. Atomically transition the claim to `R2_COMPLETE`. If this transition cannot prove ownership, stop and return `500`; never run an unowned D1 purge.
7. Execute the existing bounded D1 deletion batch with a first statement that validates the claim token, state, source title, dependency/merge fingerprints, and absence of active work. The claim row must still belong to this attempt.
8. On D1 success, delete the source last; the claim disappears by foreign-key cascade. On D1 failure, preserve `R2_COMPLETE` with `source_delete_d1_failed` so a later retry can resume.

## Write serialization boundary

The migration adds `BEFORE INSERT`/relevant `BEFORE UPDATE` triggers that abort with the stable message `source_deletion_in_progress` when a live claim exists. The protected source-owned paths are:

- `source_versions` and source-owned source metadata updates;
- `visual_assets`, `visual_asset_versions`, `visual_analyses`, `visual_embeddings`, `visual_relations`, and `visual_asset_operations`;
- `visual_extraction_runs` and `visual_extraction_units`;
- `research_jobs` whose JSON input directly names `sourceId`, `sourceVersionId`, or a `visualAssetId` owned by the claimed source.

The central `enqueueResearchJob` path also resolves direct source/version/visual inputs and calls the claim guard before dedupe or insert. This gives callers a stable `409` error while the database trigger protects non-route writers and future call sites. Trigger predicates use `json_valid` and indexed ownership joins; unrelated discovery, distill, and radar jobs remain unaffected.

R2-producing workers call the same guard immediately before `ORIGINALS.put`:

- source acquisition/re-import and Obsidian sync originals;
- personal/PDF visual originals and extraction page/crop objects;
- visual capsule transforms.

If the guard detects a claim, the worker aborts before the put and records a bounded job error. Cleanup deletes remain allowed so the deleting request can remove already-created objects.

## Error contract

Add `source_delete_in_progress` to `SourceDeletionError`. The API maps it to `409` without exposing claim tokens, leases, R2 keys, or SQL text. Existing error codes remain unchanged for title mismatch, active work, state drift, R2 failure, and D1 failure.

## Recovery and safety

- Lease duration is short enough to recover a dead request but longer than the bounded R2 batch timeout; renewal occurs before each R2 batch and before the D1 batch.
- A retry after `R2_PENDING` or `R2_COMPLETE` is the only supported way to finish a failed delete. There is no UI force-unlock action in this change.
- Claim rows contain no original text or R2 key list. They are operational lock metadata.
- Existing logical merge repair and historical merge fingerprint protections remain unchanged.

## Verification

Worker tests must cover:

1. Two concurrent claims for one source yield one owner and one `source_delete_in_progress` result.
2. A live claim blocks direct version, visual dependency, extraction, and enqueue writes; an unrelated source remains writable.
3. A dead/expired claim can be resumed, while a live lease cannot be stolen.
4. R2 failure preserves the claim and all source D1 rows; a retry completes without accepting an intervening write.
5. D1 failure preserves `R2_COMPLETE`; a retry completes and removes the claim by source cascade.
6. An in-flight visual/source worker that observes a claim performs no new R2 put.
7. The existing merge, historical merge, and route/UI regression suites remain green.

No remote migration, deploy, push, or production data mutation is part of this implementation.
