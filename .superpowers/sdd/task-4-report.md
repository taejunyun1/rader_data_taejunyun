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
