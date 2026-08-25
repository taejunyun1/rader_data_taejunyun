# Visual Reservoir Delivery 2 — PDF·웹 시각 자료 추출 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Delivery 1 완료·배포 검증 후 시작한다.

**Goal:** 업로드/발견 PDF와 웹 원문에서 연구 가치가 있는 사진·작품·설치 전경·도판·그래프·다이어그램을 찾아 부모 원문 위치와 함께 검토하게 하고, 장식·광고·반복 이미지는 기본 흐름에서 걸러낸다.

**Architecture:** Delivery 1의 `visual_*`, `VisualTransform`, `VisualAnalyzer`, `VisualReview`를 재사용한다. 저장된 raw HTML은 Worker가 본문 범위의 이미지 URL과 문맥을 결정론적으로 추출한다. PDF는 현재 제품의 입력 경로 결정을 유지해 브라우저 `pdf.js`가 원본 PDF를 페이지별 저해상도 WebP로 렌더링하고 extraction run에 업로드하며, Worker workflow가 page preview에서 bbox 후보를 판정·crop·필터한다. 임시 page preview는 R2에 최대 24시간만 남기고, 선택되지 않은 후보는 지속 이미지 객체를 만들지 않는다.

**Why PDF is browser-assisted:** 현재 Workers AI `toMarkdown`은 PDF의 구조화 텍스트와 이미지 설명은 제공하지만 개별 figure bytes/bbox를 반환하지 않는다. 별도 PDF 서버나 브라우저 렌더링 서비스를 추가하지 않고 기존 `pdfjs-dist`를 재사용하는 것이 Cloudflare-first/External-minimal 원칙과 현재 SPEC D5를 보존한다.

**Tech Stack:** Delivery 1 stack + `pdfjs-dist` browser rasterization, existing SSRF-safe remote fetch, HTML deterministic extraction, R2 temporary page previews

**Prerequisite:** `docs/superpowers/plans/2026-08-25-visual-reservoir-delivery-1-plan.md`의 완료 기준 전부 통과.

## 고정 구현 결정

- 웹 HTML acquisition 성공 시 `VISUAL_EXTRACTION`을 자동 enqueue하되, source당 최대 후보 40개, 다운로드/변환 대상 최대 12개다.
- PDF는 UI에서 `시각 자료 찾기`를 한 번 누르면 page scan이 시작된다. 브라우저는 최대 동시 1페이지 렌더링/2개 업로드로 진행하고, 탭을 닫아도 업로드 완료 page까지 보존된다. 같은 run을 열면 남은 페이지부터 재개한다.
- PDF page preview는 장변 최대 1600px, WebP quality 82다. 원본 PDF와 active source version이 항상 Source of Truth다.
- 페이지가 80장을 넘으면 40장 chunk로 처리하고 다음 chunk를 자동 이어가되, 사용자가 취소할 수 있다. 이는 설정 파라미터가 아니라 처리 안전 상한이다.
- PDF visual asset은 `origin_kind=PDF_PAGE_CROP`, `page_number`, normalized bbox `[x,y,width,height]`, Figure/caption/nearby text를 가진다. UI에서 `PDF 페이지 파생`으로 표시한다.
- 웹 external asset은 권리가 `UNKNOWN|RESTRICTED`면 LINK_ONLY다. `PERMITTED` 근거를 사용자가 기록한 후에만 WebP Capsule을 R2에 저장한다.
- SVG 원문은 `SVG_SOURCE`로 참조/보존할 수 있지만 사진을 SVG로 변환하지 않는다. 외부 SVG도 rights gate를 통과한다.
- 필터는 결정론적 규칙 → exact/near duplicate → vision relevance 순서다. 작은 크기 하나만으로 자동 폐기하지 않는다.
- 정상 0건은 성공이다. 일부 후보 실패는 부모 source/job 전체 실패가 아니다.

## 파일 구조

### Create

- `worker/migrations/0018_visual_extraction_runs.sql`
- `worker/src/visual/extractHtmlVisuals.ts`
- `worker/src/visual/extractPdfVisuals.ts`
- `worker/src/visual/extractionStore.ts`
- `worker/src/visual/filter.ts`
- `worker/src/visual/fetchRemoteImage.ts`
- `worker/src/visual/cleanup.ts`
- `worker/src/routes/visualExtraction.ts`
- `web/src/lib/pdfVisualExtraction.ts`
- `web/src/lib/pdfVisualExtraction.test.ts`
- `web/src/components/visual/PdfExtractionProgress.tsx`
- `web/src/components/visual/PdfCropPreview.tsx`
- `web/src/components/visual/FilteredVisualsDisclosure.tsx`
- `web/tests/e2e/visual-extraction-web-pdf.spec.ts`
- `web/tests/fixtures/visual/article-with-figures.html`
- `web/tests/fixtures/visual/figures-and-decoration.pdf`

### Modify

- `worker/src/index.ts`
- `worker/src/ingestion/extractHtml.ts`
- `worker/src/ingestion/acquireRemoteSource.ts`
- `worker/src/ingestion/fetchRemoteDocument.ts`
- `worker/src/workflows/researchJob.ts`
- `worker/src/routes/reservoir.ts`
- `web/src/views/ReservoirView.tsx`
- `web/src/views/ReservoirView.test.tsx`
- `web/src/components/reading/ReadingPane.tsx`
- `web/src/components/visual/VisualStrip.tsx`
- `web/src/components/visual/VisualInspector.tsx`
- `web/src/components/visual/VisualBoard.tsx`
- `web/src/styles/reading.css`
- `docs/PROJECT_CONTEXT.md`

---

### Task 1: extraction run과 임시 페이지 checkpoint 스키마를 추가

**Files:**
- Create: `worker/migrations/0018_visual_extraction_runs.sql`
- Create: `worker/src/visual/extractionStore.ts`
- Test: `web/src/lib/ingestion.test.ts`
- Test: `web/src/lib/visualAssets.test.ts`

**Schema:**

```sql
visual_extraction_runs(
  id, parent_source_id, parent_version_id, origin_kind,
  status, total_units, uploaded_units, processed_units,
  selected_count, review_count, filtered_count, unavailable_count,
  error, created_at, updated_at, finished_at
)

visual_extraction_units(
  id, run_id, unit_number, status, temp_r2_key,
  width, height, content_hash, error, created_at, processed_at, deleted_at,
  UNIQUE(run_id, unit_number)
)
```

- [ ] migration 실패 테스트에 FK, unique unit, status CHECK, source/version index, 오래된 temp unit 조회 index를 추가한다.
- [ ] run status는 `UPLOADING|QUEUED|RUNNING|SUCCEEDED|PARTIAL|FAILED|CANCELLED`, unit status는 `UPLOADED|PROCESSING|SUCCEEDED|FAILED|DELETED`로 제한한다.
- [ ] `ExtractionStore`에 `createOrResumeRun`, `recordUnit`, `markUnitProcessed`, `updateCounts`, `finishRun`, `listExpiredTempObjects`를 구현한다.
- [ ] 같은 `(source, active version, origin kind)`의 RUNNING run은 재사용하고 active version이 바뀌면 새 run을 만든다.
- [ ] 0건 성공과 부분 성공을 표현할 수 있도록 job status와 run counts를 분리한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/ingestion.test.ts src/lib/visualAssets.test.ts
git add worker/migrations/0018_visual_extraction_runs.sql worker/src/visual/extractionStore.ts web/src/lib/ingestion.test.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: 시각 추출 run과 임시 페이지 체크포인트 추가"
```

---

### Task 2: HTML 본문 이미지 후보와 문맥을 결정론적으로 추출

**Files:**
- Create: `worker/src/visual/extractHtmlVisuals.ts`
- Modify: `worker/src/ingestion/extractHtml.ts`
- Test: `web/src/lib/remoteAcquisition.test.ts`
- Fixture: `web/tests/fixtures/visual/article-with-figures.html`

**Candidate contract:**

```ts
interface HtmlVisualCandidate {
  candidateKey: string;
  sourceUrl: string;
  sourceSetUrls: string[];
  alt: string | null;
  figureLabel: string | null;
  caption: string | null;
  nearbyText: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  deterministicSignals: string[];
}
```

- [ ] fixture에 본문 figure, srcset, relative URL, data URI tracking pixel, header logo, repeated icon, ad slot, CSS background를 포함하고 예상 후보/제외 이유 테스트를 먼저 작성한다.
- [ ] 기존 `extractStaticHtml`이 선택한 article/main fragment를 함께 반환하도록 내부 result를 확장하되 기존 API text 결과는 바꾸지 않는다.
- [ ] `img`, `picture/source`, `figure/figcaption`만 기본 후보로 수집하고 URL은 `finalUrl` 기준으로 resolve한다. data/blob/javascript URL은 거부한다.
- [ ] srcset은 가장 큰 합리적 candidate를 선택하되 원본 URL 목록을 provenance로 보존한다.
- [ ] header/footer/nav/aside, 명시적 ad/tracker/social class, 1×1, 동일 공통 logo는 deterministicSignals에 제외 이유를 기록한다.
- [ ] width/height가 작아도 `figure`, 캡션, 주변 문단 관련성이 있으면 REVIEW 후보로 남긴다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts
git add worker/src/visual/extractHtmlVisuals.ts worker/src/ingestion/extractHtml.ts web/src/lib/remoteAcquisition.test.ts web/tests/fixtures/visual/article-with-figures.html
git commit -m "260825: 웹 본문 이미지 후보와 문맥 추출 구현"
```

---

### Task 3: 외부 이미지 fetch 안전성과 rights-first LINK_ONLY 저장을 구현

**Files:**
- Create: `worker/src/visual/fetchRemoteImage.ts`
- Create: `worker/src/visual/filter.ts`
- Create: `worker/src/routes/visualExtraction.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/ingestion/fetchRemoteDocument.ts`
- Test: `web/src/lib/remoteAcquisition.test.ts`
- Test: `web/src/lib/visualAssets.test.ts`

- [ ] 기존 remote fetch의 URL/DNS/redirect/private-network 검사를 공용 helper로 export하고 image-only fetch가 같은 차단 규칙을 쓰는 테스트를 작성한다.
- [ ] 허용 MIME은 JPEG/PNG/WebP/GIF/SVG, 최대 response 10 MiB, redirect 5회다. `Content-Type`과 magic mismatch는 `IMAGE_TYPE_INVALID`, 초과는 `IMAGE_SIZE_LIMIT`이다.
- [ ] deterministic filter 결과를 `DECORATIVE|DUPLICATE|UNAVAILABLE|REVIEW`로 visual_assets에 기록하되 이미지 bytes는 지속 R2에 저장하지 않는다.
- [ ] `UNKNOWN|RESTRICTED`는 source URL, final URL, caption, nearby text, 판정 이유만 가진 LINK_ONLY다.
- [ ] `PERMITTED|PERSONAL`만 exact hash 후 Delivery 1 `VisualTransform`으로 Capsule을 생성한다. `PUBLIC_LINK`는 기본 LINK_ONLY이며 사용자가 명시적으로 permitted 근거를 추가하지 않으면 저장하지 않는다.
- [ ] HTML raw acquisition 성공 뒤 source/version당 dedupe된 `VISUAL_EXTRACTION` job을 enqueue하도록 `acquireRemoteSource.ts`를 연결한다. visual enqueue 실패는 source acquisition 성공을 뒤집지 않고 diagnostic warning으로 남긴다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/remoteAcquisition.test.ts src/lib/visualAssets.test.ts
git add worker/src/visual/fetchRemoteImage.ts worker/src/visual/filter.ts worker/src/routes/visualExtraction.ts worker/src/index.ts worker/src/ingestion/fetchRemoteDocument.ts worker/src/ingestion/acquireRemoteSource.ts web/src/lib/remoteAcquisition.test.ts web/src/lib/visualAssets.test.ts
git commit -m "260825: 외부 이미지 안전 수집과 권리 게이트 구현"
```

---

### Task 4: PDF 원본 스트리밍과 브라우저 페이지 raster checkpoint를 구현

**Files:**
- Create: `web/src/lib/pdfVisualExtraction.ts`
- Create: `web/src/lib/pdfVisualExtraction.test.ts`
- Create: `web/src/components/visual/PdfExtractionProgress.tsx`
- Create: `web/src/components/visual/PdfCropPreview.tsx`
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `worker/src/routes/visualExtraction.ts`
- Modify: `web/src/views/ReservoirView.tsx`
- Test: `web/src/views/ReservoirView.test.tsx`

**Endpoints:**

```http
POST /api/visual-extraction/pdf/runs
GET  /api/visual-extraction/pdf/runs/:runId
PUT  /api/visual-extraction/pdf/runs/:runId/pages/:pageNumber
POST /api/visual-extraction/pdf/runs/:runId/finalize
GET  /api/reservoir/:sourceId/original?version=<activeVersionId>
```

- [ ] original endpoint가 active PDF version의 R2 key만 읽고 `application/pdf`, `Content-Disposition: inline`, `nosniff`, `Cache-Control: private`를 반환하는 테스트를 작성한다. HTML raw는 이 endpoint에서 렌더링하지 않는다.
- [ ] `renderPdfVisualPages(blob, checkpoint)`는 기존 `pdfjs-dist` worker 설정을 재사용하고, 장변 1600 이하 WebP quality 0.82로 페이지를 순차 렌더링한다.
- [ ] `PdfCropPreview`는 LINK_ONLY PDF asset을 열 때 부모 PDF의 해당 page만 브라우저 메모리에서 렌더링하고 normalized bbox로 canvas crop한다. 결과는 object URL로만 표시하고 서버/R2에 재업로드하지 않으며 component unmount 시 해제한다.
- [ ] 각 page upload에는 page number, pixel width/height, content hash가 포함된다. 서버는 run source/version 일치와 WebP magic/size를 검증한 뒤 `visual-temp/{runId}/page-{n}.webp`에 저장한다.
- [ ] client는 서버 checkpoint를 읽어 이미 업로드된 page를 건너뛰고, AbortController로 취소할 수 있다. 재진입하면 남은 page부터 이어진다.
- [ ] 40-page chunk와 전체 80+ page continuation을 테스트한다. 페이지 하나 실패 시 그 page만 retry하고 이전 성공 page는 유지한다.
- [ ] finalize는 업로드된 unit이 1개 이상일 때 `VISUAL_EXTRACTION` job을 enqueue하고, 0개면 actionable error를 반환한다.
- [ ] UI는 `시각 자료 찾기`, 진행률, `중지`, `계속`만 노출하고 저수준 해상도/동시성 설정은 노출하지 않는다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/pdfVisualExtraction.test.ts src/views/ReservoirView.test.tsx src/lib/visualAssets.test.ts
git add web/src/lib/pdfVisualExtraction.ts web/src/lib/pdfVisualExtraction.test.ts web/src/components/visual/PdfExtractionProgress.tsx web/src/components/visual/PdfCropPreview.tsx worker/src/routes/reservoir.ts worker/src/routes/visualExtraction.ts web/src/views/ReservoirView.tsx web/src/views/ReservoirView.test.tsx
git commit -m "260825: PDF 페이지 시각 추출 체크포인트 구현"
```

---

### Task 5: PDF page vision bbox 추출·crop·필터 workflow를 구현

**Files:**
- Create: `worker/src/visual/extractPdfVisuals.ts`
- Modify: `worker/src/visual/filter.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Test: `web/src/lib/visualAssets.test.ts`
- Fixture: `web/tests/fixtures/visual/figures-and-decoration.pdf`

**PDF vision output:**

```ts
interface PdfPageCandidate {
  bbox: { x: number; y: number; width: number; height: number }; // all 0..1
  visualKind: "PHOTO" | "ARTWORK" | "INSTALLATION" | "GRAPHIC" | "DIAGRAM" | "DOCUMENT_SCAN" | "DECORATIVE";
  figureLabel: string | null;
  caption: string | null;
  reason: string;
  confidence: number;
}
```

- [ ] schema parser가 out-of-range bbox, overlapping near-identical boxes, whole-page background, header/footer logo를 정리하는 실패 테스트를 작성한다.
- [ ] extraction job은 page unit별로 vision model을 호출하며 parent normalized text에서 해당 page의 Figure/caption 힌트만 제한적으로 전달한다.
- [ ] bbox를 page pixel의 `top/right/bottom/left` trim 값으로 환산하고 Cloudflare Images `.transform({ trim: { ... } })` 뒤 scale-down을 적용해 저용량 candidate를 만든다. 이 crop은 filter/분류용 임시 bytes다.
- [ ] parent rights가 `PERSONAL|PERMITTED`인 SELECTED/REVIEW만 Delivery 1 Capsule 경계로 전달한다. `UNKNOWN|RESTRICTED|PUBLIC_LINK`는 page/bbox/문맥만 LINK_ONLY로 남기고 crop bytes를 삭제하며, UI는 `PdfCropPreview`로 필요할 때만 다시 보여준다.
- [ ] 전체 페이지 scan 자체가 작품인 경우 `DOCUMENT_SCAN`으로 한 장을 허용하되 반복 배경/페이지 전체 캡처와 구분 이유를 기록한다.
- [ ] 임시 crop에도 Delivery 1 `IMAGES_RGBA_DHASH_V1`을 적용한다. exact hash 반복 또는 dHash Hamming distance 임계값 이내 candidate는 DUPLICATE relation만 만들고 자동 merge하지 않는다.
- [ ] job은 unit 성공마다 checkpoint와 counts를 갱신한다. 한 unit failure는 UNAVAILABLE로 기록하고 다음 unit을 계속한다.
- [ ] job 완료 또는 실패 후 처리된 temp page를 삭제한다. 삭제 실패는 cleanup 대상에 남기고 추출 성공을 뒤집지 않는다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts
git add worker/src/visual/extractPdfVisuals.ts worker/src/visual/filter.ts worker/src/workflows/researchJob.ts web/src/lib/visualAssets.test.ts web/tests/fixtures/visual/figures-and-decoration.pdf
git commit -m "260825: PDF 도판 bbox 추출과 필터 workflow 구현"
```

---

### Task 6: 공통 Visual Extraction Gate와 사용자 복구를 완성

**Files:**
- Modify: `worker/src/visual/filter.ts`
- Modify: `worker/src/routes/visualExtraction.ts`
- Create: `web/src/components/visual/FilteredVisualsDisclosure.tsx`
- Modify: `web/src/components/visual/VisualInspector.tsx`
- Test: `web/src/components/visual/VisualWorkspace.test.tsx`

**Filter order:**

```text
URL/MIME/size safety
→ deterministic decoration/tracker/repetition rules
→ exact hash / available dHash
→ caption + nearby text relevance
→ vision kind/confidence
→ SELECTED | REVIEW | DECORATIVE | DUPLICATE | UNAVAILABLE
```

- [ ] 작은 핵심 도판, 큰 광고, 반복 로고, 동일 URL 다른 query, 같은 이미지 다른 crop, 접근 실패 fixture를 포함한 table-driven 테스트를 작성한다.
- [ ] filter 결과는 항상 `selectionReason`과 rule version `visual-filter-v1`을 가진다.
- [ ] 기본 strip/board에는 SELECTED와 REVIEW만 표시한다. 나머지는 `필터링된 이미지 N개` disclosure에 이유별 집계로 표시한다.
- [ ] 사용자가 DECORATIVE/DUPLICATE를 REVIEW 또는 SELECTED로 복구하면 원래 자동 판정을 relation/audit에 남기고 현재 status만 변경한다.
- [ ] `장식 이미지` 판단은 즉시 UI에서 빠지지만 undo toast와 disclosure 복구 경로를 제공한다.
- [ ] 0건이면 `이미지를 찾지 못함`과 `모두 장식으로 분류됨`을 구분한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/components/visual/VisualWorkspace.test.tsx src/lib/visualAssets.test.ts
git add worker/src/visual/filter.ts worker/src/routes/visualExtraction.ts web/src/components/visual/FilteredVisualsDisclosure.tsx web/src/components/visual/VisualInspector.tsx web/src/components/visual/VisualWorkspace.test.tsx
git commit -m "260825: 시각 추출 필터와 사용자 복구 흐름 완성"
```

---

### Task 7: 원문 인라인 위치·Figure provenance와 비교 UX를 연결

**Files:**
- Modify: `worker/src/routes/reservoir.ts`
- Modify: `web/src/components/reading/ReadingPane.tsx`
- Modify: `web/src/components/visual/VisualStrip.tsx`
- Modify: `web/src/components/visual/VisualInspector.tsx`
- Modify: `web/src/components/visual/VisualBoard.tsx`
- Modify: `web/src/components/visual/PdfCropPreview.tsx`
- Modify: `web/src/views/ReservoirView.tsx`
- Modify: `web/src/styles/reading.css`
- Test: `web/src/views/ReservoirView.test.tsx`
- Test: `web/src/components/visual/VisualWorkspace.test.tsx`

- [ ] API DTO가 HTML nearby text anchor와 PDF page/figure/bbox를 반환하고, deleted/LINK_ONLY/UNAVAILABLE content URL을 잘못 노출하지 않는 테스트를 작성한다.
- [ ] HTML visual은 nearby paragraph 뒤에, PDF visual은 page/figure 그룹으로 ReadingPane에 배치한다. 정확한 text offset이 없으면 source 상단 strip에 표시하고 가짜 위치를 만들지 않는다.
- [ ] inspector에 `웹 원문`, `PDF p.N / Figure`, `PDF 페이지 파생`, rights/storage state를 명확히 표시한다.
- [ ] 웹 LINK_ONLY는 외부 링크와 메타데이터만, PDF LINK_ONLY는 `PdfCropPreview`의 일시적 crop과 메타데이터만 표시한다. 분석 재실행 버튼은 비활성화하고 permitted 전환 action은 관리 메뉴에 둔다.
- [ ] 시각 보드에서 source scope 기본, 작업/시리즈/전체 확장, SELECTED/REVIEW/필터링/storage filters가 동작하도록 한다.
- [ ] board 진입·닫기 뒤 source 선택, 목록 scroll, 원문 scroll, inspector focus가 복원되는 테스트를 작성한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/views/ReservoirView.test.tsx src/components/visual/VisualWorkspace.test.tsx
git add worker/src/routes/reservoir.ts web/src/components/reading/ReadingPane.tsx web/src/components/visual/VisualStrip.tsx web/src/components/visual/VisualInspector.tsx web/src/components/visual/VisualBoard.tsx web/src/components/visual/PdfCropPreview.tsx web/src/views/ReservoirView.tsx web/src/styles/reading.css web/src/views/ReservoirView.test.tsx web/src/components/visual/VisualWorkspace.test.tsx
git commit -m "260825: 원문 연결 시각 자료와 비교 UX 구현"
```

---

### Task 8: 임시 R2 정리, 비용 상한, 재시도 관찰성을 추가

**Files:**
- Create: `worker/src/visual/cleanup.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/workflows/researchJob.ts`
- Modify: `web/src/lib/researchJobs.ts`
- Test: `web/src/lib/visualAssets.test.ts`

- [ ] 24시간 지난 SUCCEEDED/FAILED extraction unit의 temp R2 key만 삭제하고 RUNNING/recent unit은 보존하는 테스트를 작성한다.
- [ ] cleanup은 R2 delete 후 `deleted_at`을 기록하고, 실패 key는 다음 cron에 재시도한다.
- [ ] source당 HTML 후보 40/다운로드 12, PDF page chunk 40, run당 vision call 상한을 코드 상수로 두고 diagnostic에 실제 차단 수를 기록한다.
- [ ] 모든 vision call이 monthly budget reservation을 거치고, budget block은 candidate를 REVIEW로 남긴 채 job을 BLOCKED로 표시한다.
- [ ] Job Center result ref는 source/run으로 이동하고 `웹 이미지 추출`, `PDF 이미지 추출`, `일부 이미지 확인 필요`를 구분한다.
- [ ] retry는 같은 run/unit/version을 재사용하고 duplicate Capsule을 만들지 않는다.
- [ ] `worker/src/index.ts` scheduled handler의 두 cron 경로 모두 종료 전에 cleanup을 호출하되, cleanup 실패가 homepage sync/snapshot/discovery 결과를 뒤집지 않게 한다.
- [ ] 테스트와 커밋을 실행한다.

```bash
pnpm --dir web exec vitest run src/lib/visualAssets.test.ts src/components/layout/JobCenter.test.tsx
git add worker/src/visual/cleanup.ts worker/src/index.ts worker/src/workflows/researchJob.ts web/src/lib/researchJobs.ts web/src/lib/visualAssets.test.ts web/src/components/layout/JobCenter.test.tsx
git commit -m "260825: 시각 추출 임시 자산 정리와 작업 관찰성 추가"
```

---

### Task 9: 웹·PDF E2E와 독립 배포 검증

**Files:**
- Create: `web/tests/e2e/visual-extraction-web-pdf.spec.ts`
- Modify: `docs/PROJECT_CONTEXT.md`

- [ ] HTML fixture acquisition → candidate extraction → 광고/로고 제외 → LINK_ONLY review를 검증한다.
- [ ] PDF fixture original stream → page checkpoint → bbox extraction → Figure/page provenance → temp R2 cleanup을 검증한다.
- [ ] 정상 0건, 일부 page failure, budget blocked, filtered recovery, rights permitted 후 Capsule 생성 경로를 각각 검증한다.
- [ ] 모바일에서 PDF 진행 sheet와 visual inspector가 겹치지 않고, 취소/재개가 동작하는지 검증한다.
- [ ] `docs/PROJECT_CONTEXT.md`에 browser-assisted PDF 경계, HTML 자동 enqueue, rights gate, temp retention, filter limits를 기록한다.
- [ ] 전체 검증을 실행한다.

```bash
pnpm typecheck
pnpm build
pnpm --dir web exec vitest run
pnpm --dir web exec playwright test tests/e2e/visual-reservoir-personal.spec.ts tests/e2e/visual-extraction-web-pdf.spec.ts
git status --short
```

- [ ] 문서와 E2E를 커밋한다.

```bash
git add docs/PROJECT_CONTEXT.md web/tests/e2e/visual-extraction-web-pdf.spec.ts
git commit -m "260825: PDF 웹 시각 추출 검증과 운영 문서화"
```

- [ ] 사용자 승인 후 migration과 배포를 실행한다.

```bash
pnpm db:migrate
pnpm deploy
```

- [ ] 프로덕션 smoke test는 권리 상태가 명확한 공개 fixture URL/PDF로만 수행한다. 실제 외부 작품 이미지를 임의로 R2에 저장하지 않는다.

## Delivery 2 완료 기준

- HTML source acquisition 성공 뒤 visual extraction이 부모 source 성공을 방해하지 않고 실행된다.
- PDF는 active raw PDF를 브라우저가 페이지별 checkpoint로 처리하고 중단 후 이어갈 수 있다.
- 모든 visual은 source/version/page/figure/caption/nearby text 중 가능한 provenance를 유지한다.
- 장식·광고·tracking·반복 이미지는 기본 목록에서 제외되며 이유와 복구 경로가 있다.
- 작은 핵심 도판은 크기 하나로 폐기되지 않는다.
- 외부 UNKNOWN/RESTRICTED는 LINK_ONLY이고 rights 근거 없이 Capsule을 만들지 않는다.
- filtered temp image/page는 성공 여부와 무관하게 정리되며 부모 원본은 유지된다.
- 정상 0건과 부분 실패가 원문 수집 실패로 표시되지 않는다.
- 비교 보드와 인라인 검수 후 기존 읽기 위치가 유지된다.
