# Task 7 Report — Visual Inspector and Reservoir Analysis Editing

## Status

Completed Task 7 only: the visual inspector, analysis editor, PDF crop preview, responsive desktop/mobile presentation, retry/error UX, and Reservoir integration. No Task 8+ extraction-status or assignment workflow was implemented.

## TDD Evidence

### RED

- Added `web/src/components/visual/VisualWorkspace.test.tsx` before production edits.
- Ran `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx`.
- Result: 6 failures, as expected. The existing panel exposed non-interactive cards, no inspector, no edit flow, no LINK_ONLY preview behavior, and no mobile close/focus restoration.

### GREEN

- Rebuilt `VisualAssetPanel` around clickable cards, on-demand `/api/visual-assets/:id` detail loading, inspector state, and local summary syncing.
- Added `VisualInspector`, `VisualAnalysisEditor`, and `PdfCropPreview`.
- Wired Reservoir to keep its detail/unassigned visual lists coherent after inspector updates.
- Re-ran `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx`.
- Result: 1 file, 6 tests passed.

## Verification

- Focused visual suites: `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx src/views/ReservoirView.test.tsx` — 2 files, 39 tests passed.
- Workspace typecheck: `pnpm typecheck` — shared, worker, and web all passed.

## Files Changed

- `web/src/components/visual/VisualInspector.tsx`
- `web/src/components/visual/VisualAnalysisEditor.tsx`
- `web/src/components/visual/PdfCropPreview.tsx`
- `web/src/components/visual/VisualWorkspace.test.tsx`
- `web/src/components/visual/VisualAssetPanel.tsx`
- `web/src/views/ReservoirView.tsx`
- `web/src/views/ReservoirView.test.tsx`
- `web/src/styles/reading.css`

## Behavior Delivered

- Card click opens a dedicated inspector and shows the full stored analysis instead of the previous first-line preview only.
- `사용자 검증` and `AI 제안` are separated as tabs, and verified analysis is selected first when present.
- The editor keeps visual analysis in short list items, validates client-side before save, and preserves input with inline retry messaging on save failure.
- PDF `LINK_ONLY` assets render an in-memory crop preview from the parent PDF page and revoke generated object URLs on cleanup.
- Web `LINK_ONLY` assets avoid hotlinking and show caption, nearby text, and `원문에서 보기` instead.
- Failed processing states now show stage-oriented guidance and one retry action rather than surfacing raw technical details.
- Narrow screens use a sheet-style inspector and restore focus to the source card when closed.

## Limitations

- The mobile inspector is implemented as a sheet-style dialog via responsive component logic and CSS, but the tests validate behavior and focus restoration rather than visual animation specifics.
- The client-side validation mirrors the server schema inside the editor component rather than moving the schema into a newly shared module, to keep the change set inside the Task 7 boundary.

## Commit

- Pending commit
