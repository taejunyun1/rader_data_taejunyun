# Task 2 Visual Reservoir Report

Date: 2026-08-25
Requested commit prefix: `260826`
Scope: deterministic HTML visual candidate extraction and source-acquisition enqueue behavior only

## Summary

Implemented Task 2 with a strict red-green cycle:

- Added fixture-driven tests first for selected HTML fragment exposure, deterministic HTML visual candidate extraction, rejection signals, and `VISUAL_EXTRACTION` enqueue gating.
- Confirmed RED before production changes.
- Implemented the minimum worker changes to expose the selected article/main fragment, extract deterministic HTML visual candidates from stored HTML, and enqueue `VISUAL_EXTRACTION` only when the acquired version becomes the active source version.
- Preserved the existing text extraction output and normalization behavior.
- Kept enqueue failure non-fatal to source acquisition and surfaced it as a warning in the acquisition job result.

## Files Changed

- `worker/src/ingestion/extractHtml.ts`
- `worker/src/workflows/sourceAcquisition.ts`
- `worker/src/visual/extraction/html.ts`
- `web/src/lib/ingestion.test.ts`
- `web/src/lib/remoteAcquisition.test.ts`
- `web/tests/fixtures/visual/article-with-figures.html`

## Requirement Coverage

- Added a fixture containing `figure/figcaption`, `picture/srcset`, relative URLs, duplicate query URLs, a tracker pixel, repeated logos, a social icon, and an ad.
- Added `selectedFragmentHtml` to `extractStaticHtml` without changing the existing normalized text behavior.
- Limited candidate parsing to `figure`, `picture/source`, and `img`, and resolved URLs against the final response URL.
- Rejected non-HTTP image sources and private-network targets at candidate normalization time.
- Recorded rejection signals for header/footer/nav/aside chrome, trackers, ads, decorative icons, and repeated logos.
- Preserved small contextual images as candidates by marking them with `review_small_context` instead of auto-dropping them.
- Enqueued `VISUAL_EXTRACTION` only after a successful acquisition produced the active source version.
- Kept source acquisition successful when the follow-up enqueue failed, and surfaced that failure as `visual_extraction_enqueue_failed:<message>` in the acquisition result warnings.
- Added a test that no visual extraction enqueue happens when the acquired version is not active.

## Verification

RED:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Observed failures:

- missing `selectedFragmentHtml`
- HTML visual extraction stub returned no candidates
- source acquisition did not enqueue `VISUAL_EXTRACTION`
- enqueue failure warning was not surfaced

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Passed: `56/56` tests

Typecheck:

```bash
pnpm typecheck
```

Passed for `shared`, `web`, and `worker`.

## Notes

- No automatic external image persistence was added.
- No feed-thumbnail scraping was added before source promotion.
- The existing unrelated `.superpowers/sdd/task-2-report.md` file was left untouched.

## Fix Follow-Up

Date: 2026-08-25
Reason: reviewer findings after the initial Task 2 delivery

### Addressed Findings

- `srcset` parsing now reads width and density descriptors, preserves every resolved `sourceSetUrls` entry for provenance, and picks the strongest usable `srcset` candidate as `sourceUrl`. `img src` is only used when no usable `srcset` entry exists.
- Tiny contextual visuals at `<=32x32` are no longer dropped solely for size. When they have figure context, caption, meaningful alt text, or meaningful nearby text, they stay in `candidates` with `review_small_context`.
- Added direct regression coverage for `data:`, `blob:`, `javascript:`, and private-network candidate URLs being rejected.

### Additional RED/GREEN Cycle

RED:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Observed failure:

- contextual `24x24` figure was still rejected instead of remaining a review candidate

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Passed: `60/60` tests

Additional regression coverage added for:

- thumbnail `img src` plus `800w/1600w` `srcset`, expecting the `1600w` candidate as `sourceUrl`
- contextual `24x24` figure remaining in candidates with `review_small_context`
- direct candidate rejection for `data:`, `blob:`, `javascript:`, and `127.0.0.1` URLs
