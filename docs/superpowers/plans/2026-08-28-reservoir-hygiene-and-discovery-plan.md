# Reservoir Hygiene and Discovery Variety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, deterministic duplicate consolidation and previewable repository refresh, correct deep-analysis quality messaging, and rotate diversified discovery suggestions without a deployment.

**Architecture:** A pure worker matching module supplies normalized fingerprints and a three-state decision to both ingestion and refresh. D1 stores reversible logical merge groups and review candidates rather than deleting sources. The React UI adds an accurate deep-analysis quality action, repository maintenance workflow, and rotating recommendation chips.

**Tech Stack:** TypeScript, Cloudflare Workers/Hono, D1, R2, React 19, Vite, Vitest.

## Global Constraints

- Preserve source rows, versions, R2 originals, and provenance; merging is logical and reversible.
- Do not use embeddings, semantic search, AI models, or additional dependencies.
- Strong identities are DOI, normalized URL, raw hash, normalized text hash, and normalized Obsidian origin.
- Auto-merge only a strong identity or title Dice similarity `>= 0.96` with an author/year/host support signal; `0.85–<0.96` is review-only.
- Nonempty conflicting DOI is a hard non-match unless raw or normalized text hashes match.
- Refresh preview does not create active merge groups; apply creates groups only for high-confidence matches.
- Do not run `wrangler deploy`, `pnpm deploy`, or a remote D1 migration.

---

### Task 1: Fix deep-analysis blocked-action classification

**Files:**
- Modify: `web/src/views/ReservoirView.tsx`
- Modify: `web/src/views/ReservoirView.test.tsx`

**Interfaces:**
- Produces a local `deepBlockedAction` derived from `detail.acquisition.textScope`, `qualityStatus`, `charCount`, and `canonicalUrl`.
- `FULLTEXT + REVIEW` renders a non-acquisition quality message and never calls `refetch()` merely because it is blocked.

- [ ] **Step 1: Write a failing UI test for full text under review**

```ts
it("shows a quality recheck action instead of acquisition for FULLTEXT REVIEW", async () => {
  mockDetail({ acquisition: { textScope: "FULLTEXT", qualityStatus: "REVIEW", charCount: 3790, canDeepAnalyze: false, originalTextUrl: null } });
  render(<ReservoirView {...props} />);
  expect(await screen.findByRole("button", { name: "품질 다시 검사" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "원문 수집 필요" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Verify the test is red**

Run: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx`

Expected: FAIL because the existing action is `원문 수집 필요`.

- [ ] **Step 3: Implement the smallest explicit action classifier**

```ts
const reviewBlocked = acquisition?.textScope === "FULLTEXT" && acquisition?.qualityStatus === "REVIEW";
const deepActionLabel = reviewBlocked ? "품질 다시 검사" : acquisitionDeepBlocked ? canonicalUrl ? "원문 다시 가져오기" : "원문 수집 필요" : "심층 정리하기";
```

Call the existing reanalysis route only for `reviewBlocked`; retain `refetch()` only for acquisition-blocked sources with a canonical URL.

- [ ] **Step 4: Verify green and commit**

Run: `pnpm --filter @radar/web exec vitest run src/views/ReservoirView.test.tsx`

Expected: PASS.

Commit: `git add web/src/views/ReservoirView.tsx web/src/views/ReservoirView.test.tsx && git commit -m "260828: 심층 정리 품질 검토 CTA 분리"`

### Task 2: Add origin-aware duplicate fingerprinting to ingestion

**Files:**
- Modify: `worker/src/ingestion/normalize.ts`
- Modify: `worker/src/ingestion/dedup.ts`
- Modify: `worker/src/ingestion/dedup.test.ts`
- Modify: `worker/src/ingestion/store.ts`
- Modify: `worker/src/ingestion/store.test.ts`

**Interfaces:**
- Produces `normalizeOriginIdentity(origin: string): string | null`.
- Extends `DedupInput` with `origin` and `normalizedContentHash` and `DedupMatch.field` with `origin` and `normalized_content_hash`.

- [ ] **Step 1: Write red unit tests**

```ts
expect(normalizeOriginIdentity("obsidian:.worktrees/paper-faithful-deck/10_PROJECTS/a.md")).toBe("obsidian:10_PROJECTS/a.md");
expect(await findDuplicate(db, { origin: "obsidian:.worktrees/branch/10_PROJECTS/a.md" })).toEqual({ sourceId: "source-1", field: "origin" });
```

Add a store test proving same normalized origin with changed bytes appends version 2 to the original source.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/ingestion/dedup.test.ts src/ingestion/store.test.ts`

Expected: FAIL because origin identity is not present.

- [ ] **Step 3: Implement minimal identity lookup**

Create `source_fingerprints` in Task 3’s migration only after Task 3 lands; until then use normalized-origin fallback query against `sources.origin`. Pass the origin from `createSource()` to `findDuplicate()` and preserve changed bytes through `appendReimportedVersion()`.

- [ ] **Step 4: Verify green and commit**

Run the Task 2 command again. Expected: PASS.

Commit: `git add worker/src/ingestion && git commit -m "260828: Obsidian 경로 기반 중복 수집 방지"`

### Task 3: Persist reversible merge groups and duplicate candidates

**Files:**
- Create: `worker/migrations/0025_reservoir_hygiene.sql`
- Create: `worker/src/ingestion/matching.ts`
- Create: `worker/src/ingestion/matching.test.ts`
- Create: `worker/src/reservoir/mergeGroups.ts`
- Create: `worker/src/reservoir/mergeGroups.test.ts`

**Interfaces:**

```ts
export type DuplicateDecision = "AUTO_MERGE" | "REVIEW" | "SEPARATE";
export function evaluateDuplicate(left: SourceMatchInput, right: SourceMatchInput): DuplicateAssessment;
export async function createLogicalMerge(db: D1Database, input: LogicalMergeInput): Promise<string>;
export async function resolveCanonicalSourceId(db: D1Database, sourceId: string): Promise<string>;
```

- [ ] **Step 1: Write red matching and persistence tests**

```ts
expect(evaluateDuplicate({ doi: "10.1/a" }, { doi: "10.1/a" }).decision).toBe("AUTO_MERGE");
expect(evaluateDuplicate({ title: "Densecap Deepdream" }, { title: "Densecap: Deepdream" }).decision).toBe("REVIEW");
expect(evaluateDuplicate({ doi: "10.1/a" }, { doi: "10.1/b" }).decision).toBe("SEPARATE");
```

Add a D1 test that creates a group, resolves a member to its canonical source, and reverses the group without deleting either source.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/ingestion/matching.test.ts src/reservoir/mergeGroups.test.ts`

Expected: FAIL because the module and tables do not exist.

- [ ] **Step 3: Add migration and minimal services**

The migration creates `source_merge_groups`, `source_merge_members`, `source_duplicate_candidates`, `source_fingerprints`, and `reservoir_refresh_runs`, with indexes on active group membership, candidate status, fingerprint kind/value, and refresh status. The service stores JSON reason codes and changes only group state when reversed.

- [ ] **Step 4: Verify green and commit**

Run the Task 3 command and `pnpm --filter @radar/worker run typecheck`. Expected: PASS.

Commit: `git add worker/migrations/0025_reservoir_hygiene.sql worker/src/ingestion/matching* worker/src/reservoir/mergeGroups* && git commit -m "260828: 저장소 논리 병합과 중복 후보 보존"`

### Task 4: Add previewable reservoir-refresh worker API

**Files:**
- Create: `worker/src/reservoir/refresh.ts`
- Create: `worker/src/reservoir/refresh.test.ts`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `worker/src/routes/reservoir.test.ts`

**Interfaces:**

```ts
POST /api/reservoir/refresh { mode: "PREVIEW" | "APPLY" }
GET /api/reservoir/refresh/:runId
GET /api/reservoir/duplicates?status=PENDING
POST /api/reservoir/duplicates/:candidateId { action: "MERGE" | "SEPARATE" }
```

- [ ] **Step 1: Write red route tests**

```ts
expect((await app.request("/api/reservoir/refresh", { method: "POST", body: JSON.stringify({ mode: "PREVIEW" }) })).status).toBe(202);
expect(await activeMergeCount(db)).toBe(0);
```

Add an apply test proving only `AUTO_MERGE` assessments create groups and a review-action test proving `SEPARATE` keeps both sources visible.

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.route.config.ts src/routes/reservoir.test.ts`

Expected: FAIL with 404 or missing handler.

- [ ] **Step 3: Implement bounded refresh**

Scan sources by ID in batches of 50. Store a run record and candidate/reason summaries. Preview stops after candidate creation; apply creates logical groups only for auto decisions. Do not call AI, delete R2, or change source quality states.

- [ ] **Step 4: Verify green and commit**

Run the Task 4 command and `pnpm --filter @radar/worker run typecheck`. Expected: PASS.

Commit: `git add worker/src/reservoir/refresh* worker/src/routes/reservoir* && git commit -m "260828: 저장소 리프레시 미리보기와 병합 검토"`

### Task 5: Expose repository refresh and duplicate review in Settings

**Files:**
- Modify: `web/src/views/SettingsView.tsx`
- Modify: `web/src/views/SettingsView.test.tsx`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Settings posts `PREVIEW`, renders its exact/needs-review counts, and enables `정리 적용` only after a preview.
- Settings renders pending candidates with `병합` and `별도 유지` actions.

- [ ] **Step 1: Write red UI test**

```ts
await userEvent.click(screen.getByRole("button", { name: "저장소 점검 미리보기" }));
expect(await screen.findByText("자동 병합 3건 · 검토 2건")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "정리 적용" })).toBeEnabled();
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @radar/web exec vitest run src/views/SettingsView.test.tsx`

Expected: FAIL because repository maintenance controls do not exist.

- [ ] **Step 3: Implement only the preview/apply/review controls**

Use existing Settings busy/status patterns. Copy must state that originals are retained and preview changes no merge state.

- [ ] **Step 4: Verify green and commit**

Run the Task 5 command and `pnpm --filter @radar/web run typecheck`. Expected: PASS.

Commit: `git add web/src/views/SettingsView.tsx web/src/views/SettingsView.test.tsx web/src/styles/views.css && git commit -m "260828: 저장소 정리 미리보기와 중복 검토 화면"`

### Task 6: Diversify and rotate source-backed discovery recommendations

**Files:**
- Modify: `worker/src/discovery/recommendations.ts`
- Modify: `worker/src/discovery/recommendations.test.ts`
- Modify: `web/src/components/discovery/DiscoveryDirectionPanel.tsx`
- Create: `web/src/components/discovery/DiscoveryDirectionPanel.test.tsx`

**Interfaces:**

```ts
export function diversifyRecommendations(items: CandidateRecommendation[], selected: string[]): DiscoveryKeywordRecommendation[];
```

- [ ] **Step 1: Write red worker and UI tests**

```ts
expect(diversifyRecommendations(items, []).slice(0, 4).map(({ source }) => source)).toEqual(["SAVED", "MOMENTUM", "DISTILL", "RESEARCH_GAP"]);
await userEvent.click(screen.getByRole("button", { name: "새 추천 보기" }));
expect(screen.getByText("다른 키워드")).toBeInTheDocument();
```

- [ ] **Step 2: Verify red**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/discovery/recommendations.test.ts && pnpm --filter @radar/web exec vitest run src/components/discovery/DiscoveryDirectionPanel.test.tsx`

Expected: FAIL because recommendations are score-only and the rotate control does not exist.

- [ ] **Step 3: Implement round-robin diversity and local rotation**

Keep the best candidate per normalized keyword, group by source category, then emit up to eight by round-robin category order. The panel maintains an offset per lane and displays four chips; `새 추천 보기` advances by four modulo candidate count. Chip `title` retains the recommendation reason.

- [ ] **Step 4: Verify green and commit**

Run the Task 6 command and `pnpm typecheck`. Expected: PASS.

Commit: `git add worker/src/discovery/recommendations* web/src/components/discovery/DiscoveryDirectionPanel* && git commit -m "260828: 발견 키워드 다양화와 추천 순환"`

### Task 7: Run non-production verification and document behavior

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/PROJECT_CONTEXT.md`

- [ ] **Step 1: Add source-of-truth contracts**

Document reversible logical merges, the deterministic auto/review thresholds, preview-before-apply refresh, and the `FULLTEXT + REVIEW` quality CTA distinction.

- [ ] **Step 2: Verify focused behavior**

Run: `pnpm typecheck && pnpm test:workers && pnpm test:unit && pnpm build`

Expected: all commands pass; no Wrangler deploy or `--remote` D1 command is run.

- [ ] **Step 3: Commit**

Commit: `git add docs/SPEC.md docs/PROJECT_CONTEXT.md && git commit -m "260828: 저장소 정리와 추천 다양화 운영 계약"`

