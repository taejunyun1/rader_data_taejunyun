import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueResearchJob = vi.fn();
const createOrResumeRun = vi.fn();
const recordUnit = vi.fn();
const cancelRun = vi.fn();

vi.mock("../../../worker/src/jobs/enqueue", () => ({
  enqueueResearchJob,
}));

vi.mock("../../../worker/src/visual/extraction/store", () => ({
  ExtractionStore: {
    createOrResumeRun,
    recordUnit,
    cancelRun,
  },
}));

function createReservoirOriginalDb(options: {
  inputFormat?: string;
  activeVersionId?: string;
  requestedVersionId?: string;
  r2Key?: string | null;
}) {
  const inputFormat = options.inputFormat ?? "PDF_TEXT";
  const activeVersionId = options.activeVersionId ?? "version-active";
  const r2Key = options.r2Key ?? "originals/source-1/v1-paper.pdf";

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM sources s LEFT JOIN source_versions v ON v.id = s.active_version_id")) {
                const requestedVersionId = String(values[1] ?? "");
                if (requestedVersionId !== activeVersionId) return null;
                return {
                  source_id: "source-1",
                  input_format: inputFormat,
                  active_version_id: activeVersionId,
                  active_r2_key: r2Key,
                  title: "Visual PDF",
                } as T;
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createVisualExtractionDb(options: {
  sourceId?: string;
  activeVersionId?: string;
  inputFormat?: string;
  runId?: string;
  uploadedPages?: number[];
}) {
  const sourceId = options.sourceId ?? "source-1";
  const activeVersionId = options.activeVersionId ?? "version-active";
  const inputFormat = options.inputFormat ?? "PDF_TEXT";
  const runId = options.runId ?? "run-1";
  const uploadedPages = options.uploadedPages ?? [];

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM sources s") && sql.includes("active_version_id")) {
                return {
                  source_id: sourceId,
                  input_format: inputFormat,
                  active_version_id: activeVersionId,
                } as T;
              }
              if (sql.includes("FROM visual_extraction_runs")) {
                return {
                  id: runId,
                  parentSourceId: sourceId,
                  parentVersionId: activeVersionId,
                  originKind: "PDF_PAGE_CROP",
                  status: "UPLOADING",
                  totalUnits: 85,
                  uploadedUnits: uploadedPages.length,
                  processedUnits: 0,
                  selectedCount: 0,
                  reviewCount: 0,
                  filteredCount: 0,
                  unavailableCount: 0,
                  errorCode: null,
                  error: null,
                  createdAt: "2026-08-25T09:00:00.000Z",
                  updatedAt: "2026-08-25T09:00:00.000Z",
                  finishedAt: null,
                } as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM visual_extraction_units")) {
                return {
                  results: uploadedPages.map((pageNumber) => ({
                    id: `unit-${pageNumber}`,
                    runId,
                    unitNumber: pageNumber,
                    candidateKey: `page-${pageNumber}`,
                    status: "UPLOADED",
                    tempR2Key: `visual-temp/${runId}/page-${pageNumber}.webp`,
                    width: 1200,
                    height: 900,
                    contentHash: `hash-${pageNumber}`,
                    errorCode: null,
                    error: null,
                    createdAt: "2026-08-25T09:00:00.000Z",
                    processedAt: null,
                    deletedAt: null,
                  })) as T[],
                  success: true,
                  meta: {},
                };
              }
              return { results: [] as T[], success: true, meta: {} };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createOriginalsBucket() {
  const put = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({
    body: new Response("%PDF-1.7 active").body,
  }));
  return { get, put };
}

describe("reservoir active PDF original", () => {
  it("streams only the active PDF version and sets private nosniff headers", async () => {
    const { default: reservoir } = await import("../../../worker/src/routes/reservoir");
    const originals = createOriginalsBucket();

    const response = await reservoir.request("/source-1/original?version=version-active", undefined, {
      DB: createReservoirOriginalDb({}),
      ORIGINALS: originals,
    } as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(response.text()).resolves.toContain("%PDF-1.7 active");
    expect(originals.get).toHaveBeenCalledWith("originals/source-1/v1-paper.pdf");
  });

  it("rejects non-active or non-pdf original requests", async () => {
    const { default: reservoir } = await import("../../../worker/src/routes/reservoir");

    const wrongVersionResponse = await reservoir.request("/source-1/original?version=version-old", undefined, {
      DB: createReservoirOriginalDb({}),
      ORIGINALS: createOriginalsBucket(),
    } as Env);
    expect(wrongVersionResponse.status).toBe(404);

    const wrongFormatResponse = await reservoir.request("/source-1/original?version=version-active", undefined, {
      DB: createReservoirOriginalDb({ inputFormat: "URL_HTML" }),
      ORIGINALS: createOriginalsBucket(),
    } as Env);
    expect(wrongFormatResponse.status).toBe(404);
  });
});

describe("visual extraction pdf route", () => {
  beforeEach(() => {
    vi.resetModules();
    enqueueResearchJob.mockReset();
    createOrResumeRun.mockReset();
    recordUnit.mockReset();
    cancelRun.mockReset();
  });

  it("creates a resumable run with uploaded-page checkpoint state", async () => {
    createOrResumeRun.mockResolvedValue({
      id: "run-1",
      parentSourceId: "source-1",
      parentVersionId: "version-active",
      originKind: "PDF_PAGE_CROP",
      status: "UPLOADING",
      totalUnits: 85,
      uploadedUnits: 40,
      processedUnits: 0,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      errorCode: null,
      error: null,
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z",
      finishedAt: null,
    });
    const { default: visualExtraction } = await import("../../../worker/src/routes/visualExtraction");

    const response = await visualExtraction.request("/pdf/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-1", versionId: "version-active", pageCount: 85 }),
    }, {
      DB: createVisualExtractionDb({ uploadedPages: Array.from({ length: 40 }, (_, index) => index + 1) }),
      ORIGINALS: createOriginalsBucket(),
    } as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      run: expect.objectContaining({
        id: "run-1",
        status: "UPLOADING",
        totalUnits: 85,
        uploadedUnits: 40,
      }),
      checkpoint: {
        uploadedPages: Array.from({ length: 40 }, (_, index) => index + 1),
        totalPages: 85,
        remainingPages: 45,
        nextPageNumber: 41,
      },
    });
  });

  it("rejects non-webp page uploads and only enqueues finalize when at least one page exists", async () => {
    createOrResumeRun.mockResolvedValue({
      id: "run-1",
      parentSourceId: "source-1",
      parentVersionId: "version-active",
      originKind: "PDF_PAGE_CROP",
      status: "UPLOADING",
      totalUnits: 3,
      uploadedUnits: 0,
      processedUnits: 0,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      errorCode: null,
      error: null,
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:00:00.000Z",
      finishedAt: null,
    });
    const { default: visualExtraction } = await import("../../../worker/src/routes/visualExtraction");
    const originals = createOriginalsBucket();

    const invalidUpload = await visualExtraction.request("/pdf/runs/run-1/pages/1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: "source-1",
        versionId: "version-active",
        width: 1200,
        height: 900,
        contentHash: "hash-1",
        imageBase64: Buffer.from("not-webp").toString("base64"),
      }),
    }, {
      DB: createVisualExtractionDb({ uploadedPages: [] }),
      ORIGINALS: originals,
    } as Env);

    expect(invalidUpload.status).toBe(400);
    expect(recordUnit).not.toHaveBeenCalled();
    expect(originals.put).not.toHaveBeenCalled();

    enqueueResearchJob.mockResolvedValue({ job: { id: "visual-job" }, reused: false });
    const finalizeWithoutUploads = await visualExtraction.request("/pdf/runs/run-1/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-1", versionId: "version-active" }),
    }, {
      DB: createVisualExtractionDb({ uploadedPages: [] }),
      ORIGINALS: originals,
    } as Env);

    expect(finalizeWithoutUploads.status).toBe(200);
    await expect(finalizeWithoutUploads.json()).resolves.toEqual({
      queued: false,
      run: expect.objectContaining({ id: "run-1", uploadedUnits: 0 }),
      checkpoint: {
        uploadedPages: [],
        totalPages: 85,
        remainingPages: 85,
        nextPageNumber: 1,
      },
    });
    expect(enqueueResearchJob).not.toHaveBeenCalled();
  });
});

describe("renderPdfVisualPages", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders sequential webp pages for the next 40-page chunk using the existing pdfjs worker setup", async () => {
    const render = vi.fn(async () => ({ promise: Promise.resolve() }));
    const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 2000 * scale }));
    const getPage = vi.fn(async (pageNumber: number) => ({
      getViewport,
      render,
      pageNumber,
    }));
    const destroy = vi.fn(async () => undefined);
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 85,
        getPage,
        destroy,
      }),
    }));
    vi.doMock("pdfjs-dist", () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument,
    }));

    const toBlob = vi.fn((callback: BlobCallback, type?: string, quality?: unknown) => {
      callback(new Blob(["RIFF0000WEBP"], { type: String(type ?? "image/webp") }));
      expect(type).toBe("image/webp");
      expect(quality).toBe(0.82);
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(toBlob);

    const { renderPdfVisualPages } = await import("./pdfVisualExtraction");
    const result = await renderPdfVisualPages(new Blob(["pdf"], { type: "application/pdf" }), {
      runId: "run-1",
      uploadedPages: Array.from({ length: 40 }, (_, index) => index + 1),
    });

    expect(result.totalPages).toBe(85);
    expect(result.hasMore).toBe(true);
    expect(result.pages).toHaveLength(40);
    expect(result.pages[0]).toMatchObject({ pageNumber: 41, width: 800, height: 1600 });
    expect(result.pages.at(-1)).toMatchObject({ pageNumber: 80 });
    expect(getDocument).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledTimes(40);
    expect(render).toHaveBeenCalledTimes(40);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("skips uploaded pages inside the checkpoint and stops cleanly when aborted", async () => {
    const render = vi.fn(async () => ({ promise: Promise.resolve() }));
    const getPage = vi.fn(async (pageNumber: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 1200 * scale, height: 900 * scale }),
      render,
      pageNumber,
    }));
    vi.doMock("pdfjs-dist", () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 6,
          getPage,
          destroy: async () => undefined,
        }),
      }),
    }));

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob(["RIFF0000WEBP"], { type: "image/webp" }));
    });

    const { renderPdfVisualPages } = await import("./pdfVisualExtraction");
    const controller = new AbortController();
    controller.abort();

    const result = await renderPdfVisualPages(new Blob(["pdf"], { type: "application/pdf" }), {
      runId: "run-1",
      uploadedPages: [1, 2, 4],
    }, controller.signal);

    expect(result.pages).toEqual([]);
    expect(getPage).not.toHaveBeenCalled();
  });
});
