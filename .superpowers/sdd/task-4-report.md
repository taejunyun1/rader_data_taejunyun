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

## Review follow-up — 2026-08-24 (Discover candidate latest intent)

- Discover candidate selection and list return now advance a shared candidate-intent generation and cancel obsolete pending UI/job tracking.
- Candidate judgment completion rechecks its candidate ID and generation before recording follow-up develop signals, refreshing candidates, changing visible state, or navigating to Reservoir. A Keep acquisition completion applies the same current-intent check.
- TDD record: added a deferred `develop` response regression; selecting a second candidate while the first judgment is pending now leaves the newer reading selection intact and prevents the old source signal/navigation. The pre-fix run failed because it navigated to `RESERVOIR`.
- Verification: focused reading-flow Vitest passed (4 files, 43 tests); full web Vitest passed (37 files, 250 tests); `pnpm -r typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (Discover refreshed selection)

- Discover candidate reloads now preserve the initial default selection only until the first candidate is selected. If the currently selected candidate is absent from a refreshed job- or filter-driven list, the view invalidates candidate intent, closes the judgment sheet, clears selection/document/error/pending state, and remains in the unselected reading state instead of selecting the next candidate.
- Same-candidate decisions retain their existing intent guard; a reload that removes that candidate now safely invalidates the old intent rather than retargeting its judgment to another candidate.
- TDD record: added the A-judgment → refreshed-B-only regression. It failed before the change because B replaced A while the judgment sheet stayed open; it passes with neither A nor B selected until an explicit click.
- Verification: focused Task 4 web Vitest passed (4 files, 44 tests); full web Vitest passed (37 files, 251 tests); `pnpm -r typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (Discover candidate list latest intent)

- Discover candidate list requests now receive an incrementing generation and `AbortController`. Mount, status/lane filter changes, completed discovery-job refreshes, explicit retries, and post-decision reloads all use this same guarded path.
- A response may update candidates, selection, judgment state, or list errors only while it is both the newest list request and the same candidate-selection intent captured when it began. Superseded requests are aborted; late responses and aborts are ignored.
- The first accepted list request still selects its first candidate by default. Once the user has selected or cleared a candidate, a later accepted list that no longer contains that ID uses the existing reset path: close judgment, clear selection, and do not auto-select another candidate.
- TDD record: added a deferred `KEPT` filter response versus newer `CANDIDATE` reload regression. It failed before the guard because the late response cleared the selected second candidate; it passes after the change.
- Verification: focused Task 4 web Vitest passed (4 files, 45 tests); full web Vitest passed (37 files, 252 tests); `pnpm typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (Keep acquisition intent preservation)

- A queued Keep acquisition now retains its exact candidate intent when the selected candidate disappears in the post-Keep candidate reload. The visible reading selection and judgment sheet still close; only the matching pending acquisition intent survives.
- Ordinary candidate disappearance still clears the full candidate intent, and a later explicit selection clears the retained Keep intent. A stale or unrelated acquisition therefore cannot navigate to Reservoir.
- TDD record: added the A Keep → B-only refreshed list → acquisition success → Reservoir navigation regression. It failed before the fix because reconciliation cleared the queued Keep intent.
- Verification: focused DiscoverView Vitest passed (21 tests); full web Vitest passed (37 files, 253 tests); `pnpm --dir web run typecheck` passed.

## Review follow-up — 2026-08-24 (Reservoir freshness races)

- Reservoir list/filter reloads now use a latest-request generation, so late responses and errors cannot replace newer items, next-research state, or the active reading context.
- Deep-analysis submission tracks both its request generation and the selected interaction generation. A late result, readiness block, error, job refresh, or pending-state completion from source A cannot affect source B or an unselected reader.
- Judgment, reanalysis, and canonical refetch now retain an action generation across their own detail refresh, but navigation invalidates it. Their stale completion/error feedback and pending-state cleanup cannot affect a later source or list state.
- TDD record: added deferred list-overlap, deep-analysis block/navigation, deep-analysis error/list-return, and refetch-error/navigation regressions. All four failed before the guards and pass after the change.
- Verification: focused Task 4 web Vitest passed (4 files, 50 tests); full web Vitest passed (37 files, 257 tests); `pnpm typecheck` passed for shared, worker, and web.

## Review follow-up — 2026-08-24 (field-signal and topic freshness)

- Discover field-signal list requests now capture the active status/type filter intent, abort superseded requests, and apply list data or errors only when both the request generation and filter generation remain current.
- Field-signal actions now capture the same filter intent and an action generation. Changing status/type invalidates an in-flight action's visible completion, pending item, message, and follow-up reload while preserving the normal same-filter save/dismiss/restore refresh.
- Reservoir topic-option requests now use a latest generation and abort cleanup. Starting any Reservoir list/filter reload invalidates prior topic responses, so old topic chips cannot replace options for the current result/filter set.
- TDD record: added deferred NEW→SAVED list, delayed field-signal action after a filter change, and late topic-options regressions. The RED run failed on all three expected stale updates before implementation.
- Verification: focused Discover/Reservoir Vitest passed (2 files, 49 tests); full web Vitest passed (37 files, 260 tests); `pnpm -r typecheck` passed for shared, worker, and web; `git diff --check` passed.
