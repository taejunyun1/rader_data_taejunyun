# Settings continuation and recommendation order fix report

Date: 2026-08-29

## Completed

- Settings repository previews now automatically continue while the refresh API returns `hasMore: true`, aggregate automatic-merge and review counts across all batches, and enable `정리 적용` only after the terminal preview batch. The existing copy that originals and analysis records are preserved remains unchanged.
- Discovery recommendation round-robin order now follows the fixed contract: `SAVED`, `MOMENTUM`, `DISTILL`, `RESEARCH_GAP`, `UNDERREPRESENTED`, `COUNTER`.

## TDD evidence

- Added a Settings test with a deferred second preview response. It initially failed because the UI stopped after the first `hasMore: true` response; it now proves the second request, aggregate counts, and disabled APPLY state until completion.
- Added a counter-lane ordering test. It initially failed because `COUNTER` was emitted before `UNDERREPRESENTED`; it now verifies the complete order in the counter lane.

## Verification

| Command | Result |
| --- | --- |
| `pnpm --filter @radar/web exec vitest run src/views/SettingsView.test.tsx` | PASS — 4 tests |
| `pnpm --filter @radar/web exec vitest run src/views/SettingsView.test.tsx src/views/SettingsUsageView.test.tsx` | PASS — 8 tests |
| `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/discovery/recommendations.test.ts` | PASS — 2 tests |
| `pnpm --filter @radar/web typecheck && pnpm --filter @radar/worker typecheck` | PASS |

The first sandboxed worker-test attempt could not create the Workers loopback listener or Wrangler log. The identical elevated local test passed. No deployment, push, or D1 migration was run.
