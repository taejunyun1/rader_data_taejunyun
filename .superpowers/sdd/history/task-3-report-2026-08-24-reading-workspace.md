# Task 3 Report

- Changed: `SplitWorkspace.tsx`, `SplitWorkspace.test.tsx`, `reading.css`, `ReservoirView.tsx`, `DiscoverView.tsx`.
- Added independent desktop pane scrolling and mobile index/reading pane switching.
- `readingKey` resets the reading-pane scroll only when selection changes.
- Added accessible index and reading landmarks.
- Tests: focused SplitWorkspace (2/2); focused component/views (26/26).
- Tests: full web Vitest (233/233); `pnpm --dir web run typecheck` passed.
- Commit: `260824: 읽기 작업공간 독립 스크롤과 모바일 전환`.
- Caveat: no deploy performed; pre-existing unrelated working-tree files remain untouched.
- Follow-up fix: replaced the reading pane's nested `main` landmark with `section role="region" aria-label="자료 읽기"` because `AppShell` owns the page `main`; scroll reset behavior is unchanged.
