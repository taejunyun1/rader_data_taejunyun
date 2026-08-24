# Task 5 Report

Date: 2026-08-24
Scope: reading workspace visual hierarchy, control density, header opacity, and deterministic UX E2E.

- Added 40px desktop and 44px mobile control tokens; filter/topic strips stay horizontally scrollable on mobile.
- Made the sticky page header fully opaque and aligned search/deep-analysis controls with shared sizing.
- Raised source-list reading hierarchy and render unknown access as muted metadata; direct/PDF/institution badges remain badges.
- Added E2E coverage for desktop pane scroll, opaque header, mobile filter row, and list/detail switching using `region: 자료 읽기`.

Verification: new Playwright UX spec 4/4, relevant Vitest 55/55, full web Vitest 264/264, `pnpm -r typecheck`, and `git diff --check` passed.
No deploy performed.
