import { useEffect, useState } from "react";
import type { NormalizedVisualBbox } from "@radar/shared";

interface PdfCropPreviewProps {
  sourceId: string;
  versionId: string;
  pageNumber: number;
  bbox: NormalizedVisualBbox;
}

let pdfjsLib: typeof import("pdfjs-dist") | null = null;

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

function cropToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("pdf_crop_preview_failed"));
        return;
      }
      resolve(blob);
    }, "image/png", 0.9);
  });
}

export default function PdfCropPreview({ sourceId, versionId, pageNumber, bbox }: PdfCropPreviewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let currentUrl: string | null = null;
    let fullCanvas: HTMLCanvasElement | null = null;
    let cropCanvas: HTMLCanvasElement | null = null;

    async function renderPreview() {
      try {
        setError("");
        setPreviewUrl(null);
        const response = await fetch(`/api/reservoir/${sourceId}/original?version=${versionId}`, { signal: controller.signal });
        if (!response.ok) throw new Error("pdf_original_not_available");
        const pdfjs = await loadPdfjs();
        const documentProxy = await pdfjs.getDocument({ data: await (await response.blob()).arrayBuffer() }).promise;
        try {
          const page = await documentProxy.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.5 });
          fullCanvas = document.createElement("canvas");
          fullCanvas.width = Math.max(1, Math.round(viewport.width));
          fullCanvas.height = Math.max(1, Math.round(viewport.height));
          const context = fullCanvas.getContext("2d");
          if (!context) throw new Error("pdf_canvas_context_missing");
          await page.render({ canvasContext: context, viewport }).promise;

          cropCanvas = document.createElement("canvas");
          cropCanvas.width = Math.max(1, Math.round(fullCanvas.width * bbox.width));
          cropCanvas.height = Math.max(1, Math.round(fullCanvas.height * bbox.height));
          const cropContext = cropCanvas.getContext("2d");
          if (!cropContext) throw new Error("pdf_canvas_context_missing");
          cropContext.drawImage(
            fullCanvas,
            Math.round(fullCanvas.width * bbox.x),
            Math.round(fullCanvas.height * bbox.y),
            Math.round(fullCanvas.width * bbox.width),
            Math.round(fullCanvas.height * bbox.height),
            0,
            0,
            cropCanvas.width,
            cropCanvas.height,
          );

          const cropBlob = await cropToBlob(cropCanvas);
          if (controller.signal.aborted) return;
          currentUrl = URL.createObjectURL(cropBlob);
          setPreviewUrl(currentUrl);
        } finally {
          await documentProxy.destroy();
        }
      } catch (nextError) {
        if (controller.signal.aborted) return;
        setError(nextError instanceof Error ? nextError.message : "pdf_crop_preview_failed");
      }
    }

    void renderPreview();

    return () => {
      controller.abort();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      if (fullCanvas) {
        fullCanvas.width = 0;
        fullCanvas.height = 0;
      }
      if (cropCanvas) {
        cropCanvas.width = 0;
        cropCanvas.height = 0;
      }
    };
  }, [bbox.height, bbox.width, bbox.x, bbox.y, pageNumber, sourceId, versionId]);

  if (error) {
    return <p className="visual-inspector__hint">PDF 잘라보기를 준비하지 못했습니다.</p>;
  }

  if (!previewUrl) {
    return <p className="visual-inspector__hint">PDF 잘라보기를 준비하고 있습니다.</p>;
  }

  return (
    <figure className="visual-inspector__preview">
      <img src={previewUrl} alt="PDF 잘라보기 미리보기" />
      <figcaption>{pageNumber}페이지에서 선택한 영역만 메모리에서 잘라 보여 줍니다.</figcaption>
    </figure>
  );
}
