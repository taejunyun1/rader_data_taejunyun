# Reservoir permanent source deletion design

## Goal

Give a user an intentional, irreversible way to remove one stored source and the source-owned data it created. The action must remove the original objects in R2 as well as the directly dependent D1 records, without damaging other sources or a logical merge group that happens to contain the source.

## Chosen approach

Use a **confirmation-gated permanent deletion** flow.

- The user must enter the exact current source title before the destructive action is enabled.
- There is no automatic deletion, retention timer, or automatic refresh deletion.
- `ignore` remains a reversible research judgment and is not deletion.
- The feature does not rewrite composite historical research artifacts such as distill session output. Those records can contain multiple sources, so removing them is a separate, explicitly scoped feature.

This was chosen over immediate deletion because it prevents accidental loss, and over a trash system because the requested action is complete deletion and a trash system adds a new retention subsystem.

## Scope

Deleting source `S` permanently removes its source-owned data:

1. The active source row and every `source_versions` row, including the source original/version R2 objects.
2. Source analyses, keywords, questions, fragments, thread links, user signals, processing jobs, source embeddings, identity keys, and refresh fingerprints.
3. Duplicate candidates that include `S`, plus the selected source's membership in a logical merge group.
4. Visual assets owned by `S` or its versions, their versions, analyses, embeddings, relations, operations, extraction runs and units, including visual and temporary R2 objects.

It does not alter another source, its data, or its R2 objects. It also does not rewrite shared historical output that may mention the deleted source in JSON snapshots, distill sessions, or completed job results.

`discovery_candidates` is discovery history rather than source-owned content. A candidate linked to `S` is preserved, but its nullable `source_id` link is cleared so it cannot point to a deleted source. `discovery_field_signals.source_id` identifies the configured discovery feed, not a Reservoir source, and is therefore not changed.

## Merge behavior

Logical merging remains reversible for ordinary use. Permanent deletion deliberately removes just the selected member.

- Deleting a noncanonical member removes that member and preserves the canonical source and remaining members.
- Deleting a canonical member selects a replacement from remaining members using the existing canonical ordering: user decisions/thread links, `READY + FULLTEXT`, active normalized text length, then oldest creation time.
- Deleting the last member removes the merge group.
- Candidate records that reference the deleted source are removed. Candidate records for other members remain.

The server re-reads the source and active merge state immediately before deletion. If the source has disappeared, the confirmation no longer matches, or a conflicting active operation is present, the request fails safely without partial D1 deletion.

## API contract

Add `DELETE /api/reservoir/:sourceId` with JSON body:

```json
{ "confirmTitle": "Exact current source title" }
```

Responses:

| Status | Meaning |
| --- | --- |
| `200` | Source was deleted; response includes the deleted ID and any merge-group update. |
| `400` | Missing or invalid confirmation payload. |
| `404` | Source no longer exists. |
| `409` | Title confirmation mismatch, an active source job/extraction exists, or the merge state changed before deletion. |
| `502` | One or more R2 objects could not be removed. No D1 records are deleted. |
| `500` | The D1 deletion batch failed after R2 cleanup. The source remains visible and the request can be retried. |

The endpoint returns no original text, R2 key, or deleted payload.

## Delete transaction and R2 consistency

R2 and D1 cannot participate in one transaction. The operation therefore uses this order:

1. Load the source, its direct dependencies, its merge state, and every source-owned R2 key.
2. Reject the request when a source-owned job or visual extraction is active.
3. Remove all collected R2 keys. R2 deletion is idempotent; a missing key is considered removed.
4. If any R2 deletion fails, stop and return `502`; do not modify D1. A retry can safely repeat deletes that already succeeded.
5. In one D1 batch/transaction, delete dependent data from leaf tables upward, repair or remove merge data, delete versions, then delete the source row last.
6. If D1 fails after R2 succeeds, retain the source record and report failure. A retry remains safe because R2 key deletion is idempotent.

The UI only treats the action as successful after both phases complete. The implementation must use bounded D1 batches where a source has many visual descendants, while keeping each logical D1 stage atomic.

## User interface

The Reservoir detail view gains a visually separated danger area:

- A `자료 삭제` button opens a modal.
- The modal names the selected source, states that originals, versions, analysis, visual data, and R2 objects cannot be restored, and explains whether the source is an ordinary record, a merge member, or the current canonical member.
- The user enters the displayed title exactly. The `영구 삭제` button remains disabled until it matches client-side, and the server repeats the validation.
- During the request the controls are locked and indicate progress.
- On success, invalidate Reservoir list/detail data and navigate to the source list with a concise completion notice.
- On failure, leave the detail open and show a retryable reason without exposing storage keys or internal SQL errors.

## Error handling and audit boundaries

- Do not add a soft-delete state or a separate retained copy of the source. This is deliberately permanent.
- Do not log original text, R2 keys, or full source metadata in the success response or UI notification.
- Existing system request logs may record ordinary endpoint metadata; the feature adds no new content-bearing audit record.
- Treat all client-provided source IDs and confirmation strings as untrusted and use parameterized D1 statements.

## Verification

Worker route/service tests must cover:

1. A standalone source with multiple versions and all direct dependent records is removed.
2. All collected source-owned R2 keys, including visual and extraction temporary keys, are deleted.
3. R2 failure leaves all D1 records unchanged and makes retry safe.
4. Invalid/missing confirmation, deleted source, and active work return the specified errors without mutation.
5. Deleting a member preserves its merge group; deleting canonical source elects the correct replacement; deleting the last member removes the group.
6. D1 deletion failure does not return success and a retry can complete safely.

Web tests must cover disabled confirmation, explanatory merge copy, in-flight lock, success navigation/cache refresh, and readable failure states.

## Non-goals

- Bulk deletion and automatic cleanup rules.
- Restoring deleted records, a recycle bin, or retention schedules.
- Editing composite historical research outputs.
- Deploying the feature or executing a remote D1 migration as part of the design work.
