# 발견 후보 원문 수집·심층 읽기 신뢰성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 발견 후보를 실제 HTML/PDF 원문까지 수집하고, 본문이 충분히 확보된 자료만 Reservoir 심층 정리 대상으로 허용한다.

**Architecture:** Discovery Keep는 제목·링크만 가진 초기 `METADATA_ONLY` version을 만든 뒤 기존 `research_jobs`/`ResearchJobWorkflow`에 `SOURCE_ACQUISITION` 작업을 등록한다. Worker는 URL을 검증하고 원본을 R2에 먼저 저장한 다음 HTML 정적 본문 추출 또는 PDF `env.AI.toMarkdown()`을 실행해 새 `source_version`을 만든다. `FULLTEXT + READY` 조건을 통과한 version만 active로 승격하고, Reservoir는 실제 수집 상태와 provenance를 표시한다.

**Tech Stack:** Cloudflare Workers, Hono, D1/SQLite migrations, R2, Workers AI `toMarkdown`, TypeScript, Vite + React, Vitest, Playwright CLI.

## Global Constraints

- Cloudflare-first / External-minimal / Serverless-first / Reservoir-first / Model-agnostic 원칙을 유지한다.
- 원본은 항상 R2에 보존한 뒤 추출·정규화·분석한다.
- 모델명은 코드에 하드코딩하지 않고 기존 wrangler vars와 `env.AI` 바인딩을 사용한다.
- 발견 후보는 자동으로 핵심 Reservoir 분석 결과로 간주하지 않으며, 사용자 Keep 이후에만 수집한다.
- 브라우저 렌더링/헤드리스 브라우저, 로그인·유료 콘텐츠 우회, Google Scholar 결과 페이지 크롤링은 이번 범위에 포함하지 않는다.
- 기존 업로드 PDF의 브라우저 pdf.js 경로는 유지하고, 발견 원격 PDF에만 Worker `toMarkdown` 경로를 추가한다.
- 정규화된 텍스트를 HTML로 삽입하지 않는다. 원문 보기 UI는 plain text로만 렌더링한다.
- 현재 `docs/SPEC.md`, `docs/DEV_PLAN.md`, `docs/PROJECT_CONTEXT.md`의 Source of Truth 관계를 유지한다.
- 기존 사용자 자료·버전·분석을 삭제하지 않는다. 재수집은 새 version을 추가하고 품질이 좋아질 때만 active version을 바꾼다.
- 각 Task는 해당 테스트가 통과한 뒤 날짜+주요 변경을 요약한 커밋을 만든다. 예: `260823: 원격 PDF 수집 provenance 추가`.

---

## 파일 구조와 책임

구현 전에 아래 경계를 유지한다.

| 파일 | 책임 |
|---|---|
| `worker/migrations/0015_source_acquisition.sql` | version provenance와 `SOURCE_ACQUISITION` job 종류를 D1에 추가하고 기존 자료를 보수적으로 backfill |
| `shared/src/ingestion.ts` | text scope/extraction method 타입과 본문 품질 판정 순수 함수 |
| `shared/src/discovery.ts` | 연구 작업 종류와 결과 ref 타입 확장 |
| `worker/src/ingestion/extractHtml.ts` | HTML에서 본문 후보를 선택하는 결정론적 추출기 |
| `worker/src/ingestion/acquireRemoteSource.ts` | URL 검증, fetch, Content-Type 판정, R2 원본 저장, HTML/PDF 추출 위임 |
| `worker/src/ingestion/store.ts` | 최초 source 생성 시 metadata-only version을 기록할 수 있도록 입력·insert 확장 |
| `worker/src/ingestion/versioning.ts` | 새 acquisition version 생성과 품질 향상 시 active 승격 |
| `worker/src/workflows/researchJob.ts` | `SOURCE_ACQUISITION` 단계 진행률·재시도·완료 결과 처리 |
| `worker/src/jobs/enqueue.ts` | acquisition job 요청 타입과 dedupe key 생성 |
| `worker/src/routes/discover.ts` | Keep 시 metadata-only source 생성 후 acquisition job 등록 |
| `worker/src/routes/inbox.ts` | 재수집과 재분석 동작을 분리하고 원문/버전 상태 API 제공 |
| `worker/src/routes/reservoir.ts` | active version provenance 반환, 원문 준비 여부 검증, 안전한 plain-text 원문 endpoint |
| `worker/src/analysis/deepAnalyze.ts` | 40자 임계값을 제거하고 full-text gate 적용 |
| `worker/src/lib/rss.ts`, `shared/src/discovery.ts` | RSS CDATA 정규화 |
| `web/src/components/reading/types.ts` | 읽기 화면에 수집 상태와 원문 preview를 전달하는 타입 |
| `web/src/components/reading/ReadingPane.tsx` | 원문 상태, plain-text 원문 preview, 심층 정리 안내 표시 |
| `web/src/views/ReservoirView.tsx` | 심층 정리 버튼 gate, 다시 가져오기/다시 분석하기 분리 |
| `web/src/views/DiscoverView.tsx` | Keep 후 acquisition job 상태와 Reservoir 이동 표시 |
| `web/src/lib/researchJobs.ts`, `web/src/components/layout/JobCenter.tsx` | acquisition 작업 label/result navigation |
| `web/src/styles/reading.css`, `web/src/styles/views.css` | 상태 배지와 원문 preview 스타일 |
| `web/src/lib/ingestion.test.ts`, `web/src/lib/remoteAcquisition.test.ts` | shared quality gate와 extractor 회귀 테스트 |
| `web/src/views/ReservoirView.test.tsx`, `web/src/views/DiscoverView.test.tsx`, `web/src/components/reading/ReadingPane.test.tsx` | UI 상태/행동 회귀 테스트 |
| `docs/SPEC.md`, `docs/DEV_PLAN.md`, `docs/PROJECT_CONTEXT.md` | 구현 결과와 운영 절차 반영 |

---

### Task 1: 실패 재현 테스트와 provenance 타입 정의

**Files:**
- Modify: `shared/src/ingestion.ts`
- Modify: `shared/src/discovery.ts`
- Modify: `web/src/lib/ingestion.test.ts`
- Create: `web/src/lib/remoteAcquisition.test.ts`

**Interfaces:**
- Produces `TextScope`, `ExtractionMethod`, `classifyTextScope(input)` for Tasks 2–6.
- Produces `ResearchJobKind = "SOURCE_ACQUISITION"` and `ResearchJobResultRef` variant `{ view: "RESERVOIR"; sourceId: string; acquisition: true }` for Tasks 4 and 8.

- [ ] **Step 1: Write the failing quality-scope tests**

```ts
import { classifyTextScope } from "@radar/shared/ingestion";

it("accepts a long clean remote HTML article as full text", () => {
  const result = classifyTextScope({
    format: "URL_HTML",
    meaningfulChars: 2_400,
    warnings: [],
    extractionMethod: "HTML_STATIC",
  });
  expect(result).toEqual({ scope: "FULLTEXT", qualityStatus: "READY" });
});

it("does not treat a discovery title as analysable text", () => {
  const result = classifyTextScope({
    format: "DISCOVERY_LINK",
    meaningfulChars: 92,
    warnings: [],
    extractionMethod: "DISCOVERY_METADATA",
  });
  expect(result).toEqual({ scope: "METADATA_ONLY", qualityStatus: "REVIEW" });
});

it("marks a PDF conversion with no text as empty", () => {
  const result = classifyTextScope({
    format: "PDF_TEXT",
    meaningfulChars: 0,
    warnings: ["empty_text"],
    extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
  });
  expect(result).toEqual({ scope: "EMPTY", qualityStatus: "EMPTY" });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts`

Expected: FAIL because `classifyTextScope` and the new types do not exist.

- [ ] **Step 3: Add exact shared types and the pure classifier**

Add to `shared/src/ingestion.ts`:

```ts
export type TextScope = "FULLTEXT" | "PARTIAL" | "METADATA_ONLY" | "EMPTY" | "UNKNOWN";
export type ExtractionMethod =
  | "MANUAL_TEXT"
  | "BROWSER_PDFJS"
  | "HTML_STATIC"
  | "PDF_REMOTE_TO_MARKDOWN"
  | "DISCOVERY_METADATA"
  | "LEGACY";

export interface TextScopeInput {
  format: InputFormat;
  meaningfulChars: number;
  warnings: string[];
  extractionMethod: ExtractionMethod;
}

export function classifyTextScope(input: TextScopeInput): { scope: TextScope; qualityStatus: QualityStatus } {
  if (input.meaningfulChars === 0) return { scope: "EMPTY", qualityStatus: "EMPTY" };
  if (input.extractionMethod === "DISCOVERY_METADATA" || input.meaningfulChars < 200) {
    return { scope: "METADATA_ONLY", qualityStatus: "REVIEW" };
  }
  if (input.meaningfulChars < 1_000 || input.warnings.length > 0) {
    return { scope: "PARTIAL", qualityStatus: "REVIEW" };
  }
  return { scope: "FULLTEXT", qualityStatus: "READY" };
}
```

Extend `ResearchJobKind` and `ResearchJobResultRef` in `shared/src/discovery.ts` with the exact variants named in the Interfaces block.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts`

Expected: PASS, including the existing normalization tests.

- [ ] **Step 5: Commit**

```bash
git add shared/src/ingestion.ts shared/src/discovery.ts web/src/lib/ingestion.test.ts web/src/lib/remoteAcquisition.test.ts
git commit -m "260823: 원문 범위·추출 방법 타입과 품질 게이트 정의"
```

### Task 2: D1 provenance migration과 version writer

**Files:**
- Create: `worker/migrations/0015_source_acquisition.sql`
- Modify: `worker/src/ingestion/store.ts`
- Modify: `worker/src/ingestion/versioning.ts`
- Modify: `worker/src/routes/inbox.ts`
- Test: `web/src/lib/ingestion.test.ts`

**Interfaces:**
- Consumes `TextScope`, `ExtractionMethod`, and `classifyTextScope` from Task 1.
- Produces the metadata-only `CreateSourceInput` shape through the existing `createSource` input and `appendAcquisitionVersion(db, input)` for Tasks 4–7.

- [ ] **Step 1: Write migration/backfill assertions before implementation**

Add a migration contract test in `web/src/lib/ingestion.test.ts` that asserts the allowed values used by the worker are stable:

```ts
it("keeps acquisition provenance values explicit", () => {
  expect(["FULLTEXT", "PARTIAL", "METADATA_ONLY", "EMPTY", "UNKNOWN"]).toHaveLength(5);
  expect(["HTML_STATIC", "PDF_REMOTE_TO_MARKDOWN", "DISCOVERY_METADATA"]).toEqual([
    "HTML_STATIC", "PDF_REMOTE_TO_MARKDOWN", "DISCOVERY_METADATA",
  ]);
});
```

- [ ] **Step 2: Add migration `0015_source_acquisition.sql`**

Add these columns to `source_versions`:

```sql
ALTER TABLE source_versions ADD COLUMN text_scope TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE source_versions ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE source_versions ADD COLUMN extraction_error TEXT;
ALTER TABLE source_versions ADD COLUMN content_type TEXT;
ALTER TABLE source_versions ADD COLUMN final_url TEXT;
ALTER TABLE source_versions ADD COLUMN acquired_at TEXT;
```

Update the `research_jobs` check constraint by rebuilding the table in the same migration so `SOURCE_ACQUISITION` is accepted. Preserve every existing column and index. Backfill existing versions with these deterministic rules:

```sql
UPDATE source_versions
SET text_scope = CASE
  WHEN char_count IS NULL OR char_count = 0 THEN 'EMPTY'
  WHEN source_id IN (SELECT id FROM sources WHERE origin LIKE 'discovery:%') AND char_count < 1000 THEN 'METADATA_ONLY'
  WHEN char_count < 1000 THEN 'PARTIAL'
  ELSE 'FULLTEXT'
END,
extraction_method = CASE
  WHEN source_id IN (SELECT id FROM sources WHERE origin LIKE 'discovery:%') THEN 'DISCOVERY_METADATA'
  ELSE 'LEGACY'
END;
```

The rebuilt job table must retain this exact column set and add only the new enum value:

```sql
CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY_RUN', 'DISTILL_RUN', 'RADAR_SYNTHESIS', 'DEEP_ANALYSIS', 'SOURCE_ACQUISITION')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  result_ref_json TEXT,
  error_code TEXT,
  error TEXT,
  retry_of TEXT REFERENCES research_jobs(id),
  requested_by TEXT,
  dedupe_key TEXT NOT NULL,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO research_jobs_new SELECT id, workflow_instance_id, kind, status, progress, message, input_json, result_json, result_ref_json, error_code, error, retry_of, requested_by, dedupe_key, dismissed_at, created_at, started_at, finished_at, updated_at FROM research_jobs;
DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX idx_research_jobs_recent ON research_jobs(created_at DESC);
CREATE INDEX idx_research_jobs_status ON research_jobs(status, updated_at DESC);
CREATE UNIQUE INDEX idx_research_jobs_active_dedupe ON research_jobs(dedupe_key) WHERE status IN ('QUEUED', 'RUNNING');
```

Do not change `active_version_id` in this migration.

- [ ] **Step 3: Extend source creation to record metadata-only provenance**

In `worker/src/ingestion/store.ts`, add optional `textScope`, `extractionMethod`, `extractionError`, `contentType`, `finalUrl`, and `acquiredAt` to `CreateSourceInput`. Default them from `input.extractedText` and `input.inputFormat`:

```ts
const textScope = input.textScope ?? (text ? "FULLTEXT" : "METADATA_ONLY");
const extractionMethod = input.extractionMethod ?? (text ? "MANUAL_TEXT" : "DISCOVERY_METADATA");
```

Write these values into the initial `source_versions` row. For a Discovery Keep call, `storedOriginal: null` must leave `r2_key` null so the title is never stored as a fake original file.

- [ ] **Step 4: Add the version append writer**

In `worker/src/ingestion/versioning.ts`, add:

```ts
export interface AppendAcquisitionVersionInput {
  sourceId: string;
  r2Key: string | null;
  extractedText: string;
  inputFormat: InputFormat;
  textScope: TextScope;
  extractionMethod: ExtractionMethod;
  extractionError?: string | null;
  contentType?: string | null;
  finalUrl?: string | null;
  acquiredAt?: string | null;
  versionOrigin?: VersionOrigin;
  parentVersionId?: string | null;
}

export async function appendAcquisitionVersion(
  db: D1Database,
  input: AppendAcquisitionVersionInput,
): Promise<{ versionId: string; version: number; qualityStatus: QualityStatus }>;
```

The function must compute normalized text and content hash, insert a new version, and call `activateVersion` only when `textScope === "FULLTEXT"` and `qualityStatus === "READY"`. A `PARTIAL` version may be active only if it contains more meaningful text than the current active version; an `EMPTY` result must never replace a usable active version.

- [ ] **Step 5: Run typecheck and migration syntax checks**

Run: `pnpm --filter @radar/shared typecheck && pnpm --filter @radar/worker typecheck`

Expected: PASS with the new migration file included in the worker migration directory.

- [ ] **Step 6: Commit**

```bash
git add worker/migrations/0015_source_acquisition.sql worker/src/ingestion/store.ts worker/src/ingestion/versioning.ts worker/src/routes/inbox.ts web/src/lib/ingestion.test.ts
git commit -m "260823: 원문 수집 provenance migration과 version writer 추가"
```

### Task 3: 정적 HTML 본문 추출기와 안전한 원격 fetch

**Files:**
- Create: `worker/src/ingestion/extractHtml.ts`
- Create: `worker/src/ingestion/acquireRemoteSource.ts`
- Modify: `worker/src/ingestion/extractUrl.ts`
- Modify: `web/src/lib/remoteAcquisition.test.ts`

**Interfaces:**
- Consumes the Task 1 classifier and Task 2 version input shape.
- Produces `extractStaticHtml(html, url)` and `acquireRemoteSource(env, input)` for Task 4.

- [ ] **Step 1: Write HTML extraction tests**

Add tests covering article selection, boilerplate removal, fallback, and JS shell:

```ts
it("selects article text and excludes site chrome", () => {
  const result = extractStaticHtml(
    `<header>메뉴</header><main><article><h1>제목</h1><p>${"본문 ".repeat(500)}</p></article></main><footer>쿠키</footer>`,
    "https://example.com/article",
  );
  expect(result.text).toContain("본문");
  expect(result.text).not.toContain("쿠키");
  expect(result.method).toBe("HTML_STATIC");
});

it("flags a JavaScript shell as partial or empty", () => {
  const result = extractStaticHtml(`<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>`, "https://example.com/app");
  expect(["PARTIAL", "EMPTY"]).toContain(result.scope);
  expect(result.warnings).toContain("js_shell");
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`

Expected: FAIL because the worker extractor module does not exist.

- [ ] **Step 3: Implement deterministic static extraction**

Define:

```ts
export interface HtmlExtractionResult {
  title: string;
  description: string | null;
  siteName: string | null;
  text: string;
  warnings: string[];
  scope: TextScope;
  method: "HTML_STATIC";
}

export function extractStaticHtml(html: string, url: string): HtmlExtractionResult;
```

The implementation must remove script/style/nav/footer/header/aside/noscript blocks, decode entities, collect `article`, `main`, `[role=main]`, and content-class candidates, score them by meaningful character count + paragraph count − link density − repeated lines, then choose the highest candidate. If no candidate exceeds 200 meaningful characters, use body fallback and add `fallback_body`; if the body is a JS shell, add `js_shell`. Reuse `decodeEntities` behavior from `extractUrl.ts` through an exported helper rather than duplicating entity rules.

- [ ] **Step 4: Implement URL validation and fetch limits**

Define:

```ts
export interface RemoteAcquisitionInput {
  sourceId: string;
  url: string;
  version: number;
}

export interface RemoteAcquisitionResult {
  kind: "HTML" | "PDF";
  r2Key: string;
  extractedText: string;
  title: string | null;
  contentType: string;
  finalUrl: string;
  warnings: string[];
  textScope: TextScope;
  extractionMethod: ExtractionMethod;
}

export async function acquireRemoteSource(env: Env, input: RemoteAcquisitionInput): Promise<RemoteAcquisitionResult>;
```

Use `AbortController` with a 20-second timeout, a 20 MB response limit, and at most five redirects. Before every request, reject non-HTTP(S) URLs and hostnames resolving to localhost, loopback, link-local, or private network ranges. Inspect `Content-Type` and URL suffix; accept HTML/XHTML/text and PDF, otherwise throw a typed error with one of the error codes in the approved design. Put the raw response into R2 before calling either `extractStaticHtml` or the PDF converter. Save HTML as `originals/{sourceId}/v{version}.html` and PDF as `originals/{sourceId}/v{version}.pdf`.

- [ ] **Step 5: Keep existing manual URL behavior compatible**

Refactor `worker/src/ingestion/extractUrl.ts` to call `extractStaticHtml` for its extraction result, while preserving `fetchAndExtract(url)` return fields used by `worker/src/routes/inbox.ts`. Add the new result fields without removing `html`, `title`, `text`, `siteName`, or `description`.

- [ ] **Step 6: Run extractor tests and typecheck**

Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts && pnpm --filter @radar/worker typecheck`

Expected: PASS; no worker type errors and no regression in URL ingestion types.

- [ ] **Step 7: Commit**

```bash
git add worker/src/ingestion/extractHtml.ts worker/src/ingestion/acquireRemoteSource.ts worker/src/ingestion/extractUrl.ts web/src/lib/remoteAcquisition.test.ts
git commit -m "260823: 정적 HTML 본문 추출과 원격 fetch 안전성 추가"
```

### Task 4: 원격 PDF `toMarkdown`와 acquisition workflow

**Files:**
- Modify: `worker/src/ingestion/acquireRemoteSource.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `worker/src/jobs/enqueue.ts`
- Modify: `worker/src/jobs/store.ts`
- Modify: `worker/src/env-secrets.d.ts`
- Modify: `web/src/lib/remoteAcquisition.test.ts`

**Interfaces:**
- Consumes `acquireRemoteSource`, `appendAcquisitionVersion`, and `classifyTextScope` from Tasks 1–3.
- Produces `enqueueResearchJob(env, { kind: "SOURCE_ACQUISITION", input: { sourceId, url } }, requestedBy)` and a completed job result `{ sourceId, textScope, versionId, charCount }`.

- [ ] **Step 1: Write PDF conversion tests with a fake AI binding**

```ts
it("converts a remote PDF through Workers AI and preserves the method", async () => {
  const env = makeAcquisitionEnv({
    contentType: "application/pdf",
    body: new ArrayBuffer(32),
    toMarkdown: async () => [{ name: "paper.md", blob: new Blob(["${"본문 ".repeat(400)}"]) }],
  });
  const result = await acquireRemoteSource(env, { sourceId: "s1", url: "https://arxiv.org/pdf/1234", version: 2 });
  expect(result.kind).toBe("PDF");
  expect(result.extractionMethod).toBe("PDF_REMOTE_TO_MARKDOWN");
  expect(result.textScope).toBe("FULLTEXT");
});

it("reports a conversion failure without treating the binary as text", async () => {
  const env = makeAcquisitionEnv({ contentType: "application/pdf", body: new ArrayBuffer(32), toMarkdown: async () => { throw new Error("conversion_failed"); } });
  await expect(acquireRemoteSource(env, { sourceId: "s1", url: "https://arxiv.org/pdf/1234", version: 2 })).rejects.toThrow("PDF_CONVERSION_FAILED");
});
```

Place the test-only fixture in `web/src/lib/remoteAcquisition.test.ts` before these tests. It must expose the same minimal bindings used by the Worker code:

```ts
function makeAcquisitionEnv(input: {
  contentType: string;
  body: ArrayBuffer;
  toMarkdown: (files: unknown[]) => Promise<{ name: string; blob: Blob }[]>;
}) {
  const objects = new Map<string, ArrayBuffer>();
  return {
    ORIGINALS: {
      put: async (key: string, value: ArrayBuffer | Blob | string) => {
        objects.set(key, value instanceof ArrayBuffer ? value : new TextEncoder().encode(String(value)).buffer);
      },
    },
    AI: { toMarkdown: input.toMarkdown },
    __fixture: { contentType: input.contentType, body: input.body, objects },
  } as unknown as Env;
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`

Expected: FAIL because the PDF branch and workflow kind do not exist.

- [ ] **Step 3: Implement the PDF branch**

For `application/pdf` or a `.pdf` URL, create a `Blob` with `type: "application/pdf"` and call:

```ts
const documents = await env.AI.toMarkdown({ files: [{ name: `${input.sourceId}.pdf`, blob: pdfBlob }] });
const markdown = documents.map((document) => await document.blob.text()).join("\n\n").trim();
```

If the call throws, throw `PDF_CONVERSION_FAILED`. If the output has fewer than 200 meaningful characters, return an `EMPTY`/`REVIEW` result with the R2 key still present. Do not call OpenAI for extraction.

- [ ] **Step 4: Add the `SOURCE_ACQUISITION` enqueue path**

Extend `ResearchJobRequest` in `worker/src/jobs/enqueue.ts`:

```ts
| { kind: "SOURCE_ACQUISITION"; input: { sourceId: string; url: string } }
```

Use the existing dedupe key mechanism so one source and URL cannot have two active acquisition jobs. Update the migration check constraint already introduced in Task 2 and the worker job mapper to accept the new kind.

- [ ] **Step 5: Execute acquisition in the existing workflow**

Add this branch before the deep-analysis fallback in `worker/src/workflows/researchJob.ts`:

```ts
if (job.kind === "SOURCE_ACQUISITION") {
  const input = job.input as { sourceId: string; url: string };
  await updateJobProgress(this.env.DB, job.id, 20, "원문 링크를 확인하는 중");
  const current = await getActiveVersion(this.env.DB, input.sourceId);
  const nextVersion = (current?.version ?? 0) + 1;
  await updateIngestJob(this.env.DB, input.sourceId, "received", null);
  const acquired = await acquireRemoteSource(this.env, { sourceId: input.sourceId, url: input.url, version: nextVersion });
  await updateJobProgress(this.env.DB, job.id, 75, "원문을 정규화하는 중");
  const stored = await appendAcquisitionVersion(this.env.DB, { sourceId: input.sourceId, r2Key: acquired.r2Key, extractedText: acquired.extractedText, inputFormat: acquired.kind === "PDF" ? "PDF_TEXT" : "URL_HTML", textScope: acquired.textScope, extractionMethod: acquired.extractionMethod, contentType: acquired.contentType, finalUrl: acquired.finalUrl, acquiredAt: new Date().toISOString(), parentVersionId: current?.id ?? null, versionOrigin: "REEXTRACT" });
  await updateIngestJob(this.env.DB, input.sourceId, stored.qualityStatus === "READY" ? "extracted" : "failed", stored.qualityStatus === "READY" ? null : "text_not_ready");
  return { result: { sourceId: input.sourceId, textScope: acquired.textScope, versionId: stored.versionId, charCount: acquired.extractedText.length }, resultRef: { view: "RESERVOIR", sourceId: input.sourceId, acquisition: true } };
}
```

The actual helper must preserve the existing `processing_jobs` row and update its `stage`, `status`, `error`, and `updated_at`. Workflow retries must not create duplicate active versions: use the same source/version and R2 key for a retry, or mark a failed incomplete row before creating the next version.

Add the helper in `worker/src/ingestion/store.ts` with this signature:

```ts
export async function updateIngestJob(
  db: D1Database,
  sourceId: string,
  status: "received" | "stored" | "extracted" | "analyzed" | "indexed" | "failed",
  error: string | null,
): Promise<void>;
```

- [ ] **Step 6: Verify workflow types and focused tests**

Run: `pnpm --filter @radar/worker typecheck && pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts`

Expected: PASS, including the existing deep/discovery job type imports.

- [ ] **Step 7: Commit**

```bash
git add worker/src/ingestion/acquireRemoteSource.ts worker/src/workflows/researchJob.ts worker/src/jobs/enqueue.ts worker/src/jobs/store.ts worker/src/env-secrets.d.ts web/src/lib/remoteAcquisition.test.ts
git commit -m "260823: 원격 PDF toMarkdown과 수집 workflow 연결"
```

### Task 5: Discovery Keep를 실제 수집으로 연결하고 RSS CDATA 정리

**Files:**
- Modify: `worker/src/routes/discover.ts`
- Modify: `worker/src/lib/rss.ts`
- Modify: `shared/src/discovery.ts`
- Modify: `web/src/views/DiscoverView.tsx`
- Modify: `web/src/views/DiscoverView.test.tsx`

**Interfaces:**
- Consumes the Task 4 `SOURCE_ACQUISITION` enqueue request.
- Produces a Keep response `{ ok: true, status: "KEPT", sourceId: string, jobId: string }` and UI feedback that the candidate is being imported.

- [ ] **Step 1: Write the Keep response test**

Extend the Discover view mock so a Keep response includes a job and assert that the UI shows the pending acquisition message:

```ts
it("tells the user that a kept candidate is being imported", async () => {
  // select a candidate, open the action sheet, and click 보관하기
  expect(await screen.findByText(/원문 수집을 시작했습니다/)).toBeInTheDocument();
});
```

Add an RSS parser assertion:

```ts
expect(cleanDiscoverySourceText("<![CDATA[At This Year's Rencontres d'Arles]]>")).toBe("At This Year's Rencontres d'Arles");
```

- [ ] **Step 2: Run the tests and verify the new assertions fail**

Run: `pnpm --dir web exec vitest run src/views/DiscoverView.test.tsx src/lib/discoverySources.test.ts`

Expected: FAIL because Keep still passes the title as the only source content and CDATA is not removed.

- [ ] **Step 3: Update the Keep route**

In `worker/src/routes/discover.ts`:

1. Resolve the provider URL. For OpenAlex, use the existing `searchWorks` result’s `openAccessUrl` when present, otherwise `external_url`; for arXiv, use the candidate PDF URL.
2. Call `createSource` with `original: cand.title`, `storedOriginal: null`, `extractedText: ""`, `textScope: "METADATA_ONLY"`, and `extractionMethod: "DISCOVERY_METADATA"`.
3. Call `enqueueResearchJob(c.env, { kind: "SOURCE_ACQUISITION", input: { sourceId: r.sourceId, url: acquisitionUrl } }, requestedBy)`.
4. Return `jobId` and `sourceId`; if no usable URL exists, keep the candidate but return `acquisitionStatus: "LINK_ONLY"` and do not create an invalid workflow.

The title must not be written into `extracted_text` as a substitute for the original.

- [ ] **Step 4: Strip CDATA once at RSS normalization**

Update `cleanDiscoverySourceText` in `shared/src/discovery.ts`:

```ts
const stripCdata = (value: string) => value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
```

Apply it after XML entity decoding and before title/summary storage. Keep the operation idempotent.

- [ ] **Step 5: Update Discover UI and tests**

After a successful Keep response, show `원문 수집을 시작했습니다. 작업센터에서 진행 상태를 확인하세요.` and refresh the candidate list. If `acquisitionStatus === "LINK_ONLY"`, show `링크만 저장했습니다. 원문 주소를 확인해 주세요.`. When the acquisition job completes, use its result ref to navigate to Reservoir.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `pnpm --dir web exec vitest run src/views/DiscoverView.test.tsx src/lib/discoverySources.test.ts && pnpm --filter @radar/worker typecheck`

Expected: PASS; current candidate access labels and field-signal flows remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add worker/src/routes/discover.ts worker/src/lib/rss.ts shared/src/discovery.ts web/src/views/DiscoverView.tsx web/src/views/DiscoverView.test.tsx
git commit -m "260823: Discovery Keep 원문 수집 연결과 RSS CDATA 정리"
```

### Task 6: Deep analysis gate와 재분석/재수집 동작 분리

**Files:**
- Modify: `worker/src/analysis/deepAnalyze.ts`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `worker/src/routes/inbox.ts`
- Modify: `worker/src/ingestion/versioning.ts`
- Modify: `web/src/lib/deepAnalysis.test.ts`
- Modify: `web/src/views/ReservoirView.test.tsx`

**Interfaces:**
- Consumes `text_scope`, `quality_status`, `char_count`, `normalized_text` from the active version.
- Produces `deep_analysis_text_not_ready` with `{ textScope, qualityStatus, charCount }` and separate fetch/reanalyze endpoints for Task 8.

- [ ] **Step 1: Write the failing deep-gate test**

Add a pure query/result assertion around the gate helper:

```ts
it("blocks deep analysis for a title-only discovery version", () => {
  const result = isDeepAnalysisReady({ textScope: "METADATA_ONLY", qualityStatus: "REVIEW", charCount: 92, normalizedText: "제목" });
  expect(result).toEqual({ ok: false, error: "deep_analysis_text_not_ready", textScope: "METADATA_ONLY", qualityStatus: "REVIEW", charCount: 92 });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts`

Expected: FAIL because `analyzeDeepSource` only checks for 40 characters.

- [ ] **Step 3: Add the active-version readiness gate**

In `worker/src/analysis/deepAnalyze.ts`, select `v.id`, `v.text_scope`, `v.char_count`, `s.quality_status`, and both text columns. Reject unless all are true:

```ts
if (row.text_scope !== "FULLTEXT" || row.quality_status !== "READY" || Number(row.char_count ?? 0) < 1_000 || !sourceText) {
  throw new Error("deep_analysis_text_not_ready");
}
```

Import `TextScope` and `QualityStatus` from `@radar/shared/ingestion`, then export the pure gate used by the test and the route:

```ts
export function isDeepAnalysisReady(input: {
  textScope: TextScope;
  qualityStatus: QualityStatus;
  charCount: number;
  normalizedText: string | null;
}): { ok: true } | { ok: false; error: "deep_analysis_text_not_ready"; textScope: TextScope; qualityStatus: QualityStatus; charCount: number } {
  if (input.textScope === "FULLTEXT" && input.qualityStatus === "READY" && input.charCount >= 1_000 && Boolean(input.normalizedText?.trim())) return { ok: true };
  return { ok: false, error: "deep_analysis_text_not_ready", textScope: input.textScope, qualityStatus: input.qualityStatus, charCount: input.charCount };
}
```

Use `char_count` for the gate, not JavaScript string length. Store the selected `version_id` in the deep analysis insert and include `textScope`, `sourceCharCount`, and `versionId` in the payload metadata.

- [ ] **Step 4: Guard the route before creating a paid workflow**

In `worker/src/routes/reservoir.ts`, run the readiness query before `enqueueResearchJob`. Return HTTP 422 and the readiness fields when the gate fails. This prevents a paid workflow from being created for metadata-only content.

- [ ] **Step 5: Separate inbox retry paths**

Keep `POST /api/inbox/retry/:id?analyze=1` as “reanalyze current active version”. Add `POST /api/inbox/retry/:id?fetch=1` that resolves `sources.canonical_url`, creates a `SOURCE_ACQUISITION` job, and does not call `analyzeSource`. Return the job object and `202`.

- [ ] **Step 6: Update UI tests for blocked and allowed cases**

Assert that Reservoir disables `심층 정리하기` and shows the reason for a `PARTIAL`/`METADATA_ONLY` detail, while the existing `READY` fixture still sends the deep-analysis POST request.

- [ ] **Step 7: Run focused tests and typecheck**

Run: `pnpm --dir web exec vitest run src/lib/deepAnalysis.test.ts src/views/ReservoirView.test.tsx && pnpm --filter @radar/worker typecheck`

Expected: PASS; no deep workflow is enqueued for an unready source.

- [ ] **Step 8: Commit**

```bash
git add worker/src/analysis/deepAnalyze.ts worker/src/routes/reservoir.ts worker/src/routes/inbox.ts worker/src/ingestion/versioning.ts web/src/lib/deepAnalysis.test.ts web/src/views/ReservoirView.test.tsx
git commit -m "260823: 심층 정리 full-text gate와 재수집 분리"
```

### Task 7: Reservoir API와 안전한 원문 표시

**Files:**
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `worker/src/routes/inbox.ts`
- Modify: `web/src/components/reading/types.ts`
- Modify: `web/src/components/reading/ReadingPane.tsx`
- Modify: `web/src/components/reading/SourceAccessBadge.tsx`
- Modify: `web/src/components/reading/ReadingPane.test.tsx`
- Modify: `web/src/styles/reading.css`

**Interfaces:**
- Consumes active-version provenance columns from Task 2.
- Produces `SourceAcquisitionView` and a plain-text detail response from `/api/reservoir/:sourceId/original-text`.

- [ ] **Step 1: Write the API/reading view contract test**

Extend the ReadingPane test document fixture:

```ts
const acquisition = {
  textScope: "FULLTEXT" as const,
  extractionMethod: "HTML_STATIC" as const,
  qualityStatus: "READY" as const,
  charCount: 32739,
  acquisitionLabel: "원문 저장됨 · 32,739자",
  canDeepAnalyze: true,
  originalTextUrl: "/api/reservoir/source-1/original-text",
};
```

Assert the label and a `details` section titled `저장된 원문` are visible. Add a second fixture for `METADATA_ONLY` and assert `메타데이터만 저장됨` is visible.

- [ ] **Step 2: Extend the reading types**

In `web/src/components/reading/types.ts`, add:

```ts
export interface SourceAcquisitionView {
  textScope: "FULLTEXT" | "PARTIAL" | "METADATA_ONLY" | "EMPTY" | "UNKNOWN";
  extractionMethod: string;
  qualityStatus: string;
  charCount: number;
  acquisitionLabel: string;
  canDeepAnalyze: boolean;
  originalTextUrl: string | null;
  acquisitionError?: string | null;
}
```

Add optional `acquisition` and `originalText` fields to `ReadingDocument`. Keep `SourceAccess` for external link status; do not overload it with local acquisition status.

- [ ] **Step 3: Return active version provenance from Reservoir**

Update `GET /api/reservoir/:sourceId` to join the active version and return a stable `acquisition` object. Use labels generated from `textScope` and `charCount`; do not infer the label from the URL. Add `originalTextUrl` only when normalized/extracted text exists, and keep `/api/inbox/:sourceId/original` for the original R2 binary.

Add `GET /api/reservoir/:sourceId/original-text` that returns `text/plain; charset=utf-8` from the active version’s normalized text, truncated to the existing 500,000-character storage cap. Do not return raw HTML as `text/html`.

- [ ] **Step 4: Render status and safe text in ReadingPane**

Render the acquisition label near the external SourceAccessBadge. For available text, render:

```tsx
<details className="reading-pane__original-text">
  <summary>저장된 원문 보기</summary>
  <a href={document.acquisition.originalTextUrl}>텍스트 새 창에서 열기</a>
  <pre>{document.originalText}</pre>
</details>
```

Load the original text only after the details element is opened, via `fetch(document.acquisition.originalTextUrl)`. Treat the response as plain text and never use `dangerouslySetInnerHTML`.

- [ ] **Step 5: Run component tests**

Run: `pnpm --dir web exec vitest run src/components/reading/ReadingPane.test.tsx`

Expected: PASS; external access badge behavior remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/reservoir.ts worker/src/routes/inbox.ts web/src/components/reading/types.ts web/src/components/reading/ReadingPane.tsx web/src/components/reading/SourceAccessBadge.tsx web/src/components/reading/ReadingPane.test.tsx web/src/styles/reading.css
git commit -m "260823: Reservoir 원문 상태와 안전한 원문 보기 추가"
```

### Task 8: Reservoir/Discover actions와 background job UX

**Files:**
- Modify: `web/src/views/ReservoirView.tsx`
- Modify: `web/src/views/DiscoverView.tsx`
- Modify: `web/src/lib/researchJobs.ts`
- Modify: `web/src/components/layout/JobCenter.tsx`
- Modify: `web/src/views/ReservoirView.test.tsx`
- Modify: `web/src/views/DiscoverView.test.tsx`
- Modify: `web/src/styles/views.css`

**Interfaces:**
- Consumes `SourceAcquisitionView`, the Task 4 result ref, and the Task 6 fetch/reanalyze endpoints.
- Produces a UI where `다시 분석하기` never refetches and `다시 가져오기` always starts acquisition.

- [ ] **Step 1: Write action separation tests**

In `ReservoirView.test.tsx`, assert these exact requests:

```ts
expect(fetch).toHaveBeenCalledWith("/api/inbox/retry/source-1?analyze=1", { method: "POST" });
expect(fetch).not.toHaveBeenCalledWith("/api/inbox/retry/source-1?fetch=1", { method: "POST" });
```

Add a second test that clicks `다시 가져오기` and expects the `fetch=1` request. Add a blocked fixture and assert the deep button is disabled.

- [ ] **Step 2: Run tests and verify the action test fails**

Run: `pnpm --dir web exec vitest run src/views/ReservoirView.test.tsx src/views/DiscoverView.test.tsx`

Expected: FAIL because Reservoir has only the existing reanalyze action and does not consume acquisition metadata.

- [ ] **Step 3: Add acquisition labels and deep gate to ReservoirView**

Map `detail.acquisition.canDeepAnalyze` to the deep button’s `disabled` value. When disabled, show one sentence below the controls using `textScope`, `qualityStatus`, and `charCount`. Add `다시 가져오기` calling `/api/inbox/retry/:id?fetch=1`; keep the existing `reanalyze` callback calling `analyze=1`.

- [ ] **Step 4: Update job labels and result navigation**

In `web/src/lib/researchJobs.ts`, map `SOURCE_ACQUISITION` to `원문 수집`. In `JobCenter.tsx`, allow the acquisition result ref to call the existing Reservoir navigation callback with its `sourceId`, without requiring an `analysisId`.

- [ ] **Step 5: Update Discover Keep feedback**

After Keep, display the job-start message and refresh the kept list. When the user selects a kept candidate that already has a source id, link the reading action to the Reservoir source rather than showing a metadata-only ReadingPane in Discover. Keep candidate external links available for verification.

- [ ] **Step 6: Run UI tests and typecheck**

Run: `pnpm --dir web exec vitest run src/views/ReservoirView.test.tsx src/views/DiscoverView.test.tsx src/components/layout/JobCenter.test.tsx && pnpm --filter @radar/web typecheck`

Expected: PASS; existing Keep/Watch/Ignore and deep-analysis happy paths remain functional.

- [ ] **Step 7: Commit**

```bash
git add web/src/views/ReservoirView.tsx web/src/views/DiscoverView.tsx web/src/lib/researchJobs.ts web/src/components/layout/JobCenter.tsx web/src/views/ReservoirView.test.tsx web/src/views/DiscoverView.test.tsx web/src/styles/views.css
git commit -m "260823: 원문 수집 작업센터와 Reservoir 행동 분리"
```

### Task 9: Existing discovery backfill and operator endpoint

**Files:**
- Modify: `worker/src/routes/inbox.ts`
- Modify: `worker/src/routes/settings.ts`
- Modify: `web/src/views/SettingsView.tsx`
- Create: `worker/src/ingestion/backfillDiscovery.ts`
- Modify: `web/src/views/SettingsUsageView.test.tsx`

**Interfaces:**
- Consumes the Task 4 acquisition workflow and Task 2 version metadata.
- Produces a bounded, repeatable backfill action that never deletes existing versions.

- [ ] **Step 1: Write the backfill selection test**

```ts
it("selects only discovery sources without usable active text", () => {
  const ids = selectDiscoveryBackfillSources([
    { id: "metadata", origin: "discovery:arxiv", textScope: "METADATA_ONLY", charCount: 92 },
    { id: "ready", origin: "discovery:rss", textScope: "FULLTEXT", charCount: 2400 },
  ]);
  expect(ids).toEqual(["metadata"]);
});
```

- [ ] **Step 2: Implement bounded selection and enqueue**

In `worker/src/ingestion/backfillDiscovery.ts`, first export the pure selector:

```ts
export function selectDiscoveryBackfillSources(rows: Array<{ id: string; origin: string | null; textScope: TextScope; charCount: number }>): string[] {
  return rows.filter((row) => row.origin?.startsWith("discovery:") && (row.textScope !== "FULLTEXT" || row.charCount < 1_000)).map((row) => row.id);
}
```

Then select `origin LIKE 'discovery:%'` where active version scope is not `FULLTEXT` or meaningful `char_count < 1_000`, limit to 10 per request, resolve each canonical URL, and enqueue a deduplicated `SOURCE_ACQUISITION` job. Return `{ selected, enqueued, skipped, errors }`.

- [ ] **Step 3: Add a protected Settings action**

Add `POST /api/settings/backfill-discovery` with a maximum batch size of 10 and an explicit response count. Add a Settings button labeled `발견 자료 원문 다시 가져오기` with helper text explaining that old versions are preserved. No automatic cron is added.

- [ ] **Step 4: Run settings tests and typecheck**

Run: `pnpm --dir web exec vitest run src/views/SettingsUsageView.test.tsx && pnpm --filter @radar/worker typecheck`

Expected: PASS and the endpoint returns a bounded count without modifying unrelated manual sources.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingestion/backfillDiscovery.ts worker/src/routes/inbox.ts worker/src/routes/settings.ts web/src/views/SettingsView.tsx web/src/views/SettingsUsageView.test.tsx
git commit -m "260823: 기존 발견 자료 원문 재수집 backfill 추가"
```

### Task 10: End-to-end verification, documentation, migration, and deployment

**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/DEV_PLAN.md`
- Modify: `docs/PROJECT_CONTEXT.md`
- Modify: `web/tests/e2e/core-reading-flow.spec.ts`
- Modify: `web/src/views/ReservoirView.test.tsx`
- Modify: `web/src/views/DiscoverView.test.tsx`

**Interfaces:**
- Consumes all prior task behavior.
- Produces a deployable migration and a verified production-safe flow.

- [ ] **Step 1: Add the end-to-end fixture flow**

Extend `web/tests/e2e/core-reading-flow.spec.ts` with this sequence:

1. Open Discover and keep one HTML candidate.
2. Assert a `원문 수집` job appears.
3. Open Reservoir from the completed acquisition result.
4. Assert `원문 저장됨` and a positive character count.
5. Assert `저장된 원문 보기` contains text from the fixture.
6. Assert the deep-analysis button is enabled only after the fixture reports `FULLTEXT + READY`.
7. Repeat with a PDF fixture and assert `PDF_REMOTE_TO_MARKDOWN` in the provenance panel.
8. Repeat with a JS shell and assert deep analysis is disabled with a recovery message.

- [ ] **Step 2: Run all automated checks**

Run:

```bash
pnpm -r typecheck
pnpm --dir web exec vitest run
pnpm --dir web exec playwright test tests/e2e/core-reading-flow.spec.ts
pnpm build
```

Expected: all typechecks, unit/component tests, the core reading flow, and the production build pass.

- [ ] **Step 3: Apply migration in a non-production check**

Run: `pnpm db:migrate` against the configured development database, then query:

```sql
SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_jobs';
SELECT text_scope, extraction_method, COUNT(*) FROM source_versions GROUP BY text_scope, extraction_method;
```

Expected: `SOURCE_ACQUISITION` is accepted by `research_jobs`, existing source rows remain, and no active version is deleted or changed by the migration.

- [ ] **Step 4: Update the three source-of-truth documents**

In `docs/SPEC.md`, change D5 to state: “업로드 PDF는 브라우저 pdf.js, 발견 원격 PDF는 R2 보존 후 Workers AI `toMarkdown`”.

In `docs/DEV_PLAN.md`, add the new migration, discovery Keep acquisition workflow, `text_scope` quality gate, Reservoir status UI, and acceptance criteria.

In `docs/PROJECT_CONTEXT.md`, record the actual status fields, error codes, retry distinction (`fetch=1` vs `analyze=1`), and the fact that current historical discovery sources require the bounded backfill action.

- [ ] **Step 5: Deploy and perform read-only production verification**

Run: `pnpm deploy`

Then verify with the protected production app:

- `/api/health` returns 200.
- A real HTML candidate Keep creates one acquisition job and one new active version after success.
- A real arXiv PDF creates an R2 object and a `PDF_REMOTE_TO_MARKDOWN` version.
- A failed URL keeps the source and exposes a retry action.
- A title-only source receives HTTP 422 from the deep-analysis endpoint.
- Existing `Photography & Automation — A Detailed Timeline` still reports its stored text and previous deep-analysis history.

- [ ] **Step 6: Commit documentation and final verification**

```bash
git add docs/SPEC.md docs/DEV_PLAN.md docs/PROJECT_CONTEXT.md web/tests/e2e/core-reading-flow.spec.ts web/src/views/ReservoirView.test.tsx web/src/views/DiscoverView.test.tsx
git commit -m "260823: 원문 수집·심층 읽기 품질 개선 검증과 운영 문서 반영"
```

## Execution order and checkpoints

1. Tasks 1–2: types, migration, and version provenance. Checkpoint: typecheck + migration contract.
2. Tasks 3–4: HTML/PDF acquisition engine and workflow. Checkpoint: fake R2/fetch/AI tests.
3. Tasks 5–6: Discovery Keep and deep gate. Checkpoint: title-only source cannot create a paid deep job.
4. Tasks 7–8: Reservoir and job-center UI. Checkpoint: external access status and local acquisition status are visibly separate.
5. Task 9: bounded historical backfill. Checkpoint: only discovery metadata-only records are selected.
6. Task 10: full verification, docs, migration, and deployment. Checkpoint: production smoke flow and existing good source regression.

## Self-review checklist

- Spec coverage: R2-before-processing, HTML extraction, PDF `toMarkdown`, text scope, deep gate, UI provenance, retry separation, RSS CDATA, historical backfill, tests, and docs each have an explicit task.
- Placeholder scan: no task relies on “TBD”, “TODO”, or an unspecified library. All new function names, routes, status values, and commands are stated.
- Type consistency: `TextScope`/`ExtractionMethod` are defined in Task 1, version writers consume them in Task 2, acquisition returns them in Tasks 3–4, and UI/API consume them in Tasks 7–8.
- Safety: remote fetch limits, private-network rejection, raw R2 preservation, non-destructive versioning, and no raw HTML injection are explicit.
- Cost: PDF extraction uses Workers AI; OpenAI is not called until the full-text analysis gate passes.
