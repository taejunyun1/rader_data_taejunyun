# Task 4 Report

- Scope: separated reading selection from explicit judgment entry.
- Files: ReadingActionBar; DecisionBottomSheet; Reservoir/Discover views, tests, and reading.css.
- Tests added: action bar behavior; source/candidate explicit judgment; reservoir deselection.
- Tests updated: prior automatic-dialog flows now click `판단하기` first.
- Focused: 4 files, 31 tests passed.
- Full web Vitest: 37 files, 238 tests passed.
- Typecheck: `pnpm -r typecheck` passed (shared, worker, web).
- Commit: `260824: 읽기와 판단 진입 상태 분리`.
- Caveats: no API, D1, R2, Cloudflare, deployment, E2E, or documentation changes.

## Review follow-up — 2026-08-24

- Closed the three Important findings from the Task 4 review without entering Task 5/6 scope.
- Reservoir detail loading now clears stale document state immediately and uses a request-generation guard. A late prior response or error after a newer selection or `clearSelection()` cannot update detail, deep profile, or the visible error state; the existing view signal POST remains on the current request path.
- The Reservoir detail-error reading pane now uses `ReadingActionBar` without a document or judgment action, retaining the mobile `목록으로` route back to the index while keeping retry available.
- Discover maps `KEPT`, `WATCHED`, `IGNORED`, and `DEVELOPED` candidate statuses to `DECISION_STATUS_LABELS`, supplies the mapped label to the action bar, and supplies the same status to the judgment sheet for the selected candidate.
- TDD record: added race/clear, detail-error back-navigation, and existing-candidate-decision tests; the focused pre-fix run failed on all three expected behaviors before implementation.
- Verification: focused reading-flow Vitest run passed (4 files, 34 tests); full web Vitest run passed (37 files, 241 tests); `pnpm typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (async detail completion)

- Closed the remaining two Important asynchronous-state findings without entering Task 5/6 scope.
- Successful Reservoir searches now use the same selection-clear path as the reading back action, incrementing the active detail generation before replacing the result index. A late detail success or error can no longer restore the prior document after a search transition.
- Deep-history loading captures the selected source ID and current generation. It updates the detail only when both still match, and surfaces its error only for that current request; a prior source's history result cannot overwrite a newly selected source.
- TDD record: added focused deferred-response tests for search/detail clearing and deep-history/source replacement; both failed before the guards were added.
- Verification: focused Task 4 web Vitest run passed (4 files, 36 tests); full web Vitest passed (37 files, 243 tests); `pnpm typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (latest-intent ordering)

- Closed the latest Task 4 asynchronous findings without entering Task 5/6 scope.
- Reservoir search, selection, and explicit clearing now share one interaction generation. Starting a non-empty search invalidates earlier detail/deep-history work immediately; its response clears selection and replaces search results only if that search is still the newest interaction. A later source selection clears the pending search result instead.
- Deep-history requests now use their own generation in addition to the interaction generation. For repeated history clicks on the same source, only the newest request may replace the displayed analysis or set the loading error.
- TDD record: added deferred search-then-selection and repeated same-source history tests. Both failed before the guards were added (late search cleared the newer detail; stale history error surfaced after the later history result) and pass after the change.
- Verification: focused Task 4 web Vitest run passed (4 files, 38 tests); full web Vitest passed (37 files, 245 tests); `pnpm typecheck` passed for shared, worker, and web; `git diff --check` passed.

## Review follow-up — 2026-08-24 (empty intent and signal isolation)

- An empty Reservoir search now advances the shared interaction generation before clearing search hits. A deferred non-empty search response can no longer restore stale hits after the query has been cleared.
- View-signal recording now runs after a successful detail fetch as an independent best-effort POST. A failed or rejected view signal no longer clears valid detail or shows a detail-fetch error.
- Judgment and reanalysis capture their starting interaction generation. Their completion, error, source refresh, selection clear, and list reload now run only while that interaction remains current, so a later source selection or return to the list is not overwritten. The normal same-source completion still refreshes the current source.
- TDD record: added four deferred-response regressions for empty-search invalidation, failed view signaling, delayed judgment after a newer selection, and delayed reanalysis after returning to the list. The focused RED run failed in exactly those four cases; the GREEN run passed `21` tests.
- Verification: full web Vitest passed (37 files, 249 tests); `pnpm typecheck` passed for shared, worker, and web. The prior budget-reservation report is preserved verbatim in `task-4-report-history.md`.
