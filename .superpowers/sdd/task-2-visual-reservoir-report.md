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

## Fix Follow-Up 2

Date: 2026-08-25
Reason: final Task 2 review findings

### Addressed Findings

- Private candidate URL detection now normalizes `URL.hostname` by removing IPv6 brackets before checking loopback, ULA, and link-local ranges, so bracketed hosts like `http://[fd00::1]/...` and `http://[fe80::1]/...` are rejected correctly.
- The reusable acquisition fast-path no longer re-enqueues visual extraction just because the reused version is active. It first checks whether a `visual_extraction_runs` row already exists for that source version. If a run already exists, enqueue is skipped; if no run exists, the enqueue retry still happens so earlier enqueue failures can recover.

### Additional RED/GREEN Cycle

RED:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Observed failures:

- bracketed IPv6 ULA and link-local candidate URLs were still accepted as candidates
- reusable active acquisition versions still re-enqueued visual extraction without checking prior extraction runs

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Passed: `64/64` tests

Additional regression coverage added for:

- `http://[fd00::1]/private.png` and `http://[fe80::1]/private.png` candidate rejection
- reusable active version with an existing `visual_extraction_runs` row does not enqueue again
- reusable active version with no existing extraction run still retries enqueue

## Fix Follow-Up 3

Date: 2026-08-25
Reason: latest Task 2 review findings

### Addressed Findings

- `isPrivateUrl` is now robust for IPv6 private-address detection. It strips brackets, expands IPv6 hextets, blocks the full `fe80::/10` link-local range (`fe80` through `febf`), blocks the full `fc00::/7` ULA range (`fc00` and `fd00` families), and recognizes IPv4-mapped IPv6 hosts such as `::ffff:127.0.0.1` by applying the existing IPv4 private-range rules.
- `collectSourceSetCandidates` no longer drops blocked `srcset` entries silently. It preserves deterministic rejection signals like `private_source_url` and `blocked_source_scheme` even when another public `srcset` candidate wins and remains the selected `sourceUrl`.

### Additional RED/GREEN Cycle

RED:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Observed failures:

- `fe90::1` and IPv4-mapped loopback candidate URLs were still accepted instead of being rejected as private
- blocked `srcset` entries were still disappearing instead of leaving deterministic provenance signals on the winning public candidate

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Passed: `66/66` tests

Additional regression coverage added for:

- `http://[fe90::1]/private.png` candidate rejection
- `http://[::ffff:127.0.0.1]/private.png` candidate rejection via IPv4-mapped IPv6 handling
- fixture-backed `picture srcset` case with a blocked private entry plus public entries, asserting the public candidate remains selected and carries `private_source_url`

## Fix Follow-Up 4

Date: 2026-08-25
Reason: remaining Task 2 reviewer issue

### Addressed Finding

- `inspectHtmlVisualCandidates` now removes `header`/`footer`/`nav`/`aside` fragments from the normal selected-content scope before the main `scanFragment` pass. Those container fragments are still scanned once for rejected outputs and keep their `container:<tag>` signals, but they are no longer scanned again as ordinary candidates when the selected fragment still contains them.

### Additional RED/GREEN Cycle

RED:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Observed failure:

- a neutral plain photo inside `<aside>` was still leaking into `candidates` when `inspectHtmlVisualCandidates` received a selected fragment that still contained the aside block

GREEN:

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/ingestion.test.ts
```

Passed: `67/67` tests

Additional regression coverage added for:

- fixture-backed selected-fragment case where the raw `<article>` still contains `<aside>`, asserting the neutral aside photo is rejected with `container:aside` and does not appear in `candidates`
