import type { PDFDocumentProxy } from "pdfjs-dist";
let pdfjsLib: typeof import("pdfjs-dist") | null = null;

const PDF_UPLOAD_CHUNK_SIZE = 40;
const PDF_RENDER_MAX_EDGE = 1600;
const PDF_WEBP_QUALITY = 0.82;
const PDF_PAGE_UPLOAD_RETRY_DELAYS_MS = [150, 400] as const;

export interface PdfVisualRenderedPage {
  pageNumber: number;
  blob: Blob;
  width: number;
  height: number;
  contentHash: string;
}

export interface PdfVisualRenderCheckpoint {
  runId: string;
  uploadedPages: number[];
}

export interface PdfVisualRenderResult {
  totalPages: number;
  hasMore: boolean;
  pages: PdfVisualRenderedPage[];
}

export interface PdfVisualExtractionResult {
  runId: string;
  status: string;
  totalPages: number;
  uploadedPages: number;
  remainingPages: number;
  nextPageNumber: number | null;
}

export type PdfVisualExtractionStage = "PREPARING" | "UPLOADING" | "FINALIZING" | "QUEUED";

export interface PdfVisualExtractionProgressContext {
  stage: PdfVisualExtractionStage;
  currentPage: number | null;
}

interface PdfRunResponse {
  run: {
    id: string;
    status: string;
    totalUnits: number;
  };
  checkpoint: {
    uploadedPages: number[];
    totalPages: number;
    remainingPages: number;
    nextPageNumber: number | null;
  };
}

async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }
  return pdfjsLib;
}

async function loadPdfPageCount(blob: Blob): Promise<number> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  try {
    return doc.numPages;
  } finally {
    await doc.destroy();
  }
}

function nextChunkPages(totalPages: number, uploadedPages: number[]): number[] {
  const uploaded = new Set(uploadedPages);
  const pages: number[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (uploaded.has(pageNumber)) continue;
    pages.push(pageNumber);
    if (pages.length === PDF_UPLOAD_CHUNK_SIZE) break;
  }
  return pages;
}

function scaleViewport(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  if (longEdge <= PDF_RENDER_MAX_EDGE) return 1;
  return PDF_RENDER_MAX_EDGE / longEdge;
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("pdf_webp_render_failed"));
        return;
      }
      resolve(blob);
    }, "image/webp", PDF_WEBP_QUALITY);
  });
}

async function sha256Hex(blob: Blob): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hashBuffer)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",").at(-1) ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("blob_base64_failed"));
    reader.readAsDataURL(blob);
  });
}

function mapRunResponse(data: PdfRunResponse): PdfVisualExtractionResult {
  return {
    runId: data.run.id,
    status: data.run.status,
    totalPages: data.checkpoint.totalPages,
    uploadedPages: data.checkpoint.uploadedPages.length,
    remainingPages: data.checkpoint.remainingPages,
    nextPageNumber: data.checkpoint.nextPageNumber,
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isRetryablePageUploadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const onAbort = () => {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadPdfPageWithRetry(input: {
  runId: string;
  sourceId: string;
  versionId: string;
  page: PdfVisualRenderedPage;
  signal?: AbortSignal;
}): Promise<Response> {
  const imageBase64 = await blobToBase64(input.page.blob);

  for (let attempt = 0; attempt <= PDF_PAGE_UPLOAD_RETRY_DELAYS_MS.length; attempt += 1) {
    if (input.signal?.aborted) throw abortError();
    try {
      const response = await fetch(`/api/visual-extraction/pdf/runs/${input.runId}/pages/${input.page.pageNumber}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: input.sourceId,
          versionId: input.versionId,
          width: input.page.width,
          height: input.page.height,
          contentHash: input.page.contentHash,
          imageBase64,
        }),
        signal: input.signal,
      });
      if (response.ok) return response;
      if (!isRetryablePageUploadStatus(response.status)) throw new Error("pdf_visual_page_upload_failed");
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if (error instanceof Error && error.message === "pdf_visual_page_upload_failed") throw error;
    }

    const delayMs = PDF_PAGE_UPLOAD_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await waitForRetry(delayMs, input.signal);
  }

  throw new Error("pdf_visual_page_upload_retry_exhausted");
}

async function renderPdfVisualPage(doc: PDFDocumentProxy, pageNumber: number): Promise<PdfVisualRenderedPage> {
  const page = await doc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: scaleViewport(baseViewport.width, baseViewport.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("pdf_canvas_context_missing");
  await page.render({ canvasContext: context, viewport }).promise;
  const webpBlob = await canvasToWebp(canvas);
  const rendered = {
    pageNumber,
    blob: webpBlob,
    width: canvas.width,
    height: canvas.height,
    contentHash: await sha256Hex(webpBlob),
  };
  page.cleanup?.();
  canvas.width = 0;
  canvas.height = 0;
  return rendered;
}

function pausedPdfExtractionResult(runId: string, checkpoint: PdfRunResponse["checkpoint"], totalPages: number): PdfVisualExtractionResult {
  return {
    runId,
    status: "PAUSED",
    totalPages: Math.max(totalPages, checkpoint.totalPages),
    uploadedPages: checkpoint.uploadedPages.length,
    remainingPages: checkpoint.remainingPages,
    nextPageNumber: checkpoint.nextPageNumber,
  };
}

export async function renderPdfVisualPages(
  blob: Blob,
  checkpoint: PdfVisualRenderCheckpoint,
  signal?: AbortSignal,
): Promise<PdfVisualRenderResult> {
  if (signal?.aborted) {
    return {
      totalPages: checkpoint.uploadedPages.length,
      hasMore: false,
      pages: [],
    };
  }

  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  try {
    const totalPages = doc.numPages;
    const targetPages = nextChunkPages(totalPages, checkpoint.uploadedPages);
    const pages: PdfVisualRenderedPage[] = [];

    for (const pageNumber of targetPages) {
      if (signal?.aborted) break;
      pages.push(await renderPdfVisualPage(doc, pageNumber));
    }

    const remaining = nextChunkPages(totalPages, checkpoint.uploadedPages.concat(pages.map((page) => page.pageNumber)));
    return {
      totalPages,
      hasMore: remaining.length > 0,
      pages,
    };
  } finally {
    await doc.destroy();
  }
}

export async function startOrResumePdfVisualExtraction(input: {
  sourceId: string;
  versionId: string;
  originalUrl: string;
  signal?: AbortSignal;
  onProgress?: (result: PdfVisualExtractionResult, context: PdfVisualExtractionProgressContext) => void;
}): Promise<PdfVisualExtractionResult> {
  let runData: PdfRunResponse | null = null;
  let checkpoint: PdfRunResponse["checkpoint"] = {
    uploadedPages: [],
    totalPages: 0,
    remainingPages: 0,
    nextPageNumber: null,
  };
  let totalPages = 0;

  try {
    const originalResponse = await fetch(input.originalUrl, { signal: input.signal });
    if (!originalResponse.ok) throw new Error("pdf_original_not_available");
    const originalBlob = await originalResponse.blob();
    const pageCount = await loadPdfPageCount(originalBlob);

    const runResponse = await fetch("/api/visual-extraction/pdf/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: input.sourceId, versionId: input.versionId, pageCount }),
      signal: input.signal,
    });
    if (!runResponse.ok) throw new Error("pdf_visual_run_create_failed");
    runData = await runResponse.json() as PdfRunResponse;
    checkpoint = runData.checkpoint;
    input.onProgress?.(mapRunResponse(runData), { stage: "UPLOADING", currentPage: null });

    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: await originalBlob.arrayBuffer() }).promise;
    try {
      totalPages = Math.max(totalPages, doc.numPages, checkpoint.totalPages);
      const uploaded = new Set(checkpoint.uploadedPages);
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        if (uploaded.has(pageNumber)) continue;
        if (input.signal?.aborted) return pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages);
        const page = await renderPdfVisualPage(doc, pageNumber);
        const uploadResponse = await uploadPdfPageWithRetry({
          runId: runData.run.id,
          sourceId: input.sourceId,
          versionId: input.versionId,
          page,
          signal: input.signal,
        });
        if (!uploadResponse.ok) throw new Error("pdf_visual_page_upload_failed");
        const uploadData = await uploadResponse.json() as PdfRunResponse;
        checkpoint = uploadData.checkpoint;
        uploaded.add(pageNumber);
        input.onProgress?.(mapRunResponse(uploadData), { stage: "UPLOADING", currentPage: pageNumber });
      }
    } finally {
      await doc.destroy();
    }

    if (input.signal?.aborted) return pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages);

    input.onProgress?.(pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages), { stage: "FINALIZING", currentPage: null });

    const finalizeResponse = await fetch(`/api/visual-extraction/pdf/runs/${runData.run.id}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: input.sourceId, versionId: input.versionId }),
      signal: input.signal,
    });
    if (!finalizeResponse.ok) throw new Error("pdf_visual_finalize_failed");
    const finalizeData = await finalizeResponse.json() as PdfRunResponse;
    const result = mapRunResponse(finalizeData);
    input.onProgress?.(result, { stage: "QUEUED", currentPage: null });
    return result;
  } catch (error) {
    if (runData && input.signal?.aborted) return pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages);
    throw error;
  }
}

export async function cancelPdfVisualExtraction(runId: string): Promise<void> {
  await fetch(`/api/visual-extraction/runs/${runId}/cancel`, {
    method: "POST",
  });
}
