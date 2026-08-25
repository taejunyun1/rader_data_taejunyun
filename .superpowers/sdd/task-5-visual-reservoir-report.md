# Task 5 Visual Reservoir Report

Date: 2026-08-26

## Scope Delivered

- Replaced the `VISUAL_EXTRACTION` workflow blocker with real runtime dispatch in `worker/src/workflows/researchJob.ts`.
- Added a shared visual extraction runner in `worker/src/visual/extraction/run.ts` that branches HTML vs PDF source versions and returns run-level counts plus diagnostics.
- Added PDF candidate parsing and page-local prompt construction in `worker/src/visual/extraction/pdf.ts`.
- Added a bytes-first analysis boundary in `worker/src/visual/analyzer.ts` so LINK_ONLY assets can persist analysis without requiring a Capsule version.
- Added a shared normalized-bbox crop boundary in `worker/src/visual/transform.ts`; PDF vision analysis and permitted/personal persistence now receive only the crop bytes.
- Routed PDF crop hashes through the same visual filter as HTML, including exact/near duplicate decisions, `DUPLICATE_OF` relations, persisted dHash metadata, and per-unit continuation/counts.
- Extended LINK_ONLY draft support for PDF page metadata (`pageNumber`, `bboxJson`) in `worker/src/visual/extraction/filter.ts`.
- Extended `ResearchJobResultRef` in `shared/src/discovery.ts` so visual extraction jobs can point to a source/run result instead of only a single visual asset.
- Added focused regression coverage in `web/src/lib/visualAssets.test.ts` and `web/src/lib/deepAnalysis.test.ts`.

## Files Changed

- `shared/src/discovery.ts`
- `web/src/lib/deepAnalysis.test.ts`
- `web/src/lib/visualAssets.test.ts`
- `worker/src/visual/analyzer.ts`
- `worker/src/visual/extraction/filter.ts`
- `worker/src/visual/extraction/pdf.ts`
- `worker/src/visual/extraction/run.ts`
- `worker/src/visual/transform.ts`
- `worker/src/workflows/researchJob.ts`

## Verification

- `pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/lib/deepAnalysis.test.ts` — 40 tests passed
- `pnpm typecheck`

Both commands passed on 2026-08-26 after the reviewer-fix code changes.

## Limitations

- The full uploaded PDF page remains only as the temporary extraction unit input while candidate detection runs; crop bytes are produced in memory, and the unit temp object is deleted after processing.
- PDF page-local prompt context is bounded to page markers and figure/caption lines when present; if page markers are absent, the runner falls back to a full-page candidate instead of reconstructing richer page text.
- HTML extraction persists external-image analysis as LINK_ONLY with ephemeral bytes and no permanent Capsule, but it does not yet persist richer per-candidate fetch diagnostics beyond the run/job result.

## Exclusions

- `.superpowers/sdd/task-2-report.md` was pre-existing user-modified work and was intentionally left untouched and must remain out of the Task 5 commit.
