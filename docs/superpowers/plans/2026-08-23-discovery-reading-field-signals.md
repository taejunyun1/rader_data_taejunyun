# Discovery Reading and Field Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Discover into verified reading candidates and separately ranked field signals, using official RSS/API paths only and preserving explainable zero-result diagnostics.

**Architecture:** Extend the static source registry with content target, automatic-collection, access-policy, and topic-anchor metadata. Keep `discovery_candidates` for readable papers/articles, add `discovery_field_signals` for events and opportunities, and run both collectors inside the existing `DISCOVERY_RUN` workflow. Reuse the RSS parser, but apply separate assessment, quota, persistence, API, and UI paths after normalization.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1, Cloudflare Workflows, React 19, Vitest, Testing Library, Playwright, pnpm workspaces.

## Global Constraints

- Product requirements come from `docs/spec-v0.1.txt` and `docs/SPEC.md`; when they conflict, `docs/SPEC.md` wins.
- Preserve Reservoir First, Provenance First, Cloudflare-first, external-minimal, serverless-first, and model-agnostic principles.
- Preserve the reading-candidate relevance threshold `0.65`, `PDF`/verified `FREE_FULLTEXT` access gate, engineering-only rejection, maximum 8 reading candidates, and provider quotas `OpenAlex 4 / arXiv 2 / RSS 2`.
- Field signals are separate from reading quotas and are capped at 12 per run and 4 per source.
- Do not add HTML selector crawlers, Google Scholar result crawling, RSS proxy SaaS, email ingestion, museum-object ingestion, or paid AI calls.
- Do not auto-promote a field signal to Reservoir; `SAVED` only changes field-signal status.
- Keep e-flux Journal and Announcements as search links until a current official machine-readable channel is verified.
- Do not expose relevance thresholds, source quotas, or source trust flags as new user settings.
- Preserve user-owned changes and unrelated untracked files; stage only files listed by each task.
- Schema changes require a new forward-only D1 migration; do not edit an already-applied migration.
- Commit messages must include the date and a concise summary, for example `260823: 현장 신호 수집 스키마`.
- Implementation starts only after the user explicitly asks to execute this plan; this document creation does not authorize code or deployment changes.

---

## File Map

| File | Responsibility in this change |
|---|---|
| `shared/src/index.ts` | Source-registry contracts, curated reading/signal presets, default feed lists |
| `shared/src/discovery.ts` | Source-policy-aware reading access classification and source-balanced RSS selection |
| `shared/src/fieldSignals.ts` | Field-signal types, deterministic classification, date extraction, relevance assessment |
| `shared/package.json` | Export `@radar/shared/fieldSignals` |
| `worker/migrations/0014_discovery_field_signals.sql` | Reading source provenance column and field-signal table/indexes |
| `worker/src/lib/rss.ts` | Preserve exact feed publication timestamp in normalized items |
| `worker/src/discovery/run.ts` | Pass source metadata into reading RSS assessment and persist `source_id` |
| `worker/src/discovery/fieldSignals.ts` | Collect, diagnose, deduplicate, rank, and persist field signals |
| `worker/src/discovery/diagnostics.ts` | Whole-job outcome classification across reading and signal collectors |
| `worker/src/workflows/researchJob.ts` | Run and store both result branches in one `DISCOVERY_RUN` |
| `worker/src/routes/discover.ts` | Field-signal list/action endpoints and reading `sourceId` response |
| `web/src/components/discovery/FieldSignalList.tsx` | Field-signal cards and actions |
| `web/src/components/discovery/FieldSignalRunSummary.tsx` | Per-source signal collection diagnostics |
| `web/src/views/DiscoverView.tsx` | `읽을거리 / 현장 신호` mode, fetching, filters, status actions |
| `web/src/styles/views.css` | Discover mode tabs, signal cards, responsive layout |
| `web/src/lib/discoverySources.test.ts` | Source registry, default feeds, non-auto source assertions |
| `web/src/lib/discoveryFilter.test.ts` | Verified-source access and custom-feed rejection regression tests |
| `web/src/lib/discoveryPipelineAccounting.test.ts` | Reading RSS source-policy and source-balance accounting |
| `web/src/lib/fieldSignals.test.ts` | Pure signal type/date/relevance behavior |
| `web/src/lib/fieldSignalCollector.test.ts` | Source diagnostics, dedup, quotas, collection behavior |
| `web/src/views/DiscoverView.test.tsx` | Mode switch, API loading, save/dismiss/restore, run-result UI |
| `web/tests/e2e/core-reading-flow.spec.ts` | Reading flow regression plus field-signal tab smoke test |
| `docs/SPEC.md` | Record implemented source-target and auto-collection policy |
| `docs/DEV_PLAN.md` | Extend Phase 5 acceptance criteria with field signals |
| `docs/PROJECT_CONTEXT.md` | Current operation, source list, limits, diagnostics, provenance |

## Task 1: Make the source registry express purpose and trust

**Files:**

- Modify: `shared/src/index.ts:75-215`
- Modify: `shared/src/discovery.ts:383-395`
- Test: `web/src/lib/discoverySources.test.ts`
- Test: `web/src/lib/discoveryFilter.test.ts`

**Interfaces:**

- Consumes: existing `DiscoverySourcePreset`, `DiscoveryAccessStatus`, and `classifyDiscoveryAccess()`.
- Produces: `DiscoveryContentTarget`, `DiscoverySourceAccessPolicy`, expanded `DiscoverySourcePreset`, `DEFAULT_DISCOVERY_FEEDS`, `DEFAULT_FIELD_SIGNAL_FEEDS`, `discoverySourceByFeedUrl()`, and the optional `sourcePolicy` argument used by Tasks 2 and 4.

- [ ] **Step 1: Write failing source-registry tests**

Replace `web/src/lib/discoverySources.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_FEEDS,
  DEFAULT_FIELD_SIGNAL_FEEDS,
  DISCOVERY_SOURCE_PRESETS,
  discoverySourceByFeedUrl,
} from "@radar/shared";

describe("discovery source registry", () => {
  it("separates automatic reading feeds from field-signal feeds", () => {
    expect(DEFAULT_DISCOVERY_FEEDS).toEqual([
      "https://unthinking.photography/feed",
      "https://aperture.org/feed/",
      "https://hyperallergic.com/rss/",
    ]);
    expect(DEFAULT_FIELD_SIGNAL_FEEDS).toEqual([
      "https://www.collegeart.org/news/feed/",
      "https://forarthistory.org.uk/feed/",
      "https://www.icp.org/rss.xml",
    ]);
  });

  it("keeps stale, paywalled, and credentialed sources out of automatic collection", () => {
    const byId = new Map(DISCOVERY_SOURCE_PRESETS.map((source) => [source.id, source]));

    expect(byId.get("e-flux-journal")).toMatchObject({ collection: "SEARCH", autoCollect: false });
    expect(byId.get("e-flux-announcements")).toMatchObject({ target: "FIELD_SIGNAL", collection: "SEARCH", autoCollect: false });
    expect(byId.get("artforum")).toMatchObject({ target: "READING", accessPolicy: "PAYWALLED", autoCollect: false });
    expect(byId.get("artnews")).toMatchObject({ accessPolicy: "PAYWALLED", autoCollect: false });
    expect(byId.get("kci")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("google-scholar")).toMatchObject({ collection: "SEARCH", autoCollect: false });
  });

  it("resolves a curated feed to its source policy", () => {
    expect(discoverySourceByFeedUrl("https://unthinking.photography/feed")).toMatchObject({
      id: "unthinking-photography",
      target: "READING",
      accessPolicy: "FREE_FULLTEXT",
    });
    expect(discoverySourceByFeedUrl("https://hyperallergic.com/feed/")).toMatchObject({
      id: "hyperallergic",
      feedUrl: "https://hyperallergic.com/rss/",
    });
    expect(discoverySourceByFeedUrl("https://unknown.example/feed")).toBeNull();
  });
});
```

- [ ] **Step 2: Write failing source-aware access tests**

Add to `describe("discovery access classification", ...)` in `web/src/lib/discoveryFilter.test.ts`:

```ts
it("trusts free HTML only when the curated source policy verifies it", () => {
  expect(classifyDiscoveryAccess(
    "rss",
    "https://unthinking.photography/articles/machine-readable-photography",
    "FREE_FULLTEXT",
  )).toBe("FREE_FULLTEXT");
  expect(classifyDiscoveryAccess(
    "rss",
    "https://unknown.example/articles/photography",
  )).toBe("UNKNOWN");
});

it("keeps a curated paywalled policy stronger than a generic RSS provider", () => {
  expect(classifyDiscoveryAccess(
    "rss",
    "https://www.artforum.com/features/example",
    "PAYWALLED",
  )).toBe("PAYWALLED");
});
```

- [ ] **Step 3: Run the focused tests and verify the expected failures**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoverySources.test.ts src/lib/discoveryFilter.test.ts
```

Expected: FAIL because `DEFAULT_FIELD_SIGNAL_FEEDS`, `discoverySourceByFeedUrl`, expanded source fields, and the third `classifyDiscoveryAccess` argument do not exist.

- [ ] **Step 4: Replace the source-registry contract and add curated sources**

Replace the interface at `shared/src/index.ts:75-83` with:

```ts
export type DiscoveryContentTarget = "READING" | "FIELD_SIGNAL";
export type DiscoverySourceAccessPolicy = "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN";

export interface DiscoverySourcePreset {
  id: string;
  name: string;
  category: "ARTS" | "ACADEMIC" | "EDITORIAL";
  url: string;
  feedUrl: string | null;
  collection: "RSS" | "API" | "SEARCH";
  target: DiscoveryContentTarget;
  autoCollect: boolean;
  accessPolicy: DiscoverySourceAccessPolicy;
  topicAnchors: string[];
  description: string;
}
```

Replace the registry contract and make these six automatic presets exactly:

```ts
{
  id: "unthinking-photography",
  name: "Unthinking Photography",
  category: "ARTS",
  url: "https://unthinking.photography/",
  feedUrl: "https://unthinking.photography/feed",
  collection: "RSS",
  target: "READING",
  autoCollect: true,
  accessPolicy: "FREE_FULLTEXT",
  topicAnchors: ["photography", "network culture", "machine vision", "visual culture"],
  description: "자동화·네트워크화된 사진, AI·머신비전·이미지 문화 비평",
},
{
  id: "aperture",
  name: "Aperture",
  category: "ARTS",
  url: "https://aperture.org/",
  feedUrl: "https://aperture.org/feed/",
  collection: "RSS",
  target: "READING",
  autoCollect: true,
  accessPolicy: "FREE_FULLTEXT",
  topicAnchors: ["photography", "photographic history", "visual culture"],
  description: "사진 매체의 비평·작가·전시·출판 소식",
},
{
  id: "hyperallergic",
  name: "Hyperallergic",
  category: "EDITORIAL",
  url: "https://hyperallergic.com/",
  feedUrl: "https://hyperallergic.com/rss/",
  collection: "RSS",
  target: "READING",
  autoCollect: true,
  accessPolicy: "FREE_FULLTEXT",
  topicAnchors: ["contemporary art", "media art", "visual culture"],
  description: "미술계 현장과 비평, 디지털·뉴미디어 관련 읽을거리",
},
{
  id: "caa-news",
  name: "CAA News",
  category: "ACADEMIC",
  url: "https://www.collegeart.org/news/",
  feedUrl: "https://www.collegeart.org/news/feed/",
  collection: "RSS",
  target: "FIELD_SIGNAL",
  autoCollect: true,
  accessPolicy: "UNKNOWN",
  topicAnchors: ["visual arts", "art history", "contemporary art"],
  description: "미술사·시각예술 학회, CFP, 지원과 전문 소식",
},
{
  id: "association-art-history",
  name: "Association for Art History",
  category: "ACADEMIC",
  url: "https://forarthistory.org.uk/",
  feedUrl: "https://forarthistory.org.uk/feed/",
  collection: "RSS",
  target: "FIELD_SIGNAL",
  autoCollect: true,
  accessPolicy: "UNKNOWN",
  topicAnchors: ["art history", "visual culture", "curatorial research"],
  description: "미술사 학회·행사·공모·큐레이터 연구 소식",
},
{
  id: "icp",
  name: "International Center of Photography",
  category: "ARTS",
  url: "https://www.icp.org/",
  feedUrl: "https://www.icp.org/rss.xml",
  collection: "RSS",
  target: "FIELD_SIGNAL",
  autoCollect: true,
  accessPolicy: "UNKNOWN",
  topicAnchors: ["photography", "visual culture", "photojournalism"],
  description: "사진 전시·교육·아카이브·기관 프로그램",
},
```

For every non-automatic source, use this exact matrix. `—` means `feedUrl: null`; anchor cells are the complete `topicAnchors` arrays.

| id | category | url | feedUrl | collection | target | autoCollect | accessPolicy | topicAnchors |
|---|---|---|---|---|---|---:|---|---|
| `e-flux-journal` | ARTS | `https://www.e-flux.com/journal` | — | SEARCH | READING | false | FREE_FULLTEXT | `contemporary art`, `visual culture`, `media theory` |
| `e-flux-announcements` | ARTS | `https://www.e-flux.com/announcements` | — | SEARCH | FIELD_SIGNAL | false | UNKNOWN | `contemporary art`, `curatorial research`, `visual culture` |
| `artforum` | ARTS | `https://www.artforum.com/` | `https://www.artforum.com/feed` | RSS | READING | false | PAYWALLED | `contemporary art`, `art criticism`, `visual culture` |
| `artnews` | EDITORIAL | `https://www.artnews.com/` | `https://www.artnews.com/c/art-news/feed/` | RSS | READING | false | PAYWALLED | `contemporary art`, `museum`, `visual culture` |
| `getty-news` | ARTS | `https://www.getty.edu/news/all/` | — | SEARCH | FIELD_SIGNAL | false | UNKNOWN | `photography`, `conservation`, `museum research` |
| `moma-research` | ACADEMIC | `https://www.moma.org/research_and_learning/` | — | SEARCH | READING | false | UNKNOWN | `modern art`, `media art`, `visual culture` |
| `riss` | ACADEMIC | `https://www.riss.kr/` | — | API | READING | false | INSTITUTION | `photography`, `visual culture`, `art history` |
| `google-scholar` | ACADEMIC | `https://scholar.google.com/` | — | SEARCH | READING | false | UNKNOWN | `photography`, `visual culture`, `media theory` |
| `scopus` | ACADEMIC | `https://www.scopus.com/` | — | API | READING | false | INSTITUTION | `photography`, `visual culture`, `media theory` |
| `web-of-science` | ACADEMIC | `https://www.webofscience.com/` | — | API | READING | false | INSTITUTION | `photography`, `visual culture`, `media theory` |
| `kci` | ACADEMIC | `https://www.kci.go.kr/` | — | API | READING | false | INSTITUTION | `photography`, `visual culture`, `art history` |
| `semantic-scholar` | ACADEMIC | `https://www.semanticscholar.org/` | — | API | READING | false | UNKNOWN | `photography`, `machine vision`, `visual culture` |
| `core` | ACADEMIC | `https://core.ac.uk/` | — | API | READING | false | FREE_FULLTEXT | `photography`, `visual culture`, `media theory` |
| `doaj` | ACADEMIC | `https://doaj.org/` | — | API | READING | false | FREE_FULLTEXT | `photography`, `visual culture`, `art history` |
| `fotomuseum-winterthur` | ARTS | `https://www.fotomuseum.ch/en/explore/still-searching/` | — | SEARCH | READING | false | FREE_FULLTEXT | `photography`, `network culture`, `visual culture` |
| `foam` | ARTS | `https://www.foam.org/` | — | SEARCH | READING | false | FREE_FULLTEXT | `photography`, `photographic history`, `visual culture` |
| `one-thousand-words` | EDITORIAL | `https://1000wordsmag.com/` | — | SEARCH | READING | false | FREE_FULLTEXT | `photography`, `photobooks`, `visual culture` |

Keep the current `description` text unchanged for existing IDs. Use these exact descriptions for the new directory entries:

```ts
const NEW_DIRECTORY_DESCRIPTIONS = {
  kci: "국내 학술지 인용색인 — 공식 API 키·이용 조건 확인 필요",
  "semantic-scholar": "학술 문헌·인용 그래프 — 공식 API adapter 구현 전 디렉터리 전용",
  core: "오픈액세스 논문 집합 — 공식 API adapter와 이용 한도 확인 필요",
  doaj: "오픈액세스 학술지 색인 — 공식 API adapter 구현 전 디렉터리 전용",
  "fotomuseum-winterthur": "사진·네트워크 문화·이미지 이론 연구와 비평",
  foam: "사진 전시·비평·작가·출판을 잇는 미술관 출발점",
  "one-thousand-words": "동시대 사진과 포토북 중심의 비평 매거진",
} as const;
```

Replace the default-feed expression with:

```ts
export const DEFAULT_DISCOVERY_FEEDS = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
  source.autoCollect && source.collection === "RSS" && source.target === "READING" && source.feedUrl
    ? [source.feedUrl]
    : [],
);

export const DEFAULT_FIELD_SIGNAL_FEEDS = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
  source.autoCollect && source.collection === "RSS" && source.target === "FIELD_SIGNAL" && source.feedUrl
    ? [source.feedUrl]
    : [],
);

export function discoverySourceByFeedUrl(feedUrl: string): DiscoverySourcePreset | null {
  const normalized = feedUrl.trim().replace(/\/+$/, "");
  const direct = DISCOVERY_SOURCE_PRESETS.find((source) => source.feedUrl?.replace(/\/+$/, "") === normalized);
  if (direct) return direct;
  const legacySourceId = new Map<string, string>([
    ["https://hyperallergic.com/feed", "hyperallergic"],
  ]).get(normalized);
  return legacySourceId
    ? DISCOVERY_SOURCE_PRESETS.find((source) => source.id === legacySourceId) ?? null
    : null;
}
```

- [ ] **Step 5: Make reading access classification honor the source policy**

Replace `classifyDiscoveryAccess` in `shared/src/discovery.ts` with:

```ts
export function classifyDiscoveryAccess(
  provider: string | null | undefined,
  href: string | null | undefined,
  sourcePolicy?: "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN",
): DiscoveryAccessStatus {
  const normalizedProvider = provider?.toLowerCase() ?? "";
  const normalizedHref = href?.toLowerCase() ?? "";
  if (!href) return "UNKNOWN";
  if (normalizedProvider === "arxiv" || normalizedHref.includes("arxiv.org/abs/") || normalizedHref.includes("arxiv.org/pdf/")) return "PDF";
  if (normalizedHref.endsWith(".pdf")) return "PDF";
  if (sourcePolicy === "FREE_FULLTEXT") return "FREE_FULLTEXT";
  if (sourcePolicy === "PAYWALLED") return "PAYWALLED";
  if (sourcePolicy === "INSTITUTION") return "INSTITUTION";
  if (normalizedProvider === "riss" || normalizedHref.includes("riss.kr")) return "INSTITUTION";
  if (normalizedHref.includes("artforum.com") || normalizedHref.includes("artnews.com")) return "PAYWALLED";
  if (normalizedHref.includes("hyperallergic.com")) return "FREE_FULLTEXT";
  if (normalizedProvider === "openalex") return "UNKNOWN";
  return "UNKNOWN";
}
```

- [ ] **Step 6: Run focused tests and all typechecks**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoverySources.test.ts src/lib/discoveryFilter.test.ts
pnpm typecheck
```

Expected: all focused tests PASS and every workspace typecheck PASS.

- [ ] **Step 7: Commit the source policy**

```bash
git add shared/src/index.ts shared/src/discovery.ts web/src/lib/discoverySources.test.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260823: 발견 출처 목적과 접근 정책"
```

## Task 2: Apply curated source policy to reading RSS candidates

**Files:**

- Modify: `shared/src/discovery.ts:407-495`
- Modify: `worker/src/lib/rss.ts:4-63`
- Modify: `worker/src/discovery/run.ts:1-310`
- Modify: `worker/src/routes/discover.ts:108-118`
- Modify: `web/src/views/DiscoverView.tsx:50-53,217-220,244-250`
- Test: `web/src/lib/discoveryPipelineAccounting.test.ts`
- Test: `web/src/lib/discoveryProviderResults.test.ts`
- Test: `web/src/views/DiscoverView.test.tsx`

**Interfaces:**

- Consumes: `discoverySourceByFeedUrl()`, `DiscoverySourceAccessPolicy`, and current `fetchFeed()`.
- Produces: `DiscoveryFeedInput`, `PendingCandidate.sourceId`, `FeedItem.publishedAt`, `sanitizeCustomFeedUrls()`, `resolveDiscoveryReadingFeeds()`, source-aware RSS assessment, and source-balanced RSS selection for Task 4 persistence.

- [ ] **Step 1: Write a failing curated-reading-feed test**

Update the Worker import in `web/src/lib/discoveryPipelineAccounting.test.ts` to include `resolveDiscoveryReadingFeeds`, then add:

```ts
it("accepts a verified free HTML feed and keeps its source provenance", async () => {
  const result = await collectDiscoveryCandidates({
    profile: {
      original: { keywords: ["photography"], strength: 70 },
      counter: { keywords: [], strength: 0 },
      updatedAt: "2026-08-23T00:00:00.000Z",
    },
    homepageKeywords: [],
    momentumKeywords: [],
    legacyQueries: [],
    feeds: [{
      sourceId: "unthinking-photography",
      feedUrl: "https://unthinking.photography/feed",
      accessPolicy: "FREE_FULLTEXT",
    }],
    existingExternalIds: new Set<string>(),
    activeTitles: new Set<string>(),
    divergence: 0,
    clients: {
      openalex: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
      arxiv: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
      rss: async () => ({
        status: "OK" as const,
        items: [{
          title: "Machine Readable Photography and Visual Culture",
          url: "https://unthinking.photography/articles/machine-readable-photography",
          year: 2026,
          publishedAt: "2026-08-18T00:00:00.000Z",
          summary: "Photography, machine vision, authorship, and network culture.",
        }],
        errorCode: null,
        elapsedMs: 0,
      }),
    },
  });

  expect(result.pending).toHaveLength(1);
  expect(result.pending[0]).toMatchObject({
    sourceId: "unthinking-photography",
    accessStatus: "FREE_FULLTEXT",
    provider: "rss",
  });
});

it("always merges current curated feeds and removes legacy curated KV values", () => {
  const feeds = resolveDiscoveryReadingFeeds([
    "https://www.artforum.com/feed",
    "https://hyperallergic.com/feed/",
    "https://custom.example/photo-feed.xml",
  ]);

  expect(feeds.map((feed) => feed.feedUrl)).toEqual([
    "https://unthinking.photography/feed",
    "https://aperture.org/feed/",
    "https://hyperallergic.com/rss/",
    "https://custom.example/photo-feed.xml",
  ]);
  expect(feeds.at(-1)).toMatchObject({
    sourceId: "custom:https://custom.example/photo-feed.xml",
    accessPolicy: "UNKNOWN",
  });
});
```

Add this UI regression to `web/src/views/DiscoverView.test.tsx`:

```tsx
it("separates automatic source status from the custom feed editor", async () => {
  render(<DiscoverView onNavigate={vi.fn()} />);
  await userEvent.click(screen.getByText("발견 범위와 수집 출처 조정"));

  expect(screen.getByRole("heading", { name: "사용자 추가 RSS·Atom 피드" })).toBeVisible();
  expect(screen.getByText(/기본 피드는 자동으로 적용됩니다/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Unthinking Photography ↗" }).closest(".discovery-source__row")).toHaveTextContent("읽을거리 자동 수집");
  expect(screen.getByRole("link", { name: "CAA News ↗" }).closest(".discovery-source__row")).toHaveTextContent("현장 신호 자동 수집");
  expect(screen.getByRole("link", { name: "Artforum ↗" }).closest(".discovery-source__row")).toHaveTextContent("공식 RSS · 자동 수집 안 함");
});
```

- [ ] **Step 2: Write a failing RSS publication timestamp test**

In `web/src/lib/discoveryProviderResults.test.ts`, update the successful RSS fixture expectation so it includes:

```ts
expect(result.items[0]).toMatchObject({
  title: "Machine Readable Photography",
  year: 2026,
  publishedAt: "2026-08-18T00:00:00.000Z",
});
```

Use this feed fixture:

```xml
<rss><channel><item>
  <title>Machine Readable Photography</title>
  <link>https://unthinking.photography/item</link>
  <pubDate>Tue, 18 Aug 2026 00:00:00 +0000</pubDate>
  <description>Photography and machine vision.</description>
</item></channel></rss>
```

- [ ] **Step 3: Run the tests and verify they fail on the old contracts**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryProviderResults.test.ts
```

Expected: FAIL because `feeds` still accepts strings, `PendingCandidate` has no `sourceId`, and `FeedItem` has no `publishedAt`.

- [ ] **Step 4: Preserve exact publication dates in the RSS parser**

Change `FeedItem` in `worker/src/lib/rss.ts` to:

```ts
export interface FeedItem {
  title: string;
  url: string | null;
  year: number | null;
  publishedAt: string | null;
  summary: string | null;
}
```

Replace the date block in `parseFeedXml()` with:

```ts
const dateMatch = b.match(/<(?:pubDate|published|updated)>([^<]+)</);
const parsedDate = dateMatch ? new Date(decodeXml(dateMatch[1]!)) : null;
const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null;
const year = publishedAt ? new Date(publishedAt).getUTCFullYear() : null;
const summary = cleanDiscoverySourceText(decodeXml(tag(b, "description") ?? tag(b, "summary") ?? ""));
items.push({
  title,
  url: link ? decodeXml(link) : null,
  year,
  publishedAt,
  summary: summary.slice(0, 400) || null,
});
```

- [ ] **Step 5: Replace string feed inputs with source-aware inputs**

Add these types in `worker/src/discovery/run.ts`:

```ts
export interface DiscoveryFeedInput {
  sourceId: string;
  feedUrl: string;
  accessPolicy: "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN";
}

export interface PendingCandidate extends SelectableDiscoveryCandidate {
  sourceId: string | null;
  authors: string | null;
  year: number | null;
  abstract: string | null;
  query: string;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  url: string | null;
  accessStatus: DiscoveryAccessStatus;
}
```

Change `DiscoveryCollectionInput.feeds` to `DiscoveryFeedInput[]`. In OpenAlex and arXiv `addPending()` calls set `sourceId: null`.

Import `DEFAULT_DISCOVERY_FEEDS` and `discoverySourceByFeedUrl` from `@radar/shared`. Replace `customFeeds()` and `setCustomFeeds()`, and add the two pure helpers, with:

```ts
export function sanitizeCustomFeedUrls(feeds: string[]): string[] {
  return [...new Set(
    feeds
      .map((feed) => feed.trim())
      .filter((feed) => /^https?:\/\//.test(feed))
      .filter((feed) => discoverySourceByFeedUrl(feed) === null),
  )].slice(0, 6);
}

export function resolveDiscoveryReadingFeeds(customFeedUrls: string[]): DiscoveryFeedInput[] {
  const feedUrls = [...DEFAULT_DISCOVERY_FEEDS, ...sanitizeCustomFeedUrls(customFeedUrls)];
  return feedUrls.map((feedUrl) => {
    const source = discoverySourceByFeedUrl(feedUrl);
    return {
      sourceId: source?.id ?? `custom:${feedUrl}`,
      feedUrl,
      accessPolicy: source?.accessPolicy ?? "UNKNOWN",
    };
  });
}

export async function customFeeds(db: D1Database): Promise<string[]> {
  return sanitizeCustomFeedUrls(await loadListKV(db, DISCOVERY_FEEDS_KEY, 6, []));
}

export async function setCustomFeeds(db: D1Database, feeds: string[]): Promise<void> {
  await saveListKV(db, DISCOVERY_FEEDS_KEY, sanitizeCustomFeedUrls(feeds), 6);
}
```

This intentionally treats the KV as custom-only storage. Existing registry URLs—including the legacy Hyperallergic `/feed/` alias—disappear from the custom list, while the current three curated defaults are rebuilt for every run.

Replace the RSS loop with:

```ts
for (const feed of input.feeds) {
  const result = await input.clients.rss(feed.feedUrl, 8);
  recordProviderResult(diagnostics, "rss", result);
  if (result.status !== "OK") continue;
  for (const item of result.items) {
    if (!item.url) {
      recordCandidateOutcome(diagnostics, "rss", { kind: "MISSING_ACCESS", reason: "ACCESS_UNKNOWN" });
      continue;
    }
    const accessStatus = classifyDiscoveryAccess("rss", item.url, feed.accessPolicy);
    const assessment = assessDiscoveryCandidate({
      provider: "rss",
      title: item.title,
      summary: item.summary,
      year: item.year,
      accessStatus,
    });
    if (!recordAssessment(diagnostics, "rss", assessment)) continue;
    addPending({
      externalId: item.url,
      provider: "rss",
      sourceId: feed.sourceId,
      title: item.title,
      authors: null,
      year: item.year,
      abstract: item.summary,
      score: assessment.score,
      keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
      query: feed.feedUrl.slice(0, 80),
      lane: "ORIGINAL",
      querySource: "FEED",
      url: item.url,
      accessStatus,
    });
  }
}
```

In `runDiscovery()`, replace the current `const feeds = await customFeeds(env.DB);` line with:

```ts
const feeds = resolveDiscoveryReadingFeeds(await customFeeds(env.DB));
```

In `worker/src/routes/discover.ts`, keep `GET /feeds` custom-only and replace the successful `PUT /feeds` response with the normalized stored list:

```ts
await setCustomFeeds(c.env.DB, clean);
return c.json({ feeds: await customFeeds(c.env.DB) });
```

In `web/src/views/DiscoverView.tsx`, replace the collection-label constant with:

```ts
function sourceCollectionLabel(source: DiscoverySourcePreset): string {
  if (source.autoCollect && source.target === "READING") return "읽을거리 자동 수집";
  if (source.autoCollect && source.target === "FIELD_SIGNAL") return "현장 신호 자동 수집";
  if (source.collection === "RSS") return "공식 RSS · 자동 수집 안 함";
  if (source.collection === "API") return "공식 API 연결 필요";
  return "검색 링크로 확인";
}
```

Replace `saveFeeds()` with:

```ts
async function saveFeeds() {
  const list = feeds.split("\n").map((feed) => feed.trim()).filter((feed) => /^https?:\/\//.test(feed)).slice(0, 6);
  const response = await fetch("/api/discover/feeds", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feeds: list }),
  });
  if (!response.ok) {
    setFeedMsg("피드 저장에 실패했습니다.");
    return;
  }
  const data = await response.json() as { feeds?: string[] };
  const saved = data.feeds ?? [];
  setFeeds(saved.join("\n"));
  setFeedMsg(`${saved.length}개 사용자 피드를 저장했습니다.`);
}
```

Change the feed-editor heading and help text to:

```tsx
<h2>사용자 추가 RSS·Atom 피드</h2>
<p>검증된 기본 피드는 자동으로 적용됩니다. 여기는 별도 공개 피드만 한 줄에 하나씩, 최대 6개 추가합니다. 접근이 확인되지 않은 HTML은 읽을거리 후보가 되지 않습니다.</p>
```

Finally replace `SOURCE_COLLECTION_LABELS[source.collection]` in each source row with `sourceCollectionLabel(source)`.

- [ ] **Step 6: Add RSS source balancing without changing provider quotas**

Add `sourceId?: string | null` to `SelectableDiscoveryCandidate` in `shared/src/discovery.ts`. In `selectDiscoveryCandidatesByLane()`, replace everything from `const selected: T[] = [];` through the final `return selected;` with:

```ts
const selected: T[] = [];
const selectedIds = new Set<string>();
const seenTitles = new Set<string>();
const providerCounts = new Map<string, number>();
const sourceCounts = new Map<string, number>();

const canTake = (candidate: T, balancedPass: boolean): boolean => {
  const title = normalizeDiscoveryTitle(candidate.title);
  const providerCount = providerCounts.get(candidate.provider) ?? 0;
  if (selectedIds.has(candidate.externalId) || !title || seenTitles.has(title)) return false;
  if (providerCount >= (DISCOVERY_PROVIDER_QUOTAS[candidate.provider] ?? 8)) return false;
  if (balancedPass && candidate.provider === "rss" && candidate.sourceId) {
    return (sourceCounts.get(candidate.sourceId) ?? 0) === 0;
  }
  return true;
};

const remember = (candidate: T): void => {
  const title = normalizeDiscoveryTitle(candidate.title);
  selectedIds.add(candidate.externalId);
  seenTitles.add(title);
  providerCounts.set(candidate.provider, (providerCounts.get(candidate.provider) ?? 0) + 1);
  if (candidate.sourceId) sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
  selected.push(candidate);
};

const take = (lane: DiscoveryLane, limit: number, balancedPass: boolean): void => {
  for (const candidate of ranked) {
    if (selected.length >= total || selected.filter((item) => item.lane === lane).length >= limit) break;
    if (candidate.lane !== lane || !canTake(candidate, balancedPass)) continue;
    remember(candidate);
  }
};

take("ORIGINAL", quotas.ORIGINAL, true);
take("COUNTER", quotas.COUNTER, true);

for (const candidate of ranked) {
  if (selected.length >= total) break;
  if (!canTake(candidate, false)) continue;
  remember(candidate);
}

return selected;
```

The first lane pass allows at most one selected RSS item per `sourceId`; the fallback may take a second item only when the RSS provider still has quota. Lane and provider quota behavior otherwise stays unchanged.

- [ ] **Step 7: Run reading tests and typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryPipelineAccounting.test.ts src/lib/discoveryProviderResults.test.ts src/lib/discoveryFilter.test.ts src/lib/discoverySources.test.ts src/views/DiscoverView.test.tsx
pnpm typecheck
```

Expected: focused tests PASS and workspace typechecks PASS.

- [ ] **Step 8: Commit source-aware reading collection**

```bash
git add shared/src/discovery.ts worker/src/lib/rss.ts worker/src/discovery/run.ts worker/src/routes/discover.ts web/src/views/DiscoverView.tsx web/src/lib/discoveryPipelineAccounting.test.ts web/src/lib/discoveryProviderResults.test.ts web/src/views/DiscoverView.test.tsx
git commit -m "260823: 검증된 사진 읽을거리 피드 수집"
```

## Task 3: Define deterministic field-signal assessment

**Files:**

- Create: `shared/src/fieldSignals.ts`
- Modify: `shared/src/index.ts`
- Modify: `shared/package.json`
- Test: `web/src/lib/fieldSignals.test.ts`

**Interfaces:**

- Consumes: `DiscoveryProfile`, `discoveryProviderQuery()`, `normalizeDiscoveryTitle()`.
- Produces: `DiscoveryFieldSignalType`, `DiscoveryFieldSignalStatus`, assessment/rejection contracts, `classifyDiscoveryFieldSignalType()`, `extractDiscoveryFieldSignalDates()`, `assessDiscoveryFieldSignal()` for Tasks 4–6.

- [ ] **Step 1: Write failing type, date, and relevance tests**

Create `web/src/lib/fieldSignals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assessDiscoveryFieldSignal,
  classifyDiscoveryFieldSignalType,
  extractDiscoveryFieldSignalDates,
} from "@radar/shared/fieldSignals";

const profile = {
  original: { keywords: ["photography", "machine vision"], strength: 70 },
  counter: { keywords: ["현장 선택과 사진적 증언"], strength: 30 },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("field signal classification", () => {
  it.each([
    ["Call for Papers: Photography and Machine Vision", "CALL_FOR_PAPERS"],
    ["Annual Conference on Visual Culture", "CONFERENCE"],
    ["Open Call for a Photography Residency", "RESIDENCY"],
    ["Grant and Fellowship Opportunities", "GRANT"],
    ["New Exhibition: Networked Images", "EXHIBITION"],
    ["Photography Workshop", "WORKSHOP"],
  ] as const)("classifies %s", (title, expected) => {
    expect(classifyDiscoveryFieldSignalType(title)).toBe(expected);
  });

  it("extracts only explicit event and deadline dates", () => {
    expect(extractDiscoveryFieldSignalDates(
      "Conference on September 12, 2026. Apply by 2026-08-31.",
      2026,
    )).toEqual({
      eventAt: "2026-09-12T00:00:00.000Z",
      deadlineAt: "2026-08-31T00:00:00.000Z",
    });
    expect(extractDiscoveryFieldSignalDates("Join us next autumn", 2026)).toEqual({ eventAt: null, deadlineAt: null });
  });
});

describe("field signal relevance", () => {
  it("accepts a recent photography CFP from a trusted academic source", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Photography, AI, and Visual Culture",
      summary: "A conference on machine vision, authorship, and image politics.",
      publishedAt: "2026-08-10T00:00:00.000Z",
      profile,
      sourceAnchors: ["visual arts", "art history"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: true, signalType: "CALL_FOR_PAPERS" });
  });

  it("rejects stale signals without inventing a deadline", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Photography Conference",
      summary: "Visual culture conference.",
      publishedAt: "2024-01-01T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "STALE", eventAt: null, deadlineAt: null });
  });

  it("rejects an expired deadline even when the post is recent", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Photography Conference",
      summary: "Deadline 2026-08-20.",
      publishedAt: "2026-08-18T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "EXPIRED", deadlineAt: "2026-08-20T00:00:00.000Z" });
  });

  it("does not trust a source anchor unless the item text matches it", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Agricultural Trade",
      summary: "A conference about crop exports.",
      publishedAt: "2026-08-20T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography", "visual culture"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "NO_RESEARCH_MATCH" });
  });

  it("rejects generic institution news with no research match", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Office Holiday Hours Updated",
      summary: "The office will close early on Friday.",
      publishedAt: "2026-08-20T00:00:00.000Z",
      profile,
      sourceAnchors: [],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "NO_RESEARCH_MATCH" });
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/fieldSignals.test.ts
```

Expected: FAIL because `@radar/shared/fieldSignals` does not exist.

- [ ] **Step 3: Create the complete shared signal contract and pure functions**

Create `shared/src/fieldSignals.ts`:

```ts
import type { DiscoveryProfile } from "./discovery";
import { discoveryProviderQuery, normalizeDiscoveryTitle } from "./discovery";

export const DISCOVERY_FIELD_SIGNAL_MIN_SCORE = 0.55;

export type DiscoveryFieldSignalType =
  | "CONFERENCE"
  | "CALL_FOR_PAPERS"
  | "EXHIBITION"
  | "GRANT"
  | "RESIDENCY"
  | "WORKSHOP"
  | "INSTITUTION_NEWS"
  | "OTHER";

export type DiscoveryFieldSignalStatus = "NEW" | "SAVED" | "DISMISSED";
export type DiscoveryFieldSignalRejectionReason =
  | "NO_RESEARCH_MATCH"
  | "STALE"
  | "EXPIRED"
  | "MISSING_URL"
  | "DUPLICATE"
  | "SOURCE_QUOTA";

export interface DiscoveryFieldSignal {
  id: string;
  sourceId: string;
  sourceName: string;
  externalUrl: string;
  title: string;
  summary: string | null;
  signalType: DiscoveryFieldSignalType;
  publishedAt: string | null;
  eventAt: string | null;
  deadlineAt: string | null;
  matchedTerms: string[];
  relevanceScore: number;
  status: DiscoveryFieldSignalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryFieldSignalAssessmentInput {
  title: string;
  summary?: string | null;
  publishedAt?: string | null;
  profile: DiscoveryProfile;
  sourceAnchors: string[];
  now?: Date;
}

export interface DiscoveryFieldSignalAssessment {
  accepted: boolean;
  reason: "RELEVANT" | DiscoveryFieldSignalRejectionReason;
  score: number;
  signalType: DiscoveryFieldSignalType;
  matchedTerms: string[];
  eventAt: string | null;
  deadlineAt: string | null;
}

const TYPE_PATTERNS: Array<[DiscoveryFieldSignalType, RegExp]> = [
  ["CALL_FOR_PAPERS", /\b(call for papers?|cfp|call for proposals?|paper submissions?)\b/i],
  ["RESIDENCY", /\b(residenc(?:y|ies)|artist in residence|open call)\b/i],
  ["GRANT", /\b(grants?|fellowships?|funding|award applications?)\b/i],
  ["CONFERENCE", /\b(conferences?|symposi(?:um|a)|congress|annual meeting)\b/i],
  ["EXHIBITION", /\b(exhibitions?|biennial|triennial|on view|opening)\b/i],
  ["WORKSHOP", /\b(workshops?|seminars?|masterclasses?|lecture series)\b/i],
  ["INSTITUTION_NEWS", /\b(appoints?|announces?|acquires?|collection|museum news|prize winners?)\b/i],
];

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export function classifyDiscoveryFieldSignalType(text: string): DiscoveryFieldSignalType {
  return TYPE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "OTHER";
}

function isoDate(year: number, monthIndex: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day
    ? date.toISOString()
    : null;
}

export function extractDiscoveryFieldSignalDates(text: string, defaultYear: number): { eventAt: string | null; deadlineAt: string | null } {
  const deadlineMatch = text.match(/(?:apply by|deadline|closes?|due)\D{0,12}(\d{4})-(\d{2})-(\d{2})/i);
  const deadlineAt = deadlineMatch
    ? isoDate(Number(deadlineMatch[1]), Number(deadlineMatch[2]) - 1, Number(deadlineMatch[3]))
    : null;
  const monthMatch = text.match(new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`, "i"));
  const eventAt = monthMatch
    ? isoDate(Number(monthMatch[3] ?? defaultYear), MONTHS[monthMatch[1]!.toLowerCase()]!, Number(monthMatch[2]))
    : null;
  return { eventAt, deadlineAt };
}

function profileTerms(profile: DiscoveryProfile): string[] {
  const values = [...profile.original.keywords, ...profile.counter.keywords];
  const tokens = values.flatMap((value) => [value, discoveryProviderQuery(value)]).flatMap((value) =>
    normalizeDiscoveryTitle(value).split(" ").filter((token) => token.length >= 3),
  );
  return [...new Set(tokens)];
}

export function assessDiscoveryFieldSignal(input: DiscoveryFieldSignalAssessmentInput): DiscoveryFieldSignalAssessment {
  const now = input.now ?? new Date();
  const title = normalizeDiscoveryTitle(input.title);
  const summary = normalizeDiscoveryTitle(input.summary ?? "");
  const fullText = `${title} ${summary}`.trim();
  const signalType = classifyDiscoveryFieldSignalType(fullText);
  const published = input.publishedAt ? new Date(input.publishedAt) : null;
  const ageMs = published && Number.isFinite(published.getTime()) ? now.getTime() - published.getTime() : null;
  const dates = extractDiscoveryFieldSignalDates(`${input.title} ${input.summary ?? ""}`, now.getUTCFullYear());
  if (ageMs !== null && ageMs > 365 * 24 * 60 * 60 * 1000) {
    return { accepted: false, reason: "STALE", score: 0, signalType, matchedTerms: [], ...dates };
  }

  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const actionableAt = dates.deadlineAt ?? dates.eventAt;
  if (actionableAt && new Date(actionableAt).getTime() < currentDay) {
    return { accepted: false, reason: "EXPIRED", score: 0, signalType, matchedTerms: [], ...dates };
  }

  const terms = profileTerms(input.profile);
  const sourceTerms = input.sourceAnchors.flatMap((value) =>
    normalizeDiscoveryTitle(value).split(" ").filter((token) => token.length >= 3),
  );
  const titleMatches = terms.filter((term) => title.includes(term));
  const summaryMatches = terms.filter((term) => summary.includes(term));
  const matchedTerms = [...new Set([...titleMatches, ...summaryMatches])].slice(0, 8);
  const sourceMatches = [...new Set(sourceTerms.filter((term) => fullText.includes(term)))];
  if (sourceMatches.length === 0 && matchedTerms.length === 0) {
    return { accepted: false, reason: "NO_RESEARCH_MATCH", score: 0.1, signalType, matchedTerms, ...dates };
  }
  if (signalType === "OTHER" && matchedTerms.length === 0) {
    return { accepted: false, reason: "NO_RESEARCH_MATCH", score: 0.25, signalType, matchedTerms, ...dates };
  }

  let score = 0.25;
  if (sourceMatches.length > 0) score += 0.15;
  if (titleMatches.length > 0) score += 0.2;
  if (summaryMatches.length > 0) score += 0.1;
  if (signalType !== "OTHER") score += 0.15;
  if (ageMs === null || ageMs <= 90 * 24 * 60 * 60 * 1000) score += 0.1;
  const rounded = Math.min(1, Number(score.toFixed(2)));
  return {
    accepted: rounded >= DISCOVERY_FIELD_SIGNAL_MIN_SCORE,
    reason: rounded >= DISCOVERY_FIELD_SIGNAL_MIN_SCORE ? "RELEVANT" : "NO_RESEARCH_MATCH",
    score: rounded,
    signalType,
    matchedTerms,
    ...dates,
  };
}
```

Export it from `shared/src/index.ts` and add `"./fieldSignals": "./src/fieldSignals.ts"` to `shared/package.json` exports.

- [ ] **Step 4: Run the focused tests and typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/fieldSignals.test.ts
pnpm typecheck
```

Expected: field-signal tests PASS and every workspace typecheck PASS.

- [ ] **Step 5: Commit the field-signal domain contract**

```bash
git add shared/src/fieldSignals.ts shared/src/index.ts shared/package.json web/src/lib/fieldSignals.test.ts
git commit -m "260823: 현장 신호 분류와 관련성 계약"
```

## Task 4: Add the D1 schema and field-signal collector

**Files:**

- Create: `worker/migrations/0014_discovery_field_signals.sql`
- Create: `worker/src/discovery/fieldSignals.ts`
- Modify: `shared/src/fieldSignals.ts`
- Modify: `worker/src/discovery/run.ts:37-46,390-430`
- Test: `web/src/lib/fieldSignalCollector.test.ts`

**Interfaces:**

- Consumes: curated `FIELD_SIGNAL` presets, `fetchFeed()`, `assessDiscoveryFieldSignal()`, `FeedItem`, `uuid()`.
- Produces: `DiscoveryFieldSignalRunDiagnostics`, `DiscoveryFieldSignalRunResult`, `PendingDiscoveryFieldSignal`, `collectDiscoveryFieldSignals()`, and `runDiscoveryFieldSignals()` for Task 5.

- [ ] **Step 1: Write a failing collector test with two source outcomes**

Create `web/src/lib/fieldSignalCollector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectDiscoveryFieldSignals } from "../../../worker/src/discovery/fieldSignals";

const profile = {
  original: { keywords: ["photography", "visual culture"], strength: 70 },
  counter: { keywords: [], strength: 0 },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("field signal collector", () => {
  it("tracks selected, stale, duplicate, and failed-source outcomes separately", async () => {
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set(["https://caa.example/duplicate"]),
      sources: [
        { id: "caa-news", name: "CAA News", feedUrl: "https://caa.example/feed", topicAnchors: ["visual arts", "art history"] },
        { id: "icp", name: "ICP", feedUrl: "https://icp.example/feed", topicAnchors: ["photography"] },
      ],
      rss: async (url) => {
        if (url.includes("icp")) return { status: "TIMEOUT" as const, items: [], errorCode: "TIMEOUT", elapsedMs: 12_000 };
        return {
          status: "OK" as const,
          errorCode: null,
          elapsedMs: 10,
          items: [
            { title: "Call for Papers: Photography and Visual Culture", url: "https://caa.example/cfp", year: 2026, publishedAt: "2026-08-20T00:00:00.000Z", summary: "Conference on photography and image politics." },
            { title: "Photography Conference", url: "https://caa.example/old", year: 2024, publishedAt: "2024-01-01T00:00:00.000Z", summary: "Visual culture." },
            { title: "Visual Arts Grant", url: "https://caa.example/duplicate", year: 2026, publishedAt: "2026-08-21T00:00:00.000Z", summary: "Funding opportunity." },
          ],
        };
      },
    });

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({ sourceId: "caa-news", signalType: "CALL_FOR_PAPERS" });
    expect(result.diagnostics.sources["caa-news"]).toMatchObject({
      requests: 1,
      succeededRequests: 1,
      received: 3,
      stale: 1,
      duplicate: 1,
      selected: 1,
    });
    expect(result.diagnostics.sources.icp).toMatchObject({ requests: 1, failedRequests: 1, selected: 0 });
    expect(result.diagnostics.incomplete).toBe(true);
  });

  it("caps each source at four and the whole run at twelve", async () => {
    const sources = ["a", "b", "c", "d"].map((id) => ({
      id,
      name: id.toUpperCase(),
      feedUrl: `https://${id}.example/feed`,
      topicAnchors: ["photography"],
    }));
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set<string>(),
      sources,
      rss: async (url) => ({
        status: "OK" as const,
        errorCode: null,
        elapsedMs: 1,
        items: Array.from({ length: 6 }, (_, index) => ({
          title: `Photography Workshop ${url} ${index}`,
          url: `${url}/${index}`,
          year: 2026,
          publishedAt: `2026-08-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
          summary: "Photography and visual culture workshop.",
        })),
      }),
    });

    expect(result.pending).toHaveLength(12);
    expect(Math.max(...sources.map((source) => result.pending.filter((item) => item.sourceId === source.id).length))).toBe(4);
  });
});
```

- [ ] **Step 2: Run the collector test and verify the missing module failure**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/fieldSignalCollector.test.ts
```

Expected: FAIL because `worker/src/discovery/fieldSignals.ts` does not exist.

- [ ] **Step 3: Add the forward-only migration**

Create `worker/migrations/0014_discovery_field_signals.sql`:

```sql
ALTER TABLE discovery_candidates ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_discovery_candidate_source
  ON discovery_candidates(source_id, status, relevance_score DESC);

CREATE TABLE IF NOT EXISTS discovery_field_signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'CONFERENCE', 'CALL_FOR_PAPERS', 'EXHIBITION', 'GRANT',
    'RESIDENCY', 'WORKSHOP', 'INSTITUTION_NEWS', 'OTHER'
  )),
  published_at TEXT,
  event_at TEXT,
  deadline_at TEXT,
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  relevance_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'SAVED', 'DISMISSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_field_signal_url
  ON discovery_field_signals(external_url);

CREATE INDEX IF NOT EXISTS idx_discovery_field_signal_status
  ON discovery_field_signals(status, relevance_score DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_field_signal_deadline
  ON discovery_field_signals(deadline_at, status);
```

- [ ] **Step 4: Add diagnostics contracts to the shared signal module**

Append to `shared/src/fieldSignals.ts`:

```ts
export interface DiscoveryFieldSignalSourceStats {
  requests: number;
  succeededRequests: number;
  failedRequests: number;
  received: number;
  rejected: number;
  stale: number;
  expired: number;
  missingUrl: number;
  duplicate: number;
  quotaExcluded: number;
  selected: number;
  errorCodes: string[];
}

export interface DiscoveryFieldSignalRunDiagnostics {
  sources: Record<string, DiscoveryFieldSignalSourceStats>;
  rejectedByReason: Partial<Record<DiscoveryFieldSignalRejectionReason, number>>;
  incomplete: boolean;
}

export interface DiscoveryFieldSignalRunResult {
  collected: number;
  diagnostics: DiscoveryFieldSignalRunDiagnostics;
}

export function emptyDiscoveryFieldSignalSourceStats(): DiscoveryFieldSignalSourceStats {
  return {
    requests: 0,
    succeededRequests: 0,
    failedRequests: 0,
    received: 0,
    rejected: 0,
    stale: 0,
    expired: 0,
    missingUrl: 0,
    duplicate: 0,
    quotaExcluded: 0,
    selected: 0,
    errorCodes: [],
  };
}
```

- [ ] **Step 5: Create the complete collector and persistence module**

Create `worker/src/discovery/fieldSignals.ts`:

```ts
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { normalizeDiscoveryTitle, type DiscoveryProfile } from "@radar/shared/discovery";
import {
  assessDiscoveryFieldSignal,
  emptyDiscoveryFieldSignalSourceStats,
  type DiscoveryFieldSignalRejectionReason,
  type DiscoveryFieldSignalRunDiagnostics,
  type DiscoveryFieldSignalRunResult,
  type DiscoveryFieldSignalSourceStats,
  type DiscoveryFieldSignalType,
} from "@radar/shared/fieldSignals";
import type { DiscoveryProviderResult } from "@radar/shared/discoveryRun";
import { uuid } from "../ingestion/ids";
import { fetchFeed, type FeedItem } from "../lib/rss";

const MAX_FIELD_SIGNALS_PER_RUN = 12;
const MAX_FIELD_SIGNALS_PER_SOURCE = 4;

export interface DiscoveryFieldSignalSourceInput {
  id: string;
  name: string;
  feedUrl: string;
  topicAnchors: string[];
}

export interface PendingDiscoveryFieldSignal {
  sourceId: string;
  sourceName: string;
  externalUrl: string;
  title: string;
  summary: string | null;
  signalType: DiscoveryFieldSignalType;
  publishedAt: string | null;
  eventAt: string | null;
  deadlineAt: string | null;
  matchedTerms: string[];
  relevanceScore: number;
}

export interface DiscoveryFieldSignalCollectionInput {
  profile: DiscoveryProfile;
  sources: DiscoveryFieldSignalSourceInput[];
  existingUrls: Set<string>;
  now?: Date;
  rss: (url: string, limit: number) => Promise<DiscoveryProviderResult<FeedItem>>;
}

export interface DiscoveryFieldSignalCollectionResult {
  pending: PendingDiscoveryFieldSignal[];
  diagnostics: DiscoveryFieldSignalRunDiagnostics;
}

function countReason(diagnostics: DiscoveryFieldSignalRunDiagnostics, reason: DiscoveryFieldSignalRejectionReason): void {
  diagnostics.rejectedByReason[reason] = (diagnostics.rejectedByReason[reason] ?? 0) + 1;
}

function compareSignals(a: PendingDiscoveryFieldSignal, b: PendingDiscoveryFieldSignal): number {
  if (a.relevanceScore !== b.relevanceScore) return b.relevanceScore - a.relevanceScore;
  const aActionDate = a.deadlineAt ?? a.eventAt;
  const bActionDate = b.deadlineAt ?? b.eventAt;
  if (aActionDate && bActionDate && aActionDate !== bActionDate) return aActionDate.localeCompare(bActionDate);
  if (aActionDate && !bActionDate) return -1;
  if (!aActionDate && bActionDate) return 1;
  return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
}

export async function collectDiscoveryFieldSignals(input: DiscoveryFieldSignalCollectionInput): Promise<DiscoveryFieldSignalCollectionResult> {
  const diagnostics: DiscoveryFieldSignalRunDiagnostics = { sources: {}, rejectedByReason: {}, incomplete: false };
  const accepted: PendingDiscoveryFieldSignal[] = [];
  const seenUrls = new Set(input.existingUrls);
  const seenTitles = new Set<string>();

  for (const source of input.sources) {
    const stats: DiscoveryFieldSignalSourceStats = emptyDiscoveryFieldSignalSourceStats();
    diagnostics.sources[source.id] = stats;
    stats.requests += 1;
    const result = await input.rss(source.feedUrl, 12);
    if (result.status !== "OK") {
      stats.failedRequests += 1;
      if (result.errorCode && !stats.errorCodes.includes(result.errorCode) && stats.errorCodes.length < 5) {
        stats.errorCodes.push(result.errorCode);
      }
      diagnostics.incomplete = true;
      continue;
    }
    stats.succeededRequests += 1;
    stats.received += result.items.length;

    const sourceAccepted: PendingDiscoveryFieldSignal[] = [];
    for (const item of result.items) {
      if (!item.url) {
        stats.missingUrl += 1;
        countReason(diagnostics, "MISSING_URL");
        continue;
      }
      if (seenUrls.has(item.url)) {
        stats.duplicate += 1;
        countReason(diagnostics, "DUPLICATE");
        continue;
      }
      const assessment = assessDiscoveryFieldSignal({
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        profile: input.profile,
        sourceAnchors: source.topicAnchors,
        now: input.now,
      });
      if (!assessment.accepted) {
        stats.rejected += 1;
        if (assessment.reason === "STALE") stats.stale += 1;
        if (assessment.reason === "EXPIRED") stats.expired += 1;
        if (assessment.reason !== "RELEVANT") countReason(diagnostics, assessment.reason);
        continue;
      }
      const titleKey = `${normalizeDiscoveryTitle(item.title)}|${assessment.deadlineAt ?? assessment.eventAt ?? item.publishedAt ?? ""}`;
      if (seenTitles.has(titleKey)) {
        stats.duplicate += 1;
        countReason(diagnostics, "DUPLICATE");
        continue;
      }
      seenUrls.add(item.url);
      seenTitles.add(titleKey);
      sourceAccepted.push({
        sourceId: source.id,
        sourceName: source.name,
        externalUrl: item.url,
        title: item.title.slice(0, 300),
        summary: item.summary?.slice(0, 1000) ?? null,
        signalType: assessment.signalType,
        publishedAt: item.publishedAt,
        eventAt: assessment.eventAt,
        deadlineAt: assessment.deadlineAt,
        matchedTerms: assessment.matchedTerms,
        relevanceScore: assessment.score,
      });
    }

    sourceAccepted.sort(compareSignals);
    accepted.push(...sourceAccepted.slice(0, MAX_FIELD_SIGNALS_PER_SOURCE));
    const excluded = Math.max(0, sourceAccepted.length - MAX_FIELD_SIGNALS_PER_SOURCE);
    stats.quotaExcluded += excluded;
    for (let index = 0; index < excluded; index += 1) countReason(diagnostics, "SOURCE_QUOTA");
  }

  const selected = accepted.sort(compareSignals).slice(0, MAX_FIELD_SIGNALS_PER_RUN);
  const selectedUrls = new Set(selected.map((item) => item.externalUrl));
  for (const item of accepted) {
    const stats = diagnostics.sources[item.sourceId]!;
    if (selectedUrls.has(item.externalUrl)) stats.selected += 1;
    else {
      stats.quotaExcluded += 1;
      countReason(diagnostics, "SOURCE_QUOTA");
    }
  }
  return { pending: selected, diagnostics };
}

export async function runDiscoveryFieldSignals(env: Env, profile: DiscoveryProfile): Promise<DiscoveryFieldSignalRunResult> {
  const sources = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
    source.autoCollect && source.collection === "RSS" && source.target === "FIELD_SIGNAL" && source.feedUrl
      ? [{ id: source.id, name: source.name, feedUrl: source.feedUrl, topicAnchors: source.topicAnchors }]
      : [],
  );
  const existing = await env.DB.prepare("SELECT external_url FROM discovery_field_signals").all<{ external_url: string }>();
  const collection = await collectDiscoveryFieldSignals({
    profile,
    sources,
    existingUrls: new Set((existing.results ?? []).map((row) => row.external_url)),
    rss: fetchFeed,
  });
  const now = new Date().toISOString();
  const statements = collection.pending.map((item) => env.DB.prepare(
    `INSERT INTO discovery_field_signals
      (id, source_id, external_url, title, summary, signal_type, published_at, event_at, deadline_at,
       matched_terms_json, relevance_score, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)`,
  ).bind(
    uuid(), item.sourceId, item.externalUrl, item.title, item.summary, item.signalType,
    item.publishedAt, item.eventAt, item.deadlineAt, JSON.stringify(item.matchedTerms),
    item.relevanceScore, now, now,
  ));
  if (statements.length > 0) await env.DB.batch(statements);
  return { collected: collection.pending.length, diagnostics: collection.diagnostics };
}
```

- [ ] **Step 6: Persist reading source provenance**

In the `INSERT INTO discovery_candidates` statement in `worker/src/discovery/run.ts`, add `source_id` after `query_source`, add one `?` after the existing final placeholder, and add `candidate.sourceId` as the final binding. Do not add `source_id` to the maintenance SELECT because access reassessment does not consume it; the API projection is updated in Task 5.

- [ ] **Step 7: Run collector tests, all unit tests, and typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/fieldSignals.test.ts src/lib/fieldSignalCollector.test.ts src/lib/discoveryPipelineAccounting.test.ts
pnpm --filter @radar/web exec vitest run
pnpm typecheck
```

Expected: collector tests PASS, the existing web test suite PASS, and typechecks PASS.

- [ ] **Step 8: Commit schema and collection**

```bash
git add worker/migrations/0014_discovery_field_signals.sql shared/src/fieldSignals.ts worker/src/discovery/fieldSignals.ts worker/src/discovery/run.ts web/src/lib/fieldSignalCollector.test.ts
git commit -m "260823: 현장 신호 수집 스키마와 파이프라인"
```

## Task 5: Integrate field signals into Discovery jobs and APIs

**Files:**

- Modify: `shared/src/discoveryRun.ts`
- Modify: `worker/src/discovery/run.ts:316-435`
- Modify: `worker/src/discovery/diagnostics.ts`
- Modify: `worker/src/workflows/researchJob.ts:17-95`
- Modify: `worker/src/routes/discover.ts:10-131`
- Modify: `worker/src/index.ts:93-118`
- Test: `web/src/lib/discoveryJobOutcome.test.ts`

**Interfaces:**

- Consumes: `runDiscoveryFieldSignals()`, current `DiscoveryRunResult`, `discoveryJobOutcome()`.
- Produces: one job result with `fieldSignalsCollected` and `fieldSignalDiagnostics`, list/action endpoints, and whole-job failure semantics for Task 6.

- [ ] **Step 1: Write failing whole-job outcome tests**

Replace the existing diagnostics import in `web/src/lib/discoveryJobOutcome.test.ts` with the combined import below, then add the two tests after the current `describe` block:

```ts
import { discoveryCombinedJobOutcome, discoveryJobOutcome } from "../../../worker/src/discovery/diagnostics";

it("succeeds when reading providers fail but a field-signal source succeeds", () => {
  expect(discoveryCombinedJobOutcome(
    "FAILED",
    {
      sources: {
        icp: { requests: 1, succeededRequests: 1, failedRequests: 0, received: 2, rejected: 0, stale: 0, expired: 0, missingUrl: 0, duplicate: 0, quotaExcluded: 0, selected: 2, errorCodes: [] },
      },
      rejectedByReason: {},
      incomplete: false,
    },
  )).toBe("SUCCEEDED");
});

it("fails only when reading and field-signal providers are both unavailable", () => {
  expect(discoveryCombinedJobOutcome(
    "FAILED",
    {
      sources: {
        icp: { requests: 1, succeededRequests: 0, failedRequests: 1, received: 0, rejected: 0, stale: 0, expired: 0, missingUrl: 0, duplicate: 0, quotaExcluded: 0, selected: 0, errorCodes: ["TIMEOUT"] },
      },
      rejectedByReason: {},
      incomplete: true,
    },
  )).toBe("FAILED");
});
```

- [ ] **Step 2: Run the focused test and verify the missing function failure**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryJobOutcome.test.ts
```

Expected: FAIL because `discoveryCombinedJobOutcome()` does not exist.

- [ ] **Step 3: Extend the shared run-result contract**

In `shared/src/discoveryRun.ts`, import `DiscoveryFieldSignalRunDiagnostics` and replace `DiscoveryRunResult` with:

```ts
export interface DiscoveryRunResult {
  collected: number;
  fieldSignalsCollected: number;
  keptExisting: number;
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
  fieldSignalDiagnostics: DiscoveryFieldSignalRunDiagnostics;
}
```

- [ ] **Step 4: Run both collectors from `runDiscovery()`**

Import `runDiscoveryFieldSignals` in `worker/src/discovery/run.ts`. After reading-candidate persistence, execute:

```ts
const fieldSignals = await runDiscoveryFieldSignals(env, profile);
return {
  collected: collection.pending.length,
  fieldSignalsCollected: fieldSignals.collected,
  keptExisting: existingRows.filter((row) => row.status === "KEPT" || row.status === "WATCHED" || row.status === "CANDIDATE").length,
  queries: collection.queries,
  diagnostics: collection.diagnostics,
  fieldSignalDiagnostics: fieldSignals.diagnostics,
};
```

- [ ] **Step 5: Add whole-job outcome classification**

Add `DiscoveryFieldSignalRunDiagnostics` to the existing top-level type imports in `worker/src/discovery/diagnostics.ts`, then append the function:

```ts
export function discoveryCombinedJobOutcome(
  readingOutcome: "SUCCEEDED" | "FAILED" | "BLOCKED",
  fieldSignals: DiscoveryFieldSignalRunDiagnostics,
): "SUCCEEDED" | "FAILED" | "BLOCKED" {
  if (readingOutcome === "SUCCEEDED") return "SUCCEEDED";
  const signalSucceeded = Object.values(fieldSignals.sources).some((source) => source.succeededRequests > 0);
  if (signalSucceeded) return "SUCCEEDED";
  return readingOutcome;
}
```

The return union is intentionally identical to the existing `discoveryJobOutcome()` contract: `"SUCCEEDED" | "FAILED" | "BLOCKED"`.

- [ ] **Step 6: Store both branches in the Workflow result**

Extend `WorkflowStepResult.result` in `worker/src/workflows/researchJob.ts` with:

```ts
fieldSignalsCollected?: number;
fieldSignalDiagnostics?: DiscoveryFieldSignalRunDiagnostics;
```

Replace the Discovery outcome block with:

```ts
const readingOutcome = discoveryJobOutcome(result.diagnostics, result.diagnostics.providers.rss.requests > 0);
const outcome = discoveryCombinedJobOutcome(readingOutcome, result.fieldSignalDiagnostics);
if (outcome === "FAILED") throw new Error("discovery_providers_unavailable");
if (outcome === "BLOCKED") throw new JobBlockedError("discovery_queries_unusable", "검색어를 짧은 개념어로 수정하세요.");
return {
  result: {
    collected: result.collected,
    fieldSignalsCollected: result.fieldSignalsCollected,
    keptExisting: result.keptExisting,
    queries: result.queries,
    diagnostics: result.diagnostics,
    fieldSignalDiagnostics: result.fieldSignalDiagnostics,
  },
  resultRef: { view: "DISCOVER" },
};
```

Import both `DiscoveryFieldSignalRunDiagnostics` and `discoveryCombinedJobOutcome`.

- [ ] **Step 7: Add field-signal list and action routes**

Add to `worker/src/routes/discover.ts` before the feed settings routes:

```ts
const FIELD_SIGNAL_STATUSES = new Set(["NEW", "SAVED", "DISMISSED"]);
const FIELD_SIGNAL_TYPES = new Set([
  "CONFERENCE", "CALL_FOR_PAPERS", "EXHIBITION", "GRANT",
  "RESIDENCY", "WORKSHOP", "INSTITUTION_NEWS", "OTHER",
]);

function parseMatchedTerms(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((term): term is string => typeof term === "string")
      : [];
  } catch {
    return [];
  }
}

discover.get("/signals", async (c) => {
  const status = FIELD_SIGNAL_STATUSES.has(c.req.query("status") ?? "") ? c.req.query("status")! : "NEW";
  const type = c.req.query("type") ?? "";
  const typeClause = FIELD_SIGNAL_TYPES.has(type) ? " AND signal_type = ?" : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, source_id AS sourceId, external_url AS externalUrl, title, summary,
            signal_type AS signalType, published_at AS publishedAt, event_at AS eventAt,
            deadline_at AS deadlineAt, matched_terms_json AS matchedTermsJson,
            relevance_score AS relevanceScore, status, created_at AS createdAt, updated_at AS updatedAt
     FROM discovery_field_signals
     WHERE status = ?${typeClause}
     ORDER BY relevance_score DESC,
              CASE WHEN deadline_at IS NOT NULL OR event_at IS NOT NULL THEN 0 ELSE 1 END ASC,
              COALESCE(deadline_at, event_at) ASC,
              COALESCE(published_at, created_at) DESC
     LIMIT 50`,
  ).bind(...(typeClause ? [status, type] : [status])).all<Record<string, unknown>>();
  const sourceNames = new Map(DISCOVERY_SOURCE_PRESETS.map((source) => [source.id, source.name]));
  const items = (rows.results ?? []).map((row) => ({
    ...row,
    sourceName: sourceNames.get(String(row.sourceId)) ?? String(row.sourceId),
    matchedTerms: parseMatchedTerms(row.matchedTermsJson),
    matchedTermsJson: undefined,
  }));
  return c.json({ items });
});

discover.post("/signals/:id/:action", async (c) => {
  const action = c.req.param("action");
  const nextStatus = action === "save" ? "SAVED" : action === "dismiss" ? "DISMISSED" : action === "restore" ? "NEW" : null;
  if (!nextStatus) return c.json({ error: "invalid_action" }, 400);
  const updatedAt = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE discovery_field_signals SET status = ?, updated_at = ? WHERE id = ?",
  ).bind(nextStatus, updatedAt, c.req.param("id")).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, status: nextStatus, updatedAt });
});
```

In both projections of the `GET /candidates` query, append `source_id AS sourceId` after `query_source AS querySource`. The Keep/Watch/Ignore action query remains unchanged because it does not consume source provenance.

- [ ] **Step 8: Include field-signal counts in cron logs**

Change the Discovery cron log in `worker/src/index.ts` to:

```ts
console.log(JSON.stringify({
  level: "info",
  cron: event.cron,
  discovery: result.collected,
  fieldSignals: result.fieldSignalsCollected,
  queries: result.queries,
}));
```

- [ ] **Step 9: Run focused tests and typecheck**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/lib/discoveryJobOutcome.test.ts src/lib/fieldSignalCollector.test.ts
pnpm typecheck
```

Expected: focused tests PASS and all workspace typechecks PASS.

- [ ] **Step 10: Commit API and workflow integration**

```bash
git add shared/src/discoveryRun.ts worker/src/discovery/run.ts worker/src/discovery/diagnostics.ts worker/src/workflows/researchJob.ts worker/src/routes/discover.ts worker/src/index.ts web/src/lib/discoveryJobOutcome.test.ts
git commit -m "260823: 발견 작업에 현장 신호 통합"
```

## Task 6: Build the separate field-signal experience in Discover

**Files:**

- Create: `web/src/components/discovery/FieldSignalList.tsx`
- Create: `web/src/components/discovery/FieldSignalRunSummary.tsx`
- Modify: `web/src/views/DiscoverView.tsx:1-254`
- Modify: `web/src/styles/views.css:185-250`
- Test: `web/src/views/DiscoverView.test.tsx`

**Interfaces:**

- Consumes: `DiscoveryFieldSignal`, `DiscoveryFieldSignalRunDiagnostics`, `/api/discover/signals`, and the extended Discovery job result.
- Produces: `읽을거리 / 현장 신호` mode switch, field-signal status/type filters, cards, save/dismiss/restore actions, and separate run diagnostics.

- [ ] **Step 1: Extend fetch mocks and write failing UI tests**

In `web/src/views/DiscoverView.test.tsx`, add this signal fixture:

```ts
const fieldSignal = {
  id: "signal-1",
  sourceId: "caa-news",
  sourceName: "CAA News",
  externalUrl: "https://www.collegeart.org/news/cfp-photography",
  title: "Call for Papers: Photography and Visual Culture",
  summary: "A conference on photography, AI, and image politics.",
  signalType: "CALL_FOR_PAPERS",
  publishedAt: "2026-08-20T00:00:00.000Z",
  eventAt: "2026-09-12T00:00:00.000Z",
  deadlineAt: "2026-08-31T00:00:00.000Z",
  matchedTerms: ["photography", "visual culture"],
  relevanceScore: 0.85,
  status: "NEW",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};
```

Extend the global fetch stub:

```ts
if (url.startsWith("/api/discover/signals?") && !init?.method) {
  return Promise.resolve(new Response(JSON.stringify({ items: [fieldSignal] })));
}
if (url === "/api/discover/signals/signal-1/save" && init?.method === "POST") {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "SAVED" })));
}
```

Add these tests:

```ts
it("shows field signals separately from reading candidates", async () => {
  render(<DiscoverView onNavigate={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "현장 신호" }));
  expect(await screen.findByRole("heading", { name: "Call for Papers: Photography and Visual Culture" })).toBeVisible();
  expect(screen.getByText("CAA News")).toBeVisible();
  expect(screen.getByText("마감 2026. 8. 31.")).toBeVisible();
  expect(screen.queryByRole("option", { name: /자료 후보/ })).not.toBeInTheDocument();
});

it("saves a field signal without promoting it to Reservoir", async () => {
  render(<DiscoverView onNavigate={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "현장 신호" }));
  await userEvent.click(await screen.findByRole("button", { name: "신호 저장" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    "/api/discover/signals/signal-1/save",
    { method: "POST" },
  ));
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/signals"), expect.anything());
});
```

- [ ] **Step 2: Run the view tests and verify the missing UI failures**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
```

Expected: FAIL because the mode switch and field-signal components do not exist.

- [ ] **Step 3: Create the field-signal list component**

Create `web/src/components/discovery/FieldSignalList.tsx`:

```tsx
import type { DiscoveryFieldSignal, DiscoveryFieldSignalStatus, DiscoveryFieldSignalType } from "@radar/shared/fieldSignals";

const TYPE_LABELS: Record<DiscoveryFieldSignalType, string> = {
  CONFERENCE: "학회·심포지엄",
  CALL_FOR_PAPERS: "CFP",
  EXHIBITION: "전시",
  GRANT: "지원·펠로십",
  RESIDENCY: "레지던시",
  WORKSHOP: "워크숍",
  INSTITUTION_NEWS: "기관 소식",
  OTHER: "기타",
};

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}.`;
}

export default function FieldSignalList({
  items,
  status,
  pendingId,
  onAction,
}: {
  items: DiscoveryFieldSignal[];
  status: DiscoveryFieldSignalStatus;
  pendingId: string | null;
  onAction: (id: string, action: "save" | "dismiss" | "restore") => void;
}) {
  if (items.length === 0) return <p className="discovery-field-signals__empty">표시할 현장 신호가 없습니다.</p>;
  return <section className="discovery-field-signals" aria-label="현장 신호 목록">
    {items.map((item) => {
      const published = dateLabel(item.publishedAt);
      const event = dateLabel(item.eventAt);
      const deadline = dateLabel(item.deadlineAt);
      return <article className="discovery-field-signal" key={item.id}>
        <div className="discovery-field-signal__badges">
          <span>{TYPE_LABELS[item.signalType]}</span>
          <span>{item.sourceName}</span>
          <strong>관련도 {item.relevanceScore.toFixed(2)}</strong>
        </div>
        <h2><a href={item.externalUrl} target="_blank" rel="noreferrer">{item.title}</a></h2>
        <p className="discovery-field-signal__dates">
          {[published ? `게시 ${published}` : null, event ? `행사 ${event}` : null, deadline ? `마감 ${deadline}` : null].filter(Boolean).join(" · ")}
        </p>
        {item.summary && <p>{item.summary}</p>}
        {item.matchedTerms.length > 0 && <div className="discovery-field-signal__terms">{item.matchedTerms.map((term) => <span key={term}>{term}</span>)}</div>}
        <div className="discovery-field-signal__actions">
          {status === "NEW" && <>
            <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "save")}>신호 저장</button>
            <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "dismiss")}>제외</button>
          </>}
          {status === "SAVED" && <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "dismiss")}>제외</button>}
          {status === "DISMISSED" && <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "restore")}>복구</button>}
        </div>
      </article>;
    })}
  </section>;
}
```

- [ ] **Step 4: Create a compact per-source signal diagnostic component**

Create `web/src/components/discovery/FieldSignalRunSummary.tsx`:

```tsx
import type { DiscoveryFieldSignalRunDiagnostics } from "@radar/shared/fieldSignals";

export default function FieldSignalRunSummary({ collected, diagnostics }: { collected: number; diagnostics: DiscoveryFieldSignalRunDiagnostics }) {
  const sources = Object.entries(diagnostics.sources);
  return <section className="discovery-run-summary" aria-label="현장 신호 수집 결과">
    <div className="discovery-run-summary__header">
      <div><span className="eyebrow">현장 신호 수집</span><strong>새 신호 {collected}개</strong></div>
      {diagnostics.incomplete && <span className="discovery-run-summary__warning">일부 출처 확인 실패</span>}
    </div>
    <details open={collected === 0 || diagnostics.incomplete}>
      <summary>출처별 진단</summary>
      <div className="discovery-run-summary__providers">
        {sources.map(([sourceId, stats]) => <div key={sourceId}>
          <strong>{sourceId}</strong>
          <span>요청 {stats.requests} · 성공 {stats.succeededRequests} · 수신 {stats.received} · 선정 {stats.selected}</span>
          <span>전체 제외 {stats.rejected} · 오래됨 {stats.stale} · 종료됨 {stats.expired} · 중복 {stats.duplicate}</span>
        </div>)}
      </div>
    </details>
  </section>;
}
```

- [ ] **Step 5: Add mode, signal filters, fetch, and actions to `DiscoverView`**

Import the two components and field-signal types. Add state:

```ts
const [contentMode, setContentMode] = useState<"READING" | "FIELD_SIGNAL">("READING");
const [fieldSignals, setFieldSignals] = useState<DiscoveryFieldSignal[]>([]);
const [fieldSignalStatus, setFieldSignalStatus] = useState<DiscoveryFieldSignalStatus>("NEW");
const [fieldSignalType, setFieldSignalType] = useState<"" | DiscoveryFieldSignalType>("");
const [fieldSignalError, setFieldSignalError] = useState("");
const [pendingFieldSignalId, setPendingFieldSignalId] = useState<string | null>(null);
const [fieldSignalRunSummary, setFieldSignalRunSummary] = useState<DiscoveryFieldSignalRunDiagnostics | null>(null);
const [fieldSignalsCollected, setFieldSignalsCollected] = useState(0);
```

Add the loader and action:

```ts
const loadFieldSignals = useCallback(async () => {
  setFieldSignalError("");
  try {
    const response = await fetch(`/api/discover/signals?status=${fieldSignalStatus}${fieldSignalType ? `&type=${fieldSignalType}` : ""}`);
    if (!response.ok) throw new Error("field_signals_failed");
    const data = await response.json() as { items?: DiscoveryFieldSignal[] };
    setFieldSignals(data.items ?? []);
  } catch {
    setFieldSignalError("현장 신호를 불러오지 못했습니다.");
  }
}, [fieldSignalStatus, fieldSignalType]);

useEffect(() => { if (contentMode === "FIELD_SIGNAL") void loadFieldSignals(); }, [contentMode, loadFieldSignals]);

async function actOnFieldSignal(id: string, action: "save" | "dismiss" | "restore") {
  setPendingFieldSignalId(id);
  try {
    const response = await fetch(`/api/discover/signals/${id}/${action}`, { method: "POST" });
    if (!response.ok) throw new Error("field_signal_action_failed");
    setMsg(action === "save" ? "현장 신호를 저장했습니다." : action === "dismiss" ? "현장 신호를 제외했습니다." : "현장 신호를 복구했습니다.");
    await loadFieldSignals();
  } catch {
    setMsg("현장 신호 상태를 저장하지 못했습니다.");
  } finally {
    setPendingFieldSignalId(null);
  }
}
```

Extend the successful job result parsing:

```ts
const result = latest.result && typeof latest.result === "object"
  ? latest.result as {
      collected?: unknown;
      fieldSignalsCollected?: unknown;
      diagnostics?: DiscoveryRunDiagnostics;
      fieldSignalDiagnostics?: DiscoveryFieldSignalRunDiagnostics;
    }
  : {};
const readingCount = Number(result.collected ?? 0);
const signalCount = Number(result.fieldSignalsCollected ?? 0);
setMsg(`발견 수집 완료 · 새 읽을거리 ${readingCount}개 · 현장 신호 ${signalCount}개`);
setRunCollected(readingCount);
setFieldSignalsCollected(signalCount);
setRunSummary(result.diagnostics ?? null);
setFieldSignalRunSummary(result.fieldSignalDiagnostics ?? null);
void load();
void loadFieldSignals();
```

Insert the top-level mode buttons directly below `DiscoveryDirectionPanel`:

```tsx
<div className="discovery-content-tabs" aria-label="발견 콘텐츠 종류">
  <button className={contentMode === "READING" ? "is-active" : ""} onClick={() => setContentMode("READING")}>읽을거리</button>
  <button className={contentMode === "FIELD_SIGNAL" ? "is-active" : ""} onClick={() => setContentMode("FIELD_SIGNAL")}>현장 신호</button>
</div>
```

Wrap the existing reading toolbar, `DiscoveryRunSummary`, `SplitWorkspace`, and `DecisionBottomSheet` in `contentMode === "READING"`. Render the signal branch with:

```tsx
{contentMode === "FIELD_SIGNAL" && <>
  <div className="discovery-toolbar">
    <div className="filter-strip" aria-label="현장 신호 상태 필터">
      {([ ["NEW", "새 신호"], ["SAVED", "저장됨"], ["DISMISSED", "제외됨"] ] as const).map(([value, label]) =>
        <button key={value} className={`filter-button${fieldSignalStatus === value ? " is-active" : ""}`} onClick={() => setFieldSignalStatus(value)}>{label}</button>)}
    </div>
    <select aria-label="현장 신호 유형" value={fieldSignalType} onChange={(event) => setFieldSignalType(event.target.value as "" | DiscoveryFieldSignalType)}>
      <option value="">전체 유형</option>
      <option value="CONFERENCE">학회·심포지엄</option>
      <option value="CALL_FOR_PAPERS">CFP</option>
      <option value="EXHIBITION">전시</option>
      <option value="GRANT">지원·펠로십</option>
      <option value="RESIDENCY">레지던시</option>
      <option value="WORKSHOP">워크숍</option>
      <option value="INSTITUTION_NEWS">기관 소식</option>
    </select>
    <span className="table-note">회당 최대 12개 · 출처당 최대 4개</span>
  </div>
  {fieldSignalRunSummary && <FieldSignalRunSummary collected={fieldSignalsCollected} diagnostics={fieldSignalRunSummary} />}
  {fieldSignalError
    ? <StatusMessage kind="error" title={fieldSignalError} action={<button className="ui-button-secondary" onClick={() => void loadFieldSignals()}>다시 시도</button>} />
    : <FieldSignalList items={fieldSignals} status={fieldSignalStatus} pendingId={pendingFieldSignalId} onAction={(id, action) => void actOnFieldSignal(id, action)} />}
</>}
```

- [ ] **Step 6: Add scoped responsive styles**

Append to the Discovery section of `web/src/styles/views.css`:

```css
.discovery-content-tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--color-line); }
.discovery-content-tabs button { padding: 0 0 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--color-muted); font: inherit; font-size: 12px; cursor: pointer; }
.discovery-content-tabs button.is-active { border-bottom-color: var(--color-accent); color: var(--color-accent); font-weight: 800; }
.discovery-field-signals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.discovery-field-signal { display: grid; align-content: start; gap: 10px; padding: 16px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
.discovery-field-signal__badges, .discovery-field-signal__terms, .discovery-field-signal__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.discovery-field-signal__badges span, .discovery-field-signal__terms span { padding: 4px 7px; border-radius: 999px; background: var(--color-soft); color: var(--color-muted); font-size: 9px; }
.discovery-field-signal__badges strong { margin-left: auto; color: var(--color-accent); font-family: var(--font-mono); font-size: 9px; }
.discovery-field-signal h2 { margin: 0; font-size: 15px; line-height: 1.45; }
.discovery-field-signal h2 a { color: var(--color-ink); }
.discovery-field-signal p { margin: 0; color: var(--color-muted); font-size: 11px; line-height: 1.65; }
.discovery-field-signal__dates { font-family: var(--font-mono); font-size: 9px !important; }
.discovery-field-signal__actions { margin-top: auto; padding-top: 4px; }
.discovery-field-signals__empty { padding: 48px 0; color: var(--color-muted); text-align: center; }
@media (max-width: 760px) { .discovery-field-signals { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run UI tests, full unit tests, and build**

Run:

```bash
pnpm --filter @radar/web exec vitest run src/views/DiscoverView.test.tsx
pnpm --filter @radar/web exec vitest run
pnpm typecheck
pnpm build
```

Expected: Discover tests PASS, all unit tests PASS, typechecks PASS, and production build PASS.

- [ ] **Step 8: Commit the separate field-signal UI**

```bash
git add web/src/components/discovery/FieldSignalList.tsx web/src/components/discovery/FieldSignalRunSummary.tsx web/src/views/DiscoverView.tsx web/src/styles/views.css web/src/views/DiscoverView.test.tsx
git commit -m "260823: 발견 현장 신호 분리 화면"
```

## Task 7: Lock documentation, end-to-end behavior, migration order, and release checks

**Files:**

- Modify: `web/tests/e2e/core-reading-flow.spec.ts`
- Modify: `docs/SPEC.md`
- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/PROJECT_CONTEXT.md`

**Interfaces:**

- Consumes: all Task 1–6 behavior.
- Produces: source-of-truth documentation, reading-flow regression coverage, field-signal smoke coverage, and exact local/remote rollout procedure.

- [ ] **Step 1: Add field-signal API mocks to the existing E2E route handler**

In `web/tests/e2e/core-reading-flow.spec.ts`, add before the generic fallback:

```ts
if (url.pathname === "/api/discover/signals") return route.fulfill({ json: { items: [{
  id: "signal-1",
  sourceId: "caa-news",
  sourceName: "CAA News",
  externalUrl: "https://www.collegeart.org/news/cfp-photography",
  title: "Call for Papers: Photography and Visual Culture",
  summary: "A conference on photography and image politics.",
  signalType: "CALL_FOR_PAPERS",
  publishedAt: "2026-08-20T00:00:00.000Z",
  eventAt: "2026-09-12T00:00:00.000Z",
  deadlineAt: "2026-08-31T00:00:00.000Z",
  matchedTerms: ["photography"],
  relevanceScore: 0.85,
  status: "NEW",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
}] } });
```

Because the request contains query parameters, compare `url.pathname` only, as the existing route handler already does.

- [ ] **Step 2: Add an E2E smoke test that preserves both modes**

Append:

```ts
test("discover separates reading candidates from field signals", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "발견", exact: true }).click();
  await expect(page.getByRole("option", { name: /발견 후보/ })).toBeVisible();
  await page.getByRole("button", { name: "현장 신호" }).click();
  await expect(page.getByRole("heading", { name: "Call for Papers: Photography and Visual Culture" })).toBeVisible();
  await expect(page.getByText("CAA News")).toBeVisible();
  await page.getByRole("button", { name: "읽을거리" }).click();
  await expect(page.getByRole("option", { name: /발견 후보/ })).toBeVisible();
});
```

- [ ] **Step 3: Update the source-of-truth delta only after code behavior exists**

Replace the D6 decision row in `docs/SPEC.md` with:

```markdown
| D6 | Discovery 소스 | OpenAlex + arXiv + 검증된 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic) + 별도 현장 신호 RSS(CAA News, Association for Art History, ICP) | 읽을거리와 현장 신호는 별도 quota·상태로 저장하며, 공개 피드 또는 공식 API가 확인된 경로만 자동 수집 |
```

Then append this dated subsection under the existing Discovery source decisions:

```markdown
### Discovery 읽을거리·현장 신호 분리 (2026-08-23)

- 발견 결과는 `읽을거리`와 `현장 신호`로 분리한다.
- 읽을거리는 관련도 0.65, 무료 원문/PDF, 최대 8개 정책을 유지한다.
- 검증된 자동 읽을거리 피드는 Unthinking Photography, Aperture, Hyperallergic다.
- 현장 신호는 CAA News, Association for Art History, ICP 공식 RSS에서 별도 수집하며 회당 최대 12개·출처당 최대 4개다.
- 현장 신호 저장은 Reservoir 승격이 아니라 `SAVED` 상태 변경이다.
- e-flux는 현재 공식 피드가 갱신되지 않아 검색 링크로 유지하며 HTML 페이지를 크롤링하지 않는다.
- 미술관 작품·소장품 API는 별도 향후 설계 범위다.
```

- [ ] **Step 4: Replace the stale Phase 5 source list and acceptance criteria**

Replace the Task 5.1 body and AC in `docs/DEV_PLAN.md` with:

```markdown
홈페이지 프로젝트·읽을거리 키워드와 최근 모멘텀을 OpenAlex·arXiv 검색 계획으로 변환하고, 검증된 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic)를 함께 수집한다. 읽을거리는 관련도 0.65 이상, `PDF` 또는 검증된 `FREE_FULLTEXT`, 회당 최대 8개(OpenAlex 4·arXiv 2·RSS 2), 정규화 제목 중복 제거를 유지한다. RSS 접근 상태는 출처 레지스트리 정책을 우선하며, RSS 1차 선택은 출처별 한 건씩 균형을 적용한다. Artforum·ARTnews와 접근 미확인 커스텀 HTML은 자동 후보에서 제외한다.
**AC**: cron 1회 실행 후 모든 `CANDIDATE`가 관련도 0.65 이상과 읽기 가능한 접근 상태를 가지며, `source_id`와 provider 진단을 보존한다. 기존 미검토 후보는 재평가하고 탈락 자료는 삭제하지 않고 `IGNORED`로 보존한다. **Scope: M**
```

Replace the Task 5.3 body with:

```markdown
출처 레지스트리는 `READING`과 `FIELD_SIGNAL`, 자동 수집 여부, 접근 정책, 주제 anchor를 구분한다. CAA News·Association for Art History·ICP 공식 RSS는 `discovery_field_signals`에 별도 수집하고 회당 최대 12개·출처당 최대 4개를 적용한다. 유형·관련성·게시일·행사일·마감일·종료 여부와 출처별 진단을 기록하며, Save는 Reservoir 승격이 아니라 `SAVED` 상태 변경이다. e-flux와 공식 채널이 확인되지 않은 미술관·사진기관은 검색 링크로 유지한다. RISS·KCI·Scopus·Web of Science는 공식 API 키와 이용 권한을 확보한 뒤 별도 provider adapter로 추가하고, Google Scholar 결과 페이지는 크롤링하지 않는다.
```

Replace Checkpoint P5 with:

```markdown
**Checkpoint P5**: 주간 자동 실행 → 읽을거리 후보와 현장 신호가 별도 상한으로 유입 → 읽을거리 Keep 승격과 현장 신호 Save가 서로 다른 저장 동작임을 확인한다.
```

- [ ] **Step 5: Update the operating context with exact runtime policy**

In `docs/PROJECT_CONTEXT.md`, replace the Discovery row in the implementation table with:

```markdown
| Discovery | 홈페이지·읽을거리 시드 + OpenAlex + arXiv + 읽을거리 RSS(Unthinking Photography, Aperture, Hyperallergic) + 현장 신호 RSS(CAA News, Association for Art History, ICP) + 출처 디렉터리 | RISS·KCI·Google Scholar·Scopus·Web of Science와 기타 미술관·사진기관은 공식 API/RSS가 검증되기 전 자동 수집하지 않음 |
```

Replace the two Discovery policy paragraphs immediately below that table with:

```markdown
Discovery 읽을거리는 제목·초록·RSS 요약에 연구 기준어가 실제로 포함되고 관련도 0.65 이상일 때만 등록한다. OpenAlex는 OA URL, arXiv는 PDF, RSS HTML은 검증된 출처의 `FREE_FULLTEXT` 정책이 필요하다. Artforum·ARTnews·기관 인증 링크·접근 미확인 HTML은 후보에서 제외한다. 실행 상한은 8건(OpenAlex 4·arXiv 2·RSS 2)이며 RSS는 1차로 출처별 한 건씩 선택한다. 기본 읽을거리 피드는 KV fallback이 아니라 정적 레지스트리에서 매 실행 구성하고, KV에는 레지스트리에 없는 사용자 커스텀 피드만 최대 6개 저장한다. RISS·KCI·Google Scholar·Scopus·Web of Science 결과 페이지를 크롤링하지 않는다.

Discovery 현장 신호는 CAA News·Association for Art History·ICP 공식 RSS를 읽을거리와 별도로 수집한다. 관련도 0.55, 회당 최대 12건, 출처당 최대 4건이며 `NEW`·`SAVED`·`DISMISSED` 상태를 사용한다. 오래된 게시물은 `STALE`, 마감·행사가 지난 항목은 `EXPIRED`로 제외한다. Save는 Reservoir source를 만들지 않는다. 실행 결과는 읽을거리 `diagnostics`와 현장 신호 `fieldSignalDiagnostics`를 함께 보존하며, 출처별 요청·성공·실패·수신·관련성 탈락·오래됨·종료됨·중복·quota·선정 수를 구분한다. 정상 응답 후 0건은 오류가 아닌 유효한 빈 결과다.
```

- [ ] **Step 6: Run complete local verification before any remote mutation**

Run:

```bash
pnpm --filter @radar/web exec vitest run
pnpm typecheck
pnpm build
pnpm --filter @radar/web exec playwright test tests/e2e/core-reading-flow.spec.ts
git diff --check
git status --short
```

Expected:

- all Vitest files PASS;
- all workspace typechecks PASS;
- Vite/Worker builds PASS;
- both Playwright tests in `core-reading-flow.spec.ts` PASS;
- `git diff --check` prints nothing;
- `git status --short` lists only Task 7 files plus any pre-existing unrelated untracked directories.

- [ ] **Step 7: Commit documentation and E2E coverage**

```bash
git add web/tests/e2e/core-reading-flow.spec.ts docs/SPEC.md docs/DEV_PLAN.md docs/PROJECT_CONTEXT.md
git commit -m "260823: 발견 읽을거리와 현장 신호 운영 기준"
```

- [ ] **Step 8: Apply migration locally and verify the schema before deployment**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "SELECT name FROM sqlite_master WHERE type='table' AND name='discovery_field_signals';"
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --local --command "PRAGMA table_info(discovery_candidates);"
```

Expected: the first query returns `discovery_field_signals`; the pragma includes `source_id`.

- [ ] **Step 9: Stop for explicit release authorization**

Do not run remote migration or deployment as part of implementation verification. Report:

```text
구현과 로컬 검증 완료. 원격 적용 순서는 0014 D1 migration → Worker/SPA deploy → 실제 Discovery 1회 → 출처별 진단 확인입니다. 원격 마이그레이션과 배포 승인을 기다립니다.
```

After explicit approval, run the remote release in this order:

```bash
pnpm db:migrate
pnpm deploy
```

Then verify `https://radar.taejunyun.com/api/health`, trigger one Discovery run from the authenticated UI, and confirm:

- job result contains both `collected` and `fieldSignalsCollected`;
- Unthinking/Aperture/Hyperallergic are evaluated with verified reading access;
- CAA/Association for Art History/ICP appear only under 현장 신호;
- failure or zero-selection causes are visible per source;
- no field signal appears in Reservoir unless the user separately imports material.

---

## Self-Review Checklist

| Design completion criterion | Implementation coverage |
|---|---|
| 1. Verified free reading HTML | Tasks 1–2 source policy and RSS assessment tests |
| 2. Artforum/ARTnews excluded from automatic reading | Tasks 1–2 registry, legacy-KV sanitation, UI source status |
| 3. CAA/AAH/ICP stored only as field signals | Tasks 1 and 4 target-filtered collector |
| 4. Separate reading and signal quotas | Tasks 2, 4, and 5 independent collectors/results |
| 5. 12-per-run, 4-per-source, dedup | Task 4 collector tests and D1 uniqueness |
| 6. One run, two screens | Tasks 5–6 Workflow result and Discover modes |
| 7. Explainable empty/failure outcomes | Tasks 2, 4, 5, and 6 diagnostics including stale/expired |
| 8. No unofficial crawling or paid AI | Global constraints and Task 7 source-of-truth update |
| 9. Reading Keep/access regression safety | Tasks 2, 6, and 7 unit/E2E verification |

- [ ] Spec coverage: every design completion criterion maps to Tasks 1–7.
- [ ] Scope: no HTML crawler, museum object API, credentialed academic adapter, newsletter, calendar, alert, or AI extraction was added.
- [ ] Type consistency: `FIELD_SIGNAL`, `DiscoveryFieldSignal*`, `fieldSignalsCollected`, and `fieldSignalDiagnostics` names match across shared, Worker, Workflow, API, and React.
- [ ] State consistency: database/API/UI use only `NEW`, `SAVED`, `DISMISSED` for field signals.
- [ ] Quota consistency: reading remains 8 total with RSS 2; field signals are 12 total and 4 per source.
- [ ] Provenance: reading candidates persist `source_id`; field signals persist static `source_id` and unique official `external_url`.
- [ ] Access: only a curated `FREE_FULLTEXT` policy can make an unknown HTML reading link directly readable.
- [ ] Diagnostics: reading and field-signal diagnostics remain separate and are both stored in the job result.
- [ ] Migration: `0014` is forward-only and remote application occurs before deployment.
- [ ] Release safety: remote migration and deployment require a later explicit user approval.
