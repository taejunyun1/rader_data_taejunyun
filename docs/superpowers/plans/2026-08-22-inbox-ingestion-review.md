# 받은 자료 수신·정규화·재검수 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 받은 자료에서 PDF·링크·텍스트·Obsidian 입력을 구분하고, 원본·추출 텍스트·AI 입력용 정규화 텍스트를 검수·수정·재처리할 수 있게 한다.

**Architecture:** 기존 D1/R2 ingestion 구조를 유지하면서 `sources`에는 수신 경로·입력 형식·활성 버전을 추가하고, `source_versions`에는 정규화 텍스트·품질 보고서·버전 출처를 추가한다. Worker가 URL·Markdown·Obsidian을 정규화하고, 브라우저는 PDF 원본을 pdf.js로 다시 추출한다. AI 분석과 embedding은 `active_version_id`의 `normalized_text`만 읽는다.

**Tech Stack:** Hono Worker, Cloudflare D1/R2, Vite + React + TypeScript, shared TypeScript types, Vitest + Testing Library, pnpm workspaces.

## Global Constraints

- 원본은 항상 R2에 먼저 보존한다.
- `sources.kind`는 연구 자료 유형이고 `ingest_channel`/`input_format`은 수신 방식을 나타낸다.
- `source_versions`의 원문·추출 본문은 수정하지 않고 새 버전으로만 저장한다.
- AI는 활성 버전의 `normalized_text`만 사용한다.
- PDF 텍스트 추출은 브라우저 pdf.js를 유지하며 서버 OCR/PDF parser를 추가하지 않는다.
- Obsidian 재동기화는 수동 보정본을 자동 덮어쓰지 않는다.
- V0 범위 밖의 Google Drive, 양방향 Obsidian 편집, 챗봇, Admin UI는 추가하지 않는다.
- 사용자 UI 문구는 한국어로 표시하고 자료 고유명사와 원문은 유지한다.
- 커밋 메시지는 `YYMMDD: 변경 내용 요약` 형식을 사용한다.

---

## Task 1: shared 수신 형식·정규화·품질 계약

**Files:**
- Create: `shared/src/ingestion.ts`
- Modify: `shared/src/index.ts`
- Create: `web/src/lib/ingestion.test.ts`

**Interfaces:**
- Produces `IngestChannel`, `InputFormat`, `QualityStatus`, `VersionOrigin`, `VersionReviewStatus`.
- Produces `normalizeIngestText(text, format): NormalizationResult`.
- Produces `deriveIngestMeta(origin, filename, metadata): { channel, format }`.
- Produces `isQualityReady(result): boolean` for Worker and Web display.

- [ ] **Step 1: Write failing normalization tests**

```ts
it("normalizes Obsidian links and keeps headings and code blocks", () => {
  const result = normalizeIngestText(
    "---\ntags: [photo]\n---\n# 제목\n[[작업노트|표시명]]\n![[image.png]]\n```js\nconst x = 1\n```",
    "OBSIDIAN_MARKDOWN",
  );
  expect(result.normalizedText).toContain("# 제목");
  expect(result.normalizedText).toContain("표시명");
  expect(result.normalizedText).toContain("[첨부: image.png]");
  expect(result.normalizedText).toContain("const x = 1");
  expect(result.report.unresolvedEmbedCount).toBe(1);
});

it("uses shorter readiness threshold for personal notes", () => {
  expect(normalizeIngestText("짧지만 읽을 가치가 있는 메모입니다.", "PLAIN_TEXT").qualityStatus).toBe("READY");
  expect(normalizeIngestText("짧음", "PDF_TEXT").qualityStatus).toBe("REVIEW");
});
```

- [ ] **Step 2: Run the focused test and verify the expected missing-export failure**

Run: `pnpm --filter @radar/web exec vitest run src/lib/ingestion.test.ts`
Expected: FAIL because the shared ingestion contract does not exist yet.

- [ ] **Step 3: Implement the shared contract and deterministic normalizer**

```ts
export type IngestChannel = "MANUAL" | "OBSIDIAN" | "DISCOVERY" | "HOMEPAGE";
export type InputFormat = "PLAIN_TEXT" | "MARKDOWN" | "OBSIDIAN_MARKDOWN" | "URL_HTML" | "PDF_TEXT" | "PDF_SCAN" | "HOMEPAGE_JSON" | "DISCOVERY_LINK";
export type QualityStatus = "UNREVIEWED" | "READY" | "REVIEW" | "EMPTY" | "FAILED";
export type VersionOrigin = "INITIAL_INGEST" | "OBSIDIAN_SYNC" | "REEXTRACT" | "RENORMALIZE" | "MANUAL_EDIT";
export type VersionReviewStatus = "ACTIVE" | "PENDING_REVIEW" | "SUPERSEDED" | "REJECTED";

export interface NormalizationReport {
  extractedChars: number;
  normalizedChars: number;
  meaningfulChars: number;
  replacementCharCount: number;
  repeatedLineRatio: number;
  unresolvedEmbedCount: number;
  pageCount: number | null;
  textPages: number | null;
  warnings: string[];
}

export interface NormalizationResult {
  normalizedText: string;
  report: NormalizationReport;
  qualityStatus: QualityStatus;
  metadata: Record<string, unknown>;
}
```

The normalizer must preserve Markdown headings, lists, quotes, code blocks, page markers, and paragraph order. It must convert Obsidian wikilinks to display labels, replace embeds with `[첨부: ...]`, strip YAML frontmatter from body metadata, normalize Unicode/line endings, and never call an AI model.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm --filter @radar/web exec vitest run src/lib/ingestion.test.ts && pnpm typecheck`
Expected: the new focused tests and all package typechecks pass.

- [ ] **Step 5: Commit the shared contract**

```bash
git add shared/src/index.ts shared/src/ingestion.ts web/src/lib/ingestion.test.ts
git commit -m "260822: 수신 형식과 텍스트 품질 계약 추가"
```

## Task 2: D1 version lifecycle and ingestion storage

**Files:**
- Create: `worker/migrations/0008_ingestion_review.sql`
- Create: `worker/src/ingestion/versioning.ts`
- Modify: `worker/src/ingestion/store.ts`
- Modify: `worker/src/analysis/analyze.ts`
- Modify: `worker/src/lib/embed.ts`
- Modify: `worker/src/routes/export.ts`
- Modify: `worker/src/distill/queueImport.ts`
- Modify: `worker/src/routes/discover.ts`
- Modify: `worker/src/homepage/reading.ts`
- Modify: `worker/src/routes/settings.ts`

**Interfaces:**
- `createSource` accepts optional `ingestChannel` and `inputFormat` and creates an initial normalized version.
- `getActiveVersion(db, sourceId)` returns the version selected by `sources.active_version_id`.
- `activateVersion(db, sourceId, versionId)` atomically updates version status and source summary.
- `createVersion(env, input)` creates an immutable candidate and never overwrites the parent.

- [ ] **Step 1: Add migration before production code depends on new columns**

`0008_ingestion_review.sql` adds the exact columns from the approved design: `sources.ingest_channel`, `sources.input_format`, `sources.active_version_id`, `sources.quality_status`; `source_versions.content_hash`, `normalized_text`, `normalization_status`, `normalization_report_json`, `version_origin`, `parent_version_id`, `review_status`, `reviewed_at`; and the approved indexes. It must also backfill channel/format from existing origin values without deleting rows.

- [ ] **Step 2: Add failing lifecycle tests in the existing Web Vitest harness**

Test the pure version-transition helper with fixtures:

```ts
it("keeps a manual active version when a new Obsidian version arrives", () => {
  const result = decideIncomingVersion({ activeOrigin: "MANUAL_EDIT", incomingOrigin: "OBSIDIAN_SYNC" });
  expect(result).toEqual({ activateIncoming: false, reviewStatus: "PENDING_REVIEW" });
});

it("activates a changed Obsidian version when no manual correction exists", () => {
  expect(decideIncomingVersion({ activeOrigin: "OBSIDIAN_SYNC", incomingOrigin: "OBSIDIAN_SYNC" }).activateIncoming).toBe(true);
});
```

- [ ] **Step 3: Implement immutable version helpers and initial version creation**

`createSource` must save R2 first, write `extracted_text` and deterministic `normalized_text`, mark the first version `ACTIVE`, set `sources.active_version_id`, and set `quality_status`. A manual edit creates a `MANUAL_EDIT` version that inherits the parent `r2_key` and extracted text while replacing only normalized text. Activation changes the previous active version to `SUPERSEDED` in the same D1 batch.

- [ ] **Step 4: Make analysis, embedding, and Markdown export read the active version**

Replace every `ORDER BY version DESC LIMIT 1` used for analysis input with a join through `sources.active_version_id`. `analyzeSource` must return `no_text` without changing a valid active version to a failed state. Embedding and export use `normalized_text` first and fall back to `extracted_text` only for legacy rows during backfill.

- [ ] **Step 5: Update all createSource callers with explicit origin metadata**

Use `MANUAL/PLAIN_TEXT`, `MANUAL/MARKDOWN`, `MANUAL/PDF_TEXT` or `PDF_SCAN`, `MANUAL/URL_HTML`, `OBSIDIAN/OBSIDIAN_MARKDOWN`, `DISCOVERY/DISCOVERY_LINK`, `HOMEPAGE/HOMEPAGE_JSON`, and `MANUAL/PLAIN_TEXT` for reading-queue imports. Keep `sources.kind` unchanged as the research classification.

- [ ] **Step 6: Run typecheck and local migration smoke checks**

Run: `pnpm typecheck`
Run: `pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --local`
Expected: all packages typecheck; local D1 applies `0008` without SQL errors.

- [ ] **Step 7: Commit the storage lifecycle**

```bash
git add worker/migrations/0008_ingestion_review.sql worker/src/ingestion/versioning.ts worker/src/ingestion/store.ts worker/src/analysis/analyze.ts worker/src/lib/embed.ts worker/src/routes/export.ts worker/src/distill/queueImport.ts worker/src/routes/discover.ts worker/src/homepage/reading.ts worker/src/routes/settings.ts
git commit -m "260822: ingestion 버전과 활성 텍스트 저장 구조 추가"
```

## Task 3: Inbox API, reprocessing, and Obsidian conflict handling

**Files:**
- Modify: `worker/src/routes/inbox.ts`
- Modify: `worker/src/routes/sync.ts`
- Create: `worker/src/ingestion/backfill.ts`
- Modify: `shared/src/index.ts`
- Modify: `web/src/views/InboxView.test.tsx`

**Interfaces:**
- `GET /api/inbox?channel=&format=&quality=&versionState=&analysisState=&limit=&cursor=` returns `summary`, `items`, and `nextCursor`.
- `GET /api/inbox/:sourceId` returns source metadata, active version, versions, quality report, and `analysisFresh`.
- `GET /api/inbox/:sourceId/original` streams the authenticated R2 original.
- `POST /api/inbox/:sourceId/versions` stores manual normalized text as a new version.
- `POST /api/inbox/:sourceId/reextract` creates a URL or client-PDF candidate.
- `POST /api/inbox/:sourceId/renormalize` creates a deterministic candidate.
- `POST /api/inbox/:sourceId/versions/:versionId/activate` selects a candidate.
- `POST /api/inbox/:sourceId/analyze` analyzes only the active version.
- `POST /api/inbox/backfill` processes 20 legacy sources per call and returns progress.

- [ ] **Step 1: Add failing API contract fixtures**

Extend `InboxView.test.tsx` fixtures to assert that list data includes `ingestChannel`, `inputFormat`, `qualityStatus`, `activeVersionId`, `versionCount`, `pendingVersionCount`, and `analysisFresh`. Add a fixture for an Obsidian manual-edit conflict with one active version and one pending version.

- [ ] **Step 2: Run the test and verify it fails against the old response**

Run: `pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx`
Expected: FAIL because the old Inbox response has no summary, format, quality, or version fields.

- [ ] **Step 3: Implement list filtering and summary**

Join `sources` to `processing_jobs`, active `source_versions`, and the latest candidate-version aggregate. Apply filters only to SQL parameters. `reviewRequired` counts `UNREVIEWED`, `REVIEW`, `EMPTY`, and pending version candidates. Never expose R2 content in the list response.

- [ ] **Step 4: Implement detail, original streaming, versions, activation, and reprocessing**

Validate that a manual version has non-empty normalized text, that activation belongs to the requested source, and that failed candidates never replace the active version. For PDFs, accept browser-extracted text and page metadata; for URLs, fetch server-side; for Markdown/Obsidian, run the shared deterministic normalizer. Return Korean-safe error codes mapped by the Web layer.

- [ ] **Step 5: Implement Obsidian sync conflict rules**

On changed content, create an `OBSIDIAN_SYNC` candidate. If the active version has `MANUAL_EDIT` ancestry, keep it active and mark the candidate `PENDING_REVIEW`; otherwise activate the new sync version. Same-content sync returns `unchanged` and does not create a version. Analyze only after an automatically activated version is `READY`.

- [ ] **Step 6: Implement bounded legacy backfill**

`backfillInbox` selects at most 20 sources with `quality_status = 'UNREVIEWED'`, derives metadata, normalizes the active legacy extracted text, stores the report, and updates only the new fields. It does not call Workers AI or alter existing analysis rows. Return `{ processed, remaining, failed }`.

- [ ] **Step 7: Run typecheck and focused tests**

Run: `pnpm typecheck && pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx src/lib/ingestion.test.ts`
Expected: all selected tests pass and API-related type errors are absent.

- [ ] **Step 8: Commit the API and sync lifecycle**

```bash
git add worker/src/routes/inbox.ts worker/src/routes/sync.ts worker/src/ingestion/backfill.ts shared/src/index.ts web/src/views/InboxView.test.tsx
git commit -m "260822: 받은 자료 검수 API와 Obsidian 충돌 처리 추가"
```

## Task 4: Inbox review workspace UI

**Files:**
- Modify: `web/src/views/InboxView.tsx`
- Create: `web/src/components/inbox/IngestionReviewPane.tsx`
- Create: `web/src/components/inbox/VersionCompare.tsx`
- Modify: `web/src/styles/views.css`
- Modify: `web/src/lib/labels.ts`
- Modify: `web/src/views/InboxView.test.tsx`

**Interfaces:**
- `InboxView` owns list filters, selected source, loading/error state, and input-mode tabs.
- `IngestionReviewPane` consumes the detail response and emits `saveVersion`, `activateVersion`, `reextract`, `renormalize`, and `reanalyze` actions.
- `VersionCompare` consumes two immutable version records and renders labeled line changes.

- [ ] **Step 1: Write failing UI tests for real input tabs and review badges**

```tsx
it("switches between actual input tabs", async () => {
  render(<InboxView />);
  await userEvent.click(screen.getByRole("tab", { name: "PDF" }));
  expect(screen.getByText("PDF 원본과 텍스트 보존하기")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("읽은 문장이나 메모를 붙여 넣으세요")).not.toBeInTheDocument();
});

it("shows the active AI version and a pending Obsidian version separately", async () => {
  render(<InboxView />);
  await userEvent.click(await screen.findByRole("button", { name: "여러 문장" }));
  expect(screen.getByText("AI 입력용 텍스트")).toBeInTheDocument();
  expect(screen.getByText("새 버전 검토 필요")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "수정본 새 버전 저장" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run focused tests and verify the old static-tab/list UI fails**

Run: `pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx`
Expected: FAIL because the old UI uses non-interactive spans and has no review detail.

- [ ] **Step 3: Implement actual input tabs and capture forms**

Use `role="tablist"`, `role="tab"`, `aria-selected`, and one visible form at a time. Preserve current text, URL, Markdown, and PDF upload handlers. Add PDF progress and the existing 10 MB binary limit message. Add an Obsidian sync status summary without adding a new credential flow.

- [ ] **Step 4: Implement review summary, filters, list, and selected detail**

Display format, research kind, processing status, quality status, version state, character count, and `재분석 필요` independently. Selecting a row loads the detail pane; the list remains available on desktop. Use text labels in addition to status colors.

- [ ] **Step 5: Implement editable AI input and version actions**

The extracted pane is read-only. The AI input pane is editable. `수정본 새 버전 저장` posts the edited text and refreshes the detail. `다시 추출` and `다시 정규화` show a candidate result without activating it. `이 텍스트 사용` activates the candidate. `다시 분석` is disabled until the active version is `READY` and posts the explicit analyze action.

- [ ] **Step 6: Implement version comparison and conflict copy**

Show the selected version source (`Obsidian 동기화`, `수동 보정`, `다시 추출`) and compare two versions with `추가됨`, `삭제됨`, and unchanged context labels. Use `기존 보정본 유지` to mark a candidate rejected; do not delete it.

- [ ] **Step 7: Add responsive and accessibility styles**

Use the existing tokens in `web/src/styles/tokens.css`. On narrow screens switch from split panes to detail navigation. Ensure keyboard focus, visible status text, semantic tabs, labeled textareas, and live status messages.

- [ ] **Step 8: Run the focused UI tests and commit**

Run: `pnpm --filter @radar/web exec vitest run src/views/InboxView.test.tsx src/lib/ingestion.test.ts`
Expected: all focused tests pass.

```bash
git add web/src/views/InboxView.tsx web/src/components/inbox/IngestionReviewPane.tsx web/src/components/inbox/VersionCompare.tsx web/src/styles/views.css web/src/lib/labels.ts web/src/views/InboxView.test.tsx
git commit -m "260822: 받은 자료 검수 작업공간 UI 구현"
```

## Task 5: Regression coverage and documentation

**Files:**
- Modify: `web/src/views/InboxView.test.tsx`
- Modify: `web/tests/e2e/core-reading-flow.spec.ts`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `docs/DEV_PLAN.md`

- [ ] **Step 1: Add the end-to-end Obsidian conflict scenario**

Cover: first sync → manual normalized edit → changed Obsidian sync → pending review badge → compare versions → keep existing correction → analyze active version. Use API fixtures in the existing e2e setup and do not upload real private vault content.

- [ ] **Step 2: Document the new operational boundary**

Update `PROJECT_CONTEXT.md` with active-version-only analysis, Obsidian conflict behavior, and input-format labels. Update `DEV_PLAN.md` with the completed Inbox review acceptance criteria and migration `0008` ordering.

- [ ] **Step 3: Run the full verification suite**

Run:

```bash
pnpm typecheck
pnpm --filter @radar/web exec vitest run
pnpm build
git diff --check
```

Expected: all package typechecks pass, all Web tests pass, the production build succeeds, and `git diff --check` is empty.

- [ ] **Step 4: Commit regression and documentation changes**

```bash
git add web/src/views/InboxView.test.tsx web/tests/e2e/core-reading-flow.spec.ts docs/PROJECT_CONTEXT.md docs/DEV_PLAN.md
git commit -m "260822: 받은 자료 검수 회귀검증과 운영 문서 반영"
```

## Task 6: Remote migration, deployment, and push

- [ ] **Step 1: Verify the final worktree and commit list**

Run: `git status --short && git log --oneline origin/main..main`
Expected: only intentionally preserved untracked temporary directories remain; all feature changes are committed.

- [ ] **Step 2: Apply the remote D1 migration before Worker deployment**

Run: `pnpm --filter @radar/worker exec wrangler d1 migrations apply research-radar-db --remote`
Expected: `0008_ingestion_review.sql` applies successfully. Stop if Wrangler reports an unapplied earlier migration or SQL error.

- [ ] **Step 3: Deploy the web asset and Worker**

Run: `pnpm deploy`
Expected: web build succeeds, Worker `research-radar` uploads, bindings remain attached, and `radar.taejunyun.com` is listed.

- [ ] **Step 4: Push main only after deployment succeeds**

```bash
git push origin main
```

Expected: `main -> main` succeeds without force push.

- [ ] **Step 5: Verify the deployed health endpoint and final git state**

Run: `curl -fsS https://radar.taejunyun.com/api/health` and `git status --short`.
Expected: health returns `{ "ok": true, ... }`; only preserved temporary untracked directories remain.
