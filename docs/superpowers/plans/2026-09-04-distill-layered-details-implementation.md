# Distill Layered Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current compact Distill summary while adding expandable, source-linked research detail inside Radar only.

**Architecture:** Add an optional typed `details` layer to the existing Distill JSON, sanitize it against the summary arrays and the current Distill source allowlist before persistence, and render it through one reusable disclosure component. Existing summary fields remain the only input to homepage publication; markdown export includes both layers.

**Tech Stack:** pnpm workspaces, TypeScript, Cloudflare Workers/Hono/D1, React/Vite, Vitest/Testing Library.

## Global Constraints

- Radar displays summary first and details only on user expansion.
- Homepage preview and publication continue to use only the existing summary fields and limits.
- Existing Distill sessions without `details` render unchanged.
- Generate summary and details in one Distill call; do not add a detail-only AI call or user setting.
- Store originals and provenance unchanged; every generated detail is `SYNTHESIS`, not a source quotation.
- Keep the existing `$10` monthly guardrail, 80% warning, and 100% Distill block.
- Do not add a D1 migration.
- Use `distill-v3-layered` as the new default prompt variant; do not hardcode a model name.

---

### Task 1: Shared Distill Contract and Worker Sanitizer

**Files:**
- Create: `shared/src/distill.ts`
- Modify: `shared/src/index.ts`
- Modify: `shared/package.json`
- Modify: `worker/src/distill/prompts.ts`
- Modify: `worker/src/distill/outputSchema.ts`
- Test: `worker/src/distill/outputSchema.test.ts`

**Interfaces:**
- Produces: `DistillOutput`, `DistillDetails`, and detail item interfaces exported from `@radar/shared`.
- Produces: `sanitizeDistillDetails(output: DistillOutput, allowedSourceIds: ReadonlySet<string>): DistillOutput`.
- Preserves: `parseDistillOutput(value: unknown): DistillOutput | null` accepts legacy output without `details`.

- [ ] **Step 1: Add failing parser and sanitizer tests**

Add cases that assert:

```ts
const layered = {
  ...validDistill,
  details: {
    thoughts: [{ summaryIndex: 0, rationale: "판단 이유", sourceIds: ["source-1", "unknown"], uncertainty: "불확실", nextCheck: "확인" }],
    questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
  },
};

expect(parseDistillOutput(layered)).toEqual(layered);
expect(sanitizeDistillDetails(parseDistillOutput(layered)!, new Set(["source-1"])).details?.thoughts[0]?.sourceIds).toEqual(["source-1"]);
expect(sanitizeDistillDetails({ ...layered, details: { ...layered.details, thoughts: [
  layered.details.thoughts[0],
  { ...layered.details.thoughts[0], rationale: "duplicate" },
] } }, new Set(["source-1"])).details?.thoughts).toHaveLength(1);
expect(parseDistillOutput(validDistill)).toEqual(validDistill);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/outputSchema.test.ts`

Expected: FAIL because `details` is rejected by the strict allowlist and `sanitizeDistillDetails` does not exist.

- [ ] **Step 3: Add the shared contract**

Create `shared/src/distill.ts` with the exact optional detail structure approved in the design:

```ts
export interface DistillThoughtDetail { summaryIndex: number; rationale: string; sourceIds: string[]; uncertainty: string; nextCheck: string; }
export interface DistillQuestionDetail { summaryIndex: number; whyNow: string; method: string; evidenceNeeded: string; sourceIds: string[]; }
export interface DistillResearchGapDetail { summaryIndex: number; diagnosis: string; researchMethod: string; sourceIds: string[]; }
export interface DistillResearchDirectionDetail { summaryIndex: number; rationale: string; method: string; expectedOutcome: string; sourceIds: string[]; }
export interface DistillArtworkDirectionDetail { summaryIndex: number; rationale: string; materials: string[]; procedure: string; observation: string; sourceIds: string[]; }

export interface DistillDetails {
  thoughts: DistillThoughtDetail[];
  questions: DistillQuestionDetail[];
  researchGaps: DistillResearchGapDetail[];
  researchDirections: DistillResearchDirectionDetail[];
  artworkDirections: DistillArtworkDirectionDetail[];
}

export interface DistillOutput {
  keywords: string[];
  thoughts_fragments: string[];
  questions: string[];
  read_next: { title: string; author?: string; why_read: string; related_question?: string }[];
  research_gaps: { gap: string; kind: string }[];
  research_directions: string[];
  artwork_directions: string[];
  small_experiment?: string;
  details?: DistillDetails;
}
```

Export it from `shared/src/index.ts` and add `"./distill": "./src/distill.ts"` to `shared/package.json`. Replace the duplicate worker interface with an import/re-export from `@radar/shared`.

- [ ] **Step 4: Implement strict detail parsing and allowlist sanitization**

Extend the top-level allowed keys with `details`. Validate exact keys and string fields for every detail kind. Implement a shared internal sanitizer that:

```ts
function sanitizeItems<T extends { summaryIndex: number; sourceIds: string[] }>(
  items: T[], summaryCount: number, allowedSourceIds: ReadonlySet<string>
): T[] {
  const seen = new Set<number>();
  return items.flatMap((item) => {
    if (!Number.isInteger(item.summaryIndex) || item.summaryIndex < 0 || item.summaryIndex >= summaryCount || seen.has(item.summaryIndex)) return [];
    seen.add(item.summaryIndex);
    return [{ ...item, sourceIds: [...new Set(item.sourceIds.filter((id) => allowedSourceIds.has(id)))].slice(0, 3) }];
  });
}
```

Drop invalid detail items without rejecting a valid summary. If every detail array is empty, omit `details` from the returned output.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/outputSchema.test.ts`

Expected: PASS.

Run: `pnpm --filter @radar/shared typecheck && pnpm --filter @radar/worker typecheck`

Expected: both commands exit 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add shared/src/distill.ts shared/src/index.ts shared/package.json worker/src/distill/prompts.ts worker/src/distill/outputSchema.ts worker/src/distill/outputSchema.test.ts
git commit -m "260904: 착즙 상세층 공통 계약과 검증 추가"
```

---

### Task 2: Layered Prompt, Persistence, and Critic Input

**Files:**
- Modify: `worker/src/distill/prompts.ts`
- Modify: `worker/src/distill/run.ts`
- Create: `worker/src/distill/prompts.test.ts`
- Create: `worker/src/distill/run.test.ts`
- Modify: `worker/vitest.config.ts`

**Interfaces:**
- Consumes: `DistillOutput` and `sanitizeDistillDetails` from Task 1.
- Produces: prompt variant `distill-v3-layered` as `DEFAULT_PROMPT_VARIANT`.
- Persists: only sanitized detail objects and source IDs from `ctx.sources`.

- [ ] **Step 1: Add failing prompt tests**

Assert that the default prompt:

```ts
expect(DEFAULT_PROMPT_VARIANT).toBe("distill-v3-layered");
expect(distillPrompt(context, "distill-v3-layered")).toContain('"details"');
expect(distillPrompt(context, "distill-v3-layered")).toContain("summaryIndex");
expect(distillPrompt(context, "distill-v3-layered")).toContain("SOURCE ID allowlist");
expect(distillPrompt(context, "distill-v3-layered")).toContain("SYNTHESIS");
```

Add a run test whose mocked model returns one known and one unknown `sourceIds` entry, then assert the stored `output_json` contains only the known ID and the critic request contains the sanitized details.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/prompts.test.ts src/distill/run.test.ts`

Expected: FAIL because the v3 variant and sanitization step are absent.

- [ ] **Step 3: Add `distill-v3-layered` prompt rules**

Extend `PromptVariant` and `PROMPT_VARIANTS`, make v3 the default, retain v1/v2 for old explicit requests, and request the exact `details` JSON contract. Include these constraints:

```text
- Detail prose is SYNTHESIS, never a quotation.
- sourceIds must come only from the SOURCE ID allowlist in the prompt; maximum 3 per item.
- thoughts: rationale 2-4 sentences; uncertainty and nextCheck 1-2 sentences each.
- questions: explain whyNow, method, and evidenceNeeded.
- researchGaps: explain diagnosis and researchMethod.
- researchDirections: explain rationale, method, and expectedOutcome.
- artworkDirections: explain rationale, materials, procedure, and observation.
- summaryIndex is zero-based and must point to the matching summary array.
```

Render every source heading as `[SOURCE ID: ${s.id}]` so the model has an explicit allowlist.

- [ ] **Step 4: Sanitize before Critic and persistence**

After base parsing, call:

```ts
const distill = sanitizeDistillDetails(parsed, new Set(ctx.sources.map((source) => source.id)));
```

Use this sanitized object for Critic, Counter, queue/gap indexing, D1 persistence, and the returned `distillOutput`. Increase only the primary Distill call `maxOutputTokens` from `4000` to `6500`.

- [ ] **Step 5: Run focused and regression tests**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/prompts.test.ts src/distill/run.test.ts src/distill/outputSchema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add worker/src/distill/prompts.ts worker/src/distill/run.ts worker/src/distill/prompts.test.ts worker/src/distill/run.test.ts worker/vitest.config.ts
git commit -m "260904: 착즙 v3 상세 생성과 근거 정제 연결"
```

---

### Task 3: Session API Detail Sources and Markdown Export

**Files:**
- Modify: `worker/src/routes/distill.ts`
- Create: `worker/test/distillLayeredRoutes.test.ts`
- Modify: `worker/vitest.config.ts`

**Interfaces:**
- Produces in session detail response: `detailSources: Array<{ id: string; title: string; available: boolean }>`.
- Consumes: stored `DistillOutput.details`.
- Produces: markdown with nested detail metadata; no homepage payload changes.

- [ ] **Step 1: Add failing route tests**

Create a layered session fixture with one active and one missing detail source. Assert:

```ts
expect(body.detailSources).toEqual([
  { id: "active-source", title: "현재 자료", available: true },
  { id: "deleted-source", title: "삭제된 자료", available: false },
]);
```

For markdown, assert the output includes `### 근거와 맥락`, `판단 이유`, `연결 자료`, `남은 불확실성`, and `다음 확인`, while a legacy fixture remains unchanged.

- [ ] **Step 2: Run route tests and confirm RED**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts test/distillLayeredRoutes.test.ts`

Expected: FAIL because `detailSources` and layered markdown are absent.

- [ ] **Step 3: Resolve detail source display metadata**

Collect unique IDs from every detail array. Use stored `sources_used_json` titles as the fallback snapshot, query current `sources` rows in one bounded batch, and return entries in first-use order. Mark an ID `available: true` only when the current row exists. Do not expose summaries, fragments, or private source contents.

- [ ] **Step 4: Add layered markdown rendering**

Parse the stored output through `parseDistillOutput`. For each summary array, locate the matching detail by `summaryIndex` and print its fields directly below the summary. Render source titles from `sources_used_json`; never emit raw internal IDs as the visible label. Preserve the existing sections for sessions without details.

- [ ] **Step 5: Run route tests**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts test/distillLayeredRoutes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add worker/src/routes/distill.ts worker/test/distillLayeredRoutes.test.ts worker/vitest.config.ts
git commit -m "260904: 착즙 상세 근거 API와 마크다운 확장"
```

---

### Task 4: Expandable Radar Detail UI

**Files:**
- Create: `web/src/components/distill/DistillDetailDisclosure.tsx`
- Create: `web/src/components/distill/DistillDetailDisclosure.test.tsx`
- Create: `web/src/lib/distillDetails.ts`
- Create: `web/src/lib/distillDetails.test.ts`
- Modify: `web/src/views/DistillView.tsx`
- Modify: `web/src/views/DistillView.test.tsx`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes: `DistillOutput` from `@radar/shared` and `detailSources` from Task 3.
- Produces: `detailAt<T extends { summaryIndex: number }>(items: T[] | undefined, index: number): T | null`.
- Produces: accessible `DistillDetailDisclosure` with `label`, `children`, and deterministic `id` props.

- [ ] **Step 1: Add failing helper and component tests**

Assert exact-index lookup and missing-detail behavior. Render the component and assert:

```tsx
expect(screen.getByRole("button", { name: "근거와 맥락 보기" })).toHaveAttribute("aria-expanded", "false");
await user.click(screen.getByRole("button", { name: "근거와 맥락 보기" }));
expect(screen.getByRole("button", { name: "근거와 맥락 접기" })).toHaveAttribute("aria-expanded", "true");
expect(screen.getByText("판단 이유")).toBeVisible();
```

Add view cases for a legacy session without buttons, a layered session with active source link and missing-source notice, and a session switch resetting disclosures.

- [ ] **Step 2: Run focused web tests and confirm RED**

Run: `pnpm --filter @radar/web exec vitest run src/lib/distillDetails.test.ts src/components/distill/DistillDetailDisclosure.test.tsx src/views/DistillView.test.tsx`

Expected: FAIL because the helper and component do not exist.

- [ ] **Step 3: Implement the disclosure component and view-model helper**

Use a native button with:

```tsx
<button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
  {open ? closeLabel : openLabel}
</button>
```

The panel renders only when open. Resolve each `sourceId` against the `detailSources` response; available sources link to the existing Reservoir source detail route, unavailable sources show `연결 자료를 현재 저장소에서 찾을 수 없습니다.`.

- [ ] **Step 4: Integrate details into the five approved sections**

Replace the local `DistillOutput` interface with the shared type. Wrap each thought, question, research gap, research direction, and artwork direction with the matching disclosure. Use these labels exactly:

```text
근거와 맥락 보기
왜 중요한지 보기
진단과 조사 방법 보기
방법과 예상 결과 보기
재료와 실행 과정 보기
```

Key disclosure state by `${sessionId}:${kind}:${summaryIndex}` or remount the detail document by session ID so switching sessions resets all items. Do not add persistence or network calls on expand.

- [ ] **Step 5: Add responsive styles**

Add focused `.distill-detail-*` rules: pale violet rationale panel, two-column uncertainty/action blocks above 760px, one column below 760px, visible keyboard focus, and existing typography variables. Do not change unrelated layout or homepage styles.

- [ ] **Step 6: Run focused web tests and build**

Run: `pnpm --filter @radar/web exec vitest run src/lib/distillDetails.test.ts src/components/distill/DistillDetailDisclosure.test.tsx src/views/DistillView.test.tsx`

Expected: PASS.

Run: `pnpm --filter @radar/web run build`

Expected: TypeScript and Vite build exit 0.

- [ ] **Step 7: Commit Task 4**

```bash
git add web/src/components/distill/DistillDetailDisclosure.tsx web/src/components/distill/DistillDetailDisclosure.test.tsx web/src/lib/distillDetails.ts web/src/lib/distillDetails.test.ts web/src/views/DistillView.tsx web/src/views/DistillView.test.tsx web/src/styles/views.css
git commit -m "260904: 착즙 요약과 상세 펼침 화면 구현"
```

---

### Task 5: Publication Isolation, Full Verification, Documentation, and Deployment

**Files:**
- Modify: `worker/src/publication/projection.test.ts`
- Modify: `web/src/views/DistillView.test.tsx`
- Modify: `docs/PROJECT_CONTEXT.md`

**Interfaces:**
- Verifies: `buildHomepageProjection` ignores `DistillOutput.details`.
- Verifies: homepage content hash and published schema are unchanged when only details differ.
- Documents: deployed Worker version and layered-detail behavior.

- [ ] **Step 1: Add publication isolation regressions**

Build two otherwise identical outputs, one with `details` and one without. Assert:

```ts
expect(withDetails.content).toEqual(withoutDetails.content);
expect(withDetails.contentHash).toBe(withoutDetails.contentHash);
expect(JSON.stringify(withDetails.content)).not.toContain("details");
```

In `DistillView.test.tsx`, provide a layered Distill session, open the homepage preview, scope assertions to the dialog, and confirm that only the preview response's existing public summary fields render there.

- [ ] **Step 2: Run publication tests and confirm behavior**

Run: `pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/projection.test.ts`

Run: `pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx`

Expected: PASS with no public contract changes.

- [ ] **Step 3: Run the full repository verification**

Run: `pnpm verify`

Expected: all typechecks, Worker tests, Web tests, and production builds pass with zero failures.

- [ ] **Step 4: Perform browser acceptance checks without publishing**

In the latest generated layered session verify:

```text
1. Summary text is visible before expansion.
2. All five supported detail types expand and collapse.
3. Active source links open the matching Reservoir record.
4. A missing source shows the unavailable notice without hiding other content.
5. Switching session collapses all details.
6. Homepage preview contains summary fields only.
7. Do not press the final public publish control during verification.
```

- [ ] **Step 5: Update current project context**

Record `distill-v3-layered`, the optional details contract, legacy compatibility, source allowlist sanitization, markdown inclusion, and homepage exclusion in `docs/PROJECT_CONTEXT.md`.

- [ ] **Step 6: Deploy and record the actual Worker version**

Run: `pnpm deploy`

Expected: Wrangler reports the custom domain and a new `Current Version ID`. Replace the deployment-version line in `docs/PROJECT_CONTEXT.md` with that exact ID.

- [ ] **Step 7: Commit verification and deployment record**

```bash
git add worker/src/publication/projection.test.ts web/src/views/DistillView.test.tsx docs/PROJECT_CONTEXT.md
git commit -m "260904: 착즙 상세층 공개 격리 검증과 배포 기록"
```

- [ ] **Step 8: Re-run final verification on committed code**

Run: `pnpm verify`

Expected: all commands exit 0 and `git status --short` lists only pre-existing unrelated user changes.
