# Visual Reservoir Delivery 1 — 개인 이미지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. 모든 단계는 체크박스 단위로 진행하고, 테스트 실패 → 최소 구현 → 통과 → 커밋 순서를 지킨다.

**Goal:** 개인 사진·작업 이미지를 원본 우선으로 수집하고, 작은 WebP Capsule·구조화 시각 분석·사용자 검수본을 작업/시리즈 맥락과 함께 관리하며, 사용자가 명시적으로 저장 상태를 낮출 수 있게 한다.

**Architecture:** 기존 `sources/source_versions`를 작업·시리즈와 텍스트 원문의 Source of Truth로 유지하고, 시각 자료는 별도의 `visual_*` 테이블과 R2 객체로 저장한다. 업로드 요청은 원본을 R2에 먼저 기록한 뒤 `VISUAL_TRANSFORM` job을 만들고, 변환 성공 후 `VISUAL_ANALYSIS` job을 연결한다. Cloudflare Images binding은 `VisualTransform` 경계 뒤에 두고, Vision 호출은 `MODEL_VISION` 환경변수를 사용하는 `VisualAnalyzer` 경계 뒤에 둔다. UI는 Inbox 업로드와 Reservoir 읽기 pane 안의 이미지 스트립/검수 패널을 사용하며 새 최상위 메뉴나 사용자 설정을 추가하지 않는다.

**Tech Stack:** Cloudflare Workers + Hono, D1, private R2, Cloudflare Images binding, Workers Workflow, AI Gateway/OpenAI-compatible vision, Workers AI BGE-M3 text embedding, React 19, TypeScript 5.9, Vite 8, Vitest + Testing Library, Playwright

**Approved design:** `docs/superpowers/specs/2026-08-25-visual-reservoir-multimodal-design.md`

## 고정 구현 결정

- 업로드 허용 형식은 JPEG, PNG, WebP, GIF 첫 프레임이다. SVG는 Delivery 1 개인 사진 업로드에서 제외한다.
- 한 파일 최대 크기는 Cloudflare Images binding 입력 한도와 맞춰 `20 MiB`로 제한한다. 한 요청은 파일 1개이며, 웹이 최대 동시 2개로 묶음 업로드한다.
- 원본 R2 key는 `visuals/{assetId}/original/{version}.{ext}`, Capsule key는 `visuals/{assetId}/capsule/{version}.webp`다.
- Capsule은 사진 기본 장변 768px/quality 78, OCR·그래픽 중심 재생성은 장변 1280px/quality 92 또는 lossless WebP다. 원본보다 확대하지 않는다.
- exact hash는 Worker가 원본 bytes의 SHA-256으로 계산한다. perceptual hash는 Cloudflare Images binding으로 9×8 RGBA를 만든 뒤 Worker가 계산한 64-bit dHash(`IMAGES_RGBA_DHASH_V1`)다. 이는 중복 제안용이며 exact hash를 대체하지 않는다.
- 이미지 embedding은 1차에서 raw pixel embedding이 아니라, 구조화 분석의 정규화 텍스트를 기존 BGE-M3로 임베딩한다. `basis = ANALYSIS_TEXT`를 기록해 이미지 벡터처럼 오해하지 않게 한다.
- AI 제안은 `AUTO_SUGGESTION`, 사용자 확정은 새 `USER_VERIFIED` 행이다. 기존 분석 행을 UPDATE하지 않는다.
- `ARCHIVAL → CAPSULE → TEXT_ONLY` 전환은 자동 실행하지 않는다. R2 삭제는 operation journal로 재시도 가능하게 처리한다.
- `MODEL_VISION`은 내부 wrangler var이며 Settings의 공개 모델/파라미터에 노출하지 않는다.

## 파일 구조

### Create

- `worker/migrations/0017_visual_reservoir_core.sql`
- `worker/src/visual/contracts.ts`
- `worker/src/visual/store.ts`
- `worker/src/visual/transform.ts`
- `worker/src/visual/perceptualHash.ts`
- `worker/src/visual/analyzer.ts`
- `worker/src/visual/analysisSchema.ts`
- `worker/src/visual/lifecycle.ts`
- `worker/src/routes/visualAssets.ts`
- `web/src/lib/visualAssets.ts`
- `web/src/lib/visualAssets.test.ts`
- `web/src/components/visual/VisualUploadQueue.tsx`
- `web/src/components/visual/VisualUploadQueue.test.tsx`
- `web/src/components/visual/VisualStrip.tsx`
- `web/src/components/visual/VisualInspector.tsx`
- `web/src/components/visual/VisualReviewForm.tsx`
- `web/src/components/visual/VisualBoard.tsx`
- `web/src/components/visual/VisualWorkspace.test.tsx`
- `web/tests/e2e/visual-reservoir-personal.spec.ts`

### Modify

- `worker/wrangler.jsonc`
- `worker/worker-configuration.d.ts` (generated only via `pnpm cf:typegen`)
- `worker/src/index.ts`
- `worker/src/lib/openai.ts`
- `worker/src/jobs/enqueue.ts`
- `worker/src/workflows/researchJob.ts`
- `worker/src/routes/jobs.ts`
- `worker/src/routes/reservoir.ts`
- `shared/src/index.ts`
- `shared/src/discovery.ts`
- `web/src/lib/researchJobs.ts`
- `web/src/views/InboxView.tsx`
- `web/src/views/InboxView.test.tsx`
- `web/src/views/ReservoirView.tsx`
- `web/src/views/ReservoirView.test.tsx`
- `web/src/components/reading/ReadingPane.tsx`
- `web/src/components/reading/types.ts`
- `web/src/styles/reading.css`
- `web/src/styles/views.css`
- `docs/PROJECT_CONTEXT.md`

---

### Task 1: D1 visual core와 job kind를 원자적으로 추가

**Files:**
- Create: `worker/migrations/0017_visual_reservoir_core.sql`
- Modify: `shared/src/discovery.ts`
- Modify: `worker/src/jobs/enqueue.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `worker/src/routes/jobs.ts`
- Modify: `web/src/lib/researchJobs.ts`
- Test: `web/src/lib/ingestion.test.ts`
- Test: `web/src/lib/remoteAcquisition.test.ts`

**Required schema:**

```sql
visual_assets(
  id, parent_source_id, parent_version_id, origin_kind,
  source_url, page_number, figure_label, bbox_json,
  caption, nearby_text, asset_role, visual_kind,
  selection_status, selection_reason, rights_status,
  is_personal_work, assignment_status, storage_state,
  pending_storage_state, processing_status, last_error,
  content_hash, perceptual_hash, perceptual_hash_method,
  created_at, updated_at, deleted_at
)

visual_asset_versions(
  id, visual_asset_id, version, variant, r2_key, mime_type,
  width, height, byte_size, content_hash, transform_profile_json,
  parent_version_id, created_at, deleted_at,
  UNIQUE(visual_asset_id, version, variant)
)

visual_analyses(
  id, visual_asset_id, visual_version_id, analysis_type,
  provenance_class, payload_json, model_id, prompt_version,
  cost_usd, confidence, review_status, created_at, reviewed_at
)

visual_embeddings(
  id, visual_asset_id, visual_version_id, basis, model_id,
  dimensions, vector_id, created_at,
  UNIQUE(visual_asset_id, visual_version_id, basis, model_id)
)

visual_relations(
  id, from_visual_asset_id, to_visual_asset_id,
  related_source_id, related_thread_id, relation_kind,
  created_by, description, created_at
)

visual_asset_operations(
  id, visual_asset_id, operation_kind, from_state, to_state,
  status, error, created_at, finished_at
)
```

- [ ] 먼저 migration 테스트에 0017 실행 후 모든 테이블·CHECK·index·foreign key가 존재하는 실패 사례를 추가한다.
- [ ] `research_jobs` rebuild가 기존 행과 self-reference `retry_of`를 보존하면서 `VISUAL_TRANSFORM`, `VISUAL_ANALYSIS`, `VISUAL_EXTRACTION`을 허용하는지 테스트한다.
- [ ] `storage_state`는 `ARCHIVAL|CAPSULE|TEXT_ONLY|LINK_ONLY`, `rights_status`는 `PERSONAL|PERMITTED|PUBLIC_LINK|UNKNOWN|RESTRICTED`, `selection_status`는 `SELECTED|REVIEW|DECORATIVE|DUPLICATE|UNAVAILABLE`, `processing_status`는 `UPLOADED|TRANSFORM_PENDING|TRANSFORMING|ANALYSIS_PENDING|ANALYZING|READY|FAILED` CHECK를 둔다.
- [ ] `parent_source_id IS NOT NULL OR assignment_status = 'UNASSIGNED'`를 application invariant로 검사하고, D1 CHECK로도 가능한 범위까지 강제한다.
- [ ] `ResearchJobKind`, enqueue union, retry parser, UI label에 세 job kind를 명시적으로 추가한다. Workflow의 마지막 `else`를 `DEEP_ANALYSIS` fallback으로 사용하지 말고 exhaustive switch + `assertNever`로 바꾼다.
- [ ] `worker/src/routes/jobs.ts`의 retry 입력 복원도 새 union을 통과하게 하고, 알 수 없는 kind는 새 job을 만들지 않고 400을 반환하게 한다.
- [ ] focused test를 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/remoteAcquisition.test.ts
```

Expected: 새 migration과 job kind 회귀 테스트 PASS, `PRAGMA foreign_key_check` 결과 0건.

- [ ] 커밋한다.

```bash
git add worker/migrations/0017_visual_reservoir_core.sql shared/src/discovery.ts worker/src/jobs/enqueue.ts worker/src/workflows/researchJob.ts worker/src/routes/jobs.ts web/src/lib/researchJobs.ts web/src/lib/ingestion.test.ts web/src/lib/remoteAcquisition.test.ts
git commit -m "260825: Visual Reservoir 스키마와 작업 종류 추가"
```

---

### Task 2: 공용 계약과 저장소 경계를 구현

**Files:**
- Create: `worker/src/visual/contracts.ts`
- Create: `worker/src/visual/store.ts`
- Modify: `shared/src/index.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Core contracts:**

```ts
export type VisualStorageState = "ARCHIVAL" | "CAPSULE" | "TEXT_ONLY" | "LINK_ONLY";
export type VisualSelectionStatus = "SELECTED" | "REVIEW" | "DECORATIVE" | "DUPLICATE" | "UNAVAILABLE";
export type VisualRightsStatus = "PERSONAL" | "PERMITTED" | "PUBLIC_LINK" | "UNKNOWN" | "RESTRICTED";
export type VisualVariant = "ORIGINAL" | "CAPSULE" | "SVG_SOURCE";
export type VisualAnalysisType = "AUTO_SUGGESTION" | "USER_VERIFIED";
export type VisualEmbeddingBasis = "ANALYSIS_TEXT";
```

- [ ] serializer/parser 테스트를 먼저 작성해 unknown enum, 잘못된 bbox, 삭제된 version의 공개 URL 생성을 거부하게 한다.
- [ ] `VisualAssetStore`에 `createPersonalOriginal`, `appendVersion`, `getAsset`, `listForSource`, `appendAnalysis`, `appendEmbedding`, `setAssignment`, `beginOperation`, `finishOperation`을 구현한다.
- [ ] D1 row를 API DTO로 직접 반환하지 않는다. R2 key는 서버 내부에만 두고 `GET /api/visual-assets/:id/content?variant=CAPSULE` 같은 인증 경로만 반환한다.
- [ ] `content_hash` exact match는 merge하지 않고 기존 asset ID를 `duplicateOf`로 제안한다. 작업 맥락이 다르면 별도 asset + `DUPLICATE_OF` relation을 허용한다.
- [ ] focused test를 실행하고 커밋한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts
git add shared/src/index.ts worker/src/visual/contracts.ts worker/src/visual/store.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: 시각 자산 계약과 저장 경계 구현"
```

---

### Task 3: 안전한 원본 우선 묶음 업로드를 구현

**Files:**
- Create: `web/src/components/visual/VisualUploadQueue.tsx`
- Create: `web/src/components/visual/VisualUploadQueue.test.tsx`
- Modify: `web/src/views/InboxView.tsx`
- Modify: `web/src/views/InboxView.test.tsx`
- Create: `worker/src/routes/visualAssets.ts`
- Modify: `worker/src/index.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Upload API:**

```http
POST /api/visual-assets
Content-Type: multipart/form-data

file=<binary>
parentSourceId=<optional UUID>
```

- [ ] upload route 테스트에 MIME allowlist, 20 MiB 초과, 빈 파일, 부모 source 미존재, 부분 실패를 추가한다.
- [ ] Worker는 body를 읽은 뒤 magic signature와 `env.IMAGES.info()`를 검증하고, SHA-256을 계산한다. R2 PUT 성공 전에는 D1 asset/version이나 job을 만들지 않는다.
- [ ] R2 PUT 뒤 D1 insert가 실패하면 원본 key를 즉시 삭제하고 `visual_source_store_failed`를 반환한다. 삭제도 실패하면 structured log에 orphan key를 남긴다.
- [ ] 성공 시 `ORIGINAL v1`, `ARCHIVAL`, `PERSONAL`, `SELECTED`를 만들고 `VISUAL_TRANSFORM` job을 enqueue한다. 미지정 업로드는 `UNASSIGNED`이며 분석 job은 나중에 보류한다.
- [ ] enqueue가 실패해도 보존된 원본을 지우지 않는다. asset을 `processing_status=TRANSFORM_PENDING`, `last_error=job_enqueue_failed`로 남기고 API가 asset ID와 `다시 처리` action을 반환하게 한다.
- [ ] Inbox에 `이미지` 탭, dropzone, 작업/시리즈 1회 선택, 파일별 progress/retry/remove를 추가한다. 동시 업로드는 2개, 한 파일 실패가 나머지를 취소하지 않는다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/components/visual/VisualUploadQueue.test.tsx src/views/InboxView.test.tsx
git add web/src/components/visual/VisualUploadQueue.tsx web/src/components/visual/VisualUploadQueue.test.tsx web/src/views/InboxView.tsx web/src/views/InboxView.test.tsx worker/src/routes/visualAssets.ts worker/src/index.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: 개인 이미지 원본 우선 묶음 업로드 구현"
```

---

### Task 4: Cloudflare Images 기반 WebP Capsule 변환을 구현

**Files:**
- Create: `worker/src/visual/transform.ts`
- Create: `worker/src/visual/perceptualHash.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/worker-configuration.d.ts` (generated)
- Modify: `worker/src/workflows/researchJob.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Binding and interface:**

```jsonc
"images": { "binding": "IMAGES" }
```

```ts
export interface VisualTransform {
  createCapsule(input: R2ObjectBody, profile: "PHOTO_V1" | "GRAPHIC_V1"): Promise<{
    body: ReadableStream<Uint8Array>;
    mimeType: "image/webp";
    width: number;
    height: number;
    profile: Record<string, unknown>;
  }>;
}
```

- [ ] fake `ImagesBinding`으로 scale-down, WebP output, metadata 제거, 원본 미확대, idempotent version 생성을 검증하는 실패 테스트를 작성한다.
- [ ] 9×8 RGBA fixture로 luminance 비교 64-bit dHash가 16자리 lowercase hex를 만들고, 재인코딩된 유사 fixture의 Hamming distance가 임계값 이내인 실패 테스트를 작성한다.
- [ ] `PHOTO_V1`은 width 768/fit scale-down/quality 78/anim false, `GRAPHIC_V1`은 width 1280/quality 100/anim false로 구현한다. 첫 변환은 PHOTO_V1이며 분석이 `GRAPHIC|DIAGRAM|DOCUMENT_SCAN`으로 분류하고 OCR 품질이 낮을 때만 GRAPHIC_V1 재변환을 허용한다.
- [ ] transform job은 ORIGINAL R2 object를 읽고 Capsule을 R2에 쓴 뒤에만 `CAPSULE v1` row를 추가한다. 재실행 시 같은 `(asset, version, variant)`를 재사용한다.
- [ ] 같은 ORIGINAL stream을 다시 읽어 `.transform({ width: 9, height: 8, fit: "squeeze" }).output({ format: "rgba" })`한 288 bytes로 dHash를 계산하고 `perceptual_hash`, `perceptual_hash_method=IMAGES_RGBA_DHASH_V1`을 저장한다. hash 실패는 Capsule 성공을 취소하지 않고 `last_error=perceptual_hash_pending`으로 재시도 가능하게 남긴다.
- [ ] 원본이 없으면 `VISUAL_ORIGINAL_MISSING`, Images 변환 실패는 `VISUAL_TRANSFORM_FAILED`로 job에 기록하고 ARCHIVAL 원본은 유지한다.
- [ ] 지정된 parent source가 있으면 transform 완료 후 `VISUAL_ANALYSIS` job을 enqueue한다. UNASSIGNED면 `변환 완료 · 작업 연결 필요`로 종료한다.
- [ ] type generation과 테스트를 실행한다.

```bash
pnpm cf:typegen
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts
pnpm typecheck
```

- [ ] 커밋한다.

```bash
git add worker/wrangler.jsonc worker/worker-configuration.d.ts worker/src/visual/transform.ts worker/src/visual/perceptualHash.ts worker/src/workflows/researchJob.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: WebP Visual Capsule 변환 파이프라인 구현"
```

---

### Task 5: 구조화 vision 분석과 분석 텍스트 embedding을 구현

**Files:**
- Create: `worker/src/visual/analysisSchema.ts`
- Create: `worker/src/visual/analyzer.ts`
- Modify: `worker/src/lib/openai.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/workflows/researchJob.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Analysis payload:**

```ts
interface VisualAnalysisPayload {
  observation: {
    orientation: string;
    entities: Array<{ label: string; position?: string; confidence: number }>;
    composition: string[];
    lightColorTexture: string[];
    spatialRelations: string[];
    ocr: Array<{ text: string; confidence: number }>;
  };
  formalInterpretation: Array<{ claim: string; evidence: string[]; confidence: number }>;
  context: Array<{ claim: string; source: "USER" | "SOURCE" | "IMAGE" }>;
  uncertainty: string[];
  artisticProposition: Array<{ proposal: string; basedOn: string[] }>;
  visualKind: "PHOTO" | "ARTWORK" | "INSTALLATION" | "GRAPHIC" | "DIAGRAM" | "DOCUMENT_SCAN" | "OTHER";
}
```

- [ ] parser 테스트를 먼저 작성해 observation 누락, 0~1 밖 confidence, 문자열만 있는 근거, 작가 의도/인물 신원 단정 문구를 거부하거나 uncertainty로 강등한다.
- [ ] `OpenAiMessage.content`를 string 또는 `text/image_url` parts로 확장한다. 기존 text-only 호출 snapshot이 바뀌지 않는 회귀 테스트를 둔다.
- [ ] `VisualAnalyzer`는 Capsule을 data URL로 전달하고 parent source title/사용자 메모만 최소 context로 포함한다. 응답은 JSON mode, prompt version `visual-analysis-v1`로 기록한다.
- [ ] `MODEL_VISION`을 wrangler vars에 추가하되 모델 ID를 코드에 하드코딩하지 않는다. Settings API에는 포함하지 않는다.
- [ ] 분석 전 기존 monthly budget + atomic reservation guard를 사용한다. 예산 부족은 `BLOCKED/VISUAL_BUDGET_EXCEEDED`, 모델 실패는 Capsule을 유지한 `FAILED/VISUAL_ANALYSIS_FAILED`다.
- [ ] AUTO_SUGGESTION 저장 후 payload를 결정론적 텍스트로 직렬화하고 기존 embedding adapter로 BGE-M3 vector를 만든다. `basis=ANALYSIS_TEXT`와 model ID를 D1/Vectorize 양쪽에 기록한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/lib/deepAnalysis.test.ts
pnpm typecheck
git add worker/src/visual/analysisSchema.ts worker/src/visual/analyzer.ts worker/src/lib/openai.ts worker/wrangler.jsonc worker/src/workflows/researchJob.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: 구조화 시각 분석과 분석 임베딩 구현"
```

---

### Task 6: 작업 연결, 사용자 검수, 중복 제안을 구현

**Files:**
- Modify: `worker/src/routes/visualAssets.ts`
- Modify: `worker/src/visual/store.ts`
- Create: `web/src/lib/visualAssets.ts`
- Create: `web/src/components/visual/VisualReviewForm.tsx`
- Test: `web/src/components/visual/VisualWorkspace.test.tsx`

**Endpoints:**

```http
PATCH /api/visual-assets/:id/assignment
POST  /api/visual-assets/:id/reviews
GET   /api/visual-assets/:id/duplicates
GET   /api/visual-assets/:id/content?variant=ORIGINAL|CAPSULE
```

- [ ] assignment 변경이 relation을 보존하고, UNASSIGNED→ASSIGNED 시 분석 job을 한 번만 enqueue하는 테스트를 작성한다.
- [ ] review endpoint는 전체 payload를 검증하고 `USER_VERIFIED` 새 row를 추가한다. `AUTO_SUGGESTION` UPDATE를 금지하는 테스트를 둔다.
- [ ] duplicate query는 exact hash 우선, dHash Hamming distance 임계값 두 번째, 분석 텍스트 vector 유사도 세 번째로 제안한다. 자동 merge하지 않는다.
- [ ] content endpoint는 Access 뒤에서만 제공하고 `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, 정확한 MIME을 반환한다. deleted version은 404다.
- [ ] Review form은 관찰·형식 해석·불확실성·작업 제안을 분리해 편집하며 `채택·수정`, `나중에`만 기본 action으로 노출한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/components/visual/VisualWorkspace.test.tsx
git add worker/src/routes/visualAssets.ts worker/src/visual/store.ts web/src/lib/visualAssets.ts web/src/components/visual/VisualReviewForm.tsx web/src/components/visual/VisualWorkspace.test.tsx
git commit -m "260825: 시각 분석 검수와 중복 제안 구현"
```

---

### Task 7: 저장 상태 전환과 삭제 operation journal을 구현

**Files:**
- Create: `worker/src/visual/lifecycle.ts`
- Modify: `worker/src/routes/visualAssets.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Endpoint:**

```http
POST /api/visual-assets/:id/storage-transition
{ "target": "CAPSULE" | "TEXT_ONLY", "confirmation": "DELETE_ORIGINAL" | "DELETE_CAPSULE" }
```

- [ ] 잘못된 역방향 전환, 검수 전 전환, confirmation 불일치, 이미 삭제된 object, R2 delete 실패를 테스트한다.
- [ ] `ARCHIVAL→CAPSULE`은 Capsule 존재를 먼저 확인하고 D1 transaction에서 operation PENDING + `pending_storage_state=CAPSULE`을 기록한 뒤 ORIGINAL R2 삭제 → D1 transaction에서 version `deleted_at` + asset state 변경 + pending 해제 + operation SUCCEEDED 순서로 처리한다.
- [ ] `CAPSULE→TEXT_ONLY`도 같은 순서를 사용한다. 실패 시 asset state는 이전 상태를 유지하고 operation FAILED + 재시도 정보를 남긴다.
- [ ] R2 삭제 뒤 마지막 D1 transaction이 실패하면 pending 상태를 유지한다. 재시도는 R2 404를 성공으로 취급해 tombstone/state를 idempotently 마무리하며, UI는 그동안 `삭제 마무리 중`으로 표시한다.
- [ ] 파일 삭제 뒤 content hash, dimensions, 분석, 검수, relation, tombstone은 유지한다.
- [ ] 강제 전환은 `USER_VERIFIED`가 없을 때만 추가 경고 confirmation을 요구하고, API가 이를 명시적으로 검증한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts
git add worker/src/visual/lifecycle.ts worker/src/routes/visualAssets.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: Visual Capsule 저장 단계와 안전 삭제 구현"
```

---

### Task 8: Reservoir 인라인 이미지 판단과 시각 보드를 구현

**Files:**
- Create: `web/src/components/visual/VisualStrip.tsx`
- Create: `web/src/components/visual/VisualInspector.tsx`
- Create: `web/src/components/visual/VisualBoard.tsx`
- Modify: `web/src/components/reading/ReadingPane.tsx`
- Modify: `web/src/components/reading/types.ts`
- Modify: `web/src/views/ReservoirView.tsx`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `web/src/styles/reading.css`
- Modify: `web/src/styles/views.css`
- Test: `web/src/views/ReservoirView.test.tsx`
- Test: `web/src/components/visual/VisualWorkspace.test.tsx`

- [ ] Reservoir detail DTO에 `visuals: { total, selected, review, archival, capsule, textOnly }`와 현재 source의 lightweight visual list를 추가하는 실패 테스트를 작성한다.
- [ ] `VisualStrip`은 현재 Source 이미지 thumbnail을 가로로 표시하고 keyboard selection/aria label을 제공한다. 이미지를 선택해도 source `readingKey`를 바꾸지 않는다.
- [ ] `VisualInspector`는 reading pane 안에서 이미지, provenance, AUTO/USER 분석, uncertainty, review action을 표시한다. 닫을 때 DOM의 원문을 재생성하지 않아 scrollTop이 유지되어야 한다.
- [ ] `VisualBoard`는 현재 Source가 기본 scope이며 작업/시리즈/전체로 확장할 수 있다. 이는 별도 공개 설정이 아니라 일시적 view filter다.
- [ ] board는 reading pane 내부 overlay/dialog로 열어 기존 source 목록과 원문 DOM을 유지한다. 닫으면 focus와 scroll을 복원한다.
- [ ] 좁은 화면에서는 inspector가 sheet가 되고 목록·읽기·분석이 동시에 겹치지 않게 한다.
- [ ] storage transition은 kebab 관리 메뉴 아래에 두고 확인 dialog에서 삭제 대상과 유지 데이터를 문장으로 보여준다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/views/ReservoirView.test.tsx src/components/visual/VisualWorkspace.test.tsx
git add worker/src/routes/reservoir.ts web/src/components/reading/ReadingPane.tsx web/src/components/reading/types.ts web/src/views/ReservoirView.tsx web/src/components/visual/VisualStrip.tsx web/src/components/visual/VisualInspector.tsx web/src/components/visual/VisualBoard.tsx web/src/styles/reading.css web/src/styles/views.css web/src/views/ReservoirView.test.tsx web/src/components/visual/VisualWorkspace.test.tsx
git commit -m "260825: 저장소 인라인 시각 검수와 비교 보드 구현"
```

---

### Task 9: 개인 이미지 E2E, 운영 문서, 배포 체크포인트

**Files:**
- Create: `web/tests/e2e/visual-reservoir-personal.spec.ts`
- Modify: `docs/PROJECT_CONTEXT.md`

- [ ] E2E fixture 3개(사진, 텍스트 중심 그래픽, 동일 사진 재인코딩)를 `web/tests/fixtures/visual/`에 작은 테스트 자산으로 추가한다.
- [ ] E2E에서 묶음 업로드 일부 실패, 작업 연결, Capsule 생성, 자동 분석, 사용자 수정, 중복 제안, board 진입/복귀 scroll, ARCHIVAL→CAPSULE 확인을 검증한다.
- [ ] 파괴적 테스트는 로컬/preview 전용 fixture asset에만 수행하고 프로덕션 데이터에는 실행하지 않는다.
- [ ] `docs/PROJECT_CONTEXT.md`에 schema, R2 key, job kinds, MODEL_VISION, embedding basis, 공개 API, 저장 상태를 기록한다.
- [ ] 전체 검증을 실행한다.

```bash
pnpm typecheck
pnpm build
pnpm --dir web exec vitest run
pnpm --dir web exec playwright test tests/e2e/visual-reservoir-personal.spec.ts
git status --short
```

Expected: typecheck/build/test/E2E PASS. 계획과 무관한 기존 dirty/untracked 파일은 그대로 남는다.

- [ ] 문서와 E2E를 커밋한다.

```bash
git add docs/PROJECT_CONTEXT.md web/tests/e2e/visual-reservoir-personal.spec.ts web/tests/fixtures/visual
git commit -m "260825: 개인 이미지 Visual Reservoir 검증과 운영 문서화"
```

- [ ] 사용자 승인 후에만 D1 migration과 배포를 실행한다.

```bash
pnpm db:migrate
pnpm deploy
```

- [ ] 배포 후 smoke test: 이미지 1장 업로드 → Job Center transform/analysis 완료 → Reservoir thumbnail/inspector → 사용자 검수 저장 → 원본 endpoint Access 보호를 확인한다.

## Delivery 1 완료 기준

- 원본 R2 PUT 전에는 D1 asset/job이 만들어지지 않는다.
- 개인 이미지 기본 상태는 ARCHIVAL이며 원본·Capsule이 모두 존재한다.
- 실패 파일만 재시도할 수 있고 묶음 전체가 실패하지 않는다.
- AI 제안과 USER_VERIFIED 이력이 분리된다.
- dHash는 중복 제안만 하며 자동 merge하지 않는다.
- embedding은 `ANALYSIS_TEXT`라고 명시된다.
- 저장 상태 전환은 명시적 확인과 operation journal을 거친다.
- 이미지 판단 후 Source/목록/원문 scroll이 유지된다.
- Settings의 공개 파라미터는 기존 5개 그대로다.
