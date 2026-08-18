import type { TextItem } from "pdfjs-dist/types/src/display/api";

let pdfjsLib: typeof import("pdfjs-dist") | null = null;

async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
  }
  return pdfjsLib;
}

export interface PdfExtractResult {
  text: string;
  pageCount: number;
}

export async function extractPdfText(file: File, onProgress?: (page: number, total: number) => void): Promise<PdfExtractResult> {
  const pdfjs = await loadPdfjs();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => (item as TextItem).str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) pages.push(`[page ${i}] ${pageText}`);
    onProgress?.(i, doc.numPages);
  }
  await doc.destroy();
  return { text: pages.join("\n\n"), pageCount: doc.numPages };
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      resolve(r.slice(r.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}
