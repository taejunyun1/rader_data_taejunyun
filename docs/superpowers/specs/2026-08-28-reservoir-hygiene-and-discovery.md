# Reservoir hygiene, duplicate consolidation, and discovery variety

## Goal

Prevent repeat imports from creating duplicate logical sources, give the user a safe repository refresh workflow, correctly explain deep-analysis blocking states, and rotate source-backed discovery keyword suggestions.

## Binding decisions

- Preserve every existing `sources` row, `source_versions` row, R2 object, and provenance record. A merge is logical and reversible; it is never a deletion.
- Use deterministic metadata and text signals only. Do not add embeddings, semantic search, a chatbot, an admin system, or a new model dependency.
- Use the same matching evaluator for new ingestion and repository refresh.
- Automatically merge only an exact identity match or a title match with supporting evidence. Ambiguous candidates require explicit review.
- Normalize Obsidian worktree origins by removing `.worktrees/<name>/` before comparison. A changed file at the same normalized origin is a new version of the same logical source.
- A conflicting nonempty DOI is a hard non-match unless raw or normalized text hashes are equal.
- Repository refresh runs asynchronously in bounded batches and produces a preview before it changes merge state. It must not delete or hide a source automatically.
- `FULLTEXT + REVIEW` means the original exists but quality requires attention. It must not offer the misleading acquisition-only CTA.
- Discovery recommendations remain source-backed. They must expose up to eight diversified candidates per lane, show a reason, and support a client-side “new suggestions” rotation without changing saved settings.
- Do not deploy Workers or run remote D1 migrations as part of this work.

## Matching contract

`evaluateDuplicate(left, right)` returns one of `AUTO_MERGE`, `REVIEW`, or `SEPARATE` with machine-readable reasons.

| Condition | Result |
| --- | --- |
| same normalized DOI, URL, raw hash, normalized text hash, or normalized Obsidian origin | `AUTO_MERGE` |
| title Dice similarity >= 0.96 and one of normalized first author, exact year, or canonical URL host agrees | `AUTO_MERGE` |
| exact title without a support signal, or title Dice similarity in [0.85, 0.96) | `REVIEW` |
| conflicting nonempty DOI, or title Dice similarity < 0.85 | `SEPARATE` |

The canonical member is selected by highest count of user decisions and thread links, then `READY + FULLTEXT`, then longest active normalized text, then oldest creation timestamp.

## Logical merge data

- `source_merge_groups`: immutable merge event metadata with `canonical_source_id`, `mode`, confidence, reasons, and optional reversal timestamp.
- `source_merge_members`: one canonical member and one or more member sources per active group.
- `source_duplicate_candidates`: reviewable source pairs with deterministic score/reasons and `PENDING`, `MERGED`, or `SEPARATE` status.
- `reservoir_refresh_runs`: lifecycle, cursor, counters, preview/apply mode, and error for a bounded asynchronous refresh.

The canonical detail payload includes member count and origin/version summaries. Standard source lists hide noncanonical merged members. Direct navigation to a member resolves to its canonical source. Reversing a merge only deactivates its group and restores the member to ordinary listing; no R2 or source row is removed.

## Repository refresh

1. User starts a preview from Settings > Repository maintenance.
2. The job scans active sources in fixed batches, updates matching fingerprints, groups candidates, and stores counts plus review candidates.
3. The preview reports exact/high-confidence merge count, review count, and quality/noise findings without activating any merge.
4. User applies the preview. The job creates groups for high-confidence pairs, records audit reasons, and leaves ambiguous pairs in review.
5. The completion report links to the duplicate review queue. Retagging is a separate existing action; refresh may request it but does not run AI work implicitly.

## Quality-state UX

Deep-analysis action is selected by explicit reason:

- no or metadata-only text and canonical URL: `원문 다시 가져오기`;
- no or metadata-only text without URL: disabled `원문 수집 필요`;
- full text with `REVIEW`: `품질 다시 검사` and an explanation based on the normalization warning;
- full text below deep-analysis length: disabled length guidance;
- ready full text: `심층 정리하기`.

The `품질 다시 검사` action reuses the existing extraction/reanalysis pathway only when it can improve the active source. It must not pretend to fetch a nonexistent remote URL for a local Obsidian source.

## Discovery variety

Recommendation construction must retain the best source-backed recommendation per normalized keyword, then choose candidates round-robin across `SAVED`, `MOMENTUM`, `DISTILL`, `RESEARCH_GAP`, `UNDERREPRESENTED`, and `COUNTER` categories. The UI displays four at a time, retains up to eight per lane, and rotates through unseen entries when the user presses `새 추천 보기`.

