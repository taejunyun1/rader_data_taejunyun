# Task 5 Report

Date: 2026-08-24
Scope: reading workspace visual hierarchy, control density, header opacity, and deterministic UX E2E.

- Added 40px desktop and 44px mobile control tokens; filter/topic strips stay horizontally scrollable on mobile.
- Made the sticky page header fully opaque and aligned search/deep-analysis controls with shared sizing.
- Raised source-list reading hierarchy and render unknown access as muted metadata; direct/PDF/institution badges remain badges.
- Added E2E coverage for desktop pane scroll, opaque header, mobile filter row, and list/detail switching using `region: 자료 읽기`.

Verification: new Playwright UX spec 4/4, relevant Vitest 55/55, full web Vitest 264/264, `pnpm -r typecheck`, and `git diff --check` passed.
No deploy performed.

Review follow-up (2026-08-24):

- Kept the mobile header sticky by removing only the conflicting `position: relative` override; its wrapped mobile layout remains unchanged.
- Made `.topic-strip > .topic-chip` meet the 44px mobile touch-target contract and asserted the filter/topic strips' `overflow-x: auto` behavior.
- Strengthened the desktop fixture with a selected long reading detail, then asserted the list scroll position changes while the reading pane remains at its initial scroll position.

## Final whole-branch review follow-up (2026-08-24)

- Reservoir detail selection now has a generation-guarded loading state. While a detail request is pending, the selected reading pane shows a loading status and keeps `목록으로` available; the empty unselected state and judgment entry do not appear until appropriate.
- At 640px and below, the Reservoir search field and the deep-analysis select/button join the 44px touch-target contract. Desktop control sizing remains scoped to the existing 40px token.
- Added a deferred-detail regression that verifies loading, mobile-pane selection, back action, and loaded transition remain coherent.
