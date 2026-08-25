let pdfjsLib: typeof import("pdfjs-dist") | null = null;

const PDF_UPLOAD_CHUNK_SIZE = 40;
const PDF_RENDER_MAX_EDGE = 1600;
const PDF_WEBP_QUALITY = 0.82;

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
      pages.push({
        pageNumber,
        blob: webpBlob,
        width: canvas.width,
        height: canvas.height,
        contentHash: await sha256Hex(webpBlob),
      });
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

    let hasMore = true;
    while (hasMore) {
      const rendered = await renderPdfVisualPages(originalBlob, {
        runId: runData.run.id,
        uploadedPages: checkpoint.uploadedPages,
      }, input.signal);
      totalPages = Math.max(totalPages, rendered.totalPages, checkpoint.totalPages);

      for (const page of rendered.pages) {
        if (input.signal?.aborted) return pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages);

        const uploadResponse = await fetch(`/api/visual-extraction/pdf/runs/${runData.run.id}/pages/${page.pageNumber}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: input.sourceId,
            versionId: input.versionId,
            width: page.width,
            height: page.height,
            contentHash: page.contentHash,
            imageBase64: await blobToBase64(page.blob),
          }),
          signal: input.signal,
        });
        if (!uploadResponse.ok) throw new Error("pdf_visual_page_upload_failed");
        const uploadData = await uploadResponse.json() as PdfRunResponse;
        checkpoint = uploadData.checkpoint;
      }

      hasMore = rendered.hasMore;
      if (hasMore && rendered.pages.length === 0) throw new Error("pdf_visual_checkpoint_stalled");
    }

    if (input.signal?.aborted) return pausedPdfExtractionResult(runData.run.id, checkpoint, totalPages);

    const finalizeResponse = await fetch(`/api/visual-extraction/pdf/runs/${runData.run.id}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: input.sourceId, versionId: input.versionId }),
      signal: input.signal,
    });
    if (!finalizeResponse.ok) throw new Error("pdf_visual_finalize_failed");
    const finalizeData = await finalizeResponse.json() as PdfRunResponse;
    return mapRunResponse(finalizeData);
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
