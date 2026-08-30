# Task — Delete claim lifecycle/API

## Implementer

`delete_claim_lifecycle`

## Changes

- Validate source existence and exact title before creating claim metadata.
- Acquire the source claim before collecting mutable dependency, merge, and R2 snapshots.
- Release claims only for read-only preflight failures; retain `R2_PENDING` claims after any R2 failure and retain `R2_COMPLETE` claims after D1 failure.
- Renew the lease immediately before R2 mutation and before D1 finalization; require the exact token/state in the first D1 guard statement.
- Preserve the existing active/historical merge fingerprints and stale dependency protections.
- Add stable `source_delete_in_progress` service/API error mapping.
- Extend deletion and route tests for live conflicts, retained retry claims, D1 retry, blocked intervening writes, and claim-safe late dependency attempts.

## Verification

- `pnpm --filter @radar/worker typecheck` — passed.
- `git diff --check` — passed.
- Focused Vitest could not start in the restricted sandbox: Wrangler attempted to write `/Users/taejun-yun/.wrangler/logs` and listen on `127.0.0.1`, both denied with `EPERM`. Run the focused suite from an approved test environment.

## Commit

`18b4ace 260830: delete claim lifecycle 통합`
