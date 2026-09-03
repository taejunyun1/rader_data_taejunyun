# Distill 홈페이지 `현재 연구` 발행 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Research Radar에서 사용자가 승인한 최신 발행 가능 Distill 한 건만 비공개 R2 snapshot으로 발행하고, `www.taejunyun.com/text`의 반응 기반 `큐레이션`을 익명 조회형 `현재 연구`로 교체한다.

**Architecture:** Radar가 private D1의 Distill을 strict allowlist projection으로 변환하고 preview와 publish가 같은 builder를 사용한다. D1 singleton lease와 append-only ledger가 발행·철회·source 영구 삭제·hard purge를 직렬화하고, R2 history-first/current-last conditional PUT이 최종 공개 상태를 보호한다. 홈페이지 Worker는 공유 bucket의 고정 key만 읽어 strict schema를 재검증한 뒤 payload만 반환하며, Vue 화면은 이 공개 API만 익명으로 조회한다.

**Tech Stack:** TypeScript 5.9, Hono 4, React 19, Vite 8, Vitest 4, Cloudflare Workers/D1/R2, pnpm workspaces; separate Vue 3/Vite 8/Node test/Miniflare 4 homepage repository.

## Global Constraints

- 기준 설계는 `docs/superpowers/specs/2026-09-03-distill-homepage-current-research-design.md`다. 구현 전에 `docs/SPEC.md`와 `docs/DEV_PLAN.md`에 승인된 결정을 반영하고, 실제 배포 뒤에만 `docs/PROJECT_CONTEXT.md`를 운영 사실로 갱신한다.
- 이 계획은 한 번에 하나의 현재 연구만 다룬다. 자동 발행, 연구주제 선택, 상태 선택, 멀티 연구 분기, 최종 결과물 입력·연구 종결, 공개 Critic/Counter, semantic search를 추가하지 않는다.
- 공개 payload는 `CurrentResearchPayload` strict allowlist로만 생성한다. client가 보내는 content, actor, publication ID, timestamp를 신뢰하지 않는다.
- 모든 구현 task는 RED → 실패 확인 → 최소 구현 → PASS → 관련 회귀 테스트 → task 전용 commit 순서로 실행한다. 실패를 보지 못한 테스트는 완료로 표시하지 않는다.
- Radar 작업트리와 홈페이지 작업트리의 기존 변경은 사용자 소유다. 각 commit은 이 task의 명시 파일만 pathspec으로 stage한다.
- 홈페이지 저장소는 `/Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun`이며 Radar 저장소와 별도 Git history를 가진다. 홈페이지 task는 해당 저장소에 쓰기 권한이 있는 실행 환경에서 수행한다.
- `radar-publications` bucket은 public development URL/custom domain 없이 private으로 만든다. Radar에는 `PUBLICATIONS`, 홈페이지 Worker에는 `HOMEPAGE_PUBLICATIONS`로만 bind한다.
- remote D1 읽기, bucket 생성, secret 등록, remote migration, deploy는 운영 승인 단계다. unit/integration 구현 task에서 실행하지 않는다.
- Cloudflare 현재 계약에 맞춰 `@cloudflare/workers-types`를 `5.20260902.1`로 갱신하고 `pnpm cf:typegen`으로 binding type을 재생성한다. 이 기능과 무관한 `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin` migration은 별도 유지보수로 남긴다.
- R2 conditional `put()`은 precondition 실패 시 예외가 아니라 `null`을 반환할 수 있으므로 둘 다 conflict로 처리한다. D1 `batch()`는 한 statement 실패 시 전체 rollback되는 현재 Cloudflare 계약을 전제로 guard statement가 실패하도록 만든다.
- `displayTitle`은 Unicode code point 기준 총 200자 상한으로 고정한다. 원문이 넘으면 앞 199자 + `…`로 만들며 source 배열 항목은 자르지 않는다.
- HTML 거절은 HTML comment/doctype 또는 영문 tag 형태(`<tag>`, `</tag>`)를 대상으로 한다. 일반 수학 비교 기호 `<`, `>`는 허용하며 Vue는 모든 공개 문자열을 mustache로 렌더링한다.
- `liveDistillSessionFilter`의 현재 의미를 유지하므로 `sources_used_json = []`인 source-less Distill은 발행 가능하지 않다.
- `PURGING`은 비활성 `공개 삭제 처리 중…`, `PURGED`는 비활성 `공개 삭제됨 · 새 Distill 필요`로 표시한다. current와 다른 최신 session이 우연히 같은 hash를 가져도 session/publication identity가 다르면 `새 결과로 업데이트`할 수 있어야 한다.
- 최종 production 값은 `READING_REACTIONS_ENABLED=false`다. endpoint를 먼저 배포할 때는 `true`로 유지하고, legacy seed 보존과 새 Pages UI가 준비된 마지막 cutover에서만 `false`로 바꾼다.
- source 삭제 fence에서 current가 없을 때 null-ID/hash tombstone을 새로 만들 수 있는 경우는 해당 publication/event 이력도 전혀 없을 때뿐이다. 이력이 하나라도 있으면 식별 불가능한 tombstone을 만들지 않고 `publication_ledger_unavailable`로 fail closed한다. hard purge는 요청 publication이 속한 Distill session 전체를 범위로 삼으며, current가 없거나 scoped EXPLORING인 경우 그 범위의 publication ID/hash를 가진 non-null tombstone을 쓴다. 이미 존재하는 검증된 null-ID/hash `WITHDRAWN` tombstone은 새 revision으로 그대로 re-fence한다.
- 홈페이지 자동 배포의 유일한 release source는 version-controlled `config/current-research-release.json`이다. workflow나 임의 환경변수가 UI/Worker 모드를 독립적으로 덮어쓰지 못하게 한다.

---

## Contract Used by Both Repositories

```ts
export interface CurrentResearchMaterial {
  title: string;
  author: string | null;
  year: number | null;
  url: string;
}

export interface CurrentResearchContent {
  displayTitle: string;
  keywords: string[];
  thoughts: string[];
  questions: string[];
  researchDirections: string[];
  artworkDirections: string[];
  researchMaterials: CurrentResearchMaterial[];
}

export type ExploringCurrentResearchPayload = {
  schemaVersion: 1;
  kind: "CURRENT_RESEARCH";
  source: "research-radar";
  state: "EXPLORING";
  publicationId: string;
  distilledAt: string;
  publishedAt: string;
  updatedAt: string;
  contentHash: string;
  content: CurrentResearchContent;
};

export type WithdrawnCurrentResearchPayload = {
  schemaVersion: 1;
  kind: "CURRENT_RESEARCH";
  source: "research-radar";
  state: "WITHDRAWN";
  withdrawnPublicationId: string | null;
  withdrawnContentHash: string | null;
  withdrawnAt: string;
};

export type CurrentResearchPayload =
  | ExploringCurrentResearchPayload
  | WithdrawnCurrentResearchPayload;

export interface CurrentResearchStorageWrapper {
  storageRevision: string;
  payload: CurrentResearchPayload;
}

export type DistillHomepagePublicationState =
  | "NONE" | "CURRENT" | "SUPERSEDED" | "WITHDRAWN"
  | "FAILED" | "PURGING" | "PURGED";

export interface HomepagePreviewResponse {
  sessionId: string;
  distilledAt: string;
  contentHash: string;
  content: CurrentResearchContent;
  currentRevision: string;
  changed: boolean;
  excludedResearchMaterialCount: number;
  privateReview: {
    warnings: Array<{ category: string; note: string }>;
    overall: string | null;
  };
}

export type HomepageCurrentStatus =
  | { state: "NONE" }
  | {
      state: "PUBLISHED";
      publicationId: string;
      distillSessionId: string;
      contentHash: string;
      publishedAt: string;
      updatedAt: string;
    }
  | {
      state: "WITHDRAWN";
      publicationId: string | null;
      distillSessionId: string | null;
      contentHash: string | null;
      withdrawnAt: string;
    };

export interface HomepagePublicationStatusResponse {
  currentRevision: string;
  current: HomepageCurrentStatus;
  latestPublishable: null | { sessionId: string; distilledAt: string; contentHash: string };
  ledgerReconcilePending: boolean;
}

export interface HomepageCsrfResponse {
  token: string;
  expiresAt: string;
}

export interface ApiErrorResponse {
  error: string;
  requestId: string;
  details?: unknown;
}

export type HomepagePublishRequest = {
  expectedContentHash: string;
  expectedCurrentRevision: string;
};

export type HomepagePublishResponse = {
  ok: true;
  publication: ExploringCurrentResearchPayload;
  currentRevision: string;
  idempotent: boolean;
  ledgerReconcilePending: boolean;
};

export type HomepageWithdrawRequest = {
  expectedPublicationId: string;
  expectedContentHash: string;
  expectedCurrentRevision: string;
};

export type HomepageWithdrawResponse = {
  ok: true;
  state: "WITHDRAWN";
  withdrawnPublicationId: string;
  withdrawnAt: string;
  currentRevision: string;
  idempotent: boolean;
  ledgerReconcilePending: boolean;
};
```

Public limits are fixed: keywords 6×80, thoughts 3×600, questions 3×400, research directions 2×600, artwork directions 2×600, materials 5 with title 300/author 200/URL 2,048, and UTF-8 serialized public payload 64 KiB. At least one of keywords/thoughts/questions/researchDirections/artworkDirections must be non-empty.

---

### Task 1: Ratify the approved decision in source-of-truth docs

**Repository:** Radar

**Files:**

- Modify after explicit ratification: `docs/superpowers/specs/2026-09-03-distill-homepage-current-research-design.md`
- Modify: `docs/SPEC.md:9-84`
- Modify: `docs/DEV_PLAN.md:136-177,219-241`

- [ ] **Step 0: Stop for one explicit hard-purge safety ratification.**

  The approved design originally lets one hard-purge run observe an empty history prefix and immediately mark `PURGED`. The implementation review found a late history PUT can finish after that observation and resurrect an object. Present these alternatives before implementation and do not silently choose:

  1. **Recommended:** permanent per-Distill-session purge marker, session-wide enumeration/purge of every sibling publication ID, `PURGING` across runs, two zero observations separated by at least 60 seconds, recurring audit/sweep of marker-bearing `PURGED` rows, source-delete null tombstone only when both publication/event history are empty, and a non-null scoped publication ID/hash tombstone when hard-purge current is missing. This adds one private R2 marker key per purged session and asynchronous completion but closes resurrection, sibling-copy, and unidentified-tombstone races.
  2. Keep the one-run design, accepting that concurrent/delayed R2 PUT cannot be proven absent. This is not acceptable for a claimed hard purge and requires renaming/weaker guarantees.

  Continue with Tasks 1–20 only after the user explicitly selects the recommended guarantee. Then add the session-wide marker/sibling scope, asynchronous `PURGING`, two-pass zero rule, recurring audit, and both missing-current tombstone rules to the approved design document before changing implementation.

- [ ] **Step 1: Add the product decision to `docs/SPEC.md`.**

  Add a dated subsection that fixes: explicit preview/approval, latest publishable Distill only, automatic `EXPLORING`, one current edition, private `radar-publications`, homepage fixed-key reader, no public Critic/Counter/raw source, no final-output research closure in this release, and the ratified hard-purge guarantee from Step 0.

- [ ] **Step 2: Add a Phase 7 implementation dependency graph to `docs/DEV_PLAN.md`.**

  Use: contract → projection → ledger/lease → R2 CAS → internal API/CSRF → source-delete/hard-purge interlock. After the contract/back-end boundary, the legacy-preservation pipeline and homepage fixed-key endpoint may be built independently; both, plus reaction cutoff, must complete before the UI cutover and operations verification. This matches Tasks 15–18 without inventing a false serial dependency.

- [ ] **Step 3: Verify the docs do not contradict V0 boundaries.**

  Run:

  ```bash
  rg -n "현재 연구|radar-publications|자동 발행|최종 결과물" docs/SPEC.md docs/DEV_PLAN.md
  git diff --check -- docs/superpowers/specs/2026-09-03-distill-homepage-current-research-design.md docs/SPEC.md docs/DEV_PLAN.md
  ```

  Expected: the approved feature is explicit; auto-publish and final-output closure remain excluded.

- [ ] **Step 4: Commit only the three ratified docs.**

  ```bash
  git add docs/superpowers/specs/2026-09-03-distill-homepage-current-research-design.md docs/SPEC.md docs/DEV_PLAN.md
  git commit -m "260903: 현재 연구 발행 결정을 SPEC·DEV_PLAN에 반영"
  ```

### Task 2: Add the strict Distill and public payload contracts

**Repository:** Radar

**Files:**

- Create: `shared/src/homepagePublication.ts`
- Modify: `shared/src/index.ts:37-42`
- Modify: `shared/package.json:6-13`
- Modify: `shared/tsconfig.json`
- Create: `worker/src/distill/outputSchema.ts`
- Create: `worker/src/distill/outputSchema.test.ts`
- Create: `worker/src/publication/contracts.test.ts`
- Create: `worker/test/fixtures/current-research-exploring-v1.json`
- Create: `worker/test/fixtures/current-research-withdrawn-v1.json`
- Create: `worker/test/fixtures/current-research-hash-mismatch-v1.json`
- Modify: `worker/src/distill/prompts.ts:1-20`
- Modify: `worker/src/distill/run.ts:6-41,55-66,95-96`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing Distill schema tests.**

  Cover every required array and nested `read_next`/`research_gaps` member, optional `small_experiment`, malformed stored JSON, and an object that only has the two fields accepted by the current weak validator.

  ```ts
  expect(parseDistillOutput({ keywords: [], research_directions: [] })).toBeNull();
  expect(parseDistillOutput(validDistill)).toEqual(validDistill);
  expect(parseDistillOutput({ ...validDistill, questions: [42] })).toBeNull();
  ```

  Before the first RED run, extend `worker/vitest.config.ts`'s explicit `include` array with every new Worker test in this plan: `src/distill/outputSchema.test.ts`, `src/publication/contracts.test.ts`, `src/publication/projection.test.ts`, `src/publication/lease.test.ts`, `src/publication/storage.test.ts`, `src/publication/ledger.test.ts`, `src/publication/service.test.ts`, `test/homepagePublicationReconciliation.test.ts`, `src/security/csrf.test.ts`, `src/routes/homepagePublication.test.ts`, `src/reservoir/publicationInterlock.test.ts`, `src/publication/hardPurge.test.ts`, and `src/routes/operations.test.ts`. Keep the existing include entries. This makes every later focused RED command discover its not-yet-implemented test instead of exiting with “no test files found.”

- [ ] **Step 2: Write failing strict public contract tests.**

  Assert both discriminated variants, exact keys, ISO timestamps, lowercase 64-character hashes, UUID storage revisions, nullable author/year, strict public HTTP(S) material URLs, field/count limits, public payload byte limit, and rejection of `critic`, `counter`, `modelVersion`, `r2Key`, `input_context_json`, private/localhost/IP-literal URLs, and any unknown key. Mutate every public string location to prove residual control characters, HTML comments/doctype, and English tag forms are rejected while ordinary mathematical `<`/`>` text remains valid. Commit one valid EXPLORING, one valid WITHDRAWN, and one structurally valid but semantically hash-mismatched fixture for the homepage consumer to mirror byte-for-byte.

  Pin an implementation-independent canonical vector in both repositories. The exact UTF-8 byte string is:

  ```text
  {"content":{"artworkDirections":[],"displayTitle":"현재 연구","keywords":["빛"],"questions":[],"researchDirections":[],"researchMaterials":[],"thoughts":[]},"distilledAt":"2026-09-03T00:00:00.000Z"}
  ```

  Its SHA-256 is exactly `83658fcd9e3c6f3557020c301d2b66327444e49b3eae48a7bbceef447c847170`. Assert the literal bytes and digest without generating the expectation through the production canonicalizer.

  ```ts
  expect(validateCurrentResearchPayload(validExploring)).toEqual(validExploring);
  expect(validateCurrentResearchPayload({ ...validExploring, critic: {} })).toBeNull();
  expect(validateCurrentResearchPayload({ ...validWithdrawn, withdrawnPublicationId: null, withdrawnContentHash: "a".repeat(64) })).toBeNull();
  ```

- [ ] **Step 3: Run the focused tests and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/outputSchema.test.ts src/publication/contracts.test.ts
  ```

  Expected: module/import failures because the validators do not exist.

- [ ] **Step 4: Implement `outputSchema.ts` and retain existing imports.**

  Export `DistillOutput`, `CriticOutput`, `CounterOutput`, `parseDistillOutput()` and `parseCriticOutput()`. Re-export the types from `prompts.ts` so existing route imports remain valid. Replace both `asValidated(..., "distill")` and `asValidated(..., "critic")` with the full parsers for new model output, including Re-Distill parent parsing. Candidate eligibility remains based on full Distill output plus live sources: malformed/missing stored Critic must **not** make selection fall back to an older Distill. `buildHomepageProjection()` parses it separately and substitutes private-only `{warnings: [], overall: null}` when invalid; no malformed Critic member enters `privateReview`.

  ```ts
  export function parseDistillOutput(value: unknown): DistillOutput | null {
    if (!isRecord(value)) return null;
    if (!stringArray(value.keywords) || !stringArray(value.thoughts_fragments)) return null;
    if (!stringArray(value.questions) || !stringArray(value.research_directions)) return null;
    if (!stringArray(value.artwork_directions)) return null;
    if (!readNextArray(value.read_next) || !researchGapArray(value.research_gaps)) return null;
    if (value.small_experiment !== undefined && typeof value.small_experiment !== "string") return null;
    return value as unknown as DistillOutput;
  }
  ```

- [ ] **Step 5: Implement strict shared validators and DTOs.**

  Export the contract above plus `CurrentResearchPayload`, `HomepagePreviewResponse`, `HomepagePublishRequest/Response`, `HomepageWithdrawRequest/Response`, `HomepagePublicationStatusResponse`, `HomepageCsrfResponse`, `ApiErrorResponse`, `DistillHomepagePublicationState`, `validateCurrentResearchPayload()`, and `validateCurrentResearchStorageWrapper()`. Validation must compare `Object.keys(value).sort()` with the variant's exact key list.

  The validator uses `URL` and `TextEncoder`; override the shared package compiler libs without changing the repository-wide base:

  ```json
  {
    "extends": "../tsconfig.base.json",
    "compilerOptions": { "lib": ["ES2022", "DOM"] },
    "include": ["src"]
  }
  ```

- [ ] **Step 6: Run focused and existing Distill tests.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/distill/outputSchema.test.ts src/publication/contracts.test.ts
  pnpm --filter @radar/worker test:run
  pnpm --filter @radar/shared typecheck
  ```

  Expected: PASS; weak historical objects can still be read by existing session detail, but they are not publishable.

- [ ] **Step 7: Commit the contract boundary.**

  ```bash
  git add shared/src/homepagePublication.ts shared/src/index.ts shared/package.json shared/tsconfig.json worker/src/distill/outputSchema.ts worker/src/distill/outputSchema.test.ts worker/src/publication/contracts.test.ts worker/test/fixtures/current-research-exploring-v1.json worker/test/fixtures/current-research-withdrawn-v1.json worker/test/fixtures/current-research-hash-mismatch-v1.json worker/src/distill/prompts.ts worker/src/distill/run.ts worker/vitest.config.ts
  git commit -m "260903: 공개 연구 payload와 Distill schema 검증 추가"
  ```

### Task 3: Build the deterministic public projection

**Repository:** Radar

**Files:**

- Create: `worker/src/publication/projection.ts`
- Create: `worker/src/publication/projection.test.ts`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing title, sanitization, and hash tests.**

  Test question → research direction → `현재 연구`, 199 code points + ellipsis, preserved array order/null, recursive object-key sorting, stable lowercase SHA-256, control-character cleanup, HTML-like rejection, and copied-field over-limit rejection rather than truncation.

  ```ts
  expect(deriveDisplayTitle({ questions: ["첫 질문"], researchDirections: ["방향"] })).toBe("첫 질문");
  expect([...deriveDisplayTitle({ questions: ["가".repeat(201)], researchDirections: [] })]).toHaveLength(200);
  await expect(hashHomepageProjection(at, content)).resolves.toMatch(/^[a-f0-9]{64}$/);
  ```

- [ ] **Step 2: Write failing latest-session and material-join tests.**

  Insert schema-invalid newest Distill rows, a newest valid Distill with malformed Critic, deleted-source sessions, tied `created_at` IDs, an active source deletion claim, canonical/DOI/private URLs, and more than five sources. Assert the first schema-valid Distill row from `created_at DESC, id DESC` wins, malformed Critic becomes an empty private review without fallback, and a claim on that selected session blocks instead of falling back.

- [ ] **Step 3: Run the projection test and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/projection.test.ts
  ```

- [ ] **Step 4: Implement the projection interfaces and query.**

  ```ts
  export interface PublishableDistillSession {
    id: string;
    createdAt: string;
    sourcesUsed: Array<{ id: string; title: string }>;
    output: DistillOutput;
    critic: CriticOutput | null;
  }

  export interface HomepageProjectionDraft {
    sessionId: string;
    sourceIds: string[];
    distilledAt: string;
    content: CurrentResearchContent;
    contentHash: string;
    excludedResearchMaterialCount: number;
    privateReview: { warnings: Array<{ category: string; note: string }>; overall: string | null };
  }

  export async function loadLatestPublishableDistill(db: D1Database): Promise<PublishableDistillSession | null>;
  export async function loadPublishableDistill(db: D1Database, sessionId: string): Promise<PublishableDistillSession | null>;
  export async function buildHomepageProjection(db: D1Database, session: PublishableDistillSession): Promise<HomepageProjectionDraft>;
  export function canonicalJson(value: unknown): string;
  export async function hashHomepageProjection(distilledAt: string, content: CurrentResearchContent): Promise<string>;
  ```

  Page SQL-qualified candidates without `LIMIT 1` before TypeScript validation. Material lookup must preserve `json_each` ordinal:

  ```sql
  SELECT CAST(used.key AS INTEGER) AS ordinal,
         source.title, source.authors, source.year,
         source.canonical_url AS canonicalUrl, source.doi
  FROM json_each(?) AS used
  JOIN sources AS source ON source.id = json_extract(used.value, '$.id')
  ORDER BY ordinal
  ```

- [ ] **Step 5: Enforce URL and payload rules without network access.**

  Accept public `http:`/`https:` URLs with no credentials; reject localhost, `.local`, and private/loopback IPv4/IPv6 literals. Prefer `canonical_url`, then normalized DOI URL. Do not fetch or DNS-resolve. Count excluded materials for preview.

  `canonicalJson()` recursively accepts only JSON primitives, arrays, and plain records and throws on `undefined`, non-finite numbers, prototypes, or cycles; accepting `unknown` keeps `CurrentResearchContent` type-safe without a fake index signature. Hash exactly `canonicalJson({ distilledAt, content })` as UTF-8; publication ID and approval timestamps never enter the hash. Before returning preview, validate the draft inside a worst-case fixed-length EXPLORING envelope so adding server UUID/timestamps cannot push a previewed result over 64 KiB at publish time.

- [ ] **Step 6: Run focused tests, typecheck, and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/projection.test.ts src/radar/snapshot.test.ts
  pnpm --filter @radar/worker typecheck
  git add worker/src/publication/projection.ts worker/src/publication/projection.test.ts worker/vitest.config.ts
  git commit -m "260903: 최신 Distill 공개 projection과 source join 추가"
  ```

### Task 4: Add the publication ledger, event log, and singleton lease schema

**Repository:** Radar

**Files:**

- Create: `worker/migrations/0029_homepage_publications.sql`
- Create: `worker/src/publication/lease.ts`
- Create: `worker/src/publication/lease.test.ts`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing migration and lease tests.**

  Assert table/status/pending-action constraints, paired and immutable hard-purge target/requester/time fields, purge-only state transitions (`PURGING → PURGED`, terminal `PURGED`), null pending intent in both purge states, complete `PURGED` marker/zero/payload invariant, unique `(distill_session_id, content_hash)`, unique event identity `(publication_id, action, occurred_at)`, event append-only triggers, one singleton row with paired owner/expiry, live-lock rejection, exact 60-second expiry/takeover boundary, exact 15-second renewal cadence/full-horizon extension, stale generation rejection, and conditional release.

- [ ] **Step 2: Run the test and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/lease.test.ts
  ```

- [ ] **Step 3: Add the complete migration.**

  ```sql
  CREATE TABLE homepage_publications (
    id TEXT PRIMARY KEY,
    distill_session_id TEXT NOT NULL REFERENCES distill_sessions(id),
    status TEXT NOT NULL CHECK (status IN ('PUBLISHING','PUBLISHED','SUPERSEDED','WITHDRAWN','FAILED','PURGING','PURGED')),
    payload_json TEXT,
    content_hash TEXT NOT NULL,
    error_code TEXT,
    approved_by_sub TEXT,
    withdrawn_by_sub TEXT,
    pending_action TEXT CHECK (pending_action IS NULL OR pending_action IN ('PUBLISH','REPUBLISH','WITHDRAW')),
    pending_actor_sub TEXT,
    pending_event_at TEXT,
    lease_generation INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    approved_at TEXT,
    first_published_at TEXT,
    last_published_at TEXT,
    superseded_at TEXT,
    withdrawn_at TEXT,
    purge_requested_publication_id TEXT REFERENCES homepage_publications(id),
    purge_requested_by_sub TEXT,
    purge_requested_at TEXT,
    purge_marker_at TEXT,
    purge_zero_verified_at TEXT,
    CHECK (
      (pending_action IS NULL AND pending_actor_sub IS NULL AND pending_event_at IS NULL)
      OR
      (pending_action IS NOT NULL AND pending_actor_sub IS NOT NULL AND pending_event_at IS NOT NULL)
    ),
    CHECK (
      (purge_requested_publication_id IS NULL AND purge_requested_by_sub IS NULL AND purge_requested_at IS NULL)
      OR
      (purge_requested_publication_id IS NOT NULL AND purge_requested_by_sub IS NOT NULL AND purge_requested_at IS NOT NULL)
    ),
    CHECK (
      status NOT IN ('PURGING','PURGED')
      OR (purge_requested_publication_id IS NOT NULL AND purge_requested_by_sub IS NOT NULL AND purge_requested_at IS NOT NULL)
    ),
    CHECK (
      status NOT IN ('PURGING','PURGED')
      OR (pending_action IS NULL AND pending_actor_sub IS NULL AND pending_event_at IS NULL)
    ),
    CHECK (
      status <> 'PURGED'
      OR (purge_marker_at IS NOT NULL AND purge_zero_verified_at IS NOT NULL AND payload_json IS NULL)
    ),
    UNIQUE (distill_session_id, content_hash)
  );

  CREATE INDEX idx_homepage_publications_status ON homepage_publications(status, updated_at);
  CREATE INDEX idx_homepage_publications_session ON homepage_publications(distill_session_id, created_at);

  CREATE TABLE homepage_publication_events (
    id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES homepage_publications(id),
    action TEXT NOT NULL CHECK (action IN ('PUBLISH','REPUBLISH','WITHDRAW','RECONCILE','HARD_PURGE')),
    actor_sub TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    error_code TEXT,
    UNIQUE (publication_id, action, occurred_at)
  );

  CREATE TRIGGER homepage_publication_events_no_update
  BEFORE UPDATE ON homepage_publication_events
  BEGIN SELECT RAISE(ABORT, 'homepage_publication_events_append_only'); END;

  CREATE TRIGGER homepage_publication_events_no_delete
  BEFORE DELETE ON homepage_publication_events
  BEGIN SELECT RAISE(ABORT, 'homepage_publication_events_append_only'); END;

  CREATE TRIGGER homepage_publications_purge_request_immutable
  BEFORE UPDATE OF purge_requested_publication_id, purge_requested_by_sub, purge_requested_at ON homepage_publications
  WHEN OLD.purge_requested_publication_id IS NOT NULL
   AND (NEW.purge_requested_publication_id IS NOT OLD.purge_requested_publication_id
        OR NEW.purge_requested_by_sub IS NOT OLD.purge_requested_by_sub
        OR NEW.purge_requested_at IS NOT OLD.purge_requested_at)
  BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_request_immutable'); END;

  CREATE TRIGGER homepage_publications_purge_marker_immutable
  BEFORE UPDATE OF purge_marker_at ON homepage_publications
  WHEN OLD.purge_marker_at IS NOT NULL AND NEW.purge_marker_at IS NOT OLD.purge_marker_at
  BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_marker_immutable'); END;

  CREATE TRIGGER homepage_publications_purge_state_terminal
  BEFORE UPDATE OF status ON homepage_publications
  WHEN (OLD.status = 'PURGING' AND NEW.status NOT IN ('PURGING','PURGED'))
    OR (OLD.status = 'PURGED' AND NEW.status <> 'PURGED')
  BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_state_terminal'); END;

  CREATE TABLE homepage_publication_lease (
    lock_name TEXT PRIMARY KEY CHECK (lock_name = 'homepage-current-research'),
    owner_token TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    expires_at_ms INTEGER,
    updated_at TEXT NOT NULL,
    CHECK (
      (owner_token IS NULL AND expires_at_ms IS NULL)
      OR (owner_token IS NOT NULL AND expires_at_ms IS NOT NULL)
    )
  );

  INSERT INTO homepage_publication_lease(lock_name, owner_token, generation, expires_at_ms, updated_at)
  VALUES ('homepage-current-research', NULL, 0, NULL, '1970-01-01T00:00:00.000Z');
  ```

- [ ] **Step 4: Implement lease operations.**

  ```ts
  export const PUBLICATION_LEASE_MS = 60_000;
  export const PUBLICATION_RENEW_MS = 15_000;
  export const PUBLICATION_LEASE_SAFETY_MS = 5_000;
  export interface PublicationLease { ownerToken: string; generation: number; expiresAtMs: number }
  export interface PublicationLeaseBackend {
    acquire(): Promise<PublicationLease>;
    renew(lease: PublicationLease): Promise<PublicationLease>;
    assertOwned(lease: PublicationLease): Promise<void>;
    release(lease: PublicationLease): Promise<boolean>;
  }
  export interface PublicationLeaseTimerClock {
    monotonicNowMs(): number;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  }
  export interface PublicationLeaseController {
    currentLease(): PublicationLease;
    checkpoint(): Promise<PublicationLease>;
    stop(): Promise<void>;
  }
  export function createD1PublicationLeaseBackend(db: D1Database): PublicationLeaseBackend;
  export async function acquirePublicationLeaseController(backend: PublicationLeaseBackend, clock?: PublicationLeaseTimerClock): Promise<PublicationLeaseController>;
  ```

  Every production acquire/renew/assert/release statement evaluates time **inside that D1 statement**, for example through one CTE `clock(now_ms) AS (SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER))`. Acquire succeeds only for null/`expires_at_ms <= now_ms`, increments generation, and sets `expires_at_ms = now_ms + 60000`; renew succeeds only for the exact owner/generation with `expires_at_ms > now_ms` and resets it to DB-now + 60000. An expired generation can never be renewed or resurrected, even if its request sat in a queue. Assert/release use the same DB-time/identity contract. The low-level production backend accepts no caller wall-clock override.

  Keep deterministic scheduling separate: inject a fake `PublicationLeaseBackend` and monotonic timer into controller unit tests, while D1 integration tests directly arrange live/equal/expired row values and prove the SQL's `> / <=` DB-time boundary. The controller owns acquisition so it can record `acquireDispatchStarted`; its conservative earliest deadline is dispatch-start + 60 seconds because D1 can only evaluate later. If acquisition returns inside the 5-second safety window, renew before exposing the controller or fail. Apply the same dispatch-start deadline to each renewal response.

  Use one serialized controller, never `setInterval(async ...)`, and preserve an **absolute** monotonic cadence: initialize `nextDue = acquireDispatchStarted + 15s`, advance with `nextDue += 15s`, and after a renewal settles either renew immediately when overdue or wait only `nextDue - monotonicNow`. `checkpoint()` loops: await any in-flight renewal, renew if its conservative deadline is near, call backend `assertOwned()`, then re-check the monotonic deadline **after the assertion returns**. Because assertion does not extend the horizon, a slow assertion that consumes the safety window forces renew + reassert; checkpoint never returns a lease without a confirmed safe horizon. `stop()` cancels the timer and awaits the one in-flight renewal; it never releases. Test a 50-second delayed acquisition, 14,999/15,000 ms scheduling, deferred overlap, completion inversion, a 50-second renewal, immediate catch-up, a delayed assertion crossing the safety boundary, assertion/renewal failure propagation, and caller-controlled conditional release. Never delete the singleton row. A failed acquisition maps to `409 publication_in_progress`.

- [ ] **Step 5: Verify migration rollback semantics and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/lease.test.ts
  pnpm --filter @radar/worker test:run
  git add worker/migrations/0029_homepage_publications.sql worker/src/publication/lease.ts worker/src/publication/lease.test.ts worker/vitest.config.ts
  git commit -m "260903: 홈페이지 발행 ledger와 singleton lease 추가"
  ```

### Task 5: Add conditional R2 history/current storage

**Repository:** Radar

**Files:**

- Create: `worker/src/publication/storage.ts`
- Create: `worker/src/publication/storage.test.ts`
- Modify: `worker/wrangler.jsonc:40-49`
- Modify: `worker/test/helpers/runtime.ts:5-22`
- Modify: `worker/vitest.config.ts:23-25`
- Modify: `worker/package.json:20-29`
- Modify: `pnpm-lock.yaml`
- Regenerate: `worker/worker-configuration.d.ts`

- [ ] **Step 1: Write failing R2 tests.**

  Test missing/current reads, wrapper validation, opaque revision, history first-write, same-key/same-hash retry, same-key/different-hash integrity failure, existing ETag CAS, missing `etagDoesNotMatch: "*"`, `null` conditional result, thrown timeout followed by read-after-write verification, and a new `storageRevision` when the payload is unchanged. Add permanent session purge-marker tests: marker first-write/idempotent reread, every sibling publication history write rejected by one session marker, marker appearing during a deferred history PUT, post-check deletion of that just-written key, and marker never being deleted by any sibling history-prefix sweep. Marker **key existence**, checked with `head/get != null`, is the deny fence: an empty or malformed marker must still block both pre- and post-check history writes with `publication_purged`; parse/metadata corruption raises a separate audit alert and can never downgrade to “marker absent.”

- [ ] **Step 2: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/storage.test.ts
  ```

- [ ] **Step 3: Implement the storage boundary.**

  ```ts
  export const CURRENT_RESEARCH_KEY = "homepage/current-research.json";
  export const PURGE_MARKER_PREFIX = "homepage/purge-markers/sessions/";
  export type CurrentPublicationSnapshot =
    | { exists: false; etag: null; currentRevision: string; wrapper: null }
    | { exists: true; etag: string; currentRevision: string; wrapper: CurrentResearchStorageWrapper };

  export function historyKey(publicationId: string, eventAt: string): string;
  export function purgeMarkerKey(distillSessionId: string): string;
  export async function hasPermanentPurgeMarker(bucket: R2Bucket, distillSessionId: string): Promise<boolean>;
  export async function readPurgeMarker(bucket: R2Bucket, distillSessionId: string): Promise<{ distillSessionId: string; requestedPublicationId: string; createdAt: string } | null>;
  export async function putPermanentPurgeMarker(bucket: R2Bucket, input: { distillSessionId: string; requestedPublicationId: string; createdAt: string }): Promise<void>;
  export async function readCurrentPublication(bucket: R2Bucket): Promise<CurrentPublicationSnapshot>;
  export async function putHistoryEventIfAbsent(bucket: R2Bucket, input: { distillSessionId: string; payload: ExploringCurrentResearchPayload }): Promise<void>;
  export async function compareAndSwapCurrent(bucket: R2Bucket, expected: CurrentPublicationSnapshot, payload: CurrentResearchPayload): Promise<CurrentPublicationSnapshot>;
  export async function fenceCurrentPublication(bucket: R2Bucket, expected: CurrentPublicationSnapshot): Promise<CurrentPublicationSnapshot>;
  export async function deletePublicationHistory(
    bucket: R2Bucket,
    publicationId: string,
    heartbeat: () => Promise<void>,
  ): Promise<{ deleted: number; remaining: number }>;
  ```

  Current stores `{storageRevision: crypto.randomUUID(), payload}`. History stores immutable public payload JSON, never the storage wrapper. `currentRevision` is `sha256(etag ?? "MISSING")`; the actual ETag never leaves the service layer. On every EXPLORING current read and same-key history retry, recompute `sha256(canonicalJson({ distilledAt, content }))` and reject a stored `contentHash` mismatch as `publication_storage_invalid`; format-only hash validation is insufficient.

  The session purge marker is immutable, contains no public payload, lives outside every `homepage/history/{publicationId}/`, and is never deleted. `hasPermanentPurgeMarker()` checks key existence only and is the deny decision; `readPurgeMarker()` separately parses optional audit metadata and corruption raises an operator alert. `putHistoryEventIfAbsent()` receives the private Distill session ID separately from the public payload, checks its session marker immediately before PUT and again after the PUT resolves; if either sees even an empty/malformed marker, return `publication_purged`, deleting the exact just-written history key on the post-check path. `deletePublicationHistory()` must assert/renew through `heartbeat()` before every paginated list, delete chunk, and final zero-count list, and must never include the marker prefix.

- [ ] **Step 4: Add the `PUBLICATIONS` binding and current runtime types.**

  Add:

  ```json
  { "binding": "PUBLICATIONS", "bucket_name": "radar-publications" }
  ```

  Then update and regenerate:

  ```bash
  pnpm --filter @radar/worker add -D @cloudflare/workers-types@5.20260902.1
  pnpm cf:typegen
  ```

  Add a `PUBLICATIONS` probe in `worker/test/helpers/runtime.ts` next to the existing `ORIGINALS` probe.

- [ ] **Step 5: Run focused/runtime tests and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/storage.test.ts
  pnpm --filter @radar/worker test:run
  pnpm --filter @radar/worker typecheck
  git add worker/src/publication/storage.ts worker/src/publication/storage.test.ts worker/wrangler.jsonc worker/test/helpers/runtime.ts worker/vitest.config.ts worker/package.json pnpm-lock.yaml worker/worker-configuration.d.ts
  git commit -m "260903: 공개 연구 R2 history와 current CAS 저장소 추가"
  ```

### Task 6: Implement guarded ledger transitions and reconciliation primitives

**Repository:** Radar

**Files:**

- Create: `worker/src/publication/ledger.ts`
- Create: `worker/src/publication/ledger.test.ts`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing transition tests.**

  Cover new `PUBLISHING`, `FAILED` with a retained publish tuple reusing it, pending-null `FAILED` allocating a fresh `PUBLISH`/`REPUBLISH` intent from first-publication history, `WITHDRAWN`/`SUPERSEDED` republish with a new event time, stable publication ID from the unique pair, first-published preservation, previous `PUBLISHED` → `SUPERSEDED`, append-only actions, stale owner/generation, and expired lease.

- [ ] **Step 2: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/ledger.test.ts
  ```

- [ ] **Step 3: Implement explicit transition functions.**

  ```ts
  export interface BeginPublishingInput {
    sessionId: string;
    contentHash: string;
    actorSub: string;
    approvedAt: string;
  }

  export interface PublishingEdition {
    publicationId: string;
    eventAction: "PUBLISH" | "REPUBLISH";
    eventAt: string;
    publishedAt: string;
  }

  export interface FinalizePublishedInput {
    previousPublicationId: string | null;
    publication: ExploringCurrentResearchPayload;
  }

  export interface BeginWithdrawalInput {
    publicationId: string;
    actorSub: string;
    requestedAt: string;
  }

  export interface WithdrawalIntent {
    publicationId: string;
    eventAt: string;
  }

  export interface FinalizeWithdrawnInput {
    publicationId: string;
  }

  export interface ReconcileResult {
    scanned: number;
    repaired: number;
    failed: number;
  }

  export async function beginPublishing(db: D1Database, lease: PublicationLease, input: BeginPublishingInput): Promise<PublishingEdition>;
  export async function allocatePublicationEventAt(db: D1Database, lease: PublicationLease, publicationId: string, requestedAt: string): Promise<string>;
  export async function beginWithdrawal(db: D1Database, lease: PublicationLease, input: BeginWithdrawalInput): Promise<WithdrawalIntent>;
  export async function clearPendingWithdrawal(db: D1Database, lease: PublicationLease, publicationId: string): Promise<void>;
  export async function finalizePublished(db: D1Database, lease: PublicationLease, input: FinalizePublishedInput): Promise<void>;
  export async function markPublicationFailed(db: D1Database, lease: PublicationLease, publicationId: string, errorCode: string): Promise<void>;
  export async function finalizeWithdrawn(db: D1Database, lease: PublicationLease, input: FinalizeWithdrawnInput): Promise<void>;
  export async function reconcileLedgerToCurrent(db: D1Database, lease: PublicationLease, current: CurrentPublicationSnapshot): Promise<ReconcileResult>;
  export async function publicationStateForSessions(
    db: D1Database,
    sessionIds: string[],
    current: CurrentPublicationSnapshot | null,
  ): Promise<Map<string, DistillHomepagePublicationState>>;
  ```

  Every write statement in a batch must either contain the lease `EXISTS` predicate or be preceded by a `SELECT CASE ... ELSE json('publication_lease_guard_failed')` statement that deliberately fails the D1 transaction. Inspect `meta.changes` after guarded upserts; zero changes is stale ownership, never success. `beginPublishing()` reserves/loads identity and freezes `pending_action` (`PUBLISH` when `first_published_at IS NULL`, otherwise `REPUBLISH`), the human `pending_actor_sub`, and one effective `pending_event_at` derived from `approvedAt` before any R2 write. A `FAILED` retry preserves all three only when its pending action is already `PUBLISH`/`REPUBLISH`; a pending-null `FAILED` row allocates a fresh intent based on `first_published_at`. It does **not** accept final payload, because `publicationId` and approval times are not known until it returns. Return `publishedAt = first_published_at ?? eventAt`; the service then constructs and validates the full EXPLORING payload with `updatedAt = eventAt` and passes that object to history plus `finalizePublished()`. The finalizer reads and consumes pending action/actor/time from the guarded row rather than accepting duplicates, and requires payload ID/hash/`publishedAt`/`updatedAt` to match the reserved edition. On first success `approved_at = first_published_at = last_published_at = pending_event_at`; republish preserves `first_published_at` and advances the other approval/event timestamps. A definite publish history/current failure marks `FAILED` but retains all pending publish intent, including on CAS conflict, so that same intent retries idempotently.

  `beginWithdrawal()` stores `WITHDRAW`, actor, and one effective event time before R2 mutation and returns only `{publicationId,eventAt}`. Build the tombstone's `withdrawnAt` from that return value; `finalizeWithdrawn()` accepts only the publication ID and consumes actor/time from the row, making mismatched caller timestamps impossible. Successful finalization clears the intent. Only a definite **withdrawal** precondition failure clears its matching intent; an ambiguous R2 result is resolved by rereading current first. Tests must distinguish these publish-retain and withdrawal-clear rules and reject payload/tombstone time divergence.

  Generate a new opaque `crypto.randomUUID()` only when the `(distill_session_id, content_hash)` row does not exist. Reuse it for every retry and republish. Record `PUBLISH` only on the first successful approval and `REPUBLISH` after `WITHDRAWN`/`SUPERSEDED`; never create a duplicate event for an already-current idempotent retry.

  Event timestamps and history keys must be strictly monotonic per publication: reuse a stored time only for the same `FAILED`/orphan intent; otherwise exported `allocatePublicationEventAt()` chooses `max(requestedAt, latest event occurred_at + 1ms, row pending_event_at + 1ms, existing purge_requested_at + 1ms)` in UTC ISO form for every new `PUBLISH`/`REPUBLISH`/`WITHDRAW`/`RECONCILE`/`HARD_PURGE` intent. Test the allocator under a fixed clock; Task 11 then proves publish, withdraw, republish, and hard-purge request in the same millisecond receive ordered distinct event/history times.

  `publicationStateForSessions()` must treat D1 as history and the validated R2 snapshot as current truth. A non-null missing snapshot (`exists:false`) means authoritative absence; `null` means R2 unavailable/invalid and activates the D1-only fallback. Return `CURRENT` only when a non-null EXPLORING current matches both publication ID and content hash. Derive `PURGING/PURGED` from the private row first; in fallback retain terminal `SUPERSEDED`/`WITHDRAWN`/`FAILED`, but map `PUBLISHING`/`PUBLISHED` to `NONE`. Never infer `CURRENT` from D1 alone. Test every status under all three inputs: matching snapshot, authoritative missing snapshot, and null/unavailable snapshot.

- [ ] **Step 4: Implement orphan/reality reconciliation.**

  R2 current is authoritative. Before ordinary repair, inspect the target ledger row: `PURGING`/`PURGED` is never rewritten by this function, even when current is a matching tombstone; route `PURGING` to Task 11's dedicated purge resume and keep `PURGED` terminal. Non-active-generation `PUBLISHING` becomes `PUBLISHED` only when current publication ID and hash both match; otherwise `FAILED`. When this failure retains a pending publish tuple, do **not** append a `RECONCILE` event—the later idempotent publish retry must still use that earlier human event/history time without creating chronological inversion. A matching current plus pending publish intent copies the already validated R2 EXPLORING payload into `payload_json`, derives first/last timestamps from its `publishedAt`/`updatedAt`, and consumes the persisted human action/actor/time in the same guarded batch. Thus current-PUT success followed by D1 failure recovers complete private provenance plus the required `PUBLISH` or `REPUBLISH` event even though the reserved row initially had null payload. A stale D1 `PUBLISHED` becomes `SUPERSEDED` or pending-null `FAILED`. A matching tombstone plus a matching pending withdrawal intent repairs `WITHDRAWN` and writes the one `WITHDRAW` event using the persisted human actor/time; an orphan tombstone without such proof uses actor `system:reconciler` and a monotonic `RECONCILE` time. Other terminal repairs append `RECONCILE` only when no pending tuple is retained. Test initial-publish and republish crashes separately, retained-pending failure without RECONCILE, pending-null FAILED retry, withdrawal crash recovery, and both purge states to prove payload/audit survival and no purge-state reversal.

- [ ] **Step 5: Verify and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/ledger.test.ts src/publication/lease.test.ts
  pnpm --filter @radar/worker typecheck
  git add worker/src/publication/ledger.ts worker/src/publication/ledger.test.ts worker/vitest.config.ts
  git commit -m "260903: 발행 상태 전이와 원장 reconciliation 추가"
  ```

### Task 7: Orchestrate read-only preview and history-first publish

**Repository:** Radar

**Files:**

- Create: `worker/src/publication/service.ts`
- Create: `worker/src/publication/service.test.ts`
- Modify: `worker/src/publication/lease.ts`
- Modify: `worker/src/publication/lease.test.ts`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing preview tests.**

  Assert exact-session/latest-session enforcement, `410 publication_purged`, deletion-claim blocking, no D1/R2 writes, private Critic separation, current revision/changed result, and byte-for-byte equality of preview `{distilledAt, content, contentHash}` with the later public payload.

- [ ] **Step 2: Write failing publish sequencing and idempotency tests.**

  Use a scripted fake R2 plus deferred promises to prove: one concurrent publisher wins the lease; orphan `PUBLISHING`/stale `PUBLISHED` is reconciled before a new transition; history failure leaves current unchanged; current CAS failure keeps old current; same publication ID/hash succeeds before revision comparison after a lost response; a different session with the same hash is not misclassified as idempotent; initial `FAILED` retries as `PUBLISH`; previously published `FAILED` retries as `REPUBLISH`; and a current success followed by D1 failure returns success with reconciliation pending while retaining human audit intent. Add compile-checked first-publish/republish cases showing `beginPublishing()` first returns identity/action/time and only then does the service construct payload `publicationId`, preserved/new `publishedAt`, and `updatedAt`; no pre-identity payload is passed into begin. Also make immediate reconciliation fail for an already-current ID/hash: it must still return idempotent success with `ledgerReconcilePending:true`. These tests await captured `defer()` work and prove repair acquisition starts only after the original owner releases its lease.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/service.test.ts
  ```

- [ ] **Step 4: Implement the service signatures.**

  ```ts
  type PublicationEnv = Pick<Env, "DB" | "PUBLICATIONS">;
  type Defer = (work: Promise<unknown>) => void;

  export async function previewHomepagePublication(
    env: PublicationEnv,
    sessionId: string,
  ): Promise<HomepagePreviewResponse>;

  export async function publishHomepagePublication(
    env: PublicationEnv,
    input: {
      sessionId: string;
      expectedContentHash: string;
      expectedCurrentRevision: string;
      actorSub: string;
      defer: Defer;
    },
  ): Promise<HomepagePublishResponse>;

  export async function repairHomepagePublicationLedger(
    env: PublicationEnv,
  ): Promise<{ scanned: number; repaired: number; failed: number; busy: boolean }>;
  ```

  Implement `repairHomepagePublicationLedger()` in this task so publish error recovery does not import the future scheduled-operation module. It acquires its own lease, reads/validates current, runs `reconcileLedgerToCurrent()`, and conditionally releases; an already-live lease returns `{scanned:0,repaired:0,failed:0,busy:true}`.

- [ ] **Step 5: Implement the exact publish order.**

  1. Acquire singleton lease and start a 15-second renewal controller.
  2. Read and cryptographically validate R2 current and resolve any matching ledger identity, then call `reconcileLedgerToCurrent()` under this same lease before evaluating a new transition. If repair fails but the requested ledger row's ID/hash already proves it is the current R2 edition, return idempotent public success with `ledgerReconcilePending:true` after release and deferred repair. If no such proof exists, schedule the same safe post-release repair and stop with `publication_ledger_unavailable`; do not begin a new publish.
  3. Re-evaluate the authoritative latest publishable session; do not fall back when its source has a deletion claim.
  4. Reject `PURGING/PURGED`, build the projection, and compare `expectedContentHash`.
  5. Read the unique ledger row. If row ID/hash equals current ID/hash, return idempotently **before** revision comparison after the step-2 reconciliation.
  6. Compare `expectedCurrentRevision`, enter/re-enter `PUBLISHING`, and freeze `pending_event_at`.
  7. Put immutable history with that time. On ambiguous error, reread and compare ID/hash and recomputed hash integrity.
  8. Recheck every selected source against `source_deletion_claims`.
  9. Conditional-put current with the ETag from step 2. On ambiguous error, reread current and compare publication ID/hash.
  10. Finalize new `PUBLISHED`, previous `SUPERSEDED`, and event in one guarded D1 batch.
  11. If step 10 fails after current succeeded, mark `ledgerReconcilePending: true`; stop heartbeat, conditionally release the same owner/generation, and only then pass `releasePromise.then(() => repairHomepagePublicationLedger(env))` to `defer()`. Never start a second lease acquisition while this request still owns the first lease.

  The renewal controller must surface a renewal failure before each subsequent R2/D1 boundary; cleanup must not release a lease owned by a newer generation.

- [ ] **Step 6: Map deterministic service errors.**

  Use the design codes exactly: `latest_distill_required`, `distill_output_not_ready`, `public_projection_empty`, `public_projection_invalid`, `preview_stale`, `publication_state_changed`, `publication_in_progress`, `source_delete_in_progress`, `publication_ledger_unavailable`, and `publication_purged`. Do not include SQL, R2 keys, source IDs, or payload fragments in public error details.

- [ ] **Step 7: Verify and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/service.test.ts src/publication/projection.test.ts src/publication/storage.test.ts src/publication/ledger.test.ts
  pnpm --filter @radar/worker typecheck
  git add worker/src/publication/service.ts worker/src/publication/service.test.ts worker/src/publication/lease.ts worker/src/publication/lease.test.ts worker/vitest.config.ts
  git commit -m "260903: 최신 Distill preview와 원자적 홈페이지 발행 추가"
  ```

### Task 8: Add status, withdrawal, and hourly ledger repair

**Repository:** Radar

**Files:**

- Modify: `worker/src/publication/service.ts`
- Extend: `worker/src/publication/service.test.ts`
- Create: `worker/src/operations/reconcileHomepagePublications.ts`
- Create: `worker/test/homepagePublicationReconciliation.test.ts`
- Modify: `worker/src/operations/scheduled.ts:1-80`
- Modify: `worker/test/scheduledDispatch.test.ts:1-32`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing status and withdrawal tests.**

  Test no current, valid current, both tombstones, mismatched stored hash, missing/corrupt ledger fail-closed, latest publishable summary, orphan `PUBLISHING`, stale D1 `PUBLISHED`, ID+hash-proven status/tombstone repair failure returning authoritative state with `ledgerReconcilePending:true`, idempotent old-revision withdrawal retry, all three expected-value stale checks, guarded pending withdrawal intent, a crash after intent but before CAS being cleared when R2 is still EXPLORING/different, definite CAS failure clearing only that intent, ambiguous CAS resolved by reread, tombstone success/D1 crash preserving original actor/time for recovery, post-release deferred repair, and publish/withdraw contention.

- [ ] **Step 2: Write failing scheduled-repair tests.**

  Add the reconciliation task to the existing `0 * * * *` dispatch without creating a new cron. A live lease returns `{busy: true}` and must not make the whole hourly system run fail.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/service.test.ts test/homepagePublicationReconciliation.test.ts test/scheduledDispatch.test.ts
  ```

- [ ] **Step 4: Implement status and withdrawal.**

  ```ts
  export async function getHomepagePublicationStatus(
    env: PublicationEnv,
    defer: Defer,
  ): Promise<HomepagePublicationStatusResponse>;

  export async function withdrawHomepagePublication(
    env: PublicationEnv,
    input: {
      expectedPublicationId: string;
      expectedContentHash: string;
      expectedCurrentRevision: string;
      actorSub: string;
      defer: Defer;
    },
  ): Promise<HomepageWithdrawResponse>;
  ```

  Status and withdrawal start from R2 truth and reconcile orphan `PUBLISHING`/stale `PUBLISHED` before returning or mutating. Status acquires the singleton lease, reads and validates current, calls `reconcileLedgerToCurrent()`, resolves the response, then conditionally releases; a live owner yields retryable `publication_in_progress` instead of stale state. A valid EXPLORING current without a resolvable private ledger identity returns `503 publication_ledger_unavailable`; never invent `distillSessionId`. If identity is ID+hash-proven but the repair write fails, release first, schedule `repairHomepagePublicationLedger()` through `defer`, and return the authoritative status with `ledgerReconcilePending:true` instead of 500.

  Withdrawal acquires the lease, reads/validates current, reconciles, and handles an already matching tombstone idempotently before revision comparison. If that tombstone has ID+hash-proven identity but immediate repair fails, it is still idempotent success with `ledgerReconcilePending:true`, followed by post-release deferred repair. After all three expected values match, persist `beginWithdrawal()` with the human actor and one stable event time **before** R2 CAS. Then write the ID/hash tombstone and finalize D1. On a definite CAS/precondition failure, clear only the still-matching pending intent; on an ambiguous error, reread current before deciding. A D1 failure after a successful tombstone is public success plus `ledgerReconcilePending: true`, with deferred repair scheduled only after lease release. Its exact success DTO includes `withdrawnPublicationId` copied from the approved current publication; route and service tests must assert every `HomepageWithdrawResponse` field.

- [ ] **Step 5: Implement the reconciler and scheduled hook.**

  ```ts
  export async function reconcileHomepagePublications(
    env: Pick<Env, "DB" | "PUBLICATIONS">,
  ): Promise<{ scanned: number; repaired: number; failed: number; busy: boolean }>;
  ```

  Make this operation a thin scheduled wrapper around Task 7's `repairHomepagePublicationLedger()` and run it as an additional `VISUAL_TEMP_CLEANUP_CRON` task named `homepage-publication-reconciliation`. It acquires a fresh publication lease and applies only ID+hash-proven repairs. If a stale `pending_action='WITHDRAW'` exists but the validated R2 current is still EXPLORING or identifies a different publication/hash, clear that intent under the lease without emitting a WITHDRAW event; never apply it to a later tombstone.

- [ ] **Step 6: Verify and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/service.test.ts test/homepagePublicationReconciliation.test.ts test/scheduledDispatch.test.ts
  pnpm --filter @radar/worker test:run
  git add worker/src/publication/service.ts worker/src/publication/service.test.ts worker/src/operations/reconcileHomepagePublications.ts worker/test/homepagePublicationReconciliation.test.ts worker/src/operations/scheduled.ts worker/test/scheduledDispatch.test.ts worker/vitest.config.ts
  git commit -m "260903: 홈페이지 철회 상태와 시간별 원장 복구 추가"
  ```

### Task 9: Protect and expose the Radar publication APIs

**Repository:** Radar

**Files:**

- Create: `worker/.dev.vars.example`
- Create: `worker/src/security/csrf.ts`
- Create: `worker/src/security/csrf.test.ts`
- Create: `worker/src/routes/homepagePublication.ts`
- Create: `worker/src/routes/homepagePublication.test.ts`
- Create: `worker/src/routes/session.ts`
- Modify: `worker/src/index.ts:17-22,26-61,78-116`
- Modify: `worker/src/lib/access.ts:22-26,80-125`
- Modify: `worker/src/lib/httpErrors.ts:4-30`
- Modify: `worker/src/routes/distill.ts:66-141`
- Modify: `worker/src/env-secrets.d.ts:1-10`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing CSRF/auth tests.**

  Assert a 15-minute HMAC token with nonce/sub/expiry, exact request origin, `Sec-Fetch-Site: same-origin`, subject match, expiry, signature tampering, missing secret, Access actor sub, local browser behavior, and CLI-only exemption. Assert CLI actor is `cli:` plus a stable short SHA-256 key ID, never the token itself.

  ```ts
  await expect(verifyPublicationCsrf(request, accessIdentity, "secret", now)).resolves.toBeUndefined();
  await expect(verifyPublicationCsrf(crossSiteRequest, accessIdentity, "secret", now)).rejects.toMatchObject({ code: "csrf_invalid" });
  ```

  Fix the executable contract:

  ```ts
  export async function issuePublicationCsrf(
    identity: AccessIdentity,
    origin: string,
    secret: string,
    now?: Date,
  ): Promise<HomepageCsrfResponse>;

  export async function verifyPublicationCsrf(
    request: Request,
    identity: AccessIdentity,
    secret: string,
    now?: Date,
  ): Promise<void>;
  ```

  Encode `base64url(UTF8(JSON.stringify({v:1,sub,origin,nonce,exp}))) + "." + base64url(HMAC_SHA256(secret, payloadSegment))`; `exp` is epoch seconds exactly 15 minutes after issuance. A same-origin GET may omit `Origin`: issuance requires `Sec-Fetch-Site: same-origin`, uses the header only when present and equal to `new URL(request.url).origin`, otherwise binds the token to that request-URL origin. Mutation verification requires a present exact `Origin`, exact decoded keys/types, constant-time signature comparison, matching verified subject, non-expiry, and `Sec-Fetch-Site: same-origin`. The route bypasses issuance/verification only for `authMethod === "CLI"`; browser Access and local-browser calls use the same token contract.

- [ ] **Step 2: Write failing route contract tests.**

  Cover Access protection, JSON body allowlists, `Cache-Control: no-store`, request IDs, status codes, CLI exemption, actor recording, preview no writes, and exact routes:

  ```text
  GET  /api/distill/sessions/:id/homepage-preview
  POST /api/distill/sessions/:id/homepage-publish
  GET  /api/distill/homepage-publication
  POST /api/distill/homepage-publication/withdraw
  GET  /api/session/csrf
  ```

  Assert successful CSRF, publish, and withdrawal bodies against `HomepageCsrfResponse`, `HomepagePublishResponse`, and `HomepageWithdrawResponse` respectively, including `withdrawnPublicationId`; assert every error has the `ApiErrorResponse` envelope and no unlisted keys. Also force `PUBLICATIONS.get()` to throw and return corrupt bytes while loading `/sessions` and `/sessions/:id`: both base Distill responses must remain `200`, while the dedicated publication-status route reports its retryable failure.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/security/csrf.test.ts src/routes/homepagePublication.test.ts
  ```

- [ ] **Step 4: Implement identity without changing unrelated requester semantics.**

  Extend `AccessIdentity` with `authMethod: "ACCESS" | "CLI" | "LOCAL"`. Keep `verifiedRequester()` for existing jobs; add `verifiedActorSub()` for publication audit. Add `CSRF_SECRET` to secret types, never to `wrangler.jsonc` vars.

  Check in only this local template:

  ```dotenv
  ENVIRONMENT=development
  CSRF_SECRET=
  ```

  Document beside the empty value: copy it to the already ignored `worker/.dev.vars` and fill `CSRF_SECRET` with `openssl rand -base64 32`. Never overwrite or stage an existing user `.dev.vars`; production still uses `wrangler secret put` in Task 20.

- [ ] **Step 5: Implement route modules and error handling.**

  Add `410` to `HttpError`'s status union. Parse only the named expected fields and reject extra body fields with `400 invalid_request`. Use `c.executionCtx.waitUntil` only for a reconciliation already proven safe after R2 success. Apply `no-store` to preview/status/CSRF and all publication mutation responses.

- [ ] **Step 6: Add per-session publication state.**

  Extend both `/sessions` and `/sessions/:id` responses with:

  ```ts
  homepagePublicationState: "NONE" | "CURRENT" | "SUPERSEDED" | "WITHDRAWN" | "FAILED" | "PURGING" | "PURGED";
  ```

  Attempt to read and validate R2 current once; pass the `CurrentPublicationSnapshot` on success and explicit `null` on read/validation failure into `publicationStateForSessions()`. Return `CURRENT` only on publication-ID **and** content-hash match. Apply `PURGING/PURGED` before current matching. Both list and detail use the same rule; a D1 `PUBLISHED` row alone is never current.

  This enrichment is best-effort and must never make existing Distill sessions unavailable. On R2 missing/read/validation failure, return the base list/detail with `200`; retain D1-proven `PURGING`/`PURGED` (and already terminal `SUPERSEDED`/`WITHDRAWN`/`FAILED`) but conservatively map an otherwise non-authoritative D1 `PUBLISHED` row to `NONE`. Do not claim `CURRENT`. The separate publication-status request may fail and the Radar UI then sets `action: null`, renders an explicit retry control, and keeps the Distill document visible.

- [ ] **Step 7: Verify the full route boundary and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/security/csrf.test.ts src/routes/homepagePublication.test.ts
  pnpm --filter @radar/worker test:run
  pnpm --filter @radar/worker typecheck
  git add worker/.dev.vars.example worker/src/security/csrf.ts worker/src/security/csrf.test.ts worker/src/routes/homepagePublication.ts worker/src/routes/homepagePublication.test.ts worker/src/routes/session.ts worker/src/index.ts worker/src/lib/access.ts worker/src/lib/httpErrors.ts worker/src/routes/distill.ts worker/src/env-secrets.d.ts worker/vitest.config.ts
  git commit -m "260903: 홈페이지 발행 API와 HMAC CSRF 경계 추가"
  ```

### Task 10: Serialize source deletion against publication

**Repository:** Radar

**Files:**

- Modify: `worker/src/reservoir/deleteSource.ts:500-605,697-860`
- Extend: `worker/src/reservoir/deleteSource.test.ts:130-850`
- Create: `worker/src/reservoir/publicationInterlock.test.ts`
- Modify: `worker/src/routes/reservoir.ts:430-480`
- Modify: `worker/src/index.ts:100-107`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing interlock tests.**

  Cover orphan reconciliation before deletion, current session source usage even when the material was excluded from public `researchMaterials`, current-ledger missing fail-closed, unrelated source deletion, withdrawal then deletion, missing current creation of a null tombstone **only when publication and event history are both empty**, missing current with any history failing closed without deleting, same-payload fencing changing ETag, active source claim blocking publish, stale publish vs delete CAS, and stale delete generation rolling back its D1 batch. Add three fence outcomes: success then later fault retains the claim; ambiguous failure retains the claim; definite conditional conflict performs no Originals/D1 delete and clears the claim.

- [ ] **Step 2: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/publicationInterlock.test.ts src/reservoir/deleteSource.test.ts
  ```

- [ ] **Step 3: Refactor lock acquisition order.**

  Keep exact-title validation side-effect free, then use:

  ```text
  validate title
    → publication singleton lease
    → read/validate current + reconcile ledger under that lease
    → resolve private session source IDs
    → reject source_in_publication
    → source_deletion_claim
    → current CAS fence
    → ORIGINALS cleanup
    → guarded D1 delete batch
    → conditional releases
  ```

  Change the service environment to `Pick<Env, "DB" | "ORIGINALS" | "PUBLICATIONS">`.

- [ ] **Step 4: Extend the existing transactional deletion guard.**

  Add publication `owner_token + generation + expires_at_ms > DB now` to `deletionGuard()`'s first `SELECT CASE`. On mismatch it must deliberately fail, causing D1 batch rollback. Preserve all current source-claim, dependency fingerprint, merge, and active-work guards.

- [ ] **Step 5: Fence R2 current before deleting source data.**

  If current is missing, first query both `homepage_publications` and `homepage_publication_events` under the same lease **before** declaring an R2 mutation: proceed to a null-ID/hash WITHDRAWN tombstone only when both contain zero rows; otherwise fail closed with `503 publication_ledger_unavailable`, conditionally release the still-local source claim, and perform no source mutation. Immediately before the actual current CAS/fence, set the existing cleanup switch `r2MutationStarted = true`, so any successful or ambiguous R2 write prevents the catch/finally path from releasing the claim. If current exists, re-put the same validated payload with a new storage revision and observed ETag; if it is the proven no-history missing case, use `If-None-Match: *`. For a proven conditional `null`/recognized precondition failure—or a read-after-error that proves the old ETag/revision is unchanged—set `r2MutationStarted = false` before throwing so the matching source claim is released. An unresolved ambiguous outcome keeps it true for resumable cleanup. Heartbeat both leases across bounded R2 deletion. Conditional failure maps to `409 publication_state_changed`, never proceeds to D1 deletion.

- [ ] **Step 6: Verify existing deletion behavior and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/reservoir/publicationInterlock.test.ts src/reservoir/deleteSource.test.ts src/routes/reservoir.test.ts
  pnpm --filter @radar/worker test:run
  git add worker/src/reservoir/deleteSource.ts worker/src/reservoir/deleteSource.test.ts worker/src/reservoir/publicationInterlock.test.ts worker/src/routes/reservoir.ts worker/src/index.ts worker/vitest.config.ts
  git commit -m "260903: source 영구 삭제에 publication fencing 연동"
  ```

### Task 11: Add resumable CLI-only hard purge

**Repository:** Radar

**Files:**

- Create: `worker/src/publication/hardPurge.ts`
- Create: `worker/src/publication/hardPurge.test.ts`
- Create: `worker/src/routes/operations.ts`
- Create: `worker/src/routes/operations.test.ts`
- Create: `docs/runbooks/homepage-publication-hard-purge.md`
- Modify: `worker/src/operations/reconcileHomepagePublications.ts`
- Extend: `worker/test/homepagePublicationReconciliation.test.ts`
- Modify: `worker/src/index.ts:78-116`
- Modify: `worker/vitest.config.ts:23-25`

- [ ] **Step 1: Write failing purge state-machine tests.**

  Assert CLI-only read-only preview enumerates the requested row's exact Distill session and every sibling publication ID in stable ID order; hashes stay private and are resolved from those immutable ledger IDs under the lease. The POST must confirm the publication ID, session ID, and entire sibling-ID list, then prove shared lease contention, pre-operation reconciliation, session marker-before-sweep ordering, every `PUBLISHED/WITHDRAWN/SUPERSEDED/FAILED` sibling → `PURGING`, and permanent `410` for any future publication attempt from that session. Include the critical case where an older target `P1` and current sibling `P2` share a session but have different hashes: P2 must be tombstoned and both histories purged; a current publication from another session is only re-fenced unchanged. Missing current uses a non-null ID/hash from the confirmed scope. A validated null-ID/hash `WITHDRAWN` tombstone is re-fenced unchanged with a new revision because no public publication is current; a malformed tombstone or non-null ID/hash that cannot resolve remains fail closed.

  Cover paginated deletion/counting across all sibling prefixes, two aggregate zero observations separated by a settle window, resume from partial `PURGING`, every sibling payload cleared, one `HARD_PURGE` event per sibling, and no unenumerated/new sibling admitted under the lease. Freeze the original CLI actor and a monotonic approval time per sibling in the first guarded batch; retries/takeovers cannot overwrite them, marker creation time remains separate, and later reconciler events use exactly those values. Resolve a publisher's deferred history PUT after the first zero check; its post-check or next sweep must remove the resurrected key, reset the session zero window, and every prefix must be zero before all rows become `PURGED`. Also simulate a writer that dies between late PUT and post-check after `PURGED`; the next hourly audit must delete the object, increment exact `securityRepairs`, emit the specified structured warning, and keep all rows `PURGED`. Use a controllable clock to expire the first purge owner between R2 pages, let a new generation take over, and prove the stale owner cannot delete the next page or run the final D1 batch.

- [ ] **Step 2: Run and observe RED.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/hardPurge.test.ts src/routes/operations.test.ts
  ```

- [ ] **Step 3: Implement hard purge and its narrow route.**

  ```ts
  export async function hardPurgeHomepagePublication(
    env: Pick<Env, "DB" | "PUBLICATIONS">,
    input: {
      publicationId: string;
      confirmDistillSessionId: string;
      confirmPublicationIds: string[];
      actorSub: string;
    },
  ): Promise<{
    distillSessionId: string;
    publicationIds: string[];
    publicationCount: number;
    status: "PURGING" | "PURGED";
    deletedHistoryObjects: number;
    remainingHistoryObjects: number;
  }>;
  ```

  Add CLI-only `GET /api/operations/homepage-publications/:id/hard-purge-preview`, returning exact `{publicationId,distillSessionId,publicationIds:[...],publicationCount}` without payload/history keys. The POST route is `POST /api/operations/homepage-publications/:id/hard-purge` with body `{ "confirmPublicationId":"<path id>", "confirmDistillSessionId":"<preview session>", "confirmPublicationIds":["<every sorted preview id>"] }`; any set/order/count drift is `409 publication_state_changed` with no mutation. The mutation response repeats the sorted IDs and count. Neither route appears in the web UI.

  In this task, extend the scheduled reconciler result to `{scanned,repaired,failed,busy,securityRepairs}` with `securityRepairs:0` by default. Each late history object removed from already `PURGED` scope increments it once per object and emits exactly one `console.warn` object `{level:'warn', event:'homepage_purge_security_repair', distillSessionId, publicationIds, deletedHistoryObjects}` per audited session/run; never log payloads or R2 keys.

  After lease acquisition, reload and compare the exact session scope, then reconcile only its non-purge ledger state before entering `PURGING`. A present EXPLORING current must resolve by exact ID/hash to one ledger row before any mutation; otherwise fail closed. In one guarded batch, persist the original path target as `purge_requested_publication_id` on every sibling, allocate each sibling's own `purge_requested_at` above that row's events and any retained pending publish time, persist the same CLI actor, and clear every old pending tuple; never rewrite the target, actor, or per-row time on retries. Create the permanent **session** marker with the shared frozen requested-publication ID and a separate DB-evaluated marker-creation time, then persist that observed marker time as `purge_marker_at` on every sibling before sweeping. If current resolves to any scoped sibling, tombstone that current ID/hash; if current is missing, use the requested scoped publication ID/hash; if current is a validated null-ID/hash `WITHDRAWN` tombstone, re-put that tombstone unchanged with a new revision; if it resolves to another session, re-put that validated payload with a new revision. Corrupt current, or a non-null ID/hash current that cannot resolve, fails closed. Assert/renew the exact owner/generation before every R2 list/delete page and guarded D1 batch.

  Sum `deletePublicationHistory()` across all confirmed sibling prefixes. Any deletion or non-zero aggregate remainder clears `purge_zero_verified_at` for the scope and returns `PURGING`. The first all-zero sweep stores one shared zero time on every sibling and still returns `PURGING`; only a later invocation/reconciler run at least `PUBLICATION_LEASE_MS` afterward, with another all-prefix zero result, may clear every payload, append one idempotent `HARD_PURGE` event per sibling using its frozen actor/time, and atomically set every sibling `PURGED`. The session marker remains forever.

  Extend the hourly reconciler to group **every** `PURGING` row by Distill session, not only rows whose marker time is stored. The resume invariant is exact agreement on the frozen requested-publication ID and actor; each row's separately allocated `purge_requested_at` may differ but must remain immutable and monotonic for that row. Any target/actor disagreement is corruption and stops that group. If the session marker key is absent, recreate it with the shared stored `purge_requested_publication_id` and a fresh DB-evaluated marker-creation time; if it exists but any `purge_marker_at` is null, read/validate its requested-publication ID and marker-creation time, then backfill that observed time across the scope. Continue the dedicated all-sibling sweep only after those checks. It also groups and sweeps every session with marker-bearing `PURGED` rows forever. A late object is deleted and logged/counted without reopening state. This closes crashes both before marker PUT and between marker PUT and D1 backfill without inventing the original target.

- [ ] **Step 4: Write the runbook.**

  Require a separate operator approval over the preview's exact session ID and complete sibling publication-ID list, current/ledger preflight, permanent session-marker verification, frozen requester/time verification distinct from marker time, two-pass completion at least 60 seconds apart, zero objects under every sibling prefix, current endpoint 404 when any scoped sibling was current, and a new Distill session before future publication. Include grouped resume instructions for `PURGING`; do not provide marker deletion or force-unlock operations.

- [ ] **Step 5: Verify and commit.**

  ```bash
  pnpm --filter @radar/worker exec vitest run --config vitest.config.ts src/publication/hardPurge.test.ts src/routes/operations.test.ts test/homepagePublicationReconciliation.test.ts
  pnpm --filter @radar/worker test:run
  git add worker/src/publication/hardPurge.ts worker/src/publication/hardPurge.test.ts worker/src/routes/operations.ts worker/src/routes/operations.test.ts worker/src/operations/reconcileHomepagePublications.ts worker/test/homepagePublicationReconciliation.test.ts docs/runbooks/homepage-publication-hard-purge.md worker/src/index.ts worker/vitest.config.ts
  git commit -m "260903: 현재 연구 hard purge와 운영 runbook 추가"
  ```

### Task 12: Add the Radar browser client and pure action reducer

**Repository:** Radar

**Files:**

- Create: `web/src/lib/homepagePublication.ts`
- Create: `web/src/lib/homepagePublication.test.ts`

- [ ] **Step 1: Write failing API-client tests.**

  Build a table-driven fake `fetch` router that records URL/options and can return JSON, HTML, malformed JSON, or a deferred response. Use contract-valid preview/status/CSRF/publish/withdraw fixtures. Assert encoded session IDs; preview/status/CSRF GETs with `cache: "no-store"` and `credentials: "same-origin"`; a **new** CSRF request immediately before each mutation; exact mutation bodies; no `content`/`privateReview` leakage; no automatic POST retry; 409/410/422/503 `ApiErrorResponse` details/request-ID preservation; and HTML, malformed JSON, wrong Content-Type, or wrong-shape 2xx mapping to `invalid_response`. Expected RED is the missing client module, followed by assertion failures for the exact fetch options.

- [ ] **Step 2: Write failing action-priority tests.**

  Cover `PURGING`, `PURGED`, currently published selected session even when a newer unapproved session exists, no/withdrawn current, a newer different session with a coincident hash, normal update, and old session.

  ```ts
  export type HomepagePublicationAction =
    | { kind: "PUBLISH" | "UPDATE"; enabled: true; label: string }
    | { kind: "CURRENT" | "PURGING" | "PURGED" | "OLD"; enabled: false; label: string };

  export interface ActionInput {
    sessionId: string;
    sessionState: DistillHomepagePublicationState;
    status: HomepagePublicationStatusResponse;
  }
  ```

  Fix precedence as: selected session `PURGING/PURGED` → `status.current` PUBLISHED with the same `distillSessionId` → `latestPublishable.sessionId` equals the selected session → old session. In the third branch use `PUBLISH` when no public EXPLORING edition exists and `UPDATE` when another session is current; a coincident hash from a different session remains `UPDATE`. Pin the full copy matrix exactly: `홈페이지에 반영`, `새 결과로 업데이트`, `현재 홈페이지에 공개 중 · YYYY.MM.DD`, `공개 삭제 처리 중…`, `공개 삭제됨 · 새 Distill 필요`, and `최신 Distill만 반영 가능`; only the confirmed publish POST pending state is `반영 중…`. Also test `formatHomepagePublicationDate()` across UTC→KST midnight and assert the current label uses `current.updatedAt`, never first `publishedAt`.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/lib/homepagePublication.test.ts
  ```

- [ ] **Step 4: Implement the typed client.**

  ```ts
  export class HomepagePublicationApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly requestId: string | null,
      readonly details?: unknown,
    ) { super(code); }
  }

  export function fetchHomepagePublicationStatus(signal?: AbortSignal): Promise<HomepagePublicationStatusResponse>;
  export function fetchHomepagePreview(sessionId: string, signal?: AbortSignal): Promise<HomepagePreviewResponse>;
  export function publishHomepagePreview(sessionId: string, expected: HomepagePublishRequest): Promise<HomepagePublishResponse>;
  export function withdrawHomepagePublication(expected: HomepageWithdrawRequest): Promise<HomepageWithdrawResponse>;
  export function deriveHomepagePublicationAction(input: ActionInput): HomepagePublicationAction;
  export function formatHomepagePublicationDate(iso: string): string; // YYYY.MM.DD, Asia/Seoul
  export function homepagePublicationErrorMessage(action: "status" | "preview" | "publish" | "withdraw", code: string): string;
  ```

  Export and exact-test a frozen copy table; never render raw server codes:

  | State/code | Korean UI copy |
  |---|---|
  | status loading | `공개 상태 확인 중…` |
  | preview loading | `미리보기를 불러오는 중…` |
  | confirmed publish POST | `반영 중…` |
  | publish success | `홈페이지에 현재 연구를 반영했습니다.` |
  | update success | `홈페이지의 현재 연구를 새 결과로 업데이트했습니다.` |
  | withdraw success | `홈페이지 공개를 철회했습니다.` |
  | publish/update response + `ledgerReconcilePending:true` | `홈페이지 반영은 완료됐습니다. 내부 기록을 확인 중입니다.` |
  | withdraw response or status with `current.state === "WITHDRAWN"` + `ledgerReconcilePending:true` | `홈페이지 공개 철회는 완료됐습니다. 내부 기록을 확인 중입니다.` |
  | status with any other current state + `ledgerReconcilePending:true` | `홈페이지 상태는 확인했습니다. 내부 기록을 확인 중입니다.` |
  | status fallback / retry | `홈페이지 공개 상태를 확인하지 못했습니다.` / `다시 확인` |
  | `latest_distill_required` | `최신 Distill만 홈페이지에 반영할 수 있습니다.` |
  | `distill_output_not_ready` | `완료된 Distill 결과가 필요합니다.` |
  | `public_projection_empty` | `홈페이지에 공개할 연구 내용이 없습니다.` |
  | `public_projection_invalid` | `공개용 연구 내용을 확인해 주세요.` |
  | `preview_stale` | `연구 내용이 변경되었습니다. 미리보기를 다시 확인해 주세요.` |
  | `withdrawal_stale` | `공개본이 변경되었습니다. 철회 대상을 다시 확인해 주세요.` |
  | `publication_state_changed` | `홈페이지 공개 상태가 변경되었습니다. 다시 확인해 주세요.` |
  | `publication_in_progress` | `다른 공개 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.` |
  | `source_delete_in_progress` | `자료 삭제가 진행 중입니다. 완료 후 다시 시도해 주세요.` |
  | `publication_ledger_unavailable` | `공개 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.` |
  | `publication_purged` | `공개 삭제된 연구입니다. 새 Distill이 필요합니다.` |
  | `csrf_invalid` | `보안 확인이 만료되었습니다. 다시 시도해 주세요.` |
  | invalid/unknown preview | `미리보기를 불러오지 못했습니다. 다시 시도해 주세요.` |
  | unknown publish/withdraw | `홈페이지 공개 요청을 완료하지 못했습니다. 다시 시도해 주세요.` |

  Parse response text once, require JSON Content-Type, then validate every success DTO's required fields and discriminants. Invalid success responses throw `HomepagePublicationApiError(response.status, "invalid_response", requestId, details)`. Preserve `details` from a valid server error envelope. Every mutation fetches and validates a fresh `HomepageCsrfResponse` immediately before its POST and never reuses a token; send only the two publish or three withdrawal expected fields. Use `credentials: "same-origin"` on all requests and `cache: "no-store"` on GET. Do not set browser-managed `Origin` or `Sec-Fetch-Site`; add only `Content-Type: application/json` and `X-CSRF-Token` on POST. Never automatically retry a mutation.

- [ ] **Step 5: Verify and commit.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/lib/homepagePublication.test.ts
  pnpm --filter @radar/web typecheck
  git add web/src/lib/homepagePublication.ts web/src/lib/homepagePublication.test.ts
  git commit -m "260903: Radar 홈페이지 발행 client와 버튼 상태 추가"
  ```

### Task 13: Build the Radar publication panel and accessible dialogs

**Repository:** Radar

**Files:**

- Create: `web/src/components/distill/HomepagePublicationPanel.tsx`
- Create: `web/src/components/distill/HomepagePublicationPanel.test.tsx`
- Create: `web/src/components/distill/HomepagePreviewDialog.tsx`
- Create: `web/src/components/distill/HomepagePreviewDialog.test.tsx`
- Create: `web/src/components/distill/HomepageWithdrawalDialog.tsx`
- Create: `web/src/components/distill/HomepageWithdrawalDialog.test.tsx`
- Modify: `web/src/components/reading/modalAccessibility.ts`
- Modify: `web/src/styles/views.css:153-194,361-368`

- [ ] **Step 1: Write failing pure-panel tests.**

  Use a `makePublicationPanelProps()` fixture factory and assert every exact label/disabled state from Task 12, including `현재 홈페이지에 공개 중 · YYYY.MM.DD` from `current.updatedAt`, status failure with `다시 확인`, current-only withdrawal control, exact publish/withdraw trigger refs, and no network calls from the panel itself. Before a dialog opens, status loading must announce `공개 상태 확인 중…` and read-only preview loading must announce `미리보기를 불러오는 중…`, each with `role="status" aria-live="polite"`; neither may say `반영 중…`. Outside dialogs, assert publish/update, withdraw/`WITHDRAWN`, and status reconciliation-pending paths each render their exact Task 12 copy in the same polite live region; none may reuse another action's wording. Status/operation failure renders with `role="alert"`. Expected RED is missing components, then missing trigger/date/copy/announcement contracts.

- [ ] **Step 2: Write failing dialog rendering and accessibility tests.**

  Render a contract-valid `makeHomepagePreview()` containing a unique private Critic marker. Assert public section order, empty-section hiding, the marker is absent from the public preview subtree and appears only inside `공개되지 않는 검토 메모`, excluded material count, exact direct-citation disclaimer, no Counter/gaps/model/cost, named source links, and that the confirm callback receives no content argument. Assert `role="dialog"`, `aria-modal="true"`, stable `aria-labelledby`/`aria-describedby`, heading `tabIndex={-1}` initial focus, focus trap, background `inert`, `role="status" aria-live="polite"` pending copy, and `role="alert"` errors. Run an integration sequence `trigger click → async preview resolves → dialog opens → Escape/cancel` and require focus to return to that exact trigger. While pending, scrim, Escape, and cancel must all be ignored by one `safeClose()` path. Expected RED is missing components/helper behavior.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/components/distill/HomepagePublicationPanel.test.tsx src/components/distill/HomepagePreviewDialog.test.tsx src/components/distill/HomepageWithdrawalDialog.test.tsx
  ```

- [ ] **Step 4: Implement pure component contracts.**

  ```ts
  export interface HomepagePublicationPanelProps {
    action: HomepagePublicationAction | null;
    loading: boolean;
    previewPending: boolean;
    feedback: { kind: "status" | "error"; message: string } | null;
    publishTriggerRef: RefObject<HTMLButtonElement | null>;
    withdrawTriggerRef: RefObject<HTMLButtonElement | null>;
    onOpenPreview(): void;
    onOpenWithdraw(): void;
    onRetryStatus(): void;
  }

  export interface HomepagePreviewDialogProps {
    open: boolean;
    preview: HomepagePreviewResponse | null;
    pending: boolean;
    error: string;
    returnFocusTarget(): HTMLElement | null;
    onClose(): void;
    onConfirm(): void | Promise<void>;
  }

  export interface HomepageWithdrawalDialogProps {
    open: boolean;
    updatedAt: string | null;
    pending: boolean;
    error: string;
    returnFocusTarget(): HTMLElement | null;
    onClose(): void;
    onConfirm(): void | Promise<void>;
  }
  ```

  Extend and reuse `useModalAccessibility` from `web/src/components/reading/modalAccessibility.ts` with `returnFocusTarget?: () => HTMLElement | null`; prefer that target on cleanup, falling back to the previously active element only when it is absent/disconnected. Publish confirmation is `공개 반영`/`반영 중…`. Withdrawal copy is `현재 연구 공개본을 홈페이지에서 내립니다. 홈페이지에는 빈 상태가 표시되며 비공개 발행 이력은 보존됩니다.` with `홈페이지 공개 철회`/`철회 중…`. Keep preview/withdrawal in one discriminated dialog state so both can never be open. Render loading/preview and `feedback.kind === "status"` as `role="status" aria-live="polite"`, and `feedback.kind === "error"` as `role="alert"`; these announcements remain present after a dialog closes. `previewPending` controls only the read-only preview-loading copy; only a confirmed dialog POST's `pending` state uses `반영 중…`.

- [ ] **Step 5: Add only the required styles.**

  Keep the existing document typography. Add a bounded preview body, section spacing, private-review treatment, and full-width mobile dialog actions. Do not introduce a new design system or animation dependency.

- [ ] **Step 6: Verify and commit.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/components/distill/HomepagePublicationPanel.test.tsx src/components/distill/HomepagePreviewDialog.test.tsx src/components/distill/HomepageWithdrawalDialog.test.tsx src/components/reading/DecisionBottomSheet.test.tsx src/components/reservoir/SourceDeleteDialog.test.tsx
  pnpm --filter @radar/web typecheck
  git add web/src/components/distill/HomepagePublicationPanel.tsx web/src/components/distill/HomepagePublicationPanel.test.tsx web/src/components/distill/HomepagePreviewDialog.tsx web/src/components/distill/HomepagePreviewDialog.test.tsx web/src/components/distill/HomepageWithdrawalDialog.tsx web/src/components/distill/HomepageWithdrawalDialog.test.tsx web/src/components/reading/modalAccessibility.ts web/src/styles/views.css
  git commit -m "260903: Distill 공개 미리보기와 철회 dialog 추가"
  ```

### Task 14: Wire publication state into `DistillView`

**Repository:** Radar

**Files:**

- Modify: `web/src/views/DistillView.tsx:1-72`
- Extend: `web/src/views/DistillView.test.tsx:1-38`

- [ ] **Step 1: Write failing orchestration tests.**

  Extend the existing `fetch` stub into a route-aware router with `deferred<Response>()` controls and recorded calls. Cover no preview request before click; preview GET without mutation/CSRF; confirm CSRF → publish order using the frozen hash/revision and a POST body with no `content`/`privateReview`; exact loading/pending labels and disabled controls; publish and withdraw success announcements; exact, distinct reconciliation-pending copy for publish/update response, withdraw response, and repaired `WITHDRAWN`/other status response; status failure leaving the Distill document visible with `action: null` and an explicit retry; exact error-code copy with no raw code; stale preview reset; retryable busy/source-delete/ledger errors; a distinct frozen withdrawal snapshot; stale withdrawal refresh; purge state refresh; and rapid session switching. For the race cases, defer `/sessions/A` detail plus A status/preview/mutation, resolve `/sessions/B`, then resolve every A response last and assert none can replace B's document, action, dialog, or feedback. Expected RED is absent publication orchestration, not a test-harness import failure.

- [ ] **Step 2: Run and observe RED.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx
  ```

- [ ] **Step 3: Add publication orchestration below `document-meta`.**

  Import `DistillHomepagePublicationState` and `HomepagePreviewResponse` from `@radar/shared` and update both inline response DTOs, not only local state:

  ```ts
  interface SessionData {
    session: {
      id: string;
      redistillOf: string | null;
      counterEnabled?: boolean;
      modelVersion: string;
      promptVersion: string;
      costUsd: number;
      createdAt: string;
      sourcesUsed: { id: string; title: string }[] | null;
      output: DistillOutput | null;
      critic: { warnings: { category: string; note: string }[]; overall: string } | null;
      counter: CounterData | null;
      homepagePublicationState: DistillHomepagePublicationState;
    };
    readingQueue: QueueItem[];
    researchGaps: { id: string; gap: string; kind: string | null }[];
  }

  interface SessionListItem {
    id: string;
    redistillOf: string | null;
    counterEnabled?: boolean;
    costUsd: number;
    createdAt: string;
    homepagePublicationState: DistillHomepagePublicationState;
  }
  ```

  Keep Distill run state separate from publication state. On session change, abort the prior session-detail, status, and preview GET requests with separate controllers, close dialogs, clear snapshots/errors, and increment a request generation. Do **not** abort publish/withdraw POST after dispatch. Guard every detail/status/preview/mutation async completion with `{sessionId, generation}` so late results cannot write into a newly selected session. Open a dialog only after a fresh preview succeeds.

  ```ts
  type PublishSnapshot = Pick<
    HomepagePreviewResponse,
    "sessionId" | "contentHash" | "currentRevision"
  >;

  type WithdrawSnapshot = {
    expectedPublicationId: string;
    expectedContentHash: string;
    expectedCurrentRevision: string;
    updatedAt: string;
  };
  ```

  Copy `PublishSnapshot` only when the preview dialog opens and send that frozen value on confirm; later status responses must not rewrite it. Use only `WithdrawSnapshot` for withdrawal. On `preview_stale`/`publication_state_changed`, discard preview/snapshot, close the dialog, refresh status, and require a new human review. On `withdrawal_stale`, discard the withdrawal snapshot, close, and refresh status. On `publication_purged`, refetch session plus status and enter the permanent disabled state. For `publication_in_progress`, `source_delete_in_progress`, and `publication_ledger_unavailable`, keep the dialog/snapshot, show `role="alert"`, and issue a fresh CSRF token only when the human retries. No mutation is automatically repeated.

  After any dispatched mutation settles—even if the user changed sessions—refresh status for the **currently selected** session. The generation guard may suppress old-dialog feedback but not this convergence fetch.

- [ ] **Step 4: Preserve all existing Distill behavior.**

  Keep Counter toggle, Re-Distill, queue verification/import, session history, outline, markdown export, and cost/model metadata unchanged. Publication failure must not hide the Distill document.

- [ ] **Step 5: Verify and commit.**

  ```bash
  pnpm --filter @radar/web exec vitest run src/views/DistillView.test.tsx src/components/distill/CounterSection.test.tsx
  pnpm --filter @radar/web typecheck
  pnpm --filter @radar/web build
  git add web/src/views/DistillView.tsx web/src/views/DistillView.test.tsx
  git commit -m "260903: Distill 최신 결과에 홈페이지 반영 흐름 연결"
  ```

### Task 15: Prepare fail-closed legacy-curation preservation

**Repository:** Homepage

**Files:**

- Create: `scripts/export-reading-legacy-curation.mjs`
- Create: `scripts/current-research-release.mjs`
- Create: `config/current-research-release.json`
- Create empty pre-cutover seed, replaced at cutover: `src/data/readingLegacyCuration.mjs`
- Modify: `src/data/readingArticles.mjs:1-2,143,224-330`
- Create: `tests/fixtures/reading-legacy-curation-export.json`
- Create: `tests/reading-legacy-curation.test.mjs`
- Create: `tests/current-research-release.test.mjs`

- [ ] **Step 0: Attach the Homepage repository as a writable workspace.**

  The current planning session can read but cannot write `/Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun`. Before any Homepage RED test or edit, explicitly add that **exact repository** as a writable workspace root and verify its `.git`, source, and test paths are writable. All Homepage commands and rollout provenance below are intentionally anchored to this one checkout, so do not substitute another worktree, copy loose files into the Radar repository, or request broad Desktop write access. Stop if that exact checkout cannot be made writable.

- [ ] **Step 1: Write failing normalization and merge tests.**

  Test Wrangler JSON result extraction, allowlisted fields, `status: published`, required explicit migration date, KST `releaseAt` fallback order, removal of stats/score/lock fields, fail-closed invalid rows with their IDs reported, URL-first/ID-second dedupe, and generated-wins ordering. Coverage means each normalized live row maps to the merged output by normalized URL first and otherwise exact ID; a live row deduped against a generated article is reported as a mapping, not incorrectly required to preserve both IDs. Compute the expected union count dynamically and fail on any unmapped row. Also test a pure release-plan parser for the only allowed modes (`pre_cutover`, `current_research`, `legacy_rollback`), rejection of an uncaptured current-research seed, and exact match between release-manifest and seed date/count/checksums. Add a separate read-only `rollout-entry` classifier that validates only the durable manifest/state-machine shape and emits exactly one allowlisted line: `FRESH_PRE_CUTOVER`, `PREPARED_RESUME`, `BASELINED_INCOMPLETE_RESUME`, or `COMPLETED_RESUME`; malformed or contradictory state exits non-zero with no stdout. Allow an explicit `--manifest-file <file>` only on the read-only classifier and materializer, so Task 20 can inspect the committed PREPARED parent after a local abort cleared the working manifest; default remains the checked-in working manifest, and deploy `plan` never accepts this override. Test both sources byte-for-byte and reject missing/extra arguments. This classifier routes recovery even when a locally regenerated C seed intentionally differs from baseline A, but it never authorizes a deploy or replaces strict `plan --json` seed validation. Add deterministic batch-state normalization tests: extract exactly one Wrangler result set, validate and sort `{releaseAt,cooldownEndAt,finalizedAt}` rows, preserve `finalizedAt:null`, and emit byte-stable canonical JSON while rejecting duplicates, wrong shapes, or extra result sets. Test the durable cutover state machine: `null → PREPARED → BASELINED`, immutable original workflow state, `PREPARED` remaining `pre_cutover`, `begin-cutover` requiring the authoritative migration date/seed SHA-256/canonical batch A, all retry commands being exact-idempotent, `refresh-capture`/`complete-cutover` preserving the baseline, and materialization reproducing every stored byte after a fresh process starts. Test an approval-only PREPARED abort that requires an observed restored workflow-state file plus a validated empty active-run file, rejects BASELINED/current state, and clears only the PREPARED record. Finally test `verify-cutover-transition`: no baseline batch/seed deletion or mutation, only `finalizedAt:null → valid timestamp`, only new unfinalized batch rows, every new seed identity mapping to a newly finalized batch's KST cooldown date, changed seed requiring such a transition, and exact JSON report output.

- [ ] **Step 2: Run and observe RED.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/reading-legacy-curation.test.mjs tests/current-research-release.test.mjs tests/reading-policy.test.mjs tests/reading-catalog.test.mjs
  ```

- [ ] **Step 3: Implement the exporter and merge helper.**

  ```js
  export function normalizeLegacyCuratedArticles(rows, { migrationDate } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(migrationDate || ''))) {
      throw new Error('legacy_curation_migration_date_required');
    }
    const normalized = rows.map((row) => ({
      id: String(row.id || '').trim(),
      title: String(row.title || '').trim(),
      source: String(row.source || '').trim(),
      author: String(row.author || '').trim(),
      url: String(row.url || '').trim(),
      summary: String(row.summary || '').trim(),
      tags: parseTagsJson(row.tagsJson),
      publishedAt: String(row.publishedAt || '').trim(),
      publishedAtSource: String(row.publishedAtSource || 'unknown').trim(),
      crawledAt: String(row.crawledAt || '').trim(),
      status: 'published',
      releaseAt: firstKstDate(row.curatedAt, row.publishedAt, row.crawledAt, migrationDate),
    }));
    const invalidIds = normalized.filter((item) => !item.id || !item.title || !isPublicHttpUrl(item.url)).map((item) => item.id || '(missing-id)');
    if (invalidIds.length) throw new Error(`legacy_curation_invalid_rows:${invalidIds.join(',')}`);
    return normalized;
  }

  function normalizedReadingUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  }

  export function mergeReadingArticleSources(generated = [], legacy = []) {
    const seenUrls = new Set();
    const seenIds = new Set();
    return [...generated, ...legacy].filter((article) => {
      const url = normalizedReadingUrl(article.url);
      const id = String(article.id || '').trim();
      if ((url && seenUrls.has(url)) || (id && seenIds.has(id))) return false;
      if (url) seenUrls.add(url);
      if (id) seenIds.add(id);
      return true;
    });
  }

  export function auditLegacyCoverage(generated, legacy, merged) {
    const mappings = legacy.map((item) => {
      const byUrl = merged.find((candidate) => normalizedReadingUrl(candidate.url) === normalizedReadingUrl(item.url));
      const byId = byUrl || merged.find((candidate) => candidate.id === item.id);
      if (!byId) throw new Error(`legacy_curation_unmapped:${item.id}`);
      return { legacyId: item.id, outputId: byId.id, reason: byUrl ? 'url' : 'id' };
    });
    return Object.freeze(mappings);
  }
  ```

  Implement `parseTagsJson()` as strict JSON-array-of-strings parsing, `isPublicHttpUrl()` with the same credential/localhost/private-literal rules as the current-research contract, and `firstKstDate()` as the first valid value in `curatedAt → publishedAt → crawledAt → migrationDate`; preserve valid `YYYY-MM-DD` values and convert timestamps with `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })`. Invalid tag JSON or an invalid final date is a generation error, not an empty fallback. Generated seed modules export both the frozen articles and frozen capture metadata `{state:'CAPTURED', migrationDate, sourceRowCount, idChecksum, urlChecksum}`.

- [ ] **Step 4: Prove the generator with a synthetic Wrangler fixture; do not capture production yet.**

  The fixture contains a generated-URL overlap with a different ID, a non-overlap, UTF-8 text, and one KST boundary timestamp. The generator must print input/output counts, normalized ID/URL checksums, and duplicate mappings; it exits non-zero for any invalid or unmapped row. Initialize the checked-in module as the explicit empty pre-cutover seed:

  ```js
  export const legacyCurationCapture = Object.freeze({
    state: 'PRE_CUTOVER',
    migrationDate: null,
    sourceRowCount: 0,
    idChecksum: null,
    urlChecksum: null,
  });
  export const legacyCuratedReadingArticles = Object.freeze([]);
  ```

  Initialize `config/current-research-release.json` as `{ "schemaVersion": 1, "mode": "pre_cutover", "initialCutoverComplete": false, "legacyCapture": null, "cutoverProvenance": null }`. `scripts/current-research-release.mjs` strictly parses this manifest and the seed metadata and exposes these tested commands: strict deploy `plan`; state-only `rollout-entry [--manifest-file <file>]`; `prepare-cutover --workflow-state-file <file>`; `abort-cutover --observed-workflow-state-file <file> --active-runs-file <empty-file>`; `begin-cutover --migration-date-file <file> --seed-sha256-file <file> --batch-state-file <canonical-json>`; `materialize-cutover-provenance [--manifest-file <file>]` with explicit output files; `verify-cutover-transition --after-seed <module> --after-batch-state <canonical-json> --json-output <file>`; `refresh-capture`; `complete-cutover`; read-only `assert-zero-due --input <wrangler-json>`; and read-only `normalize-batch-state --input <wrangler-json> --output <canonical-json>`.

  `prepare-cutover` is allowed only while mode remains `pre_cutover`. It validates `active|disabled_manually` and atomically stores immutable `{phase:'PREPARED', workflowStateBefore}` in the manifest; exact retry is a no-op and a different value fails. If the user explicitly cancels before BASELINED state, `abort-cutover` succeeds only when the observed state equals the stored original and the successfully generated active-run file is exactly empty; it then clears PREPARED without changing release mode. `begin-cutover` requires that durable PREPARED record plus a `CAPTURED` seed, validates the persisted KST date, full-file seed SHA-256, and canonical batch snapshot, then derives a stable sorted baseline entry for every seed row: `{id,normalizedUrl,releaseAt,rowHash}`, where `rowHash` covers the canonical **full normalized row**, including title/source/author/summary/tags/date fields. It atomically extends provenance to `{phase:'BASELINED',workflowStateBefore,migrationDate,seedSha256,seedCaptureA,seedRowsA,batchStateA}`, switches to `current_research`, and leaves `initialCutoverComplete:false`. It never accepts workflow state as a new input, so resume cannot overwrite the original state after the workflow has been disabled. `materialize-cutover-provenance` accepts caller-selected output paths: PREPARED can materialize only the workflow state, while BASELINED must reproduce the stored workflow state, date, seed digest, and canonical batch A byte-for-byte and fails if a requested field is unavailable. This, not `/private/tmp` continuity, drives every resume. `verify-cutover-transition` compares the supplied C seed/batch against the immutable baseline; every retained ID/URL must keep the same full-row hash, additions must satisfy the batch mapping rule, and removals or field edits fail. It enforces all Step 1 transition rules and writes a deterministic report without changing the manifest. `refresh-capture` and `complete-cutover` preserve the immutable provenance object byte-for-byte.

  `rollout-entry` emits no diagnostics on stdout and derives only the durable entry enum above; callers must still prove the exact allowed Git diff, live Worker mode, baseline checksum, and fresh consent in Task 20. `assert-zero-due` reuses the tested Wrangler JSON extractor and exits non-zero unless exactly one aggregate row reports numeric `dueCount:0`; it is a **pre-cutoff** gate only. `normalize-batch-state` produces the strict, sorted byte-stable snapshot from Step 1 and never mutates D1. Reject a deploy `plan` for `current_research` unless capture metadata is `CAPTURED`, the manifest matches the current seed, and BASELINED provenance exists. The only production D1 captures occur in Task 20's explicitly approved cutover window.

- [ ] **Step 5: Merge generated first, legacy second.**

  `readingArticles` becomes `Object.freeze(mergeReadingArticleSources(generatedReadingArticles, legacyCuratedReadingArticles))`. Confirm `scripts/crawl-reading.mjs` still writes only `readingArticles.generated.mjs` and cannot overwrite the seed. Task 18 must render every represented legacy row (including generated-wins URL mappings) in the reading tab; presence only in this merged array is not sufficient completion.

- [ ] **Step 6: Verify the preservation pipeline and commit without a production capture.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/reading-legacy-curation.test.mjs tests/current-research-release.test.mjs tests/reading-policy.test.mjs tests/reading-catalog.test.mjs
  npm run crawl:reading:check
  git diff --check -- scripts/export-reading-legacy-curation.mjs scripts/current-research-release.mjs config/current-research-release.json src/data/readingLegacyCuration.mjs src/data/readingArticles.mjs tests/fixtures/reading-legacy-curation-export.json tests/reading-legacy-curation.test.mjs tests/current-research-release.test.mjs
  git add scripts/export-reading-legacy-curation.mjs scripts/current-research-release.mjs config/current-research-release.json src/data/readingLegacyCuration.mjs src/data/readingArticles.mjs tests/fixtures/reading-legacy-curation-export.json tests/reading-legacy-curation.test.mjs tests/current-research-release.test.mjs
  git commit -m "260903: 큐레이션 영속 seed 전환 파이프라인 준비"
  ```

### Task 16: Add the homepage fixed-key R2 public endpoint

**Repository:** Homepage

**Files:**

- Create: `src/contracts/currentResearch.mjs`
- Create: `scripts/verify-current-research-payload.mjs`
- Create: `workers/reading-stats/src/currentResearch.mjs`
- Modify: `workers/reading-stats/src/index.js:1-110,673-766`
- Modify: `wrangler.worker.toml:1-20`
- Create: `tests/fixtures/current-research-exploring-v1.json`
- Create: `tests/fixtures/current-research-withdrawn-v1.json`
- Create: `tests/fixtures/current-research-hash-mismatch-v1.json`
- Create: `tests/current-research-schema.test.mjs`
- Create: `tests/current-research-live-verifier.test.mjs`
- Extend: `tests/reading-worker-api.test.mjs`

- [ ] **Step 1: Write failing schema and endpoint tests.**

  Cover valid EXPLORING, missing current, both tombstones, mixed variants, unknown/private keys, bad hash/timestamp/author/year, a format-valid hash that does not equal the canonical `{distilledAt,content}` SHA-256, non-UUID storage revision, credential/localhost/private-or-loopback IP material URLs, every field/count limit, UTF-8 64 KiB overflow, query attempts to choose a history key, R2 read failure, no ETag/version/custom metadata/storage revision leakage, and `no-store` on 200/404/502/503. Run the same public-string mutation table as Radar over every string location: residual control characters, HTML comment/doctype, and English tags fail; ordinary mathematical `<`/`>` passes. Copy all three Radar fixtures byte-for-byte and run them through the homepage validator/integrity check.

  Because the homepage is a different origin from its Worker, test an allowed production/Pages `Origin` on GET and OPTIONS for the exact echoed `Access-Control-Allow-Origin` and `Vary: Origin`; test a disallowed origin receives no allow header. All 200/404/502/503 responses must pass through the same CORS boundary.

  Add an independent verifier test around the exact canonical vector and precomputed digest from Task 2. `scripts/verify-current-research-payload.mjs` must not import `src/contracts/currentResearch.mjs`; its duplicate canonical encoder exists solely as an operational cross-check. Feed it both a valid saved API response and a one-byte mutation and assert exit 0/non-zero respectively.

- [ ] **Step 2: Configure Miniflare R2 and observe RED.**

  Add to the test helper:

  ```js
  r2Buckets: { HOMEPAGE_PUBLICATIONS: 'homepage-publications-test' }
  ```

  Then run:

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/current-research-schema.test.mjs tests/current-research-live-verifier.test.mjs tests/reading-worker-api.test.mjs
  ```

- [ ] **Step 3: Implement a strict contract module shared by the homepage Worker and Vue client.**

  ```js
  export const CURRENT_RESEARCH_MAX_BYTES = 64 * 1024;
  export function isExploringCurrentResearchPayload(value) { return validateExploring(value); }
  export function isWithdrawnCurrentResearchPayload(value) { return validateWithdrawn(value); }
  export function canonicalCurrentResearchJson(value) {
    function encode(item) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
      if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
      if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
        return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
      }
      throw new Error('current_research_non_json_value');
    }
    return encode(value);
  }
  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  export async function verifyExploringContentHash(payload) {
    const bytes = new TextEncoder().encode(canonicalCurrentResearchJson({ distilledAt: payload.distilledAt, content: payload.content }));
    return hex(await crypto.subtle.digest('SHA-256', bytes)) === payload.contentHash;
  }
  export async function validateCurrentResearchStorageWrapper(value) {
    if (!hasExactKeys(value, ['payload', 'storageRevision'])) throw new Error('current_research_invalid');
    if (!UUID_PATTERN.test(value.storageRevision)) throw new Error('current_research_invalid');
    if (!isExploringCurrentResearchPayload(value.payload) && !isWithdrawnCurrentResearchPayload(value.payload)) throw new Error('current_research_invalid');
    if (value.payload.state === 'EXPLORING' && !(await verifyExploringContentHash(value.payload))) throw new Error('current_research_invalid');
    return value;
  }
  ```

  Put these validators in `src/contracts/currentResearch.mjs`. Mirror the exact Radar canonical serializer, limits, public URL rules, and required keys. Reject extra fields rather than stripping and forwarding them. Enforce the 64 KiB limit on UTF-8 bytes of the stored public payload, not JavaScript character count. `workers/reading-stats/src/currentResearch.mjs` imports the async validator and owns only the fixed-key R2 handler.

  The schema test pins this literal canonical byte string and digest without calling `canonicalCurrentResearchJson()` to construct the expected side:

  ```text
  {"content":{"artworkDirections":[],"displayTitle":"현재 연구","keywords":["빛"],"questions":[],"researchDirections":[],"researchMaterials":[],"thoughts":[]},"distilledAt":"2026-09-03T00:00:00.000Z"}
  SHA-256 83658fcd9e3c6f3557020c301d2b66327444e49b3eae48a7bbceef447c847170
  ```

- [ ] **Step 4: Add only `GET /api/research/current`.**

  Export `CURRENT_RESEARCH_KEY = 'homepage/current-research.json'` from the Worker handler. Read `HOMEPAGE_PUBLICATIONS.get(CURRENT_RESEARCH_KEY)`, validate wrapper and payload, and return a plain `{ status, body }` result—never construct a bare `Response` in this module. Missing/WITHDRAWN is `404 {ok:false,error:'current_research_not_published'}`; invalid is `502 {ok:false,error:'current_research_invalid'}`; R2 read failure is `503 {ok:false,error:'current_research_unavailable'}`. Query parameters never affect the R2 key.

  In `workers/reading-stats/src/index.js`, route both GET and OPTIONS through its origin allowlist and `json(body, {status, headers:{'Cache-Control':'no-store'}}, request, env)` helper so current research inherits the same CORS behavior on success and error. Tighten `corsHeaders()` at this shared boundary: echo `Access-Control-Allow-Origin` only for an exactly/wildcard-matched supplied Origin; omit the header for a disallowed or absent Origin instead of substituting the first allowed origin, and always retain `Vary: Origin`. Update existing CORS tests for all routes. Return payload only on 200; do not expose wrapper metadata.

- [ ] **Step 5: Add production binding while reactions remain on for the staged deploy.**

  ```toml
  [[r2_buckets]]
  binding = "HOMEPAGE_PUBLICATIONS"
  bucket_name = "radar-publications"

  [vars]
  READING_REACTIONS_ENABLED = "true"
  ```

  Preserve the existing `ALLOWED_ORIGINS` value in the same `[vars]` table.

- [ ] **Step 6: Verify and commit.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/current-research-schema.test.mjs tests/current-research-live-verifier.test.mjs tests/reading-worker-api.test.mjs
  npm test
  npx wrangler deploy --config wrangler.worker.toml --dry-run --outdir /private/tmp/taejunyun-reading-api-dry-run
  git add src/contracts/currentResearch.mjs scripts/verify-current-research-payload.mjs workers/reading-stats/src/currentResearch.mjs workers/reading-stats/src/index.js wrangler.worker.toml tests/fixtures/current-research-exploring-v1.json tests/fixtures/current-research-withdrawn-v1.json tests/fixtures/current-research-hash-mismatch-v1.json tests/current-research-schema.test.mjs tests/current-research-live-verifier.test.mjs tests/reading-worker-api.test.mjs
  git commit -m "260903: 현재 연구 R2 공개 API와 schema 검증 추가"
  ```

### Task 17: Put the reaction engine behind a safe cutoff flag

**Repository:** Homepage

**Files:**

- Modify: `workers/reading-stats/src/index.js:509-746`
- Extend: `tests/reading-worker-api.test.mjs:90-590`

- [ ] **Step 1: Preserve legacy tests under the enabled flag.**

  Make the existing Miniflare helper default to `READING_REACTIONS_ENABLED: 'true'` so current behavior remains explicitly tested rather than depending on a default.

- [ ] **Step 2: Write failing disabled-mode tests.**

  With the flag false, assert canonical `POST /api/reading/:id/click` increments only `clicks_count` and returns `{ok:true}`; GET stats, sync, like, curate, and all `/api/articles/*` aliases return 410 `reactions_disabled` with no stats/likes/curatedArticles. Assert no due-batch finalization, vote change, average calculation, or catalog insertion.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/reading-worker-api.test.mjs
  ```

- [ ] **Step 4: Implement a false-by-default route guard.**

  ```js
  function readingReactionsEnabled(env) {
    return String(env.READING_REACTIONS_ENABLED || '').toLowerCase() === 'true';
  }

  function reactionsDisabled(request, env) {
    return json({ ok: false, error: 'reactions_disabled' }, { status: 410 }, request, env);
  }
  ```

  Place the guard before `handleStats()` and sync/finalization code. Continue to allow OPTIONS, health, current research, and only the canonical click route. Do not delete D1 columns, tables, migrations, or rollback code.

- [ ] **Step 5: Verify with the staged flag still true and commit.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/reading-worker-api.test.mjs
  npm test
  git add workers/reading-stats/src/index.js tests/reading-worker-api.test.mjs
  git commit -m "260903: 읽을거리 반응 engine에 안전한 cutoff 추가"
  ```

### Task 18: Replace homepage curation with anonymous `현재 연구`

**Repository:** Homepage

**Files:**

- Create: `src/services/currentResearchApi.mjs`
- Create: `src/components/text/CurrentResearchPanel.vue`
- Modify: `src/services/readingStatsApi.mjs:59-107`
- Modify: `src/components/ArtStateView.vue:1-820,1069-1125,1821-1900`
- Create: `tests/current-research-client.test.mjs`
- Create: `tests/current-research-view.test.mjs`
- Create: `tests/reading-stats-client.test.mjs`
- Rewrite relevant expectations: `tests/reading-catalog-state.test.mjs:1-460`

- [ ] **Step 1: Write failing anonymous-client tests.**

  Use a table-driven `fetchImpl` fixture returning valid JSON, malformed text, wrong Content-Type, wrong-shape JSON, 404, 502, 503, and a rejected promise. Assert the configured reading Worker base URL, exact `/api/research/current`, `GET`, `Accept: application/json`, `cache: no-store`, `credentials: omit`, 404-to-null, typed 502/503 errors, rejected fetch → `CurrentResearchApiError('current_research_unavailable', 0)`, strict malformed/non-EXPLORING 200 rejection through the shared contract validator, no query visitor ID, and zero localStorage reads/writes. Expected RED is the missing client module.

  ```js
  export class CurrentResearchApiError extends Error {
    constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
  }

  export async function fetchCurrentResearch({ fetchImpl = globalThis.fetch } = {}) {
    const base = getReadingStatsApiUrl();
    if (!base) return null;
    let response;
    try {
      response = await fetchImpl(`${base}/api/research/current`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new CurrentResearchApiError('current_research_unavailable', 0);
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new CurrentResearchApiError('current_research_invalid_response', response.status);
    }
    let data;
    try { data = JSON.parse(await response.text()); }
    catch { throw new CurrentResearchApiError('current_research_invalid_response', response.status); }
    if (response.status === 404 && data.error === 'current_research_not_published') return null;
    if (!response.ok) throw new CurrentResearchApiError(data.error || 'current_research_unavailable', response.status);
    if (!isExploringCurrentResearchPayload(data)) throw new CurrentResearchApiError('current_research_invalid_response', response.status);
    return data;
  }
  ```

- [ ] **Step 2: Write failing panel/view tests with the existing test stack.**

  Start a Vite middleware server and load `.vue`/`import.meta.env` modules through `ssrLoadModule()`; create separate true/false servers by defining `import.meta.env.VITE_CURRENT_RESEARCH_ENABLED` explicitly. Render presentational states with `createSSRApp()` and `renderToString()` from the already installed `vue/server-renderer`; use the existing Options-API context helper plus deferred fetch promises for tab/load race behavior. Directly invoke `CurrentResearchPanel.methods.requestRetry` with a `$emit` spy, and invoke `ArtStateView`'s `mounted`/`beforeUnmount` hooks against fake `window`, `document`, timers, and localStorage to prove the true branch neither registers nor touches them. Do not directly import `.vue` from `node --test` and do not add a DOM dependency. Expected RED is missing panel/state methods, not an unknown extension error.

  Test idle/loading/ready/empty/error, retry emit contract, exact section order, empty-section hiding, heading hierarchy, `<time :datetime="updatedAt">YYYY.MM.DD</time>` across a UTC→KST boundary, title-named material links, direct-citation disclaimer, provenance copy, mustache escaping, feature flag true/false branches, no generic list empty state or timeline/cards in research, meaningful archive-header meta, and no likes/averages/counters/cooldown when the flag is true. Pin state announcements exactly: loading `현재 연구를 확인 중입니다.`, ready `현재 연구를 불러왔습니다.`, and empty `현재 공개된 연구가 없습니다.` in `role="status" aria-live="polite"`; error `현재 연구를 불러오지 못했습니다.` in `role="alert"` with the retry control. Idle emits no live announcement. Resolve an older tab request last and prove its generation cannot overwrite a newer revisit. In `reading-stats-client.test.mjs`, exercise both beacon success and fetch fallback for `sendArticleClick()` and assert the exact canonical click URL has no query string/visitor ID and performs zero localStorage access.

- [ ] **Step 3: Run and observe RED.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/current-research-client.test.mjs tests/current-research-view.test.mjs tests/reading-stats-client.test.mjs tests/reading-catalog-state.test.mjs
  ```

- [ ] **Step 4: Implement the presentational one-edition panel.**

  `currentResearchApi.mjs` imports `isExploringCurrentResearchPayload()` from Task 16's shared `src/contracts/currentResearch.mjs`; do not duplicate the schema in the client. `ArtStateView.vue` owns fetch state and retry. `CurrentResearchPanel.vue` is a pure component with this contract and performs no fetch or storage access:

  ```js
  props: {
    state: { type: String, required: true }, // idle | loading | ready | empty | error
    research: { type: Object, default: null },
    error: { type: String, default: '' },
  },
  emits: ['retry'],
  methods: {
    requestRetry() { this.$emit('retry'); },
  },
  ```

  Render the exact loading/ready/empty messages above in one persistent polite live region and the exact error message in `role="alert"`; do not announce idle or expose raw error codes. The ready announcement may be visually hidden while the article is visible, but it must remain in the accessibility tree. Retry returns state to the loading announcement, and a stale generation may not announce after a newer tab/load wins.

  Render in this exact order: `탐색 중` + title + `<time :datetime="research.updatedAt">` formatted as `YYYY.MM.DD` in `Asia/Seoul`; keywords; thoughts; questions; research directions; artwork directions; research materials + `Distill에 사용된 자료이며 각 문장의 직접 인용 근거를 뜻하지 않습니다.`; `Research Radar에서 정리한 현재 연구`. Use `<article aria-labelledby>`, named headings, and ordinary external anchors.

- [ ] **Step 5: Add the build-time feature flag and simplify the enabled branch.**

  Define `currentResearchEnabled` from `import.meta.env.VITE_CURRENT_RESEARCH_ENABLED === 'true'`. When false, preserve the existing `selected`/`큐레이션` behavior for the pre-cutover rollback build. When true, replace it with `research`/`현재 연구` and do not initialize or render reaction state, likes, stats, curation sort/merge, localStorage, 1-second cooldown, 15-second polling, focus/visibility refresh, or client-side curation. Final production uses true; rollback requires both a false rebuild and Worker reactions true.

  Keep received/written/reading tabs, reading source links, GA metadata, and private click counting. Refactor `sendArticleClick()` to an anonymous click-only beacon/fetch path that calls the canonical `/api/reading/:id/click` with no `visitorId` query and never calls `getReadingVisitorId()`; the disabled Worker already rate-limits clicks by request-derived identity. Leave visitor-backed legacy like/stats functions only for the false rollback branch. Remove the enabled branch's assumption that the click response contains `stat`. Render every represented legacy seed article in the reading tab instead of losing it behind the old 12-card curation cap, and test every URL/ID mapping.

  On each transition into the research tab, start exactly one load; dedupe concurrent calls. A later revisit starts one new load, explicit retry through `requestRetry()` forces one new load, and every completion is guarded by a monotonically increasing generation. Never use timer/focus/visibility polling. Error affects only the research panel. Suppress the generic `TransitionGroup`/empty-list rendering on the research tab. Use `현재 연구 · YYYY.MM.DD`, `현재 연구 · 공개본 없음`, or `현재 연구 확인 중` for `ArchiveFileHeader.meta` instead of `0 open documents`.

- [ ] **Step 6: Verify and commit.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/current-research-client.test.mjs tests/current-research-view.test.mjs tests/reading-stats-client.test.mjs tests/reading-catalog-state.test.mjs tests/reading-catalog.test.mjs
  npm test
  VITE_CURRENT_RESEARCH_ENABLED=true npm run build
  git add src/services/currentResearchApi.mjs src/services/readingStatsApi.mjs src/components/text/CurrentResearchPanel.vue src/components/ArtStateView.vue tests/current-research-client.test.mjs tests/current-research-view.test.mjs tests/reading-stats-client.test.mjs tests/reading-catalog-state.test.mjs
  git commit -m "260903: /text 큐레이션을 현재 연구 view로 전환"
  ```

### Task 19: Finalize cutoff, deploy-path safety, and import-loop isolation

**Repositories:** Homepage, then Radar

**Homepage files:**

- Modify: `wrangler.worker.toml:12-20`
- Modify: `scripts/deploy.sh:25-55`
- Modify: `scripts/current-research-release.mjs`
- Create: `scripts/verify-git-default-head.sh`
- Create: `scripts/push-exact-default-head.sh`
- Create: `scripts/assert-exact-ahead-commit.sh`
- Modify at rollout only: `config/current-research-release.json`
- Modify: `.github/workflows/weekly-reading-deploy.yml:20-75`
- Modify: `.env.production.example`
- Create: `tests/current-research-boundary.test.mjs`
- Extend: `tests/current-research-release.test.mjs`
- Modify: `README.md:11-15,176-203`
- Modify: `docs/reading-crawler.md:3-58`
- Modify: `docs/cloudflare-d1-reading-stats.md`

**Radar files:**

- Modify: `worker/src/homepage/reading.ts:7-10,85-99`
- Extend: `web/src/lib/homepageReading.test.ts:1-11`

- [ ] **Step 1: Write failing deployment/boundary assertions.**

  Test that `deploy`/`deploy:auto` cannot invoke `reading:sync`, the workflow has no `READING_SYNC_TOKEN`, final Worker config says false, current research is absent from `sync-radar-reading.mjs`, and homepage-reading remains `ORIGINALS` + `homepage-reading/latest.json` + `homepage_artist` + `articles`. A source scan alone is not enough for the Radar importer behavior test in Step 2. Add Wrangler JSON fixture tests for `active-worker-version` and `read-worker-reaction-mode`: require one 100%-active production version, extract its opaque ID, then require exactly one text binding named `READING_REACTIONS_ENABLED` whose value is `true` or `false`; reject split/unknown deployments, duplicate/missing bindings, malformed JSON, and all other values. With a fake `git`, test `scripts/verify-git-default-head.sh`: it must derive the current branch's configured remote/merge ref, fetch, require that ref to equal a fresh `ls-remote --symref <remote> HEAD`, and compare a one-line fresh remote-default SHA. Default mode requires `HEAD == @{upstream} == remote-default`; `--allow-local-ahead` instead requires `@{upstream} == remote-default` plus upstream ancestor of HEAD. Reject detached HEAD, upstream-ahead, divergence, multiple/missing symrefs or SHAs, unknown arguments, and every failed Git read. Test `scripts/push-exact-default-head.sh` separately: it accepts no arguments, invokes the allow-ahead verifier, derives that same verified remote/default ref, requires exactly one fetch URL and one push URL with byte-identical values, then issues exactly `git push --no-follow-tags <resolved-push-url> HEAD:<verified-default-ref>` and invokes the exact verifier afterward. Reject missing/multiple/different URLs and any failed preflight/push/postflight; never let `pushRemote`, `remote.pushDefault`, `remote.*.push`, `push.default`, or tag-following widen the write. Test `scripts/assert-exact-ahead-commit.sh <subject> <path...>` with a fake `git`: require exactly one non-merge commit above upstream, its first parent equal to upstream, exact subject equality, and exact sorted unique changed-path equality; reject zero/two commits, merge parents, extra/missing/duplicate paths, and every Git failure.

  Make `config/current-research-release.json` the only persisted release-mode input. The workflow must not set `VITE_CURRENT_RESEARCH_ENABLED` or `READING_REACTIONS_ENABLED`; arbitrary shell environment overrides must be rejected. With fake `npm`/`npx` binaries recording commands and no network, assert the exact external action order produced by `scripts/deploy.sh`:

  | Manifest state | Required plan after a successful local build |
  |---|---|
  | `pre_cutover` | Worker reactions `true` → Pages UI `false` |
  | `current_research`, `initialCutoverComplete:false` | validated BASELINED seed; active Worker `true` is fresh and `false` is an interrupted retry → Pages UI `true` → Worker `false`; retries never re-enable reactions |
  | `current_research`, `initialCutoverComplete:true` | Worker `false` → Pages UI `true`; never temporarily enable reactions |
  | `legacy_rollback` | Worker `true` → Pages UI `false` |

  Also assert a PREPARED provenance record leaves the `pre_cutover` action order unchanged, while current-research mode blocks on missing/non-BASELINED provenance, `PRE_CUTOVER` seed, capture/manifest mismatch, or an empty/unmapped seed. Every Worker deploy receives the complete checked-in `ALLOWED_ORIGINS` plus its planned reaction value; every Pages artifact was built with the planned flag; and a failure stops before the next remote action. `.env.production.example` may document local reproduction values but is never production state.

- [ ] **Step 2: Export the Radar import contract and test separation.**

  ```ts
  export const homepageReadingInputContract = Object.freeze({
    binding: "ORIGINALS",
    key: "homepage-reading/latest.json",
    schemaVersion: 1,
    source: "homepage_artist",
    collectionField: "articles",
  } as const);
  ```

  Replace the independent `INPUT_KEY`, literal source/schema, and `.articles` access inside `syncHomepageReading()` with `env[homepageReadingInputContract.binding]`, `.key`, `.schemaVersion`, `.source`, and `payload[homepageReadingInputContract.collectionField]`. In `homepageReading.test.ts`, use an `ORIGINALS.get` spy that accepts only `homepage-reading/latest.json`, a `PUBLICATIONS` getter that throws if touched, and two payloads: valid homepage reading and a CURRENT_RESEARCH wrapper. Assert the former advances to the normal importer path and the latter returns `invalid_payload` before DB writes. Also assert the contract contains none of `PUBLICATIONS`, `homepage/current-research.json`, or `CURRENT_RESEARCH`, and that Radar `ORIGINALS/reservoir-originals` and `PUBLICATIONS/radar-publications` are distinct.

- [ ] **Step 3: Make deploys manifest-driven and cutoff-safe.**

  Set checked-in `READING_REACTIONS_ENABLED = "false"`. Remove only `npm run reading:sync` from `scripts/deploy.sh` and renumber its progress messages. At startup, have the deploy script invoke `node scripts/current-research-release.mjs plan --json`. On success stdout contains exactly this machine contract (diagnostics go to stderr); invalid input exits `2` with no JSON:

  ```json
  {
    "schemaVersion": 1,
    "mode": "pre_cutover",
    "initialCutoverComplete": false,
    "viteCurrentResearchEnabled": false,
    "actions": [
      { "type": "DEPLOY_WORKER", "readingReactionsEnabled": true },
      { "type": "DEPLOY_PAGES" }
    ],
    "legacyCapture": null,
    "cutoverProvenance": null
  }
  ```

  The booleans/actions vary only according to the table above; `legacyCapture` is null or the exact frozen capture metadata object, while `cutoverProvenance` is null, PREPARED in safe `pre_cutover`, or the immutable BASELINED object in current-research mode. The deployment parser validates it but derives actions only from the allowed state table. Parse this JSON with a strict Node parser into allowlisted action values—never `eval`, source, or regex-generated shell. Build the requested UI artifact first, then execute the ordered remote actions.

  A Worker helper constructs one exact Wrangler argv containing the config, complete checked-in `ALLOWED_ORIGINS`, and planned reaction value. Tests capture that argv. The helper first runs the same argv with only `--dry-run --outdir <temp>` added, requires exit 0, then uses the original argv for the actual deploy; do not scrape Wrangler's human-readable summary as JSON. Add strict read-only `active-worker-version --input <deployments-status-json>` and `read-worker-reaction-mode --input <version-view-json>` commands to `current-research-release.mjs`; only their exact stdout contracts may drive rollout checks. Separately assert the TOML contains the exact `HOMEPAGE_PUBLICATIONS` binding. Any failure stops before the next action.

  Implement all three Git helpers with their own `set -euo pipefail` and no ambient branch/remote assumptions. `verify-git-default-head.sh` performs fresh `fetch`, `ls-remote --symref`, single-result validation, and the exact comparison tested above; it never pushes, checks out, resets, stages, or mutates working files. `push-exact-default-head.sh` accepts no arguments, calls that verifier with `--allow-local-ahead`, resolves one identical fetch/push URL for the verified remote, pushes only `HEAD:<verified-default-ref>` to that URL with `--no-follow-tags`, then calls the default exact verifier. `assert-exact-ahead-commit.sh` is read-only and enforces the one-parent/one-commit/subject/path contract before an interrupted or newly created rollout commit may be pushed. Task 20 uses only the mutation helper, never argumentless `git push`, so local/global push configuration cannot redirect or broaden the approved write.

  The weekly workflow calls only the same `deploy:auto`/`scripts/deploy.sh` path and carries no independent feature flag. Keep the old package script and D1 schema temporarily for rollback. `legacy_rollback` is therefore persistent across future scheduled deploys rather than a one-off manual environment override. Remove the now-unused workflow secret reference, not unrelated Radar R2 sync secrets. Document that mode changes are reviewable commits made through `begin-cutover`, `complete-cutover`, or an explicit `legacy_rollback` manifest update; never roll back only one side.

- [ ] **Step 4: Update operational docs to the new truth.**

  Explain that clicks remain private, public reactions are 410 in completed current-research mode, current research comes from fixed-key R2, `reading:sync` is no longer in deploy, legacy curated items are static reading seed, `sync:radar` still sends only generated reading articles to the old importer, and the release manifest controls pre-cutover/current/rollback choreography. State explicitly that `.env.production.example` is documentation only.

- [ ] **Step 5: Verify and commit Homepage.**

  ```bash
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node --test tests/current-research-boundary.test.mjs tests/reading-worker-api.test.mjs tests/reading-legacy-curation.test.mjs
  npm test
  node scripts/current-research-release.mjs plan
  VITE_CURRENT_RESEARCH_ENABLED=false npm run build
  VITE_CURRENT_RESEARCH_ENABLED=true npm run build
  bash -n scripts/deploy.sh
  bash -n scripts/verify-git-default-head.sh
  bash -n scripts/push-exact-default-head.sh
  bash -n scripts/assert-exact-ahead-commit.sh
  node scripts/sync-radar-reading.mjs --dry-run
  npx wrangler deploy --config wrangler.worker.toml --dry-run --outdir /private/tmp/taejunyun-reading-api-final-dry-run
  git diff --check
  git add wrangler.worker.toml scripts/deploy.sh scripts/current-research-release.mjs scripts/verify-git-default-head.sh scripts/push-exact-default-head.sh scripts/assert-exact-ahead-commit.sh .github/workflows/weekly-reading-deploy.yml .env.production.example tests/current-research-boundary.test.mjs tests/current-research-release.test.mjs README.md docs/reading-crawler.md docs/cloudflare-d1-reading-stats.md
  git commit -m "260903: 반응 cutoff와 현재 연구 배포 경계 확정"
  ```

- [ ] **Step 6: Verify and commit Radar loop isolation.**

  ```bash
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm --filter @radar/web exec vitest run src/lib/homepageReading.test.ts
  pnpm --filter @radar/worker typecheck
  cmp worker/test/fixtures/current-research-exploring-v1.json /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/tests/fixtures/current-research-exploring-v1.json
  cmp worker/test/fixtures/current-research-withdrawn-v1.json /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/tests/fixtures/current-research-withdrawn-v1.json
  cmp worker/test/fixtures/current-research-hash-mismatch-v1.json /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/tests/fixtures/current-research-hash-mismatch-v1.json
  git add worker/src/homepage/reading.ts web/src/lib/homepageReading.test.ts
  git commit -m "260903: 홈페이지 읽을거리와 현재 연구 순환 경계 고정"
  ```

### Task 20: Run the gated production rollout and record proven state

**Repositories:** Radar and Homepage

**Files after successful rollout:**

- Replace from verified live capture: Homepage `src/data/readingLegacyCuration.mjs`
- Modify through the checked-in release commands: Homepage `config/current-research-release.json`
- Modify: Radar `docs/PROJECT_CONTEXT.md:39-84,103-176,201-240`

**Fail-fast execution rule:** Every `bash` fence in Task 20 is a standalone operator block and must begin with `set -euo pipefail` in the same shell process. The line is written explicitly in each mutation/gate block below. A non-zero `gh`, Wrangler, `rg`, `test`, `cmp`, test, commit, or push exits that block immediately; never continue by inspecting an empty redirected file produced by a failed command. On a new shell or resumed session, rerun the preamble and durable-state classifier before any action.

**Pre-router abort recovery:** A crash after successful `abort-cutover` but before its commit makes the working manifest look fresh while local `HEAD` still contains PREPARED provenance. Detect only that exact state before ordinary routing. This local block neither edits nor contacts a remote; any other dirty fresh state stops instead of being guessed:

```bash
set -euo pipefail
cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
CURRENT_ROLLOUT_ENTRY="$(node scripts/current-research-release.mjs rollout-entry)"
git diff --name-only > /private/tmp/current-research-prerouter-unstaged-files.txt
git diff --cached --name-only > /private/tmp/current-research-prerouter-staged-files.txt
sort -u /private/tmp/current-research-prerouter-unstaged-files.txt /private/tmp/current-research-prerouter-staged-files.txt > /private/tmp/current-research-prerouter-changed-files.txt
git ls-files --others --exclude-standard > /private/tmp/current-research-prerouter-untracked-files.txt
if test "$CURRENT_ROLLOUT_ENTRY" = FRESH_PRE_CUTOVER && { test -s /private/tmp/current-research-prerouter-changed-files.txt || test -s /private/tmp/current-research-prerouter-untracked-files.txt; }; then
  test ! -s /private/tmp/current-research-prerouter-untracked-files.txt
  git diff --check
  git diff --cached --check
  test "$(wc -l < /private/tmp/current-research-prerouter-changed-files.txt | tr -d ' ')" = 1
  rg -x 'config/current-research-release\.json' /private/tmp/current-research-prerouter-changed-files.txt
  git show HEAD:config/current-research-release.json > /private/tmp/current-research-abort-parent-manifest.json
  test "$(node scripts/current-research-release.mjs rollout-entry --manifest-file /private/tmp/current-research-abort-parent-manifest.json)" = PREPARED_RESUME
  node scripts/current-research-release.mjs materialize-cutover-provenance --manifest-file /private/tmp/current-research-abort-parent-manifest.json --workflow-state-output /private/tmp/current-research-abort-required-workflow.txt
  rg -x 'active|disabled_manually' /private/tmp/current-research-abort-required-workflow.txt
  printf '%s\n' LOCAL_ABORT_RESUME > /private/tmp/current-research-prerouter-result.txt
else
  printf '%s\n' STANDARD_ROUTER > /private/tmp/current-research-prerouter-result.txt
fi
```

If that emits `LOCAL_ABORT_RESUME`, do not run the ordinary router yet. With approved remote reads, inspect the current workflow and active runs, present the exact manifest diff plus stored/current workflow states, and obtain a new explicit abort-completion approval:

```bash
set -euo pipefail
cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
test "$(tr -d '\n' < /private/tmp/current-research-prerouter-result.txt)" = LOCAL_ABORT_RESUME
gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/current-research-abort-current-workflow.txt
test "$(wc -l < /private/tmp/current-research-abort-current-workflow.txt | tr -d ' ')" = 1
rg -x 'active|disabled_manually' /private/tmp/current-research-abort-current-workflow.txt
: > /private/tmp/current-research-abort-current-runs.tsv
for RUN_STATUS in queued in_progress waiting requested pending; do
  gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/current-research-abort-current-runs.tsv
done
```

Only after that approval, re-establish the stored workflow state, require no active run, commit the already-validated manifest-only abort transition, and push through the exact default-branch gate. Then stop and restart Task 20 so the ordinary router sees a clean `FRESH_PRE_CUTOVER` checkpoint:

```bash
set -euo pipefail
cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
test "$(tr -d '\n' < /private/tmp/current-research-prerouter-result.txt)" = LOCAL_ABORT_RESUME
test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
test -z "$(git ls-files --others --exclude-standard)"
git diff --check
git diff --cached --check
git diff --name-only > /private/tmp/current-research-abort-mutation-unstaged-files.txt
git diff --cached --name-only > /private/tmp/current-research-abort-mutation-staged-files.txt
sort -u /private/tmp/current-research-abort-mutation-unstaged-files.txt /private/tmp/current-research-abort-mutation-staged-files.txt > /private/tmp/current-research-abort-mutation-changed-files.txt
test "$(wc -l < /private/tmp/current-research-abort-mutation-changed-files.txt | tr -d ' ')" = 1
rg -x 'config/current-research-release\.json' /private/tmp/current-research-abort-mutation-changed-files.txt
git show HEAD:config/current-research-release.json > /private/tmp/current-research-abort-parent-manifest.json
test "$(node scripts/current-research-release.mjs rollout-entry --manifest-file /private/tmp/current-research-abort-parent-manifest.json)" = PREPARED_RESUME
node scripts/current-research-release.mjs materialize-cutover-provenance --manifest-file /private/tmp/current-research-abort-parent-manifest.json --workflow-state-output /private/tmp/current-research-abort-required-workflow.txt
REQUIRED_ABORT_WORKFLOW_STATE="$(tr -d '\n' < /private/tmp/current-research-abort-required-workflow.txt)"
test "$REQUIRED_ABORT_WORKFLOW_STATE" = active || test "$REQUIRED_ABORT_WORKFLOW_STATE" = disabled_manually
bash scripts/verify-git-default-head.sh
if test "$REQUIRED_ABORT_WORKFLOW_STATE" = disabled_manually; then gh workflow disable weekly-reading-deploy.yml; fi
: > /private/tmp/current-research-abort-recheck-runs.tsv
for RUN_STATUS in queued in_progress waiting requested pending; do
  gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/current-research-abort-recheck-runs.tsv
done
test ! -s /private/tmp/current-research-abort-recheck-runs.tsv
if test "$REQUIRED_ABORT_WORKFLOW_STATE" = active; then gh workflow enable weekly-reading-deploy.yml; else gh workflow disable weekly-reading-deploy.yml; fi
gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/current-research-abort-restored-workflow.txt
cmp /private/tmp/current-research-abort-required-workflow.txt /private/tmp/current-research-abort-restored-workflow.txt
git add config/current-research-release.json
if git diff --cached --quiet -- config/current-research-release.json; then exit 1; fi
git commit --only config/current-research-release.json -m "260903: 취소된 cutover 준비 상태 해제"
bash scripts/assert-exact-ahead-commit.sh "260903: 취소된 cutover 준비 상태 해제" config/current-research-release.json
bash scripts/push-exact-default-head.sh
test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
git diff --exit-code
git diff --cached --exit-code
test -z "$(git ls-files --others --exclude-standard)"
```

**Mandatory entry router:** Run this before Step 1 on every fresh executor/session. `rollout-entry` is a read-only, exact-enum classifier; it does not make an incomplete or locally modified seed deployable. The selected lane is binding—do not execute or “catch up” intervening steps:

```bash
set -euo pipefail
cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
test "$(tr -d '\n' < /private/tmp/current-research-prerouter-result.txt)" = STANDARD_ROUTER
node scripts/current-research-release.mjs rollout-entry > /private/tmp/current-research-rollout-entry.txt
test "$(wc -l < /private/tmp/current-research-rollout-entry.txt | tr -d ' ')" = 1
ROLLOUT_ENTRY="$(tr -d '\n' < /private/tmp/current-research-rollout-entry.txt)"
case "$ROLLOUT_ENTRY" in
  FRESH_PRE_CUTOVER) printf '%s\n' 'NEXT=Task20-Step1' ;;
  PREPARED_RESUME) printf '%s\n' 'NEXT=Task20-Step5-PREPARED-resume' ;;
  BASELINED_INCOMPLETE_RESUME) printf '%s\n' 'NEXT=Task20-Step6-common-setup' ;;
  COMPLETED_RESUME) printf '%s\n' 'NEXT=Task20-Step6-completed-deploy-or-verification' ;;
  *) exit 1 ;;
esac
```

- `FRESH_PRE_CUTOVER` alone follows Steps 1–4 and the fresh half of Step 5.
- `PREPARED_RESUME` first passes the resume Git/live-state approval gate, then executes only Step 5's PREPARED materialization, disable/quiescence, authoritative capture, renewed-baseline approval, and `begin-cutover` path.
- `BASELINED_INCOMPLETE_RESUME` first passes that same new-session approval gate, then jumps directly to Step 6 common setup; it must not rerun pre-cutover deploy, publication, preliminary capture, `prepare-cutover`, or `begin-cutover`.
- `COMPLETED_RESUME` first passes that same new-session approval gate, then runs only the idempotent completed deploy/workflow restoration unless the same commit and all live proofs are already recorded; it never reruns C/D or publication mutations. A locally dirty completed transition is the sole exception: Step 6's exact post-C recovery lane validates and commits it before completed deploy.

- [ ] **Step 1: Pass both repositories' complete local gates.**

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm verify
  git diff --check

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  npm test
  node scripts/current-research-release.mjs plan
  bash -n scripts/deploy.sh
  VITE_CURRENT_RESEARCH_ENABLED=true npm run build
  VITE_CURRENT_RESEARCH_ENABLED=false npm run build
  git diff --check
  ```

- [ ] **Step 2: Inspect the deployment surface and provision resources with explicit approval.**

  Pause and obtain approval before these remote reads. Inspect the bucket and Pages project first:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm --filter @radar/worker exec wrangler r2 bucket list

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  npx wrangler pages project list
  ```

  Confirm `homepage-artist` is direct-upload controlled by this deploy script. If the listing is insufficient to prove its source, inspect the project in the Cloudflare dashboard/API. If an unexpected Git-integrated automatic production deploy exists, stop until it is disabled or made to invoke the same manifest gate with explicit approval; two independent production deploy paths are not allowed.

  Before staging, verify **both** checkouts against fresh remote state. Derive each configured upstream, run approved `git fetch` plus `git ls-remote --symref <remote> HEAD`, and prove the tracked merge ref is still that remote's default branch. Radar must contain the reviewed Tasks 1–14 and Task 19 commits and have no staged/unstaged/untracked deploy-surface change; unrelated user-owned planning/report files outside that surface are not staged or erased. Homepage must contain the reviewed Tasks 15–19 commits, keep manifest `pre_cutover`, and be clean across its **entire tree**, because root files and `public/` are Pages inputs. The currently observed modified `public/sitemap.xml` plus untracked `.playwright-cli/` and `.wrangler/` are therefore explicit rollout blockers until the user resolves or deliberately ignores them in a reviewed commit; never discard or bundle them implicitly. Capture and show each exact local HEAD plus its upstream-to-HEAD commit list, then obtain explicit Git remote-write approval over those hashes and reviewed ranges. Push only through `push-exact-default-head.sh`; do not use ambient push defaults or invent/force a branch/ref. Freshly read both remote-default SHAs again and require exact equality with local HEAD before any production deploy. This prevents a later default-branch deployment from reverting either half and ensures the daily Homepage workflow already contains the manifest-safe path. Stop on a detached HEAD, unexpected upstream/default branch, non-fast-forward, unreviewed commit, or deploy-surface drift.

  Make the clean-state requirement executable before the first production deploy. Radar may retain unrelated user-owned planning/report changes, but none may be staged and no Worker/Web/shared/root-build input may differ or be untracked. Homepage is stricter because its whole checkout can affect Pages:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
  node scripts/current-research-release.mjs plan --json > /private/tmp/current-research-pre-push-plan.json
  ```

  After the deployment-surface diff review and approved remote reads, run this exact pre-push fast-forward/default-branch gate for both repositories. It allows local reviewed commits ahead of upstream, but never upstream-ahead or divergence:

  ```bash
  set -euo pipefail
  verify_pre_push_state() {
    local checkout="$1"
    local prefix="$2"
    cd "$checkout"
    local branch remote merge_ref default_ref remote_sha
    branch="$(git branch --show-current)"
    test -n "$branch"
    remote="$(git config --get "branch.${branch}.remote")"
    merge_ref="$(git config --get "branch.${branch}.merge")"
    test -n "$remote"
    test -n "$merge_ref"
    git fetch --prune "$remote"
    git ls-remote --symref "$remote" HEAD > "${prefix}-head.symref"
    test "$(awk '$1 == "ref:" && $3 == "HEAD" { count++ } END { print count + 0 }' "${prefix}-head.symref")" = 1
    default_ref="$(awk '$1 == "ref:" && $3 == "HEAD" { print $2 }' "${prefix}-head.symref")"
    test "$merge_ref" = "$default_ref"
    git ls-remote "$remote" "$default_ref" > "${prefix}-default.sha"
    test "$(wc -l < "${prefix}-default.sha" | tr -d ' ')" = 1
    remote_sha="$(awk '{ print $1 }' "${prefix}-default.sha")"
    test "$(git rev-parse '@{upstream}')" = "$remote_sha"
    git merge-base --is-ancestor '@{upstream}' HEAD
  }
  verify_pre_push_state /Users/taejun-yun/Documents/Codex/Radar_data /private/tmp/radar-pre-push
  verify_pre_push_state /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun /private/tmp/homepage-pre-push
  git -C /Users/taejun-yun/Documents/Codex/Radar_data rev-parse HEAD > /private/tmp/radar-approved-push-head.txt
  git -C /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun rev-parse HEAD > /private/tmp/homepage-approved-push-head.txt
  git -C /Users/taejun-yun/Documents/Codex/Radar_data log --format='%H %s' '@{upstream}..HEAD' > /private/tmp/radar-approved-push-commits.txt
  git -C /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun log --format='%H %s' '@{upstream}..HEAD' > /private/tmp/homepage-approved-push-commits.txt
  sed -n 'p' /private/tmp/radar-approved-push-head.txt
  sed -n 'p' /private/tmp/homepage-approved-push-head.txt
  sed -n 'p' /private/tmp/radar-approved-push-commits.txt
  sed -n 'p' /private/tmp/homepage-approved-push-commits.txt
  ```

  After those read-only checks and explicit approval over the saved HEADs/ranges, the only allowed writes are below. A lost shell/session requires recapture and new approval:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(git rev-parse HEAD)" = "$(tr -d '\n' < /private/tmp/homepage-approved-push-head.txt)"
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  bash scripts/verify-git-default-head.sh --allow-local-ahead

  cd /Users/taejun-yun/Documents/Codex/Radar_data
  test "$(git rev-parse HEAD)" = "$(tr -d '\n' < /private/tmp/radar-approved-push-head.txt)"
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/push-exact-default-head.sh

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(git rev-parse HEAD)" = "$(tr -d '\n' < /private/tmp/homepage-approved-push-head.txt)"
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  bash scripts/push-exact-default-head.sh

  verify_post_push_state() {
    local checkout="$1"
    local prefix="$2"
    cd "$checkout"
    local branch remote merge_ref default_ref remote_sha
    branch="$(git branch --show-current)"
    test -n "$branch"
    remote="$(git config --get "branch.${branch}.remote")"
    merge_ref="$(git config --get "branch.${branch}.merge")"
    test -n "$remote"
    test -n "$merge_ref"
    git fetch --prune "$remote"
    git ls-remote --symref "$remote" HEAD > "${prefix}-head.symref"
    test "$(awk '$1 == "ref:" && $3 == "HEAD" { count++ } END { print count + 0 }' "${prefix}-head.symref")" = 1
    default_ref="$(awk '$1 == "ref:" && $3 == "HEAD" { print $2 }' "${prefix}-head.symref")"
    test "$merge_ref" = "$default_ref"
    git ls-remote "$remote" "$default_ref" > "${prefix}-default.sha"
    test "$(wc -l < "${prefix}-default.sha" | tr -d ' ')" = 1
    remote_sha="$(awk '{ print $1 }' "${prefix}-default.sha")"
    test "$(git rev-parse HEAD)" = "$(git rev-parse '@{upstream}')"
    test "$(git rev-parse HEAD)" = "$remote_sha"
  }
  verify_post_push_state /Users/taejun-yun/Documents/Codex/Radar_data /private/tmp/radar-post-push
  verify_post_push_state /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun /private/tmp/homepage-post-push
  ```

  If and only if `radar-publications` is absent, obtain the production-write approval and create it once:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm --filter @radar/worker exec wrangler r2 bucket create radar-publications
  ```

  Inspect secret names first; this reveals no secret values:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm --filter @radar/worker exec wrangler secret list
  ```

  If `CSRF_SECRET` is absent, obtain approval to create it and run this isolated block. If it already exists, **skip the entire block**; rotation is a separate change requiring separate approval and a coordinated session-expiry note:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh
  pnpm --filter @radar/worker exec wrangler secret list --format json > /private/tmp/radar-secrets-before-csrf-create.json
  node -e 'const fs = require("node:fs"); const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!Array.isArray(rows) || rows.some((row) => row && row.name === "CSRF_SECRET")) process.exit(1);' /private/tmp/radar-secrets-before-csrf-create.json
  pnpm --filter @radar/worker exec wrangler secret put CSRF_SECRET
  ```

  Inspect the remote pending-migration snapshot first. Prove the reviewed Radar deploy surface and exact remote-default HEAD, require Wrangler's only unapplied filename to be `0029_homepage_publications.sql`, show the saved output, and obtain independent approval over that exact snapshot:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh
  pnpm --filter @radar/worker exec wrangler d1 migrations list research-radar-db --remote > /private/tmp/radar-approved-pending-migrations-0029.txt
  rg -o '[0-9]{4}_[A-Za-z0-9._-]+\.sql' /private/tmp/radar-approved-pending-migrations-0029.txt > /private/tmp/radar-approved-pending-migration-names-0029.txt
  test "$(wc -l < /private/tmp/radar-approved-pending-migration-names-0029.txt | tr -d ' ')" = 1
  rg -x '0029_homepage_publications\.sql' /private/tmp/radar-approved-pending-migration-names-0029.txt
  sed -n '1,20p' /private/tmp/radar-approved-pending-migrations-0029.txt
  ```

  Only after that approval, rerun every gate and compare a fresh remote listing byte-for-byte with the approved snapshot before applying. A lost shell/session requires a new snapshot and approval:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh
  pnpm --filter @radar/worker exec wrangler d1 migrations list research-radar-db --remote > /private/tmp/radar-mutation-pending-migrations-0029.txt
  cmp /private/tmp/radar-approved-pending-migrations-0029.txt /private/tmp/radar-mutation-pending-migrations-0029.txt
  pnpm db:migrate:remote
  pnpm --filter @radar/worker exec wrangler d1 migrations list research-radar-db --remote > /private/tmp/radar-pending-migrations-after-0029.txt
  rg -F 'No migrations to apply!' /private/tmp/radar-pending-migrations-after-0029.txt
  ```

  Verify the private surface and both build manifests; the dev URL must report disabled and the domain list must be empty:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  pnpm --filter @radar/worker exec wrangler r2 bucket info radar-publications
  pnpm --filter @radar/worker exec wrangler r2 bucket dev-url get radar-publications
  pnpm --filter @radar/worker exec wrangler r2 bucket domain list radar-publications
  pnpm --filter @radar/worker exec wrangler deploy --dry-run --outdir /private/tmp/radar-publications-worker-dry-run

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  npx wrangler deploy --config wrangler.worker.toml --dry-run --outdir /private/tmp/homepage-publications-worker-dry-run
  rg -n 'PUBLICATIONS|HOMEPAGE_PUBLICATIONS|radar-publications' /Users/taejun-yun/Documents/Codex/Radar_data/worker/wrangler.jsonc wrangler.worker.toml
  ```

  Expected: Radar `PUBLICATIONS` and homepage `HOMEPAGE_PUBLICATIONS` both name exactly `radar-publications`; no other public binding or domain exists.

- [ ] **Step 3: Stage APIs through the pre-cutover release mode.**

  This step is fresh-only. Require `rollout-entry` to still be `FRESH_PRE_CUTOVER`, the checked-in manifest to remain `pre_cutover` with its explicit empty seed, and save/show strict `plan --json` before any write. Any other entry must follow the mandatory router instead of running this step. Obtain deploy approval. Deploy Radar backend, then run the one official Homepage deploy path: it builds UI `false`, deploys the Worker with reactions `true`, and deploys the compatible legacy Pages UI. Do not use an ad-hoc CLI override.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
  node scripts/current-research-release.mjs plan --json > /private/tmp/current-research-pre-cutover-plan.json
  bash scripts/verify-git-default-head.sh

  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --exit-code
  git diff --exit-code -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json
  test -z "$(git ls-files --others --exclude-standard -- worker web shared package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)"
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh

  pnpm deploy

  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
  node scripts/current-research-release.mjs plan --json > /private/tmp/current-research-pre-cutover-plan.json
  bash scripts/verify-git-default-head.sh
  npm run deploy
  ```

  The script must pass the tested manifest/TOML/argv structural preflight and the exact-argv dry run before actual deploy; do not parse Wrangler's human output as a machine contract. Verify Radar health, Access-protected preview, existing Text page/reactions, and no private bucket metadata. A fresh rollout requires the current endpoint's controlled 404. A resumed pre-cutover run after Step 4 may already return 200; that is accepted only after independent payload verification, exact Radar ledger/session/hash resolution, and new resume approval below.

  Exercise the public CORS boundary with exact Origin headers. Allowed GET is 404 for fresh state or 200 for the narrowly verified resume, while allowed OPTIONS is always 204; all include `Vary: Origin`, and allowed responses echo `https://www.taejunyun.com`. Disallowed GET must return the same application status as allowed GET but omit `Access-Control-Allow-Origin`; disallowed OPTIONS is 403 and also omits it:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  CURRENT_API=https://taejunyun-reading-api.taejunyun.workers.dev/api/research/current
  ALLOWED_GET_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 15 --dump-header /private/tmp/current-allowed-get.headers --output /private/tmp/current-allowed-get.json --write-out '%{http_code}' --header 'Origin: https://www.taejunyun.com' --header 'Accept: application/json' "$CURRENT_API")"
  test "$ALLOWED_GET_CODE" = 404 || test "$ALLOWED_GET_CODE" = 200
  if test "$ALLOWED_GET_CODE" = 404; then rg -q '"error"\s*:\s*"current_research_not_published"' /private/tmp/current-allowed-get.json; fi
  if test "$ALLOWED_GET_CODE" = 200; then node scripts/verify-current-research-payload.mjs /private/tmp/current-allowed-get.json; fi
  rg -i '^access-control-allow-origin:\s*https://www\.taejunyun\.com\s*$' /private/tmp/current-allowed-get.headers
  rg -i '^vary:\s*Origin\s*$' /private/tmp/current-allowed-get.headers
  ALLOWED_OPTIONS_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 15 --request OPTIONS --dump-header /private/tmp/current-allowed-options.headers --output /dev/null --write-out '%{http_code}' --header 'Origin: https://www.taejunyun.com' "$CURRENT_API")"
  test "$ALLOWED_OPTIONS_CODE" = 204
  rg -i '^access-control-allow-origin:\s*https://www\.taejunyun\.com\s*$' /private/tmp/current-allowed-options.headers
  rg -i '^vary:\s*Origin\s*$' /private/tmp/current-allowed-options.headers
  DISALLOWED_GET_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 15 --dump-header /private/tmp/current-disallowed-get.headers --output /dev/null --write-out '%{http_code}' --header 'Origin: https://invalid.example' "$CURRENT_API")"
  test "$DISALLOWED_GET_CODE" = "$ALLOWED_GET_CODE"
  test -z "$(rg -i '^access-control-allow-origin:' /private/tmp/current-disallowed-get.headers || true)"
  rg -i '^vary:\s*Origin\s*$' /private/tmp/current-disallowed-get.headers
  DISALLOWED_OPTIONS_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 15 --request OPTIONS --dump-header /private/tmp/current-disallowed-options.headers --output /dev/null --write-out '%{http_code}' --header 'Origin: https://invalid.example' "$CURRENT_API")"
  test "$DISALLOWED_OPTIONS_CODE" = 403
  test -z "$(rg -i '^access-control-allow-origin:' /private/tmp/current-disallowed-options.headers || true)"
  rg -i '^vary:\s*Origin\s*$' /private/tmp/current-disallowed-options.headers
  ```

- [ ] **Step 4: Publish one approved Distill and validate the payload.**

  In fresh 404 state, open preview but do **not** confirm it. Present the exact `sessionId`, `distilledAt`, projected content, excluded-material count, and `contentHash` to the user, then pause for explicit publication approval. Only after that approval may the executor press `공개 반영` or issue the equivalent POST.

  In resumed 200 state, do not demand 404 or publish again. Independently validate the saved response, resolve its exact publication ID/hash/session from Radar status and ledger, and compare it with the last durable/current approved candidate. Present all values and the remaining rollout actions, then obtain new explicit resume approval. A mismatch or unresolvable ledger stops; a match proceeds without another publication mutation.

  Save GET `/api/research/current` to `/private/tmp/current-research-live.json` and run `node scripts/verify-current-research-payload.mjs /private/tmp/current-research-live.json`. Confirm the exact allowlist, `EXPLORING`, no Critic/Counter/raw IDs, and independently recomputed `{distilledAt,content}` hash. Failed-update preservation is proven only by Task 7's automated fault tests; do not induce a production failure.

- [ ] **Step 5: Capture the final live legacy seed immediately before cutover.**

  Re-run the mandatory `rollout-entry` router before this step. `FRESH_PRE_CUTOVER` follows the preliminary flow below. `PREPARED_RESUME` uses the dedicated materialization lane below and skips preliminary capture plus `prepare-cutover`. `BASELINED_INCOMPLETE_RESUME` skips this entire step and enters Task 20 Step 6 common setup. `COMPLETED_RESUME` skips to the completed deploy/restoration path. Stop on every other combination; never infer the original workflow state from its current disabled state.

  Durable provenance records state, not user consent. On every PREPARED, BASELINED, or uncertain completed resume in a new executor/session, materialize the stored values, inspect the remote default-branch commit plus live Worker `200/410` and current Pages mode, present the remaining `gh`/push/deploy mutations to the user, and obtain a new explicit resume approval. No stored phase automatically authorizes another external write.

  Immediately after classification, reconcile local Git state to a durable checkpoint. Compare local manifest/seed, index, HEAD, configured upstream, and remote default branch. A PREPARED interruption may affect only `config/current-research-release.json` and/or a not-yet-trusted generated `src/data/readingLegacyCuration.mjs`; BASELINED/post-C interruption may affect only those same two paths, staged or unstaged. The dedicated lanes below distinguish seed A from post-C by the immutable digest, validate the exact phase, and never deploy an uncommitted candidate. For post-C state, rerun C/D or regenerate them if temporary evidence is gone, run `verify-cutover-transition` and the full tests, then obtain a new explicit commit/push approval. Commit with the matching Step 5/6 message and push before any further remote **write**. Any other diff stops for review.

  In the fresh lane, require the **entire Homepage tree** clean—`public/`, root HTML/Vite config, and every other Pages input are included. The currently observed `public/sitemap.xml` modification therefore blocks production until the user resolves it; never discard or silently include it. A PREPARED recovery may contain only its manifest and/or the generated seed from a crash between adjacent local commands; its dedicated block below checks that exact allowlist, commits only the validated PREPARED manifest first, and regenerates rather than trusts the seed. The BASELINED/post-C lane uses Step 6's separate two-file diff allowlist. With the approved remote read, derive the current branch's configured remote/merge ref, fetch it, use a fresh `ls-remote --symref` result to prove that merge ref is still the remote default, then require local HEAD, fetched upstream, and fresh remote-default SHA all equal:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  CURRENT_BRANCH="$(git branch --show-current)"
  test -n "$CURRENT_BRANCH"
  UPSTREAM_REMOTE="$(git config --get "branch.${CURRENT_BRANCH}.remote")"
  UPSTREAM_MERGE_REF="$(git config --get "branch.${CURRENT_BRANCH}.merge")"
  test -n "$UPSTREAM_REMOTE"
  test -n "$UPSTREAM_MERGE_REF"
  git fetch --prune "$UPSTREAM_REMOTE"
  git ls-remote --symref "$UPSTREAM_REMOTE" HEAD > /private/tmp/homepage-remote-head.symref
  test "$(awk '$1 == "ref:" && $3 == "HEAD" { count++ } END { print count + 0 }' /private/tmp/homepage-remote-head.symref)" = 1
  REMOTE_DEFAULT_REF="$(awk '$1 == "ref:" && $3 == "HEAD" { print $2 }' /private/tmp/homepage-remote-head.symref)"
  test -n "$REMOTE_DEFAULT_REF"
  test "$UPSTREAM_MERGE_REF" = "$REMOTE_DEFAULT_REF"
  git ls-remote "$UPSTREAM_REMOTE" "$REMOTE_DEFAULT_REF" > /private/tmp/homepage-remote-default.sha
  test "$(wc -l < /private/tmp/homepage-remote-default.sha | tr -d ' ')" = 1
  REMOTE_DEFAULT_SHA="$(awk '{ print $1 }' /private/tmp/homepage-remote-default.sha)"
  test "$(git rev-parse HEAD)" = "$(git rev-parse '@{upstream}')"
  test "$(git rev-parse HEAD)" = "$REMOTE_DEFAULT_SHA"
  ```

  `FRESH_PRE_CUTOVER` only: this production read requires explicit approval. Start with a **read-only preliminary capture**; do not modify the checked-in seed or manifest yet. A PREPARED resume skips to its dedicated block below because ephemeral preview files are never treated as durable evidence. Query due/open batches into a file. If `dueCount > 0`, show that result, explicitly acknowledge that the existing GET has a finalization side effect, and obtain separate approval before calling it once. Rerun the query and use the tested pre-cutoff assertion; stop unless `dueCount` is then zero:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT COALESCE(SUM(CASE WHEN finalized_at IS NULL AND cooldown_end_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END), 0) AS dueCount, COALESCE(SUM(CASE WHEN finalized_at IS NULL THEN 1 ELSE 0 END), 0) AS openBatchCount FROM reading_batches" > /private/tmp/reading-batch-preflight-preview.json
  ```

  Only after the separate side-effect approval when that file reports `dueCount > 0`, run this isolated mutation and overwrite the preflight with a fresh read:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 --header 'Accept: application/json' --output /private/tmp/taejunyun-finalized-reading-response.json https://taejunyun-reading-api.taejunyun.workers.dev/api/reading
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT COALESCE(SUM(CASE WHEN finalized_at IS NULL AND cooldown_end_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END), 0) AS dueCount, COALESCE(SUM(CASE WHEN finalized_at IS NULL THEN 1 ELSE 0 END), 0) AS openBatchCount FROM reading_batches" > /private/tmp/reading-batch-preflight-preview.json
  ```

  In both branches, enforce the final read:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node scripts/current-research-release.mjs assert-zero-due --input /private/tmp/reading-batch-preflight-preview.json
  ```

  Skip the conditional GET when the first query already reports zero. Non-due open batches are not yet curated and are intentionally excluded from the legacy seed; record their exact count, leave their D1 rows for rollback, and rely on the false reaction guard to prevent later finalization. They may become chronologically due after cutoff while remaining intentionally unfinalized, so `dueCount === 0` is never a post-cutoff invariant.

  Capture the exact curated set twice into temporary files, normalize both with the same preliminary KST date, and require byte identity without writing the repository. Also inspect the workflow state and active runs using commands supported by `gh 2.95.0`:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  PREVIEW_CAPTURE_A=/private/tmp/taejunyun-live-curated-preview-a.json
  PREVIEW_CAPTURE_B=/private/tmp/taejunyun-live-curated-preview-b.json
  PREVIEW_NORMALIZED_A=/private/tmp/readingLegacyCuration-preview-a.mjs
  PREVIEW_NORMALIZED_B=/private/tmp/readingLegacyCuration-preview-b.mjs
  TZ=Asia/Seoul date +%F > /private/tmp/taejunyun-legacy-preview-date.txt
  PREVIEW_CUTOVER_DATE="$(tr -d '\n' < /private/tmp/taejunyun-legacy-preview-date.txt)"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$PREVIEW_CAPTURE_A"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$PREVIEW_CAPTURE_B"
  node scripts/export-reading-legacy-curation.mjs --input "$PREVIEW_CAPTURE_A" --output "$PREVIEW_NORMALIZED_A" --migration-date "$PREVIEW_CUTOVER_DATE"
  node scripts/export-reading-legacy-curation.mjs --input "$PREVIEW_CAPTURE_B" --output "$PREVIEW_NORMALIZED_B" --migration-date "$PREVIEW_CUTOVER_DATE"
  cmp "$PREVIEW_NORMALIZED_A" "$PREVIEW_NORMALIZED_B"
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/weekly-reading-preview-workflow-state.txt
  test "$(wc -l < /private/tmp/weekly-reading-preview-workflow-state.txt | tr -d ' ')" = 1
  rg -x 'active|disabled_manually' /private/tmp/weekly-reading-preview-workflow-state.txt
  sed -n '1p' /private/tmp/weekly-reading-preview-workflow-state.txt
  : > /private/tmp/weekly-reading-preview-active-runs.tsv
  for RUN_STATUS in queued in_progress waiting requested pending; do
    gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/weekly-reading-preview-active-runs.tsv
  done
  sed -n '1,5p' /private/tmp/weekly-reading-preview-active-runs.tsv
  ```

  In the fresh lane, present the preliminary A/B row count, mappings, checksums, KST date, non-due open-batch count, workflow state/active runs, and the exact mutation plan. Pause for explicit cutover approval. It must cover committing/pushing the PREPARED recovery record, disabling the workflow, waiting for all active runs, an authoritative recapture, pushing the BASELINED initial manifest commit, both Step 6 deploys, pushing the completed manifest, and restoring the prior workflow state. Cancellation of any listed run is **not** implied: prefer waiting; if cancellation is needed, show the exact run IDs and obtain a separate cancellation approval.

  Fresh lane only: after approval, record the prior state in the manifest **before disabling anything**. Commit and push this still-`pre_cutover` PREPARED record; verify the remote default branch contains it. No GitHub workflow mutation may occur until this recovery datum is durable:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(tr -d '\n' < /private/tmp/current-research-rollout-entry.txt)" = FRESH_PRE_CUTOVER
  test "$(node scripts/current-research-release.mjs rollout-entry)" = FRESH_PRE_CUTOVER
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  bash scripts/verify-git-default-head.sh
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  test "$(wc -l < /private/tmp/weekly-reading-workflow-state-before-cutover.txt | tr -d ' ')" = 1
  rg -x 'active|disabled_manually' /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  cmp /private/tmp/weekly-reading-preview-workflow-state.txt /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  node scripts/current-research-release.mjs prepare-cutover --workflow-state-file /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  node scripts/current-research-release.mjs plan
  git add config/current-research-release.json
  git commit --only config/current-research-release.json -m "260903: cutover 원상복구 기준 상태 기록"
  bash scripts/assert-exact-ahead-commit.sh "260903: cutover 원상복구 기준 상태 기록" config/current-research-release.json
  bash scripts/push-exact-default-head.sh
  ```

  PREPARED new-session lane only: never recapture the current workflow state into the manifest and never depend on a preliminary `/private/tmp` artifact. Materialize the immutable original state first; read the current workflow/runs only as live observations. Present those observations, the exact remaining mutations, and obtain a new explicit resume approval before disable or any other remote write. A workflow already disabled after an interrupted attempt is valid only because the stored original—not that current state—remains the restoration target:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(tr -d '\n' < /private/tmp/current-research-rollout-entry.txt)" = PREPARED_RESUME
  test "$(node scripts/current-research-release.mjs rollout-entry)" = PREPARED_RESUME
  test -z "$(git ls-files --others --exclude-standard)"
  git diff --check
  git diff --cached --check
  git diff --name-only > /private/tmp/current-research-prepared-unstaged-files.txt
  git diff --cached --name-only > /private/tmp/current-research-prepared-staged-files.txt
  sort -u /private/tmp/current-research-prepared-unstaged-files.txt /private/tmp/current-research-prepared-staged-files.txt > /private/tmp/current-research-prepared-changed-files.txt
  test -z "$(rg -v '^(config/current-research-release\.json|src/data/readingLegacyCuration\.mjs)$' /private/tmp/current-research-prepared-changed-files.txt || true)"
  bash scripts/verify-git-default-head.sh --allow-local-ahead
  PREPARED_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  test "$PREPARED_AHEAD" = 0 || test "$PREPARED_AHEAD" = 1
  if test "$PREPARED_AHEAD" = 1; then
    PREPARED_HEAD_SUBJECT="$(git log -1 --pretty=%s)"
    case "$PREPARED_HEAD_SUBJECT" in
      "260903: cutover 원상복구 기준 상태 기록"|"260903: 중단된 cutover 원상복구 기준 상태 확정") ;;
      *) exit 1 ;;
    esac
    bash scripts/assert-exact-ahead-commit.sh "$PREPARED_HEAD_SUBJECT" config/current-research-release.json
    git diff --exit-code -- config/current-research-release.json
    git diff --cached --exit-code -- config/current-research-release.json
  fi
  git rev-parse HEAD > /private/tmp/current-research-prepared-approved-head.txt
  git hash-object config/current-research-release.json > /private/tmp/current-research-prepared-approved-manifest-blob.txt
  git hash-object src/data/readingLegacyCuration.mjs > /private/tmp/current-research-prepared-approved-seed-blob.txt
  git diff -- config/current-research-release.json src/data/readingLegacyCuration.mjs
  git diff --cached -- config/current-research-release.json src/data/readingLegacyCuration.mjs
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  rg -x 'active|disabled_manually' /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/weekly-reading-workflow-state-on-resume.txt
  test "$(wc -l < /private/tmp/weekly-reading-workflow-state-on-resume.txt | tr -d ' ')" = 1
  rg -x 'active|disabled_manually' /private/tmp/weekly-reading-workflow-state-on-resume.txt
  : > /private/tmp/weekly-reading-active-runs-on-resume.tsv
  for RUN_STATUS in queued in_progress waiting requested pending; do
    gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/weekly-reading-active-runs-on-resume.tsv
  done
  ```

  After that resume approval, make the PREPARED record durable before disabling. If it was interrupted before its commit, commit only the manifest; never stage the candidate seed. A previously committed but unpushed PREPARED record is pushed by the same block. Then require exact local/upstream/remote-default equality:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(node scripts/current-research-release.mjs rollout-entry)" = PREPARED_RESUME
  test "$(git rev-parse HEAD)" = "$(tr -d '\n' < /private/tmp/current-research-prepared-approved-head.txt)"
  test "$(git hash-object config/current-research-release.json)" = "$(tr -d '\n' < /private/tmp/current-research-prepared-approved-manifest-blob.txt)"
  test "$(git hash-object src/data/readingLegacyCuration.mjs)" = "$(tr -d '\n' < /private/tmp/current-research-prepared-approved-seed-blob.txt)"
  if ! git diff --cached --quiet -- src/data/readingLegacyCuration.mjs; then git restore --staged -- src/data/readingLegacyCuration.mjs; fi
  if ! git diff --quiet -- config/current-research-release.json || ! git diff --cached --quiet -- config/current-research-release.json; then
    git add config/current-research-release.json
    git commit --only config/current-research-release.json -m "260903: 중단된 cutover 원상복구 기준 상태 확정"
  fi
  PREPARED_POST_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  case "$PREPARED_POST_AHEAD" in
    0)
      bash scripts/verify-git-default-head.sh
      ;;
    1)
      PREPARED_COMMIT_SUBJECT="$(git log -1 --pretty=%s)"
      case "$PREPARED_COMMIT_SUBJECT" in
        "260903: cutover 원상복구 기준 상태 기록"|"260903: 중단된 cutover 원상복구 기준 상태 확정") ;;
        *) exit 1 ;;
      esac
      bash scripts/assert-exact-ahead-commit.sh "$PREPARED_COMMIT_SUBJECT" config/current-research-release.json
      bash scripts/push-exact-default-head.sh
      ;;
    *) exit 1 ;;
  esac
  test "$(node scripts/current-research-release.mjs rollout-entry)" = PREPARED_RESUME
  ```

  If the user cancels while the durable phase is only PREPARED, do not leave a stale intent. With separate abort approval, materialize the stored original workflow state, restore and verify that exact state, generate an active-run listing successfully and require it empty, and explicitly discard only the already-shown generated seed diff if one exists. Then run `abort-cutover --observed-workflow-state-file <verified-state> --active-runs-file <empty-file>`, commit/push the cleared pre-cutover manifest, and stop; abort is unavailable after BASELINED. Never use this path for an unreviewed seed change.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(node scripts/current-research-release.mjs rollout-entry)" = PREPARED_RESUME
  test -z "$(git ls-files --others --exclude-standard)"
  git diff --check
  git diff --cached --check
  git diff --name-only > /private/tmp/cutover-abort-unstaged-files.txt
  git diff --cached --name-only > /private/tmp/cutover-abort-staged-files.txt
  sort -u /private/tmp/cutover-abort-unstaged-files.txt /private/tmp/cutover-abort-staged-files.txt > /private/tmp/cutover-abort-changed-files.txt
  test -z "$(rg -v '^(config/current-research-release\.json|src/data/readingLegacyCuration\.mjs)$' /private/tmp/cutover-abort-changed-files.txt || true)"
  bash scripts/verify-git-default-head.sh
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/cutover-abort-required-state.txt
  REQUIRED_WORKFLOW_STATE="$(tr -d '\n' < /private/tmp/cutover-abort-required-state.txt)"
  test "$REQUIRED_WORKFLOW_STATE" = active || test "$REQUIRED_WORKFLOW_STATE" = disabled_manually
  if test "$REQUIRED_WORKFLOW_STATE" = active; then gh workflow enable weekly-reading-deploy.yml; else gh workflow disable weekly-reading-deploy.yml; fi
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/cutover-abort-observed-state.txt
  test "$(wc -l < /private/tmp/cutover-abort-observed-state.txt | tr -d ' ')" = 1
  cmp /private/tmp/cutover-abort-required-state.txt /private/tmp/cutover-abort-observed-state.txt
  : > /private/tmp/cutover-abort-active-runs.tsv
  for RUN_STATUS in queued in_progress waiting requested pending; do
    gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/cutover-abort-active-runs.tsv
  done
  test ! -s /private/tmp/cutover-abort-active-runs.tsv
  test "$(node scripts/current-research-release.mjs rollout-entry)" = PREPARED_RESUME
  test -z "$(git ls-files --others --exclude-standard)"
  git diff --name-only > /private/tmp/cutover-abort-recheck-unstaged-files.txt
  git diff --cached --name-only > /private/tmp/cutover-abort-recheck-staged-files.txt
  sort -u /private/tmp/cutover-abort-recheck-unstaged-files.txt /private/tmp/cutover-abort-recheck-staged-files.txt > /private/tmp/cutover-abort-recheck-changed-files.txt
  test -z "$(rg -v '^(config/current-research-release\.json|src/data/readingLegacyCuration\.mjs)$' /private/tmp/cutover-abort-recheck-changed-files.txt || true)"
  if ! git diff --cached --quiet -- src/data/readingLegacyCuration.mjs; then git restore --staged -- src/data/readingLegacyCuration.mjs; fi
  if ! git diff --quiet -- src/data/readingLegacyCuration.mjs; then git restore --source=HEAD -- src/data/readingLegacyCuration.mjs; fi
  node scripts/current-research-release.mjs abort-cutover --observed-workflow-state-file /private/tmp/cutover-abort-observed-state.txt --active-runs-file /private/tmp/cutover-abort-active-runs.tsv
  node scripts/current-research-release.mjs plan
  git add config/current-research-release.json
  if ! git diff --cached --quiet -- config/current-research-release.json; then git commit --only config/current-research-release.json -m "260903: 취소된 cutover 준비 상태 해제"; fi
  bash scripts/assert-exact-ahead-commit.sh "260903: 취소된 cutover 준비 상태 해제" config/current-research-release.json
  bash scripts/push-exact-default-head.sh
  ```

  Now disable the workflow and require exactly one matching workflow in `disabled_manually` state. Then list active runs again. If the file is non-empty, stop and wait for every run to finish, or cancel only the specifically approved IDs; repeat the query until it is empty before any authoritative capture or `begin-cutover`:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  bash scripts/verify-git-default-head.sh
  gh workflow disable weekly-reading-deploy.yml
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/weekly-reading-workflow-state-disabled.txt
  test "$(wc -l < /private/tmp/weekly-reading-workflow-state-disabled.txt | tr -d ' ')" = 1
  rg -x 'disabled_manually' /private/tmp/weekly-reading-workflow-state-disabled.txt
  : > /private/tmp/weekly-reading-active-runs.tsv
  for RUN_STATUS in queued in_progress waiting requested pending; do
    gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/weekly-reading-active-runs.tsv
  done
  test ! -s /private/tmp/weekly-reading-active-runs.tsv
  ```

  With the workflow disabled and quiescent, rerun the due/open preflight:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT COALESCE(SUM(CASE WHEN finalized_at IS NULL AND cooldown_end_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END), 0) AS dueCount, COALESCE(SUM(CASE WHEN finalized_at IS NULL THEN 1 ELSE 0 END), 0) AS openBatchCount FROM reading_batches" > /private/tmp/reading-batch-preflight-authoritative.json
  ```

  Any newly due batch requires the same separate finalization approval; do not infer it from rollout approval. Only with that approval, run the isolated GET and immediately overwrite the authoritative preflight with a fresh query:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 --header 'Accept: application/json' --output /private/tmp/taejunyun-finalized-reading-response-authoritative.json https://taejunyun-reading-api.taejunyun.workers.dev/api/reading
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT COALESCE(SUM(CASE WHEN finalized_at IS NULL AND cooldown_end_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END), 0) AS dueCount, COALESCE(SUM(CASE WHEN finalized_at IS NULL THEN 1 ELSE 0 END), 0) AS openBatchCount FROM reading_batches" > /private/tmp/reading-batch-preflight-authoritative.json
  ```

  Skip that GET when the first authoritative read is already zero. In both branches assert the final file, then capture authoritative A/B plus the complete batch finalization state twice. Normalize both pairs and require A=B and batch-A=batch-B:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node scripts/current-research-release.mjs assert-zero-due --input /private/tmp/reading-batch-preflight-authoritative.json
  LEGACY_CAPTURE_A=/private/tmp/taejunyun-live-curated-a.json
  LEGACY_CAPTURE_B=/private/tmp/taejunyun-live-curated-b.json
  LEGACY_NORMALIZED_B=/private/tmp/readingLegacyCuration-b.mjs
  BATCH_RAW_A=/private/tmp/reading-batches-a.json
  BATCH_RAW_B=/private/tmp/reading-batches-b.json
  BATCH_SNAPSHOT_A=/private/tmp/reading-batches-a.canonical.json
  BATCH_SNAPSHOT_B=/private/tmp/reading-batches-b.canonical.json
  TZ=Asia/Seoul date +%F > /private/tmp/taejunyun-legacy-cutover-date.txt
  LEGACY_CUTOVER_DATE="$(tr -d '\n' < /private/tmp/taejunyun-legacy-cutover-date.txt)"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$LEGACY_CAPTURE_A"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT release_at AS releaseAt, cooldown_end_at AS cooldownEndAt, finalized_at AS finalizedAt FROM reading_batches ORDER BY release_at ASC" > "$BATCH_RAW_A"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$LEGACY_CAPTURE_B"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT release_at AS releaseAt, cooldown_end_at AS cooldownEndAt, finalized_at AS finalizedAt FROM reading_batches ORDER BY release_at ASC" > "$BATCH_RAW_B"
  node scripts/export-reading-legacy-curation.mjs --input "$LEGACY_CAPTURE_A" --output src/data/readingLegacyCuration.mjs --migration-date "$LEGACY_CUTOVER_DATE"
  node scripts/export-reading-legacy-curation.mjs --input "$LEGACY_CAPTURE_B" --output "$LEGACY_NORMALIZED_B" --migration-date "$LEGACY_CUTOVER_DATE"
  node scripts/current-research-release.mjs normalize-batch-state --input "$BATCH_RAW_A" --output "$BATCH_SNAPSHOT_A"
  node scripts/current-research-release.mjs normalize-batch-state --input "$BATCH_RAW_B" --output "$BATCH_SNAPSHOT_B"
  cmp src/data/readingLegacyCuration.mjs "$LEGACY_NORMALIZED_B"
  cmp "$BATCH_SNAPSHOT_A" "$BATCH_SNAPSHOT_B"
  node --test tests/reading-legacy-curation.test.mjs tests/reading-catalog.test.mjs tests/current-research-view.test.mjs
  git diff --check -- src/data/readingLegacyCuration.mjs
  shasum -a 256 src/data/readingLegacyCuration.mjs | awk '{print $1}' > /private/tmp/readingLegacyCuration-a.sha256
  git rev-parse HEAD > /private/tmp/current-research-authoritative-approved-parent.txt
  shasum -a 256 /private/tmp/weekly-reading-workflow-state-before-cutover.txt | awk '{print $1}' > /private/tmp/current-research-authoritative-approved-workflow.sha256
  shasum -a 256 /private/tmp/taejunyun-legacy-cutover-date.txt | awk '{print $1}' > /private/tmp/current-research-authoritative-approved-date.sha256
  shasum -a 256 /private/tmp/reading-batches-a.canonical.json | awk '{print $1}' > /private/tmp/current-research-authoritative-approved-batch.sha256
  ```

  In the fresh lane, compare the authoritative output and batch/open counts with the preliminary report. If the KST date, row count, mappings, checksums, or batch/open state changed, stop, present the exact drift, and obtain renewed approval over the authoritative values. In the PREPARED new-session lane, no preliminary artifact is valid: always present the authoritative A/B row count, complete mappings, checksums, persisted KST date, open/due result, and canonical batch checksum as a new baseline, then obtain explicit approval over those exact values. Only with unchanged fresh values, renewed drift approval, or that PREPARED authoritative-baseline approval may the executor run `begin-cutover`, commit, and push through the already verified upstream:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(git rev-parse HEAD)" = "$(tr -d '\n' < /private/tmp/current-research-authoritative-approved-parent.txt)"
  test "$(shasum -a 256 /private/tmp/weekly-reading-workflow-state-before-cutover.txt | awk '{print $1}')" = "$(tr -d '\n' < /private/tmp/current-research-authoritative-approved-workflow.sha256)"
  test "$(shasum -a 256 /private/tmp/taejunyun-legacy-cutover-date.txt | awk '{print $1}')" = "$(tr -d '\n' < /private/tmp/current-research-authoritative-approved-date.sha256)"
  test "$(shasum -a 256 /private/tmp/reading-batches-a.canonical.json | awk '{print $1}')" = "$(tr -d '\n' < /private/tmp/current-research-authoritative-approved-batch.sha256)"
  test "$(shasum -a 256 src/data/readingLegacyCuration.mjs | awk '{print $1}')" = "$(tr -d '\n' < /private/tmp/readingLegacyCuration-a.sha256)"
  node scripts/current-research-release.mjs begin-cutover --migration-date-file /private/tmp/taejunyun-legacy-cutover-date.txt --seed-sha256-file /private/tmp/readingLegacyCuration-a.sha256 --batch-state-file /private/tmp/reading-batches-a.canonical.json
  node scripts/current-research-release.mjs plan
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/cutover-check-workflow-state.txt --migration-date-output /private/tmp/cutover-check-date.txt --seed-sha256-output /private/tmp/cutover-check-seed.sha256 --batch-state-output /private/tmp/cutover-check-batch-a.json
  cmp /private/tmp/weekly-reading-workflow-state-before-cutover.txt /private/tmp/cutover-check-workflow-state.txt
  cmp /private/tmp/taejunyun-legacy-cutover-date.txt /private/tmp/cutover-check-date.txt
  cmp /private/tmp/readingLegacyCuration-a.sha256 /private/tmp/cutover-check-seed.sha256
  cmp /private/tmp/reading-batches-a.canonical.json /private/tmp/cutover-check-batch-a.json
  git add src/data/readingLegacyCuration.mjs config/current-research-release.json
  git commit --only src/data/readingLegacyCuration.mjs config/current-research-release.json -m "260903: 전환 직전 seed와 초기 cutover 상태 확정"
  bash scripts/assert-exact-ahead-commit.sh "260903: 전환 직전 seed와 초기 cutover 상태 확정" config/current-research-release.json src/data/readingLegacyCuration.mjs
  bash scripts/push-exact-default-head.sh
  ```

  The exporter output must show every live row mapped by normalized URL or ID and the same row/count/checksums for authoritative A and B. `begin-cutover` must atomically copy the seed's `CAPTURED` metadata into the manifest, switch it to `current_research`, and leave `initialCutoverComplete:false`. Do not continue on any invalid row, checksum or batch-state difference, unmapped row, retained empty-seed comment, manifest mismatch, or active workflow run.

- [ ] **Step 6: Cut over, freeze curation, and close the capture race.**

  With the immediately preceding rollout approval—or a new explicit resume approval—reconstruct every baseline from the versioned manifest, not ambient temp files. Common setup materializes the migration date, batch A, original workflow state, and seed-A digest **before** choosing a lane; it also proves the active Worker mode without a side-effecting reading GET. There are three explicit recovery lanes; never mix them:

  - **Clean BASELINED/A lane:** `BASELINED_INCOMPLETE_RESUME`, no staged/unstaged/untracked file, and the checked-in seed hash equals immutable baseline A. Active Worker `true` means a fresh cutover; `false` means a fresh-host retry after Worker cutoff. Both values run the same strict manifest deploy path, Pages-true → Worker-false after the successful build; no retry can enable reactions.
  - **Dirty BASELINED/A checkpoint lane:** interruption after `begin-cutover` but before its commit may leave exactly the manifest and seed A staged, unstaged, or split between both. Require `BASELINED_INCOMPLETE_RESUME`, the union of staged+unstaged paths to be exactly those two files, current seed hash to equal immutable A, and strict `plan --json` to pass. With renewed approval, stage/commit those exact current files, push, prove remote-default equality, then use the same first deploy as the clean lane. Never interpret this state as post-C merely because it is dirty.
  - **Validated local post-C lane:** the union of staged+unstaged changes contains only `src/data/readingLegacyCuration.mjs` and optionally `config/current-research-release.json`, with no untracked files, produced after a previously proven Worker cutoff. A BASELINED-incomplete candidate must include a seed whose hash differs from A; a locally completed candidate may contain either allowed file because C can legitimately equal A. Do **not** deploy this uncommitted candidate. The durable classifier must report `BASELINED_INCOMPLETE_RESUME` or the narrowly interrupted `COMPLETED_RESUME`, the active Worker parser must report exactly `false`, and a new resume approval must cover both index and worktree diffs. Continue directly with the bounded 410 drain and regenerate C/D from live D1, so neither staged bytes nor temporary files are trusted. Run `verify-cutover-transition`, all listed tests, and the finalization block; commit/push the validated C seed and completed manifest before the completed-state deploy.

  The common block below writes the selected allowlisted lane to a temporary file only after every check. An unknown/split live state, a missing candidate seed, any other diff, or inability to regenerate C/D stops for manual review.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node scripts/current-research-release.mjs rollout-entry > /private/tmp/current-research-step6-entry.txt
  STEP6_ENTRY="$(tr -d '\n' < /private/tmp/current-research-step6-entry.txt)"
  test "$STEP6_ENTRY" = BASELINED_INCOMPLETE_RESUME || test "$STEP6_ENTRY" = COMPLETED_RESUME
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/weekly-reading-workflow-state-before-cutover.txt --migration-date-output /private/tmp/taejunyun-legacy-cutover-date.txt --seed-sha256-output /private/tmp/readingLegacyCuration-a.sha256 --batch-state-output /private/tmp/reading-batches-a.canonical.json
  rg -x 'active|disabled_manually' /private/tmp/weekly-reading-workflow-state-before-cutover.txt
  rg -x '[0-9]{4}-[0-9]{2}-[0-9]{2}' /private/tmp/taejunyun-legacy-cutover-date.txt
  test -s /private/tmp/reading-batches-a.canonical.json
  test -f src/data/readingLegacyCuration.mjs
  test -f config/current-research-release.json
  test -z "$(git ls-files --others --exclude-standard)"
  git diff --check
  git diff --cached --check
  bash scripts/verify-git-default-head.sh --allow-local-ahead
  STEP6_INITIAL_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  test "$STEP6_INITIAL_AHEAD" = 0 || test "$STEP6_INITIAL_AHEAD" = 1
  git diff --name-only > /private/tmp/current-research-step6-unstaged-files.txt
  git diff --cached --name-only > /private/tmp/current-research-step6-staged-files.txt
  sort -u /private/tmp/current-research-step6-unstaged-files.txt /private/tmp/current-research-step6-staged-files.txt > /private/tmp/current-research-step6-changed-files.txt
  shasum -a 256 src/data/readingLegacyCuration.mjs | awk '{print $1}' > /private/tmp/readingLegacyCuration-current.sha256
  SEED_MATCHES_A=false
  if cmp /private/tmp/readingLegacyCuration-a.sha256 /private/tmp/readingLegacyCuration-current.sha256; then SEED_MATCHES_A=true; fi
  if test ! -s /private/tmp/current-research-step6-changed-files.txt; then
    test "$STEP6_ENTRY" = BASELINED_INCOMPLETE_RESUME
    test "$SEED_MATCHES_A" = true
    printf '%s\n' CLEAN_BASELINED_A > /private/tmp/current-research-step6-lane.txt
  else
    test -z "$(rg -v '^(config/current-research-release\.json|src/data/readingLegacyCuration\.mjs)$' /private/tmp/current-research-step6-changed-files.txt || true)"
    if test "$STEP6_ENTRY" = BASELINED_INCOMPLETE_RESUME && test "$SEED_MATCHES_A" = true; then
      test "$(wc -l < /private/tmp/current-research-step6-changed-files.txt | tr -d ' ')" = 2
      rg -x 'config/current-research-release\.json' /private/tmp/current-research-step6-changed-files.txt
      rg -x 'src/data/readingLegacyCuration\.mjs' /private/tmp/current-research-step6-changed-files.txt
      test "$STEP6_INITIAL_AHEAD" = 0
      node scripts/current-research-release.mjs plan --json > /private/tmp/current-research-dirty-baseline-plan.json
      git add config/current-research-release.json src/data/readingLegacyCuration.mjs
      git diff --cached --check
      git commit --only config/current-research-release.json src/data/readingLegacyCuration.mjs -m "260903: 전환 직전 seed와 초기 cutover 상태 확정"
      printf '%s\n' DIRTY_BASELINED_A > /private/tmp/current-research-step6-lane.txt
    else
      if test "$STEP6_ENTRY" = BASELINED_INCOMPLETE_RESUME; then
        test "$SEED_MATCHES_A" = false
        rg -x 'src/data/readingLegacyCuration\.mjs' /private/tmp/current-research-step6-changed-files.txt
      fi
      printf '%s\n' VALIDATED_LOCAL_POST_C > /private/tmp/current-research-step6-lane.txt
    fi
  fi
  STEP6_LANE="$(tr -d '\n' < /private/tmp/current-research-step6-lane.txt)"
  case "$STEP6_LANE" in
    CLEAN_BASELINED_A)
      if test "$STEP6_INITIAL_AHEAD" = 0; then
        bash scripts/verify-git-default-head.sh
      else
        bash scripts/assert-exact-ahead-commit.sh "260903: 전환 직전 seed와 초기 cutover 상태 확정" config/current-research-release.json src/data/readingLegacyCuration.mjs
        bash scripts/push-exact-default-head.sh
      fi
      ;;
    DIRTY_BASELINED_A)
      bash scripts/assert-exact-ahead-commit.sh "260903: 전환 직전 seed와 초기 cutover 상태 확정" config/current-research-release.json src/data/readingLegacyCuration.mjs
      bash scripts/push-exact-default-head.sh
      ;;
    VALIDATED_LOCAL_POST_C)
      test "$STEP6_INITIAL_AHEAD" = 0
      bash scripts/verify-git-default-head.sh
      ;;
    *) exit 1 ;;
  esac
  npx wrangler deployments status --config wrangler.worker.toml --name taejunyun-reading-api --json > /private/tmp/reading-worker-deployment-status.json
  ACTIVE_WORKER_VERSION="$(node scripts/current-research-release.mjs active-worker-version --input /private/tmp/reading-worker-deployment-status.json)"
  npx wrangler versions view "$ACTIVE_WORKER_VERSION" --config wrangler.worker.toml --name taejunyun-reading-api --json > /private/tmp/reading-worker-version.json
  ACTIVE_REACTION_MODE="$(node scripts/current-research-release.mjs read-worker-reaction-mode --input /private/tmp/reading-worker-version.json)"
  test "$ACTIVE_REACTION_MODE" = true || test "$ACTIVE_REACTION_MODE" = false
  case "$STEP6_LANE" in
    CLEAN_BASELINED_A|DIRTY_BASELINED_A)
      node scripts/current-research-release.mjs plan --json > /private/tmp/current-research-initial-cutover-plan.json
      npm run deploy
      ;;
    VALIDATED_LOCAL_POST_C)
      test "$ACTIVE_REACTION_MODE" = false
      ;;
    *) exit 1 ;;
  esac
  ```

  Do not capture immediately. First require the public reaction endpoint to return a body-safe 410 three times and allow a bounded drain for requests accepted by the old Worker. Each probe has a 5-second connect and 8-second total timeout; a timeout is a hard failure, never counted as 410. Three probes plus three 10-second waits therefore remain at or below 54 seconds. This is a verification/drain window, not a claim that one 410 cancels already in-flight work:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  for attempt in 1 2 3; do
    HTTP_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 8 --output "/private/tmp/reactions-disabled-${attempt}.json" --write-out '%{http_code}' --header 'Accept: application/json' https://taejunyun-reading-api.taejunyun.workers.dev/api/reading)"
    test "$HTTP_CODE" = 410
    rg -q '"error"\s*:\s*"reactions_disabled"' "/private/tmp/reactions-disabled-${attempt}.json"
    sleep 10
  done
  ```

  After the drain, query the same exact curated set and complete batch-finalization state twice as C and D. Normalize both pairs, reuse the original persisted KST date for the curated seed, and require curated C=D plus batch C=D before changing release state. Do **not** assert `dueCount === 0` here: a deliberately retained open batch may become due by wall-clock time after cutoff while correctly remaining unfinalized.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  LEGACY_CAPTURE_C=/private/tmp/taejunyun-live-curated-c.json
  LEGACY_CAPTURE_D=/private/tmp/taejunyun-live-curated-d.json
  LEGACY_NORMALIZED_D=/private/tmp/readingLegacyCuration-d.mjs
  BATCH_RAW_C=/private/tmp/reading-batches-c.json
  BATCH_RAW_D=/private/tmp/reading-batches-d.json
  BATCH_SNAPSHOT_C=/private/tmp/reading-batches-c.canonical.json
  BATCH_SNAPSHOT_D=/private/tmp/reading-batches-d.canonical.json
  LEGACY_CUTOVER_DATE="$(tr -d '\n' < /private/tmp/taejunyun-legacy-cutover-date.txt)"
  rg -x '[0-9]{4}-[0-9]{2}-[0-9]{2}' /private/tmp/taejunyun-legacy-cutover-date.txt
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$LEGACY_CAPTURE_C"
  C_FREEZE_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /private/tmp/reactions-disabled-after-c.json --write-out '%{http_code}' --header 'Accept: application/json' https://taejunyun-reading-api.taejunyun.workers.dev/api/reading)"
  test "$C_FREEZE_CODE" = 410
  rg -q '"error"\s*:\s*"reactions_disabled"' /private/tmp/reactions-disabled-after-c.json
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT release_at AS releaseAt, cooldown_end_at AS cooldownEndAt, finalized_at AS finalizedAt FROM reading_batches ORDER BY release_at ASC" > "$BATCH_RAW_C"
  node scripts/current-research-release.mjs normalize-batch-state --input "$BATCH_RAW_C" --output "$BATCH_SNAPSHOT_C"
  sleep 20
  D_FREEZE_CODE="$(curl --silent --show-error --connect-timeout 5 --max-time 10 --output /private/tmp/reactions-disabled-before-d.json --write-out '%{http_code}' --header 'Accept: application/json' https://taejunyun-reading-api.taejunyun.workers.dev/api/reading)"
  test "$D_FREEZE_CODE" = 410
  rg -q '"error"\s*:\s*"reactions_disabled"' /private/tmp/reactions-disabled-before-d.json
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT a.article_id AS id, a.title, a.source, COALESCE(a.author, '') AS author, a.url, a.summary, a.tags_json AS tagsJson, a.published_at AS publishedAt, a.published_at_source AS publishedAtSource, a.crawled_at AS crawledAt, s.curated_at AS curatedAt FROM reading_articles AS a INNER JOIN article_stats AS s ON s.article_id = a.article_id WHERE s.curated_at IS NOT NULL ORDER BY s.curated_at DESC, a.article_id ASC" > "$LEGACY_CAPTURE_D"
  npx wrangler d1 execute taejunyun-reading-stats --remote --json --config wrangler.worker.toml --command "SELECT release_at AS releaseAt, cooldown_end_at AS cooldownEndAt, finalized_at AS finalizedAt FROM reading_batches ORDER BY release_at ASC" > "$BATCH_RAW_D"
  node scripts/export-reading-legacy-curation.mjs --input "$LEGACY_CAPTURE_C" --output src/data/readingLegacyCuration.mjs --migration-date "$LEGACY_CUTOVER_DATE"
  node scripts/export-reading-legacy-curation.mjs --input "$LEGACY_CAPTURE_D" --output "$LEGACY_NORMALIZED_D" --migration-date "$LEGACY_CUTOVER_DATE"
  node scripts/current-research-release.mjs normalize-batch-state --input "$BATCH_RAW_D" --output "$BATCH_SNAPSHOT_D"
  cmp src/data/readingLegacyCuration.mjs "$LEGACY_NORMALIZED_D"
  cmp "$BATCH_SNAPSHOT_C" "$BATCH_SNAPSHOT_D"
  shasum -a 256 src/data/readingLegacyCuration.mjs | awk '{print $1}' > /private/tmp/readingLegacyCuration-c.sha256
  node scripts/current-research-release.mjs verify-cutover-transition --after-seed src/data/readingLegacyCuration.mjs --after-batch-state "$BATCH_SNAPSHOT_C" --json-output /private/tmp/current-research-cutover-transition.json
  node --test tests/reading-legacy-curation.test.mjs tests/reading-catalog.test.mjs tests/current-research-view.test.mjs
  node scripts/current-research-release.mjs refresh-capture
  node scripts/current-research-release.mjs plan
  node --test tests/reading-legacy-curation.test.mjs tests/current-research-release.test.mjs tests/reading-catalog.test.mjs tests/current-research-view.test.mjs
  git diff --check -- src/data/readingLegacyCuration.mjs config/current-research-release.json
  ```

  Before C/D export, require the persisted value to match `^\d{4}-\d{2}-\d{2}$`; the exporter enforces the same check. Never recompute this date after midnight. The exporter reports for C and D must have identical row counts, URL/ID mappings, and checksums, and canonical batch snapshots must be byte-identical. Repeated 410 plus those two stable snapshots—not post-cutoff `dueCount`—is the freeze invariant.

  The deterministic transition report, not a permissive `cmp`, decides A→C. A seed difference is allowed only when immutable provenance proves corresponding `finalizedAt:null` → timestamp transitions and accounts for every added full-row-hashed seed entry; a new/aging but still-unfinalized batch alone cannot justify it. Any baseline deletion/edit, finalized timestamp rewrite, unaccounted row, or C/D difference stops rollout. Inspect and record the report. At this point `refresh-capture` may be uncommitted, but `initialCutoverComplete` must still be false. Only after every verifier and test above passes, call `complete-cutover`, validate the final plan, and immediately commit/push C plus the completed manifest in one fail-fast block:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  node scripts/current-research-release.mjs complete-cutover
  node scripts/current-research-release.mjs plan
  git diff --check -- src/data/readingLegacyCuration.mjs config/current-research-release.json
  git add src/data/readingLegacyCuration.mjs config/current-research-release.json
  if ! git diff --cached --quiet -- src/data/readingLegacyCuration.mjs config/current-research-release.json; then
    git commit --only src/data/readingLegacyCuration.mjs config/current-research-release.json -m "260903: cutoff 후 seed와 완료 release 상태 확정"
  fi
  test "$(node scripts/current-research-release.mjs rollout-entry)" = COMPLETED_RESUME
  bash scripts/verify-git-default-head.sh --allow-local-ahead
  COMPLETE_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  case "$COMPLETE_AHEAD" in
    0)
      bash scripts/verify-git-default-head.sh
      ;;
    1)
      COMPLETE_CHANGED_PATHS="$(git diff-tree --no-commit-id --name-only -r HEAD | LC_ALL=C sort)"
      if test "$COMPLETE_CHANGED_PATHS" = "config/current-research-release.json"; then
        bash scripts/assert-exact-ahead-commit.sh "260903: cutoff 후 seed와 완료 release 상태 확정" config/current-research-release.json
      else
        EXPECTED_COMPLETE_PATHS="$(printf '%s\n' config/current-research-release.json src/data/readingLegacyCuration.mjs | LC_ALL=C sort)"
        test "$COMPLETE_CHANGED_PATHS" = "$EXPECTED_COMPLETE_PATHS"
        bash scripts/assert-exact-ahead-commit.sh "260903: cutoff 후 seed와 완료 release 상태 확정" config/current-research-release.json src/data/readingLegacyCuration.mjs
      fi
      bash scripts/push-exact-default-head.sh
      ;;
    *) exit 1 ;;
  esac
  ```

  Run the official deploy path once more. This is also the idempotent entry for an uncertain completed resume after new explicit approval. First rematerialize the stored workflow state, require the checked-in C seed to match the completed manifest, and inspect the active Worker mode through the same read-only JSON path. Completed current-research mode never enables reactions: regardless of whether inspected live mode is already `false` or has externally drifted to `true`, its tested action order is Worker-false → Pages-true. Any unknown/split deployment stops.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(node scripts/current-research-release.mjs rollout-entry)" = COMPLETED_RESUME
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  bash scripts/verify-git-default-head.sh --allow-local-ahead
  COMPLETED_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  case "$COMPLETED_AHEAD" in
    0)
      bash scripts/verify-git-default-head.sh
      ;;
    1)
      COMPLETE_CHANGED_PATHS="$(git diff-tree --no-commit-id --name-only -r HEAD | LC_ALL=C sort)"
      if test "$COMPLETE_CHANGED_PATHS" = "config/current-research-release.json"; then
        bash scripts/assert-exact-ahead-commit.sh "260903: cutoff 후 seed와 완료 release 상태 확정" config/current-research-release.json
      else
        EXPECTED_COMPLETE_PATHS="$(printf '%s\n' config/current-research-release.json src/data/readingLegacyCuration.mjs | LC_ALL=C sort)"
        test "$COMPLETE_CHANGED_PATHS" = "$EXPECTED_COMPLETE_PATHS"
        bash scripts/assert-exact-ahead-commit.sh "260903: cutoff 후 seed와 완료 release 상태 확정" config/current-research-release.json src/data/readingLegacyCuration.mjs
      fi
      bash scripts/push-exact-default-head.sh
      ;;
    *) exit 1 ;;
  esac
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/weekly-reading-workflow-state-before-cutover.txt --migration-date-output /private/tmp/taejunyun-legacy-cutover-date.txt --seed-sha256-output /private/tmp/readingLegacyCuration-a.sha256 --batch-state-output /private/tmp/reading-batches-a.canonical.json
  node scripts/current-research-release.mjs plan
  npx wrangler deployments status --config wrangler.worker.toml --name taejunyun-reading-api --json > /private/tmp/reading-worker-completed-deployment-status.json
  ACTIVE_WORKER_VERSION="$(node scripts/current-research-release.mjs active-worker-version --input /private/tmp/reading-worker-completed-deployment-status.json)"
  npx wrangler versions view "$ACTIVE_WORKER_VERSION" --config wrangler.worker.toml --name taejunyun-reading-api --json > /private/tmp/reading-worker-completed-version.json
  ACTIVE_REACTION_MODE="$(node scripts/current-research-release.mjs read-worker-reaction-mode --input /private/tmp/reading-worker-completed-version.json)"
  test "$ACTIVE_REACTION_MODE" = true || test "$ACTIVE_REACTION_MODE" = false
  npm run deploy
  ```

  Verify `/text` received/written/reading remain usable, current research renders, reaction endpoints return body-safe 410, and reading clicks still record without returning stats. Confirm the remote default branch contains the completed manifest/seed commit. Restore the workflow to the exact supported state recorded before cutover: if the target is `disabled_manually`, disable immediately to close any external-activation drift before waiting for active runs; if the target is `active`, wait for the active-run list to become empty before enabling. Stop for a new decision on any other stored value. Read the state back with `gh workflow list --all --json path,state`, require exact equality with the saved single line, and never leave it disabled accidentally or enable one that was intentionally disabled before rollout.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun
  test "$(node scripts/current-research-release.mjs rollout-entry)" = COMPLETED_RESUME
  git diff --exit-code
  git diff --cached --exit-code
  test -z "$(git ls-files --others --exclude-standard)"
  bash scripts/verify-git-default-head.sh
  node scripts/current-research-release.mjs materialize-cutover-provenance --workflow-state-output /private/tmp/weekly-reading-workflow-state-before-cutover.txt --migration-date-output /private/tmp/taejunyun-legacy-cutover-date.txt --seed-sha256-output /private/tmp/readingLegacyCuration-a.sha256 --batch-state-output /private/tmp/reading-batches-a.canonical.json
  WORKFLOW_STATE_BEFORE="$(tr -d '\n' < /private/tmp/weekly-reading-workflow-state-before-cutover.txt)"
  test "$WORKFLOW_STATE_BEFORE" = active || test "$WORKFLOW_STATE_BEFORE" = disabled_manually
  if test "$WORKFLOW_STATE_BEFORE" = disabled_manually; then gh workflow disable weekly-reading-deploy.yml; fi
  : > /private/tmp/weekly-reading-active-runs-final.tsv
  for RUN_STATUS in queued in_progress waiting requested pending; do
    gh run list --workflow weekly-reading-deploy.yml --all --status "$RUN_STATUS" --limit 1 --json databaseId,status,url --jq '.[] | [.databaseId,.status,.url] | @tsv' >> /private/tmp/weekly-reading-active-runs-final.tsv
  done
  test ! -s /private/tmp/weekly-reading-active-runs-final.tsv
  if test "$WORKFLOW_STATE_BEFORE" = active; then gh workflow enable weekly-reading-deploy.yml; else gh workflow disable weekly-reading-deploy.yml; fi
  gh workflow list --all --limit 100 --json path,state --jq '.[] | select(.path == ".github/workflows/weekly-reading-deploy.yml") | .state' > /private/tmp/weekly-reading-workflow-state-restored.txt
  test "$(wc -l < /private/tmp/weekly-reading-workflow-state-restored.txt | tr -d ' ')" = 1
  cmp /private/tmp/weekly-reading-workflow-state-before-cutover.txt /private/tmp/weekly-reading-workflow-state-restored.txt
  ```

- [ ] **Step 7: Execute the production-safe behavior matrix.**

  First run only read-only observations: a newer Distill without approval leaves current unchanged; `/text` received/written/reading remain usable; current research renders; reactions repeatedly return 410; anonymous clicks return no stats; and the saved live payload passes the independent hash verifier.

  Then stop. Present the candidate's exact `sessionId` and `contentHash`, plus the current edition's `publicationId` and `contentHash` when one exists. Show a candidate `publicationId` only when an existing ledger row already resolves by that exact `(sessionId, contentHash)`; a genuinely new preview has no publication ID because `beginPublishing()` allocates it only after the approved POST. Label that value `승인 발행 후 할당`, never reserve it during preview, and verify/record the returned ID immediately after publish. Present the ordered mutation matrix below and ask for explicit approval to run it; do not infer approval from the earlier feature decision:

  1. Publish the shown newer Distill and prove it supersedes the old edition.
  2. Retry that exact approved publish and prove no duplicate history/event.
  3. Show the exact current publication again, request withdrawal confirmation, then withdraw and prove the public empty state while private history remains.
  4. Show the same Distill preview again, request re-publication confirmation, then re-publish and prove publication ID/first `publishedAt` are preserved while `updatedAt` changes.

  After each approved mutation, reread current/status/event counts and stop on any mismatch. Run `scripts/verify-current-research-payload.mjs` again on the final EXPLORING response. Do not induce a production API failure, issue a production source-delete request, or run hard purge. Source deletion's `409 source_in_publication`, post-withdrawal deletion, and transient-failure isolation are proved only by Tasks 7, 10, and 18's automated integration tests.

- [ ] **Step 8: Record only observed production facts.**

  Update `docs/PROJECT_CONTEXT.md` in its existing `Cloudflare resources`, `Current implementation`, and `Verification` sections with migration `0029`, the observed bucket name and both binding names, endpoint, reaction cutoff, completed release-manifest state, final C/D legacy row/count/checksums and A→C outcome, reconciler, deletion interlock, hard-purge runbook path, and verification date. Record only outputs observed in Steps 2–7 and never record secret values. Do not state unexecuted deploys as complete. Show both its staged and unstaged diff, preserve all other user-owned changes, and obtain a separate Radar remote-write approval before making this operational record durable on the remote default branch.

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  git diff --cached --name-only > /private/tmp/radar-project-context-staged-files.txt
  test -z "$(rg -v '^docs/PROJECT_CONTEXT\.md$' /private/tmp/radar-project-context-staged-files.txt || true)"
  git diff --check -- docs/PROJECT_CONTEXT.md
  git diff --cached --check -- docs/PROJECT_CONTEXT.md
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh --allow-local-ahead
  RADAR_CONTEXT_AHEAD="$(git rev-list --count '@{upstream}..HEAD')"
  test "$RADAR_CONTEXT_AHEAD" = 0 || test "$RADAR_CONTEXT_AHEAD" = 1
  if test "$RADAR_CONTEXT_AHEAD" = 0; then
    if git diff --quiet HEAD -- docs/PROJECT_CONTEXT.md; then exit 1; fi
  else
    test "$(git log -1 --pretty=%s)" = "260903: 현재 연구 발행 운영 상태와 provenance 기록"
    git diff-tree --no-commit-id --name-only -r HEAD > /private/tmp/radar-project-context-head-files.txt
    test "$(wc -l < /private/tmp/radar-project-context-head-files.txt | tr -d ' ')" = 1
    rg -x 'docs/PROJECT_CONTEXT\.md' /private/tmp/radar-project-context-head-files.txt
    git diff --exit-code -- docs/PROJECT_CONTEXT.md
    git diff --cached --exit-code -- docs/PROJECT_CONTEXT.md
  fi
  git rev-parse HEAD > /private/tmp/radar-project-context-approved-head.txt
  git rev-parse '@{upstream}' > /private/tmp/radar-project-context-approved-upstream.txt
  git hash-object docs/PROJECT_CONTEXT.md > /private/tmp/radar-project-context-approved-blob.txt
  printf '%s\n' "$RADAR_CONTEXT_AHEAD" > /private/tmp/radar-project-context-approved-ahead.txt
  git diff -- docs/PROJECT_CONTEXT.md
  git diff --cached -- docs/PROJECT_CONTEXT.md
  git diff '@{upstream}..HEAD' -- docs/PROJECT_CONTEXT.md
  ```

  Only after that approval, re-prove the exact approved HEAD, upstream, worktree blob, and zero-or-one-commit lane. A fresh lane commits only the approved context path; a local-commit resume accepts only the exact dated commit whose tree changes that path alone. Then prove the resulting commit/blob, push it, and perform a fresh exact equality check. The reviewed Homepage helper is repository-agnostic and derives the Radar checkout's own branch/remote from its current working directory. If the shell/session is lost, rerun the read/approval block and obtain approval again rather than trusting stale `/private/tmp` evidence:

  ```bash
  set -euo pipefail
  cd /Users/taejun-yun/Documents/Codex/Radar_data
  APPROVED_RADAR_HEAD="$(tr -d '\n' < /private/tmp/radar-project-context-approved-head.txt)"
  APPROVED_RADAR_UPSTREAM="$(tr -d '\n' < /private/tmp/radar-project-context-approved-upstream.txt)"
  APPROVED_RADAR_BLOB="$(tr -d '\n' < /private/tmp/radar-project-context-approved-blob.txt)"
  APPROVED_RADAR_AHEAD="$(tr -d '\n' < /private/tmp/radar-project-context-approved-ahead.txt)"
  test "$(git rev-parse HEAD)" = "$APPROVED_RADAR_HEAD"
  test "$(git hash-object docs/PROJECT_CONTEXT.md)" = "$APPROVED_RADAR_BLOB"
  git diff --cached --name-only > /private/tmp/radar-project-context-mutation-staged-files.txt
  test -z "$(rg -v '^docs/PROJECT_CONTEXT\.md$' /private/tmp/radar-project-context-mutation-staged-files.txt || true)"
  git diff --check -- docs/PROJECT_CONTEXT.md
  git diff --cached --check -- docs/PROJECT_CONTEXT.md
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/verify-git-default-head.sh --allow-local-ahead
  test "$(git rev-parse '@{upstream}')" = "$APPROVED_RADAR_UPSTREAM"
  test "$(git rev-list --count '@{upstream}..HEAD')" = "$APPROVED_RADAR_AHEAD"
  case "$APPROVED_RADAR_AHEAD" in
    0)
      if git diff --quiet HEAD -- docs/PROJECT_CONTEXT.md; then exit 1; fi
      git add docs/PROJECT_CONTEXT.md
      git commit --only docs/PROJECT_CONTEXT.md -m "260903: 현재 연구 발행 운영 상태와 provenance 기록"
      ;;
    1)
      git diff --exit-code -- docs/PROJECT_CONTEXT.md
      git diff --cached --exit-code -- docs/PROJECT_CONTEXT.md
      ;;
    *) exit 1 ;;
  esac
  test "$(git rev-list --count '@{upstream}..HEAD')" = 1
  test "$(git log -1 --pretty=%s)" = "260903: 현재 연구 발행 운영 상태와 provenance 기록"
  git diff-tree --no-commit-id --name-only -r HEAD > /private/tmp/radar-project-context-final-head-files.txt
  test "$(wc -l < /private/tmp/radar-project-context-final-head-files.txt | tr -d ' ')" = 1
  rg -x 'docs/PROJECT_CONTEXT\.md' /private/tmp/radar-project-context-final-head-files.txt
  test "$(git rev-parse HEAD:docs/PROJECT_CONTEXT.md)" = "$APPROVED_RADAR_BLOB"
  git diff --cached --exit-code
  bash /Users/taejun-yun/Desktop/WEB_data/taejunyun_new/new-taejunyun/scripts/push-exact-default-head.sh
  ```

---

## Final Verification Matrix

| Boundary | Required proof |
|---|---|
| Projection privacy | exact-key validator tests and payload snapshot exclude raw input, IDs, gaps, Critic/Counter, model/cost |
| Latest-only approval | DB tie-break, invalid newest, deleted source, active deletion claim, purged session tests |
| Human approval | preview has no write; publish body contains only expected hash/revision; stale preview requires a new dialog |
| Concurrency | publish/publish, publish/withdraw, publish/delete, expired lease, stale generation, R2 precondition tests |
| Failure preservation | history/current failure retains old current; current-success/D1-failure returns success plus reconciliation |
| Homepage isolation | fixed-key only, strict wrapper/payload validation plus canonical hash recomputation, no ETag/storageRevision, no visitor ID |
| Reaction retirement | click only; stats/like/sync/curate 410; no polling/localStorage/reaction UI |
| Legacy content | pre-cutoff due batches finalized with approval, non-due policy recorded, preliminary plus quiescent authoritative A/B identity, repeated 410, bounded drain, post-freeze curated and batch C/D identity; every live row maps by normalized URL or ID |
| Loop prevention | old reading export/import key, binding, source, schema remain disjoint from current research |
| Operations | private bucket, remote migration, secret, manifest-gated staged true → Pages true → Worker false cutover, repeated 410 + drain + C/D stable capture, separately approved withdraw/re-publish smoke, deletion integration proof, runbook |

## Out of Scope Follow-ups

- Remove legacy reaction D1 tables/columns and unused rollback modules after the stabilization period.
- Remove the hidden `VITE_CURRENT_RESEARCH_ENABLED=false` curation fallback only after the stabilization/rollback window closes.
- Migrate from deprecated `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` in a separate maintenance change.
- Design final-result ingestion and research completion as a separate product cycle after this publication path is stable.
- Add multiple concurrent research themes, researcher subscriptions, or paid lake access only through a new BM/product design decision.
