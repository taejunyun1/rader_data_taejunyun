# Discovery Filter Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발견 메인에는 연구 맥락에 맞고 바로 읽을 수 있는 자료만 최대 8건 노출하며, 공학 편향·유료 링크·제목 중복·출처 독점을 제거한다.

**Architecture:** 후보 생성과 후보 선택을 분리한다. OpenAlex·arXiv·RSS adapter는 원자료와 접근 상태를 반환하고, 공유 정책 모듈이 주제 적합성 hard gate를 수행한 뒤 Worker가 제목 dedup과 출처별 quota를 적용한다. `divergence`는 hard gate를 통과한 자료의 순서에만 최대 0.05 가중치로 반영하며 탈락 자료를 살리지 않는다.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, D1, OpenAlex API, arXiv API, RSS/Atom, Vite, React, Vitest, pnpm workspaces, Wrangler 4.x

## Global Constraints

- Source of truth는 `docs/spec-v0.1.txt`, `docs/SPEC.md`, `docs/DEV_PLAN.md`, `docs/PROJECT_CONTEXT.md`이며 충돌 시 `docs/SPEC.md`를 우선한다.
- Cloudflare-first / External-minimal / Serverless-first / Reservoir-first / Model-agnostic 원칙을 유지한다.
- 새 외부 SaaS나 모델 호출을 추가하지 않는다. 이번 필터는 문자열·메타데이터 기반의 결정적 로직으로 구현한다.
- 자동 Discovery 후보는 Keep 전 Reservoir로 승격하지 않는다.
- 탈락 후보는 삭제하지 않고 `IGNORED`로 보존한다.
- 사용자에게 노출하는 설정은 기존 5개 파라미터를 넘기지 않는다.
- UI 문구는 한국어로 쓰고 자료 원문 제목·저자·출처는 원어를 보존한다.
- 현재 작업 트리의 `.playwright-cli/`, `.pnpm-store/`, `.superpowers/`, `web/test-results/`는 사용자 소유 미추적 파일로 간주하고 stage하거나 수정하지 않는다.
- 실행 시작 시 `superpowers:using-git-worktrees`로 `codex/discovery-filter-hardening` 작업공간을 만든다. `.git` 쓰기 제한이 계속되면 main에서 커밋하지 말고 사용자 승인을 먼저 받는다.
- 커밋 메시지는 `260822: 주요 내용` 형식을 사용한다.
- 운영 D1 마이그레이션과 배포는 모든 테스트·빌드·dry-run이 통과한 뒤에만 실행한다.

## Verified Baseline

2026-08-22 운영 키워드와 실제 외부 결과를 현재 필터에 적용했을 때 최종 12건은 OpenAlex 9건·arXiv 3건·RSS 0건이었다. OpenAlex 9건 중 8건은 접근 상태가 `UNKNOWN`이었고, `Image Processing, Analysis and Machine Vision` 계열이 3번 중복되었으며 카메라 캘리브레이션 논문도 통과했다. 따라서 현재 1차 필터는 배포하지 않고 아래 2차 강화 작업을 먼저 수행한다.

## File Map

- `shared/src/discovery.ts` — 공개 assessment 타입, 텍스트·제목 정규화, 주제·접근성 hard gate
- `shared/package.json` — `@radar/shared/discovery` export 유지
- `web/src/lib/discoveryFilter.test.ts` — 운영 오탐·정탐 회귀 행렬
- `worker/src/lib/openalex.ts` — OpenAlex 초록·유형·OA URL adapter
- `worker/src/lib/arxiv.ts` — 허용 category·초록 adapter
- `worker/src/lib/rss.ts` — CDATA·숫자 entity 정리와 RSS summary adapter
- `worker/src/discovery/run.ts` — 후보 생성, provider quota, dedup, divergence 순위, 기존 후보 재평가
- `worker/src/routes/discover.ts` — 읽을 수 있는 CANDIDATE만 반환하고 접근 상태 제공
- `web/src/lib/sourceAccess.ts` — 무료/PDF/기관/유료/미확인 라벨
- `web/src/views/DiscoverView.tsx` — 실제 수집 기준과 최대 8건 문구
- `worker/migrations/0007_discovery_quality.sql` — 기존 미배포 `access_status` migration 유지
- `docs/DEV_PLAN.md`, `docs/PROJECT_CONTEXT.md` — 확정 정책 기록

---

### Task 1: 운영 사례를 회귀 테스트로 고정

**Files:**
- Modify: `web/src/lib/discoveryFilter.test.ts`
- Modify: `shared/src/discovery.ts`
- Modify: `shared/package.json`

**Interfaces:**
- Consumes: `assessDiscoveryCandidate(input: DiscoveryAssessmentInput): DiscoveryAssessment`
- Produces: `normalizeDiscoveryTitle(title: string): string`

- [ ] **Step 1: 현재 중복 제목을 failing test로 추가**

```ts
import { normalizeDiscoveryTitle } from "@radar/shared/discovery";

it("normalizes punctuation and edition differences for title dedup", () => {
  expect(normalizeDiscoveryTitle("Image Processing, Analysis and Machine Vision (2nd ed.)"))
    .toBe(normalizeDiscoveryTitle("Image processing analysis & machine vision"));
});
```

- [ ] **Step 2: 회귀 테스트가 현재 구현에서 실패하는지 확인**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: `normalizeDiscoveryTitle is not a function`으로 FAIL.

- [ ] **Step 3: 제목 정규화 함수를 최소 구현**

```ts
export function normalizeDiscoveryTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/<!\[cdata\[|\]\]>/gi, " ")
    .replace(/&(?:amp|#38);/gi, " and ")
    .replace(/\b(?:first|second|third|\d+(?:st|nd|rd|th))\s+edition\b/gi, " ")
    .replace(/\(\s*\d+(?:st|nd|rd|th)\s+ed\.?\s*\)/gi, " ")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 4: 테스트를 다시 실행**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: 제목 정규화 테스트 PASS.

- [ ] **Step 5: 변경 범위 검토 후 커밋**

```bash
git add shared/package.json shared/src/discovery.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260822: 발견 운영 사례 회귀 테스트와 제목 정규화"
```

---

### Task 2: 공학 단독 자료를 차단하는 2단계 주제 gate

**Files:**
- Modify: `shared/src/discovery.ts`
- Test: `web/src/lib/discoveryFilter.test.ts`

**Interfaces:**
- Consumes: `normalizeDiscoveryTitle`, `DiscoveryAssessmentInput`
- Produces: `assessDiscoveryCandidate`의 결정적 hard gate

- [ ] **Step 1: 공학 오탐과 한국어·하이픈·복합 검색어 테스트 추가**

```ts
it.each([
  "A versatile camera calibration technique for high-accuracy 3D machine vision metrology",
  "Image Processing, Analysis and Machine Vision",
  "EarthMatch: Fine-grained Localization of Astronaut Photography",
  "Photozilla: A Large-Scale Photography Dataset and Visual Embedding",
])("rejects technical work without a critical or artistic context: %s", (title) => {
  expect(assessDiscoveryCandidate({
    provider: "arxiv",
    title,
    summary: "benchmark accuracy reconstruction dataset",
    year: 2026,
    accessStatus: "PDF",
  })).toMatchObject({ accepted: false, reason: "ENGINEERING_ONLY" });
});

it.each([
  "Camera Lucida: Reflections on Photography",
  "Family Frames: Photography, Narrative and Postmemory",
  "Understanding colors of Dufaycolor using historical colorimetric data",
  "At Rencontres d’Arles, Photography Rethinks Its Centers",
])("keeps critical, historical, or cultural photography: %s", (title) => {
  expect(assessDiscoveryCandidate({
    provider: "rss",
    title,
    summary: "photographic history, visual culture, authorship and material practice",
    year: 2026,
    accessStatus: "FREE_FULLTEXT",
  }).accepted).toBe(true);
});

it.each(["network-culture", "machine-vision", "visual-culture", "사진", "이미지-물질성"])(
  "normalizes a valid compound seed: %s",
  (query) => expect(isUsableDiscoveryQuery(query)).toBe(true),
);

it("requires critical context when machine vision is the only topic", () => {
  const result = assessDiscoveryCandidate({
    provider: "openalex",
    title: "Machine Vision and Visual Culture",
    summary: "surveillance, representation, labor and politics of images",
    year: 2025,
    accessStatus: "FREE_FULLTEXT",
  });
  expect(result).toMatchObject({ accepted: true, reason: "RELEVANT" });
});
```

- [ ] **Step 2: 테스트가 현재 느슨한 pair rule 때문에 실패하는지 확인**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: 공학 오탐 사례가 계속 승인되어 FAIL.

- [ ] **Step 3: 실패 사유를 확장하고 anchor를 핵심 연구축·비평 맥락·기술 지표로 분리**

```ts
export type DiscoveryDecisionReason =
  | "RELEVANT"
  | "NO_RESEARCH_ANCHOR"
  | "ENGINEERING_ONLY"
  | "BLOCKED_DOMAIN"
  | "LOW_SCORE"
  | "PAYWALLED"
  | "ACCESS_UNKNOWN";
```

`shared/src/discovery.ts`의 기존 `DIRECT_ANCHORS`, `CONTEXT_ANCHORS`, `TECH_CONTEXT`를 다음 세 그룹으로 교체한다.

```ts
const CORE_RESEARCH_TERMS = [
  "photography", "photographic", "visual culture", "image theory", "image politics",
  "materiality", "tactility", "print labor", "digital labor", "data epistemology",
  "network culture", "media art", "feminist photography", "visuality",
  "사진", "사진적", "시각문화", "이미지 이론", "이미지 정치", "물질성",
  "촉각", "프린트 노동", "디지털 노동", "데이터 인식론", "네트워크 문화",
];

const CRITICAL_CONTEXT_TERMS = [
  "culture", "cultural", "history", "historical", "politics", "political",
  "aesthetic", "artistic", "authorship", "representation", "memory", "archive",
  "embodiment", "body", "labor", "feminist", "surveillance", "provenance",
  "문화", "역사", "정치", "미학", "예술", "저자성", "재현", "기억",
  "아카이브", "신체", "노동", "페미니즘", "감시", "프로비넌스",
];

const TECHNICAL_TOPIC_TERMS = [
  "machine vision", "computer vision", "artificial intelligence", "ai",
  "algorithm", "dataset", "network", "digital", "data",
  "기계 시각", "컴퓨터 비전", "인공지능", "알고리즘", "데이터셋",
];

const ENGINEERING_ONLY_TERMS = [
  "calibration", "metrology", "benchmark", "accuracy", "localization",
  "reconstruction", "segmentation", "classification", "object detection",
  "neural network", "deep learning", "embedding", "optimization", "3d",
  "보정", "계측", "벤치마크", "정확도", "위치 추정", "재구성", "분할",
];
```

- [ ] **Step 4: 하이픈을 공백으로 정규화하고 기술 단독 gate를 구현**

```ts
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const core = matches(fullText, CORE_RESEARCH_TERMS);
const critical = matches(fullText, CRITICAL_CONTEXT_TERMS);
const technical = matches(fullText, TECHNICAL_TOPIC_TERMS);
const engineering = matches(fullText, ENGINEERING_ONLY_TERMS);
const titleCore = matches(title, CORE_RESEARCH_TERMS);
const summaryCore = matches(summary, CORE_RESEARCH_TERMS);
const matchedTerms = [...new Set([...core, ...critical, ...technical])];

if (engineering.length > 0 && critical.length === 0) {
  return { accepted: false, score: 0.1, matchedTerms: engineering, reason: "ENGINEERING_ONLY" };
}
if (technical.length > 0 && core.length === 0 && critical.length < 2) {
  return { accepted: false, score: 0.2, matchedTerms: technical, reason: "ENGINEERING_ONLY" };
}
if (core.length === 0 && !(technical.length > 0 && critical.length >= 2)) {
  return { accepted: false, score: 0.15, matchedTerms: [], reason: "NO_RESEARCH_ANCHOR" };
}

let score = 0.35;
if (titleCore.length > 0) score += 0.2;
if (summaryCore.length > 0) score += 0.15;
if (critical.length >= 2) score += 0.1;
score += recencyScore(input.year);
if (input.accessStatus === "PDF" || input.accessStatus === "FREE_FULLTEXT") score += 0.1;
const rounded = Math.min(1, Math.max(0, Number(score.toFixed(2))));
if (rounded < DISCOVERY_MIN_SCORE) {
  return { accepted: false, score: rounded, matchedTerms, reason: "LOW_SCORE" };
}
return { accepted: true, score: rounded, matchedTerms, reason: "RELEVANT" };
```

- [ ] **Step 5: 주제 gate 회귀 테스트 실행**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: 카메라 캘리브레이션·일반 image processing·데이터셋 논문은 REJECT, 문화·역사·물질성 문맥의 사진 자료는 PASS.

- [ ] **Step 6: 커밋**

```bash
git add shared/src/discovery.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260822: 발견 주제 필터 강화 - 공학 단독 자료 차단"
```

---

### Task 3: 무료 전문·PDF만 읽기 후보로 허용

**Files:**
- Modify: `shared/src/discovery.ts`
- Modify: `worker/src/lib/openalex.ts`
- Modify: `worker/src/discovery/run.ts`
- Modify: `web/src/lib/sourceAccess.ts`
- Test: `web/src/lib/discoveryFilter.test.ts`
- Test: `web/src/lib/sourceAccess.test.ts`

**Interfaces:**
- Consumes: `DiscoveryAccessStatus`, `OpenAlexWork.openAccessUrl`
- Produces: 읽기 후보의 접근 상태 hard gate와 정확한 CTA

- [ ] **Step 1: 접근성 정책 failing test 추가**

```ts
it.each(["UNKNOWN", "PAYWALLED"] as const)("rejects %s access from the main candidate pool", (accessStatus) => {
  expect(assessDiscoveryCandidate({
    provider: "openalex",
    title: "Photography, Narrative and Postmemory",
    summary: "visual culture, history and memory",
    year: 2024,
    accessStatus,
  }).accepted).toBe(false);
});

it.each(["PDF", "FREE_FULLTEXT"] as const)("accepts readable %s access after topic gate", (accessStatus) => {
  expect(assessDiscoveryCandidate({
    provider: "openalex",
    title: "Photography, Narrative and Postmemory",
    summary: "visual culture, history and memory",
    year: 2024,
    accessStatus,
  }).accepted).toBe(true);
});
```

- [ ] **Step 2: UNKNOWN이 현재 승인되어 FAIL하는지 확인**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts src/lib/sourceAccess.test.ts`

Expected: UNKNOWN 사례 FAIL.

- [ ] **Step 3: 주제 gate 뒤 접근성 hard gate 구현**

```ts
if (input.accessStatus === "PAYWALLED") {
  return { accepted: false, score: rounded, matchedTerms, reason: "PAYWALLED" };
}
if (input.accessStatus === "UNKNOWN") {
  return { accepted: false, score: rounded, matchedTerms, reason: "ACCESS_UNKNOWN" };
}
```

`INSTITUTION`은 현재 자동 수집 대상이 아닌 RISS 전용 상태로 유지한다. RISS adapter가 추가되기 전에는 main candidate를 생성하지 않는다.

- [ ] **Step 4: OpenAlex는 OA URL이 있는 결과만 assessment에 전달**

`worker/src/discovery/run.ts`에서 DOI fallback을 후보 URL로 쓰지 않는다.

```ts
if (!w.openAccessUrl) continue;
const accessStatus = w.openAccessUrl.toLowerCase().endsWith(".pdf") ? "PDF" : "FREE_FULLTEXT";
const assessment = assessDiscoveryCandidate({
  provider: "openalex",
  title: w.title,
  summary: w.abstract,
  year: w.year,
  accessStatus,
});
```

- [ ] **Step 5: CTA 테스트와 구현 확인**

`web/src/lib/sourceAccess.test.ts`에 다음을 추가한다.

```ts
expect(deriveSourceAccess({ provider: "openalex", href: "https://example.org/full", accessStatus: "FREE_FULLTEXT" }))
  .toMatchObject({ kind: "DIRECT", label: "무료 원문 확인", actionLabel: "원문 읽기" });
expect(deriveSourceAccess({ provider: "openalex", href: "https://doi.org/example", accessStatus: "UNKNOWN" }))
  .toMatchObject({ kind: "ABSTRACT", label: "서지·접근 정보" });
```

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts src/lib/sourceAccess.test.ts`

Expected: 모두 PASS.

- [ ] **Step 6: 커밋**

```bash
git add shared/src/discovery.ts worker/src/discovery/run.ts worker/src/lib/openalex.ts web/src/lib/sourceAccess.ts web/src/lib/discoveryFilter.test.ts web/src/lib/sourceAccess.test.ts
git commit -m "260822: 발견 무료 원문 우선 정책과 접근성 CTA"
```

---

### Task 4: 제목 dedup과 출처별 quota로 최종 8건 선택

**Files:**
- Modify: `shared/src/discovery.ts`
- Modify: `worker/src/discovery/run.ts`
- Test: `web/src/lib/discoveryFilter.test.ts`

**Interfaces:**
- Consumes: `normalizeDiscoveryTitle`, 승인된 provider candidate
- Produces: `selectDiscoveryCandidates(candidates, divergence): PendingCandidate[]`

- [ ] **Step 1: 순수 선택 함수의 failing test 추가**

`selectDiscoveryCandidates`를 `shared/src/discovery.ts`에 두어 web Vitest에서 직접 검증한다.

```ts
const selected = selectDiscoveryCandidates([
  { id: "oa-1", provider: "openalex", title: "Image Processing, Analysis and Machine Vision", score: 0.9 },
  { id: "oa-2", provider: "openalex", title: "Image processing analysis & machine vision (2nd ed.)", score: 0.8 },
  { id: "oa-3", provider: "openalex", title: "Visual Anthropology and Photography", score: 0.85 },
  { id: "oa-4", provider: "openalex", title: "Photography Narrative and Postmemory", score: 0.84 },
  { id: "oa-5", provider: "openalex", title: "The Civil Contract of Photography", score: 0.83 },
  { id: "oa-6", provider: "openalex", title: "Network Culture and Visual Politics", score: 0.82 },
  { id: "ax-1", provider: "arxiv", title: "Dufaycolor and Historical Photography", score: 0.82 },
  { id: "rss-1", provider: "rss", title: "Photography Rethinks Its Centers", score: 0.81 },
], 0.8);

expect(selected.filter((item) => item.provider === "openalex")).toHaveLength(4);
expect(selected.map((item) => normalizeDiscoveryTitle(item.title)))
  .toEqual([...new Set(selected.map((item) => normalizeDiscoveryTitle(item.title)))]);
expect(selected.some((item) => item.provider === "rss")).toBe(true);
```

- [ ] **Step 2: 현재 코드에 선택 함수가 없어 FAIL하는지 확인**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: `selectDiscoveryCandidates is not a function`으로 FAIL.

- [ ] **Step 3: 명시적 quota와 입력 타입 구현**

```ts
export interface SelectableDiscoveryCandidate {
  id: string;
  provider: string;
  title: string;
  score: number;
  keywordOverlap?: number;
}

const PROVIDER_QUOTA: Record<string, number> = {
  openalex: 4,
  arxiv: 2,
  rss: 2,
};
const MAX_SELECTED = 8;
```

위 코드는 `shared/src/discovery.ts`에 둔다. 다음 `PendingCandidate`는 Worker 내부 INSERT 계약이므로 `worker/src/discovery/run.ts`에 둔다.

```ts

interface PendingCandidate extends SelectableDiscoveryCandidate {
  externalId: string;
  authors: string | null;
  year: number | null;
  abstract: string | null;
  query: string;
  url: string;
  accessStatus: DiscoveryAccessStatus;
}
```

- [ ] **Step 4: score 정렬 → 제목 dedup → provider quota를 순서대로 적용**

```ts
export function selectDiscoveryCandidates<T extends SelectableDiscoveryCandidate>(items: T[], divergence: number): T[] {
  const boundedDivergence = Math.min(1, Math.max(0, divergence));
  const ranked = [...items].sort((a, b) => {
    const aRank = a.score + boundedDivergence * 0.05 * (1 - (a.keywordOverlap ?? 1));
    const bRank = b.score + boundedDivergence * 0.05 * (1 - (b.keywordOverlap ?? 1));
    return bRank - aRank;
  });
  const seenTitles = new Set<string>();
  const providerCounts = new Map<string, number>();
  const selected: T[] = [];
  for (const item of ranked) {
    const titleKey = normalizeDiscoveryTitle(item.title);
    if (!titleKey || seenTitles.has(titleKey)) continue;
    const count = providerCounts.get(item.provider) ?? 0;
    if (count >= (PROVIDER_QUOTA[item.provider] ?? 0)) continue;
    seenTitles.add(titleKey);
    providerCounts.set(item.provider, count + 1);
    selected.push(item);
    if (selected.length >= MAX_SELECTED) break;
  }
  return selected;
}
```

`divergence`는 최대 0.05만 순위에 영향을 주며 `accepted=false` 후보를 입력으로 받지 않는다.

- [ ] **Step 5: `runDiscovery`를 즉시 INSERT 방식에서 수집 후 선택 방식으로 변경**

```ts
const pending: PendingCandidate[] = [];

// 각 adapter loop에서는 accepted candidate를 아래 형태로 pending.push(...)만 한다.
pending.push({
  id: externalId,
  externalId,
  provider,
  title,
  authors,
  year,
  abstract,
  score: assessment.score,
  keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
  query,
  url,
  accessStatus,
});

const selected = selectDiscoveryCandidates(pending, divergence);

for (const candidate of selected) {
  if (seenIds.has(candidate.externalId) || seenTitles.has(normalizeDiscoveryTitle(candidate.title))) continue;
  stmts.push(
    env.DB.prepare(
      `INSERT INTO discovery_candidates
       (id, openalex_id, title, authors, year, abstract, relevance_score, status,
        query_used, created_at, provider, external_url, access_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?, ?, ?, ?)`,
    ).bind(
      uuid(), candidate.externalId, candidate.title.slice(0, 300), candidate.authors,
      candidate.year, candidate.abstract?.slice(0, 4000) ?? null, candidate.score,
      candidate.query, ts, candidate.provider, candidate.url, candidate.accessStatus,
    ),
  );
}
```

기존 DB 후보는 `relevance_score DESC, created_at ASC`로 읽고 같은 정규화 제목의 첫 행만 유지한다. 나머지 미검토 중복 후보는 `IGNORED`로 업데이트한다.

- [ ] **Step 6: 선택 테스트와 전체 테스트 실행**

Run: `pnpm --filter @radar/web exec vitest run`

Expected: 전체 테스트 PASS, 동일 제목 1건, OpenAlex 최대 4·arXiv 최대 2·RSS 최대 2, 전체 최대 8.

- [ ] **Step 7: 커밋**

```bash
git add shared/src/discovery.ts worker/src/discovery/run.ts web/src/lib/discoveryFilter.test.ts
git commit -m "260822: 발견 후보 dedup과 출처별 최대 8건 선택"
```

---

### Task 5: RSS 텍스트 정리와 Discover API/UI 일치

**Files:**
- Modify: `worker/src/lib/rss.ts`
- Modify: `worker/src/routes/discover.ts`
- Modify: `web/src/views/DiscoverView.tsx`
- Modify: `web/src/lib/sourceAccess.test.ts`

**Interfaces:**
- Consumes: `access_status`, `DISCOVERY_MIN_SCORE`
- Produces: 깨끗한 RSS 제목, 읽을 수 있는 후보만 반환하는 API, 실제 정책 문구

- [ ] **Step 1: RSS 정리 함수 테스트를 shared 회귀 테스트에 추가**

`shared/src/discovery.ts`에 `cleanDiscoverySourceText`를 공개하고 다음 테스트를 먼저 추가한다.

```ts
expect(cleanDiscoverySourceText("<![CDATA[Photography Rethinks Its Centers]]>"))
  .toBe("Photography Rethinks Its Centers");
expect(cleanDiscoverySourceText("Digital Artwork and AI&#160;Slop"))
  .toBe("Digital Artwork and AI Slop");
```

- [ ] **Step 2: 현재 CDATA와 숫자 entity가 남아 FAIL하는지 확인**

Run: `pnpm --filter @radar/web exec vitest run src/lib/discoveryFilter.test.ts`

Expected: `cleanDiscoverySourceText` 미구현으로 FAIL.

- [ ] **Step 3: 정리 함수 구현 후 RSS parser에서 사용**

```ts
export function cleanDiscoverySourceText(value: string): string {
  return value
    .replace(/^\s*<!\[CDATA\[/i, "")
    .replace(/\]\]>\s*$/i, "")
    .replace(/&#(?:160|xa0);/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
```

`worker/src/lib/rss.ts`에서 title과 HTML 제거 후 summary 양쪽에 적용한다.

- [ ] **Step 4: API가 최소 관련도와 읽기 가능 상태를 함께 보장**

`worker/src/routes/discover.ts`의 CANDIDATE query를 다음 조건으로 고정한다.

```sql
WHERE status = 'CANDIDATE'
  AND relevance_score >= 0.65
  AND access_status IN ('PDF', 'FREE_FULLTEXT')
ORDER BY relevance_score DESC, created_at DESC
LIMIT 8
```

다른 상태(`KEPT`, `WATCHED`, `IGNORED`)는 provenance 검토를 위해 접근 상태와 관계없이 조회한다.

- [ ] **Step 5: Discover UI 운영 문구를 실제 정책과 일치시킴**

```tsx
<span className="table-note">
  {savedQueries.length ? `저장된 검색어 ${savedQueries.length}개` : "기본 검색어로 수집 중"}
  {" · 무료 전문·PDF 우선 · 최대 8개/회"}
</span>
```

검색어 도움말은 `data`, `theory`, `AI` 단독어가 저장되어도 수집 시 제외된다는 문구로 바꾼다.

- [ ] **Step 6: 테스트·타입체크·빌드**

Run: `pnpm typecheck`

Expected: 3개 workspace package 모두 PASS.

Run: `pnpm --filter @radar/web exec vitest run`

Expected: 전체 테스트 PASS.

Run: `pnpm build`

Expected: Vite production build exit 0.

- [ ] **Step 7: 커밋**

```bash
git add shared/src/discovery.ts worker/src/lib/rss.ts worker/src/routes/discover.ts web/src/views/DiscoverView.tsx web/src/lib/discoveryFilter.test.ts web/src/lib/sourceAccess.test.ts
git commit -m "260822: 발견 RSS 정리와 읽기 가능한 후보 UI 정합화"
```

---

### Task 6: 기존 후보 재평가, 문서, 운영 배포 검증

**Files:**
- Modify: `worker/src/discovery/run.ts`
- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Verify: `worker/migrations/0007_discovery_quality.sql`

**Interfaces:**
- Consumes: 새 assessment·dedup·quota 정책
- Produces: 운영 D1에서 보존 가능한 정리 결과와 검증 기록

- [ ] **Step 1: 기존 미검토 후보 재평가 규칙 확인**

`worker/src/discovery/run.ts`에서 `status='CANDIDATE'`인 기존 행만 재평가한다. `KEPT`, `WATCHED`, 사용자가 직접 만든 `IGNORED`는 변경하지 않는다. 새 hard gate 탈락과 중복 후보는 삭제하지 않고 `IGNORED`로 업데이트한다.

```ts
if (candidate.status === "CANDIDATE" && (!assessment.accepted || duplicateTitle)) {
  maintenance.push(
    env.DB.prepare(
      "UPDATE discovery_candidates SET status = 'IGNORED', relevance_score = ?, access_status = ? WHERE id = ?",
    ).bind(assessment.score, accessStatus, candidate.id),
  );
}
```

- [ ] **Step 2: 문서를 최종 정책으로 갱신**

`docs/DEV_PLAN.md`와 `docs/PROJECT_CONTEXT.md`에 다음을 명시한다.

```md
- 발견 메인 후보는 관련도 0.65 이상이면서 PDF 또는 무료 전문인 자료만 허용한다.
- 기술 키워드는 사진·이미지·문화·물질성·노동 등 비평적 맥락과 결합될 때만 통과한다.
- 회당 최대 8건: OpenAlex 4, arXiv 2, RSS 2. 적합한 자료가 부족하면 빈 슬롯을 유지한다.
- 중복과 탈락 후보는 삭제하지 않고 IGNORED로 보존한다.
- divergence는 hard gate 이후 순위에만 최대 0.05를 반영한다.
```

- [ ] **Step 3: fresh verification 실행**

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm --filter @radar/web exec vitest run`

Expected: 0 failed.

Run: `pnpm build`

Expected: exit 0.

Run: `pnpm --filter @radar/worker exec wrangler deploy --dry-run`

Expected: Worker bundle과 assets가 생성되고 `--dry-run: exiting now.` 출력.

- [ ] **Step 4: 운영 D1 migration 적용**

Run: `pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --remote`

Expected: `0007_discovery_quality.sql` status가 성공으로 표시됨. 이미 적용되어 있다면 pending migration 0건.

- [ ] **Step 5: 배포**

Run: `pnpm deploy`

Expected: 새 Worker version ID와 production URL 출력.

- [ ] **Step 6: 인증된 발견 화면에서 1회 실행**

1. production의 `발견` 페이지를 연다.
2. `지금 새로 찾기`를 한 번 누른다.
3. 완료 메시지의 후보 수가 0~8인지 확인한다.
4. 각 후보의 CTA가 `무료 원문 확인` 또는 `PDF 제공`인지 확인한다.

- [ ] **Step 7: 운영 D1 결과를 읽기 전용으로 검증**

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --remote --command "SELECT provider, access_status, COUNT(*) AS n, MIN(relevance_score) AS min_score FROM discovery_candidates WHERE status='CANDIDATE' GROUP BY provider, access_status ORDER BY provider, access_status;"
```

Expected:

- 모든 `min_score >= 0.65`
- `access_status`는 `PDF` 또는 `FREE_FULLTEXT`만 존재
- 한 실행에서 OpenAlex 최대 4, arXiv 최대 2, RSS 최대 2

Run:

```bash
pnpm --filter @radar/worker exec wrangler d1 execute research-radar-db --remote --command "SELECT lower(trim(title)) AS title_key, COUNT(*) AS n FROM discovery_candidates WHERE status='CANDIDATE' GROUP BY title_key HAVING n > 1;"
```

Expected: 결과 0행. 애플리케이션 정규화가 더 강하므로 이 SQL은 마지막 단순 확인용이며, 회귀 테스트가 최종 기준이다.

- [ ] **Step 8: 최종 커밋과 push**

```bash
git add docs/DEV_PLAN.md docs/PROJECT_CONTEXT.md worker/src/discovery/run.ts worker/migrations/0007_discovery_quality.sql
git commit -m "260822: 발견 필터 2차 강화 운영 검증과 문서화"
git push origin HEAD
```

Expected: remote branch가 현재 HEAD로 갱신되고 unrelated untracked directories는 commit에 포함되지 않음.

## Final Acceptance Checklist

- [ ] `data`, `theory`, `AI` 단독 검색어가 실행 query에서 제외된다.
- [ ] 카메라 calibration, generic image processing, localization, dataset benchmark는 critical context 없이는 탈락한다.
- [ ] 사진사·시각문화·물질성·저자성·기억·노동·감시 문맥 자료는 통과한다.
- [ ] main candidate는 `PDF` 또는 `FREE_FULLTEXT`만 포함한다.
- [ ] ARTnews·Artforum 유료 가능 링크는 main candidate에 없다.
- [ ] 정규화 제목이 같은 OpenAlex 판본은 1건만 남는다.
- [ ] OpenAlex가 전체 슬롯을 독점하지 않는다.
- [ ] 적합한 자료가 적으면 8건을 억지로 채우지 않는다.
- [ ] 기존 탈락 자료는 삭제되지 않고 `IGNORED`로 보존된다.
- [ ] `divergence`는 hard gate를 우회하지 않는다.
- [ ] RSS 제목에 CDATA와 `&#160;`이 남지 않는다.
- [ ] 타입체크, 전체 Vitest, production build, Wrangler dry-run이 모두 통과한다.
