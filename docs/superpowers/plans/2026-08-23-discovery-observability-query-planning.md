# Discovery Search Planning and Candidate Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Discovery search failures explainable and improve recall for Korean research-direction phrases without relaxing the existing candidate quality gates.

**Architecture:** Keep `runDiscovery` as the persistence orchestrator, but extract deterministic query planning and diagnostics into pure modules. Provider adapters return typed success/failure outcomes instead of collapsing failures into empty arrays. The Workflow stores a compact diagnostics object in `research_jobs.result_json`, and the Discover view renders the dominant cause and one next action.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, React, Vitest, pnpm workspaces, Cloudflare Workflows.

## Global Constraints

- Product requirements come from `docs/spec-v0.1.txt` and `docs/SPEC.md`; when they conflict, `docs/SPEC.md` wins.
- Preserve the existing `0.65` relevance gate, `PDF`/`FREE_FULLTEXT` access gate, engineering-only rejection, maximum 8 candidates, and provider quotas `OpenAlex 4 / arXiv 2 / RSS 2`.
- Allow zero candidates when no eligible material exists, but expose the reason in the result UI.
- Keep the project Cloudflare-first, external-minimal, serverless-first, reservoir-first, and model-agnostic.
- Do not add a new external search SaaS, paid AI call, admin dashboard, or candidate-minimum fallback.
- Do not auto-edit the user's discovery profile.
- Preserve source provenance and the original Korean `sourceQuery`; only `providerQuery` is sent to external providers.
- Preserve user-owned changes and unrelated untracked files; only stage files listed in the task being committed.
- Commit messages must include the date and a concise summary, for example `260823: discovery diagnostics contract`.

---

## File Map

| File | Responsibility in this change |
|---|---|
| `shared/src/discoveryRun.ts` | Shared query-plan, provider-result, diagnostics, and run-result contracts plus empty diagnostics factory |
| `shared/src/discovery.ts` | Existing assessment/access logic plus stored-access-preserving resolver |
| `shared/src/index.ts` | Root export for the new shared contracts |
| `shared/package.json` | `@radar/shared/discoveryRun` export for Worker and tests |
| `worker/src/discovery/queryPlan.ts` | Deterministic bilingual concept mapping, context-anchor selection, lane query selection |
| `worker/src/discovery/diagnostics.ts` | Mutable run counters and final provider/job outcome classification |
| `worker/src/lib/openalex.ts` | Typed OpenAlex provider outcome and OA evidence |
| `worker/src/lib/arxiv.ts` | Typed arXiv provider outcome |
| `worker/src/lib/rss.ts` | Typed RSS/Atom provider outcome |
| `worker/src/discovery/run.ts` | Discovery orchestration, existing-candidate maintenance, candidate collection, quota/dedup persistence |
| `worker/src/workflows/researchJob.ts` | Persist diagnostics and classify all-failed/unsupported Discovery jobs |
| `worker/src/routes/discover.ts` | Update OpenAlex result handling after provider return-type change |
| `web/src/components/discovery/DiscoveryRunSummary.tsx` | Diagnostics summary and next-action UI |
| `web/src/views/DiscoverView.tsx` | Connect latest Discovery job diagnostics and status-filter actions |
| `web/src/lib/discoveryRun.test.ts` | Shared diagnostics and query-plan behavior tests |
| `web/src/lib/discoveryFilter.test.ts` | Existing OpenAlex access-state regression test |
| `web/src/views/DiscoverView.test.tsx` | Zero-result, partial-provider-failure, and legacy-job UI tests |
| `docs/DEV_PLAN.md` | Update Discovery implementation contract and verification notes |
| `docs/PROJECT_CONTEXT.md` | Update operational behavior and provenance notes |

---

## Task 1: Add shared Discovery run contracts

**Files:**

- Create: `shared/src/discoveryRun.ts`
- Modify: `shared/src/index.ts`
- Modify: `shared/package.json`
- Test: `web/src/lib/discoveryRun.test.ts`

**Interfaces:**

- Consumes: `DiscoveryLane`, `DiscoveryQuerySource`, and `DiscoveryDecisionReason` from `@radar/shared/discovery`.
- Produces: `DiscoveryQueryPlanItem`, `DiscoveryProviderResult<T>`, `DiscoveryProviderStats`, `DiscoveryRunDiagnostics`, `DiscoveryRunResult`, `createEmptyDiscoveryDiagnostics()` for Tasks 2–7.

- [ ] **Step 1: Write the failing contract test**

Add `web/src/lib/discoveryRun.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";

describe("discovery run contracts", () => {
  it("creates zeroed stats for every provider", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();

    expect(diagnostics.plannedQueries).toBe(0);
    expect(diagnostics.providers.openalex).toMatchObject({
      requests: 0,
      succeededRequests: 0,
      failedRequests: 0,
      received: 0,
      missingAccess: 0,
      rejected: 0,
      duplicate: 0,
      quotaExcluded: 0,
      selected: 0,
      errorCodes: [],
    });
    expect(diagnostics.providers.arxiv.requests).toBe(0);
    expect(diagnostics.providers.rss.requests).toBe(0);
    expect(diagnostics.rejectedByReason).toEqual({});
    expect(diagnostics.incomplete).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryRun.test.ts`

Expected: FAIL because `@radar/shared/discoveryRun` and `createEmptyDiscoveryDiagnostics` do not exist.

- [ ] **Step 3: Add the exact shared types and factory**

Create `shared/src/discoveryRun.ts` with these contracts:

```ts
import type {
  DiscoveryDecisionReason,
  DiscoveryLane,
  DiscoveryQuerySource,
} from "./discovery";

export type DiscoveryProviderName = "openalex" | "arxiv" | "rss";
export type DiscoveryQueryPlanStatus = "READY" | "UNSUPPORTED";
export type DiscoveryProviderOutcomeStatus = "OK" | "TIMEOUT" | "HTTP_ERROR" | "PARSE_ERROR";

export interface DiscoveryQueryPlanItem {
  sourceQuery: string;
  providerQuery: string | null;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  concepts: string[];
  providers: Array<"openalex" | "arxiv">;
  status: DiscoveryQueryPlanStatus;
  selected: boolean;
  unsupportedReason: "NO_MAPPABLE_CONCEPT" | null;
}

export interface DiscoveryProviderResult<T> {
  status: DiscoveryProviderOutcomeStatus;
  items: T[];
  errorCode: string | null;
  elapsedMs: number;
}

export interface DiscoveryProviderStats {
  requests: number;
  succeededRequests: number;
  failedRequests: number;
  received: number;
  missingAccess: number;
  rejected: number;
  duplicate: number;
  quotaExcluded: number;
  selected: number;
  errorCodes: string[];
}

export interface DiscoveryRunDiagnostics {
  plannedQueries: number;
  readyQueries: number;
  executedQueries: number;
  unsupportedQueries: number;
  providers: Record<DiscoveryProviderName, DiscoveryProviderStats>;
  rejectedByReason: Partial<Record<DiscoveryDecisionReason, number>>;
  existingReclassified: number;
  incomplete: boolean;
}

export interface DiscoveryRunResult {
  collected: number;
  keptExisting: number;
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
}

function emptyProviderStats(): DiscoveryProviderStats {
  return {
    requests: 0,
    succeededRequests: 0,
    failedRequests: 0,
    received: 0,
    missingAccess: 0,
    rejected: 0,
    duplicate: 0,
    quotaExcluded: 0,
    selected: 0,
    errorCodes: [],
  };
}

export function createEmptyDiscoveryDiagnostics(): DiscoveryRunDiagnostics {
  return {
    plannedQueries: 0,
    readyQueries: 0,
    executedQueries: 0,
    unsupportedQueries: 0,
    providers: {
      openalex: emptyProviderStats(),
      arxiv: emptyProviderStats(),
      rss: emptyProviderStats(),
    },
    rejectedByReason: {},
    existingReclassified: 0,
    incomplete: false,
  };
}
```

Add `export * from "./discoveryRun";` to `shared/src/index.ts` and add `"./discoveryRun": "./src/discoveryRun.ts"` to `shared/package.json` exports.

- [ ] **Step 4: Run the focused test and typecheck**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryRun.test.ts`

Expected: PASS with 1 test.

Run: `pnpm typecheck`

Expected: PASS for shared, web, and worker.

- [ ] **Step 5: Commit the shared contract**

```bash
git add shared/src/discoveryRun.ts shared/src/index.ts shared/package.json web/src/lib/discoveryRun.test.ts
git commit -m "260823: discovery run diagnostics contract"
```

## Task 2: Implement deterministic bilingual query planning

**Files:**

- Create: `worker/src/discovery/queryPlan.ts`
- Test: `web/src/lib/discoveryQueryPlan.test.ts`

**Interfaces:**

- Consumes: `DiscoveryProfile`, `DiscoveryQueryPlanItem`, `isUsableDiscoveryQuery`, `normalizeDiscoveryTitle`, `strengthQueryLimit`.
- Produces: `DiscoveryQueryPlanInput` and `buildDiscoveryQueryPlan(input): DiscoveryQueryPlanItem[]` for `worker/src/discovery/run.ts`.

- [ ] **Step 1: Write the failing current-screen fixture test**

Create `web/src/lib/discoveryQueryPlan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDiscoveryQueryPlan } from "../../../worker/src/discovery/queryPlan";

const profile = {
  original: {
    keywords: ["AI/알고리즘", "네트워크-이미지", "데이터", "사진의 재현"],
    strength: 10,
  },
  counter: {
    keywords: [
      "기술 변수의 효과가 해석적으로 무의미하거나 불안정함을 블라인드 비교로 검증하기",
      "기술 조건의 엄격한 통제와 현장 선택의 우선성",
      "느린 재방문과 제한된 맥락 안의 사진적 증언",
      "수용·사용·증언의 사건을 이미지 의미의 주된 설명 단위로 삼기",
    ],
    strength: 90,
  },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("buildDiscoveryQueryPlan", () => {
  it("keeps provenance but sends provider-friendly queries", () => {
    const plan = buildDiscoveryQueryPlan({
      profile,
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
    });

    const original = plan.find((item) => item.sourceQuery === "AI/알고리즘");
    const counter = plan.find((item) => item.sourceQuery.startsWith("기술 변수의 효과"));

    expect(original).toMatchObject({
      providerQuery: "AI algorithm visual culture",
      lane: "ORIGINAL",
      selected: true,
      status: "READY",
    });
    expect(counter?.providerQuery).toBe("visual culture comparison technical variables");
    expect(counter?.providerQuery).not.toContain("기술 변수의 효과");
  });

  it("uses one original query and at most four counter queries at 10:90", () => {
    const plan = buildDiscoveryQueryPlan({
      profile,
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
    });

    expect(plan.filter((item) => item.selected && item.lane === "ORIGINAL")).toHaveLength(1);
    expect(plan.filter((item) => item.selected && item.lane === "COUNTER")).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryQueryPlan.test.ts`

Expected: FAIL because `worker/src/discovery/queryPlan.ts` does not exist.

- [ ] **Step 3: Implement the query planner**

Create `worker/src/discovery/queryPlan.ts` with this public shape:

```ts
import type { DiscoveryProfile } from "@radar/shared/discovery";
import type { DiscoveryQueryPlanItem } from "@radar/shared/discoveryRun";

export interface DiscoveryQueryPlanInput {
  profile: DiscoveryProfile;
  homepageKeywords: string[];
  momentumKeywords: string[];
  legacyQueries: string[];
}

export function buildDiscoveryQueryPlan(input: DiscoveryQueryPlanInput): DiscoveryQueryPlanItem[];
```

Implement the function with these concrete rules:

1. Preserve lane/source order.
2. Normalize and dedupe source queries within each lane.
3. Map Korean/mixed concepts to English anchor and modifier groups.
4. Mark unmappable Korean/mixed phrases `UNSUPPORTED`.
5. Select `READY` items up to `strengthQueryLimit` for each lane.
6. Select arXiv only for selected visual/technical concepts.

Use these mapping rules:

| Input concept | Output concept group |
|---|---|
| `사진`, `photograph` | `PHOTOGRAPHY` → `photography` |
| `이미지`, `image`, `시각`, `visual` | `IMAGE` → `image` or `visual culture` |
| `AI`, `인공지능`, `알고리즘`, `머신비전` | `AI_VISUAL` → `AI algorithm` |
| `네트워크`, `플랫폼` | `NETWORK_DATA` → `network culture` |
| `데이터` | `NETWORK_DATA` → `data epistemology` |
| `물질`, `촉각` | `MATERIALITY` → `materiality tactility` |
| `재현`, `저자`, `저작권` | `REPRESENTATION` → `representation authorship` |
| `증언` | `TESTIMONY` → `testimony` |
| `기억`, `기록`, `아카이브`, `맥락` | `CONTEXT` → `memory archive context` |
| `수용`, `사용`, `현장` | `RECEPTION_FIELD` → `reception field practice` |
| `비교`, `블라인드` | `COMPARISON` → `comparison` |
| `변수`, `통제`, `조건` | `METHOD` → `technical variables control` |

Use `visual culture` as the fallback context anchor for a mapped visual/technical query when no stronger photography/image anchor exists. For a counter query, always combine one original context anchor with at most two counter modifier groups. Set `selected` only after mapping and before provider calls; unsupported items do not consume the lane query limit.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryQueryPlan.test.ts`

Expected: PASS with 2 tests.

Run: `pnpm typecheck`

Expected: PASS with the new Worker module included in the worker typecheck.

- [ ] **Step 5: Commit the query planner**

```bash
git add worker/src/discovery/queryPlan.ts web/src/lib/discoveryQueryPlan.test.ts
git commit -m "260823: discovery bilingual query planner"
```

## Task 3: Return typed provider outcomes

**Files:**

- Modify: `worker/src/lib/openalex.ts`
- Modify: `worker/src/lib/arxiv.ts`
- Modify: `worker/src/lib/rss.ts`
- Modify: `worker/src/routes/discover.ts`
- Test: `web/src/lib/discoveryProviderResults.test.ts`

**Interfaces:**

- Consumes: `DiscoveryProviderResult<T>` and `DiscoveryProviderOutcomeStatus` from `@radar/shared/discoveryRun`.
- Produces: `searchWorks(): Promise<DiscoveryProviderResult<OpenAlexWork>>`, `searchArxiv(): Promise<DiscoveryProviderResult<ArxivWork>>`, and `fetchFeed(): Promise<DiscoveryProviderResult<FeedItem[]>>` for Tasks 4–6.

- [ ] **Step 1: Write failing adapter behavior tests**

Create `web/src/lib/discoveryProviderResults.test.ts` with these cases:

```ts
import { describe, expect, it, vi } from "vitest";
import { searchWorks } from "../../../worker/src/lib/openalex";

describe("discovery provider outcomes", () => {
  it("keeps a normal empty response distinct from an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    await expect(searchWorks("photography", 1)).resolves.toMatchObject({ status: "OK", items: [] });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("rate limited", { status: 429 })));
    await expect(searchWorks("photography", 1)).resolves.toMatchObject({ status: "HTTP_ERROR", items: [] });
  });
});
```

Add equivalent tests for arXiv timeout (`AbortError`) and RSS malformed XML (`PARSE_ERROR`).

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryProviderResults.test.ts`

Expected: FAIL because the adapters still return arrays and do not expose status.

- [ ] **Step 3: Wrap each provider request in the shared result contract**

For each adapter:

```ts
const started = Date.now();
try {
  const response = await fetch(url, options);
  if (!response.ok) {
    return { status: "HTTP_ERROR", items: [], errorCode: `${provider}_http_${response.status}`, elapsedMs: Date.now() - started };
  }
  const items = parseResponse(await response.text());
  return { status: "OK", items, errorCode: null, elapsedMs: Date.now() - started };
} catch (error) {
  const timedOut = error instanceof DOMException && error.name === "AbortError";
  return { status: timedOut ? "TIMEOUT" : "PARSE_ERROR", items: [], errorCode: `${provider}_${timedOut ? "timeout" : "parse_error"}`, elapsedMs: Date.now() - started };
}
```

Use provider-specific parsers so malformed response text returns `PARSE_ERROR`; do not include response text, query strings, or exception messages in `errorCode`.

Update all callers:

- `worker/src/discovery/run.ts`: read `.items` and record `.status`.
- `worker/src/lib/openalex.ts:verifyWork`: read `result.items` in both search loops.
- `worker/src/routes/discover.ts`: read `detail.items` before matching the kept candidate.

For OpenAlex, keep `openAccessUrl` on each `OpenAlexWork` as the collection-time OA evidence. Do not change the existing `OpenAlexWork` field names in this task.

- [ ] **Step 4: Run provider tests, typecheck, and existing discovery tests**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryProviderResults.test.ts src/lib/discoveryFilter.test.ts`

Expected: PASS with the new outcome tests and all existing discovery filter tests.

Run: `pnpm typecheck`

Expected: PASS; no caller may treat a provider result object as an array.

- [ ] **Step 5: Commit provider contracts**

```bash
git add worker/src/lib/openalex.ts worker/src/lib/arxiv.ts worker/src/lib/rss.ts worker/src/routes/discover.ts web/src/lib/discoveryProviderResults.test.ts
git commit -m "260823: discovery provider outcome states"
```

## Task 4: Add diagnostics accumulator and preserve stored access evidence

**Files:**

- Create: `worker/src/discovery/diagnostics.ts`
- Modify: `shared/src/discovery.ts`
- Test: `web/src/lib/discoveryDiagnostics.test.ts`
- Test: `web/src/lib/discoveryFilter.test.ts`

**Interfaces:**

- Consumes: `DiscoveryProviderResult<T>`, `DiscoveryRunDiagnostics`, and `DiscoveryDecisionReason`.
- Produces: `recordProviderResult`, `recordCandidateOutcome`, `resolveDiscoveryAccessForExisting`, and `discoveryJobOutcome` for Tasks 5–7.

- [ ] **Step 1: Write failing diagnostics tests**

Create `web/src/lib/discoveryDiagnostics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";
import { recordCandidateOutcome, recordProviderResult } from "../../../worker/src/discovery/diagnostics";

describe("discovery diagnostics", () => {
  it("records one terminal outcome per candidate", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    recordProviderResult(diagnostics, "openalex", { status: "OK", items: [{ id: "1" }], errorCode: null, elapsedMs: 4 });
    recordCandidateOutcome(diagnostics, "openalex", { kind: "REJECTED", reason: "NO_RESEARCH_ANCHOR" });

    expect(diagnostics.providers.openalex.received).toBe(1);
    expect(diagnostics.providers.openalex.rejected).toBe(1);
    expect(diagnostics.rejectedByReason.NO_RESEARCH_ANCHOR).toBe(1);
    expect(diagnostics.providers.openalex.selected).toBe(0);
  });
});
```

Add a test for `TIMEOUT` incrementing `failedRequests` and setting `incomplete` only when another provider succeeds.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryDiagnostics.test.ts`

Expected: FAIL because `worker/src/discovery/diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the accumulator with explicit terminal outcomes**

Use these exact terminal kinds:

```ts
type CandidateOutcome =
  | { kind: "MISSING_ACCESS"; reason: "PAYWALLED" | "ACCESS_UNKNOWN" }
  | { kind: "REJECTED"; reason: Exclude<DiscoveryDecisionReason, "RELEVANT" | "PAYWALLED" | "ACCESS_UNKNOWN"> }
  | { kind: "DUPLICATE" }
  | { kind: "QUOTA_EXCLUDED" }
  | { kind: "SELECTED" };
```

Implement:

```ts
export function recordProviderResult<T>(diagnostics: DiscoveryRunDiagnostics, provider: DiscoveryProviderName, result: DiscoveryProviderResult<T>): void;
export function recordCandidateOutcome(diagnostics: DiscoveryRunDiagnostics, provider: DiscoveryProviderName, outcome: CandidateOutcome): void;
export function discoveryJobOutcome(diagnostics: DiscoveryRunDiagnostics, hasActiveRss: boolean): "SUCCEEDED" | "FAILED" | "BLOCKED";
```

`recordCandidateOutcome` must increment exactly one provider terminal count. `MISSING_ACCESS` also increments `rejectedByReason[reason]`; quality rejection increments `rejected` and its reason. `recordProviderResult` caps unique `errorCodes` at five per provider. `discoveryJobOutcome` returns `BLOCKED` only when no selected query is executable, no active RSS exists, and all planned profile items are unsupported; it returns `FAILED` only when every executed provider request failed; otherwise it returns `SUCCEEDED` and sets `incomplete` when some requests failed.

In `shared/src/discovery.ts`, add:

```ts
export function resolveDiscoveryAccessForExisting(
  stored: DiscoveryAccessStatus | null | undefined,
  provider: string | null | undefined,
  href: string | null | undefined,
): DiscoveryAccessStatus {
  if (stored === "PDF" || stored === "FREE_FULLTEXT") return stored;
  return classifyDiscoveryAccess(provider, href);
}
```

- [ ] **Step 4: Add the OpenAlex access regression test**

Append to `web/src/lib/discoveryFilter.test.ts`:

```ts
it("preserves stored OpenAlex free-fulltext evidence during re-evaluation", () => {
  expect(resolveDiscoveryAccessForExisting("FREE_FULLTEXT", "openalex", "https://repository.example/item")).toBe("FREE_FULLTEXT");
});
```

Import `resolveDiscoveryAccessForExisting` from `@radar/shared/discovery`.

- [ ] **Step 5: Run diagnostics, access, and type tests**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryDiagnostics.test.ts src/lib/discoveryFilter.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit diagnostics and access preservation**

```bash
git add worker/src/discovery/diagnostics.ts shared/src/discovery.ts web/src/lib/discoveryDiagnostics.test.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260823: discovery diagnostics and OA access preservation"
```

## Task 5: Integrate query planning and diagnostics into Discovery execution

**Files:**

- Modify: `worker/src/discovery/run.ts`
- Test: `web/src/lib/discoveryPipelineAccounting.test.ts`

**Interfaces:**

- Consumes: `buildDiscoveryQueryPlan`, `recordProviderResult`, `recordCandidateOutcome`, `resolveDiscoveryAccessForExisting`, and typed provider results.
- Produces: `runDiscovery()` returning `DiscoveryRunResult` with `diagnostics`, while preserving `collected`, `keptExisting`, and `queries` compatibility.

- [ ] **Step 1: Write failing pipeline accounting tests**

Create tests for these pure accounting cases through the extracted collection helper in `worker/src/discovery/run.ts`:

```ts
it("counts access, quality, duplicate, quota, and selected outcomes without overlap", async () => {
  const result = await collectDiscoveryCandidates({
    profile: {
      original: { keywords: ["photography"], strength: 70 },
      counter: { keywords: [], strength: 0 },
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    homepageKeywords: [],
    momentumKeywords: [],
    legacyQueries: [],
    feeds: [],
    existingExternalIds: new Set(["duplicate"]),
    activeTitles: new Set<string>(),
    divergence: 0,
    clients: {
      openalex: async () => ({
        status: "OK",
        items: [
          { id: "no-access", title: "Photography", authors: "", year: 2025, abstract: null, doi: null, openAccessUrl: null, citedByCount: 0 },
          { id: "low-quality", title: "Unrelated", authors: "", year: 2025, abstract: null, doi: null, openAccessUrl: "https://repository.example/low-quality", citedByCount: 0 },
          { id: "duplicate", title: "Photography and the Politics of the Image", authors: "", year: 2025, abstract: "image politics and authorship", doi: null, openAccessUrl: "https://repository.example/duplicate", citedByCount: 0 },
          { id: "selected", title: "Materiality, Tactility, and Print Labor in Contemporary Photography", authors: "", year: 2025, abstract: "materiality, tactility, and print labor", doi: null, openAccessUrl: "https://repository.example/selected", citedByCount: 0 },
        ],
        errorCode: null,
        elapsedMs: 0,
      }),
      arxiv: async () => ({ status: "OK", items: [], errorCode: null, elapsedMs: 0 }),
      rss: async () => ({ status: "OK", items: [], errorCode: null, elapsedMs: 0 }),
    },
  });

  expect(result.diagnostics.providers.openalex).toMatchObject({
    received: 4,
    missingAccess: 1,
    rejected: 1,
    duplicate: 1,
    selected: 1,
  });
});
```

Call the production `collectDiscoveryCandidates` export directly with fake provider clients. Do not add a test-only branch or a test-only function name inside production code.

- [ ] **Step 2: Run the pipeline test and verify it fails**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts`

Expected: FAIL because `collectDiscoveryCandidates` has not been extracted from `runDiscovery`.

- [ ] **Step 3: Extract provider collection from DB persistence**

In `worker/src/discovery/run.ts`, introduce this production interface:

```ts
import type { DiscoveryProfile, DiscoveryLane, DiscoveryQuerySource, DiscoveryAccessStatus, SelectableDiscoveryCandidate } from "@radar/shared/discovery";
import type { DiscoveryProviderResult, DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";
import type { ArxivWork } from "../lib/arxiv";
import type { FeedItem } from "../lib/rss";
import type { OpenAlexWork } from "../lib/openalex";

export interface DiscoveryProviderClients {
  openalex: (query: string, limit: number) => Promise<DiscoveryProviderResult<OpenAlexWork>>;
  arxiv: (query: string, limit: number) => Promise<DiscoveryProviderResult<ArxivWork>>;
  rss: (feedUrl: string, limit: number) => Promise<DiscoveryProviderResult<FeedItem[]>>;
}

export interface DiscoveryCollectionInput {
  profile: DiscoveryProfile;
  homepageKeywords: string[];
  momentumKeywords: string[];
  legacyQueries: string[];
  feeds: string[];
  existingExternalIds: Set<string>;
  activeTitles: Set<string>;
  divergence: number;
  clients: DiscoveryProviderClients;
}

export interface DiscoveryCollectionResult {
  pending: PendingCandidate[];
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
}

export interface PendingCandidate extends SelectableDiscoveryCandidate {
  authors: string | null;
  year: number | null;
  abstract: string | null;
  query: string;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  url: string | null;
  accessStatus: DiscoveryAccessStatus;
}

export async function collectDiscoveryCandidates(input: DiscoveryCollectionInput): Promise<DiscoveryCollectionResult>;
```

The helper must:

1. Build and count the query plan.
2. Call only `selected = true` plans and active feeds.
3. Record provider status before inspecting items.
4. Record missing access, assessment rejection, duplicate, quota exclusion, and selected exactly once per item.
5. Apply existing provider and lane quotas without changing the existing maximums.
6. Return `pending` only for selected candidates that `runDiscovery` should insert.

Keep D1 reads, maintenance updates, and inserts in `runDiscovery`. In the existing-candidate maintenance loop, replace URL-only access classification with `resolveDiscoveryAccessForExisting(candidate.access_status, candidate.provider, candidate.external_url)` and increment `diagnostics.existingReclassified` whenever a `CANDIDATE` row changes status.

- [ ] **Step 4: Update `runDiscovery` and maintain result compatibility**

`runDiscovery` must return:

```ts
return {
  collected,
  keptExisting: existingRows.filter((row) => ["KEPT", "WATCHED", "CANDIDATE"].includes(row.status)).length,
  queries: collection.queries,
  diagnostics: collection.diagnostics,
};
```

Do not insert unsupported or rejected candidates. Preserve candidate `query_used` as `sourceQuery`, `provider` as the provider name, and existing `discovery_lane`/`query_source` fields.

- [ ] **Step 5: Run pipeline, discovery-filter, and type tests**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryFilter.test.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the integrated collection pipeline**

```bash
git add worker/src/discovery/run.ts web/src/lib/discoveryPipelineAccounting.test.ts
git commit -m "260823: integrate discovery query diagnostics"
```

## Task 6: Persist Discovery job outcomes and diagnostics

**Files:**

- Modify: `worker/src/workflows/researchJob.ts`
- Test: `web/src/lib/discoveryJobOutcome.test.ts`

**Interfaces:**

- Consumes: `DiscoveryRunResult.diagnostics` and `discoveryJobOutcome`.
- Produces: Workflow result JSON containing `collected`, `keptExisting`, `queries`, and `diagnostics`; stable error codes `discovery_providers_unavailable` and `discovery_queries_unusable`.

- [ ] **Step 1: Write failing job-outcome tests**

Test these exact cases:

```ts
it("treats one successful empty provider as a successful zero-result run", () => {
  const diagnostics = createEmptyDiscoveryDiagnostics();
  diagnostics.providers.openalex.requests = 1;
  diagnostics.providers.openalex.succeededRequests = 1;
  expect(discoveryJobOutcome(diagnostics, false)).toBe("SUCCEEDED");
});

it("treats all provider failures as unavailable", () => {
  const diagnostics = createEmptyDiscoveryDiagnostics();
  diagnostics.executedQueries = 1;
  diagnostics.providers.openalex.requests = 1;
  diagnostics.providers.openalex.failedRequests = 1;
  expect(discoveryJobOutcome(diagnostics, false)).toBe("FAILED");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryJobOutcome.test.ts`

Expected: FAIL until `discoveryJobOutcome` and Workflow result handling exist.

- [ ] **Step 3: Update the Workflow result type and execution branch**

In `worker/src/workflows/researchJob.ts`, extend `WorkflowStepResult.result` with:

```ts
diagnostics?: DiscoveryRunDiagnostics;
```

For `DISCOVERY_RUN`:

1. Call `runDiscovery`.
2. Call `discoveryJobOutcome(result.diagnostics, result.diagnostics.providers.rss.requests > 0)`.
3. If the outcome is `FAILED`, throw `new Error("discovery_providers_unavailable")`.
4. If the outcome is `BLOCKED`, throw `new JobBlockedError("discovery_queries_unusable", "검색어를 짧은 개념어로 수정하세요.")`.
5. Otherwise return the result and `{ view: "DISCOVER" }` exactly as before.

Keep the existing outer catch behavior: `JobBlockedError` becomes `BLOCKED`; ordinary errors become `FAILED`. Do not mark a normal successful zero-result run as failed.

- [ ] **Step 4: Verify job result compatibility**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryJobOutcome.test.ts src/components/layout/JobCenter.test.tsx`

Expected: PASS; existing jobs without `diagnostics` remain readable.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Workflow diagnostics**

```bash
git add worker/src/workflows/researchJob.ts web/src/lib/discoveryJobOutcome.test.ts
git commit -m "260823: persist discovery job diagnostics"
```

## Task 7: Render explainable zero-result and partial-failure UI

**Files:**

- Create: `web/src/components/discovery/DiscoveryRunSummary.tsx`
- Modify: `web/src/views/DiscoverView.tsx`
- Test: `web/src/views/DiscoverView.test.tsx`

**Interfaces:**

- Consumes: `ResearchJob.result`, `DiscoveryRunDiagnostics`, and existing `statusFilter`/`laneFilter` state.
- Produces: compact result summary, expanded zero-result diagnostics, and one dominant next action.

- [ ] **Step 1: Write failing UI tests**

Add tests for these props and outcomes:

```tsx
const zeroResult = {
  collected: 0,
  diagnostics: {
    plannedQueries: 5,
    readyQueries: 5,
    executedQueries: 5,
    unsupportedQueries: 0,
    providers: {
      openalex: { requests: 5, succeededRequests: 5, failedRequests: 0, received: 20, missingAccess: 4, rejected: 12, duplicate: 2, quotaExcluded: 1, selected: 0, errorCodes: [] },
      arxiv: { requests: 2, succeededRequests: 2, failedRequests: 0, received: 8, missingAccess: 0, rejected: 8, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
      rss: { requests: 3, succeededRequests: 3, failedRequests: 0, received: 24, missingAccess: 12, rejected: 12, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: [] },
    },
    rejectedByReason: { NO_RESEARCH_ANCHOR: 20, ACCESS_UNKNOWN: 4 },
    existingReclassified: 0,
    incomplete: false,
  },
};

it("opens diagnostics automatically when the run collected zero candidates", async () => {
  render(<DiscoveryRunSummary collected={0} diagnostics={zeroResult.diagnostics} onAction={vi.fn()} />);
  expect(screen.getByText("새 후보 0개")).toBeInTheDocument();
  expect(screen.getByText("연구축 표현 부족")).toBeVisible();
});

it("labels a partial provider run without calling it a normal empty result", () => {
  render(<DiscoveryRunSummary collected={0} diagnostics={{ ...zeroResult.diagnostics, incomplete: true }} onAction={vi.fn()} />);
  expect(screen.getByText("일부 출처 확인 실패")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx`

Expected: FAIL because `DiscoveryRunSummary` and the diagnostics integration do not exist.

- [ ] **Step 3: Implement `DiscoveryRunSummary`**

Use these props:

```ts
interface DiscoveryRunSummaryProps {
  collected: number;
  diagnostics: DiscoveryRunDiagnostics;
  onAction: (action: "RETRY" | "EDIT_QUERY" | "OPEN_STATUS") => void;
}
```

Render rules:

1. One-line summary when `collected > 0`; details collapsed.
2. Details open by default when `collected === 0`.
3. Show provider requests, successful responses, received count, and selected count.
4. Show `rejectedByReason` using the fixed Korean labels from the design spec.
5. Show `일부 출처 확인 실패` when `diagnostics.incomplete` is true.
6. Select one dominant action using this priority: provider failure, unsupported query, access loss, quality rejection, duplicate, quota exclusion, normal zero result. Tie-break by larger count, then priority order.
7. Never display raw provider errors or query strings in the summary.

- [ ] **Step 4: Connect the latest job in `DiscoverView`**

In the existing `jobs` success effect:

```tsx
const result = latest.result && typeof latest.result === "object"
  ? latest.result as { collected?: unknown; diagnostics?: DiscoveryRunDiagnostics }
  : {};
setMsg(`발견 수집 완료 · 새 후보 ${Number(result.collected ?? 0)}개`);
setRunSummary(result.diagnostics ?? null);
void load();
```

Render `DiscoveryRunSummary` only when `diagnostics` exists. If an older job has no diagnostics, preserve the current message and do not render an empty summary. Map `OPEN_STATUS` to the existing status filter state without changing backend data.

- [ ] **Step 5: Run UI tests and build**

Run: `pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx src/components/layout/JobCenter.test.tsx`

Expected: PASS.

Run: `pnpm --filter @radar/web run build`

Expected: TypeScript and Vite build succeed.

- [ ] **Step 6: Commit the explainable result UI**

```bash
git add web/src/components/discovery/DiscoveryRunSummary.tsx web/src/views/DiscoverView.tsx web/src/views/DiscoverView.test.tsx
git commit -m "260823: explain discovery zero-result runs"
```

## Task 8: Update operational documentation and perform full verification

**Files:**

- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Verify: `docs/superpowers/specs/2026-08-23-discovery-observability-query-planning-design.md`

**Interfaces:**

- Consumes: the completed runtime behavior from Tasks 1–7.
- Produces: source-of-truth operational notes and a verified implementation branch.

- [ ] **Step 1: Update the Discovery documentation**

Add to `docs/DEV_PLAN.md` and `docs/PROJECT_CONTEXT.md`:

- Discovery result diagnostics are stored in `research_jobs.result_json`.
- Provider failures are distinct from normal empty results.
- Korean/mixed source phrases preserve provenance while provider queries use deterministic concept mapping.
- Existing OpenAlex stored OA evidence is not downgraded by URL-only reclassification.
- Zero candidates remain valid when all eligible material is filtered out.

Do not change the existing `0.65`, access, quota, or maximum-candidate policy statements.

- [ ] **Step 2: Run the complete local verification suite**

Run: `pnpm typecheck`

Expected: shared, web, and worker typechecks pass.

Run: `pnpm --filter @radar/web exec vitest run`

Expected: all tests pass, including the new discovery planner, provider, diagnostics, pipeline, job, and UI tests.

Run: `pnpm build`

Expected: all workspace builds pass.

Run: `pnpm --filter @radar/worker exec wrangler deploy --dry-run`

Expected: Worker bundle and static assets are generated and Wrangler exits successfully without deploying.

- [ ] **Step 3: Verify the critical invariants**

Use a local test fixture or authenticated staging run to confirm:

```text
received = missingAccess + rejected + duplicate + quotaExcluded + selected
```

Also confirm:

- Current `10:90` settings execute one original and up to four counter queries.
- A provider timeout creates `incomplete = true` when another provider succeeds.
- All provider failures create `FAILED/discovery_providers_unavailable`.
- All selected profile queries being unsupported creates `BLOCKED/discovery_queries_unusable`.
- A stored OpenAlex `FREE_FULLTEXT` candidate remains eligible on the next run.
- An old job result without diagnostics still renders the legacy completion message.

- [ ] **Step 4: Commit documentation and verification notes**

```bash
git add docs/DEV_PLAN.md docs/PROJECT_CONTEXT.md
git commit -m "260823: document discovery diagnostics operations"
```

## Final Acceptance Checklist

- [ ] `DiscoveryQueryPlanItem` preserves `sourceQuery` and uses a separate `providerQuery`.
- [ ] Counter queries combine an original context anchor with at most two counter modifier groups.
- [ ] Unsupported phrases do not consume the lane query limit.
- [ ] arXiv eligibility uses mapped concepts, not raw Korean text matching.
- [ ] Provider `OK + 0 items` is distinct from timeout, HTTP, and parse failures.
- [ ] Candidate terminal accounting satisfies the received-count invariant.
- [ ] Existing OpenAlex `FREE_FULLTEXT` evidence is preserved during re-evaluation.
- [ ] A normal zero-result run succeeds with diagnostics.
- [ ] Partial provider failure is visible as incomplete success.
- [ ] Complete provider failure is a failed job with a stable error code.
- [ ] The Discover view auto-expands diagnostics for zero candidates.
- [ ] No quality gate, access gate, provider quota, lane quota, or maximum-candidate rule is relaxed.
- [ ] No new database migration, external SaaS, or paid AI call is introduced.
- [ ] Typecheck, full Vitest, build, and Wrangler dry-run pass.
