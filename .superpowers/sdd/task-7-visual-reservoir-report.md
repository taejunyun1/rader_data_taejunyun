# Task 7 Report — Visual Inspector and Reservoir Analysis Editing

## Status

Completed Task 7 review fixes only: the visual inspector, analysis editor, PDF crop preview, responsive desktop/mobile presentation, retry/error UX, Reservoir integration, LINK_ONLY analysis resolution, and shared validation contract. No Task 8+ extraction-status or assignment workflow was implemented.

## TDD Evidence

### RED

- Added `web/src/components/visual/VisualWorkspace.test.tsx` before production edits.
- Ran `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx`.
- Result: 6 failures, as expected. The existing panel exposed non-interactive cards, no inspector, no edit flow, no LINK_ONLY preview behavior, and no mobile close/focus restoration.
- Added a worker-backed LINK_ONLY route regression covering detail → ORIGINAL analysis → edit and the no-byte ORIGINAL content boundary; it failed before the route/store fix because the route required a CAPSULE.
- Added editor normalization coverage for the shared contract, including six-item context caps, invalid `visualKind` fallback, and confidence clamping.

### GREEN

- Rebuilt `VisualAssetPanel` around clickable cards, on-demand `/api/visual-assets/:id` detail loading, inspector state, and local summary syncing.
- Added `VisualInspector`, `VisualAnalysisEditor`, and `PdfCropPreview`.
- Wired Reservoir to keep its detail/unassigned visual lists coherent after inspector updates.
- Re-ran `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx`.
- Result: 1 file, 7 tests passed.
- Resolved detail, summary, edit, and analyzer version lookup to use CAPSULE when present and metadata-only ORIGINAL when LINK_ONLY analysis is attached there.
- Moved `validateVisualAnalysis` into the client-safe `shared` package; Worker and web now use the same caps, defaults, kind normalization, confidence normalization, and meaningful-content gate.
- Inspector now renders candidate context, rights review timestamp, relations, and extraction-run status/counts from the existing detail DTO.

## Verification

- Focused visual suites: `pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx src/lib/visualAssets.test.tsx src/views/ReservoirView.test.tsx` — 3 files, 76 tests passed.
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
- `web/src/lib/visualAssets.test.ts`
- `shared/src/visualAnalysis.ts`
- `shared/src/index.ts`
- `shared/package.json`
- `worker/src/visual/analysisSchema.ts`
- `worker/src/visual/store.ts`
- `worker/src/visual/analyzer.ts`
- `worker/src/routes/visualAssets.ts`

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
- LINK_ONLY analyses remain ephemeral: the fetched source image/crop is sent through analysis in memory, while the ORIGINAL row keeps metadata and `r2_key = NULL`; content reads therefore remain unavailable and web inspectors never hotlink the image.
- The shared contract is intentionally side-effect-free and contains validation/normalization only; Worker prompt text remains Worker-owned.

## Commit

- `260826: Task 7 LINK_ONLY analysis and validation alignment`
