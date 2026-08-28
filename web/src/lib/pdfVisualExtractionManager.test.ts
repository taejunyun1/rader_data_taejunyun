import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfVisualExtractionResult } from "./pdfVisualExtraction";

const startOrResumePdfVisualExtraction = vi.fn();

vi.mock("./pdfVisualExtraction", async () => {
  const actual = await vi.importActual<typeof import("./pdfVisualExtraction")>("./pdfVisualExtraction");
  return { ...actual, startOrResumePdfVisualExtraction };
});

describe("pdf visual extraction manager", () => {
  beforeEach(async () => {
    startOrResumePdfVisualExtraction.mockReset();
    const manager = await import("./pdfVisualExtractionManager");
    manager.resetPdfVisualExtractionManagerForTests();
  });

  it("keeps one task alive after a view unsubscribes and deduplicates repeated starts", async () => {
    let resolve: ((result: PdfVisualExtractionResult) => void) | undefined;
    startOrResumePdfVisualExtraction.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise<PdfVisualExtractionResult>((res) => {
      resolve = res;
      expect(signal.aborted).toBe(false);
    }));

    const manager = await import("./pdfVisualExtractionManager");
    const first = manager.startPdfVisualExtractionTask({
      sourceId: "source-1",
      sourceVersionId: "version-1",
      originalUrl: "/original.pdf",
      title: "자료 A",
    });
    const unsubscribe = manager.subscribePdfVisualExtraction(() => undefined);
    unsubscribe();
    const second = manager.startPdfVisualExtractionTask({
      sourceId: "source-1",
      sourceVersionId: "version-1",
      originalUrl: "/original.pdf",
      title: "자료 A",
    });

    expect(second.task).toBe(first.task);
    expect(startOrResumePdfVisualExtraction).toHaveBeenCalledTimes(1);
    expect(first.task.status).toBe("PREPARING");

    resolve?.({
      runId: "run-1",
      status: "QUEUED",
      totalPages: 2,
      uploadedPages: 2,
      remainingPages: 0,
      nextPageNumber: null,
    });
    await first.promise;
    expect(manager.getPdfVisualExtractionTasks()[0]?.status).toBe("QUEUED");
  });

  it("publishes page progress and only pauses when explicitly stopped", async () => {
    let resolve: ((result: PdfVisualExtractionResult) => void) | undefined;
    startOrResumePdfVisualExtraction.mockImplementation(({ onProgress }: {
      onProgress?: (result: PdfVisualExtractionResult, context: { stage: string; currentPage: number | null }) => void;
    }) => new Promise<PdfVisualExtractionResult>((res) => {
      resolve = res;
      onProgress?.({
        runId: "run-2",
        status: "UPLOADING",
        totalPages: 8,
        uploadedPages: 3,
        remainingPages: 5,
        nextPageNumber: 4,
      }, { stage: "UPLOADING", currentPage: 3 });
    }));

    const manager = await import("./pdfVisualExtractionManager");
    const taskUpdates: string[] = [];
    const unsubscribe = manager.subscribePdfVisualExtraction((tasks) => {
      const task = tasks[0];
      if (task) taskUpdates.push(`${task.status}:${task.uploadedPages}:${task.currentPage ?? "-"}`);
    });
    const handle = manager.startPdfVisualExtractionTask({
      sourceId: "source-2",
      sourceVersionId: "version-2",
      originalUrl: "/original-2.pdf",
      title: "자료 B",
    });

    await vi.waitFor(() => expect(handle.task.status).toBe("UPLOADING"));
    expect(handle.task.uploadedPages).toBe(3);
    expect(handle.task.currentPage).toBe(3);
    expect(taskUpdates).toContain("UPLOADING:3:3");

    handle.stop();
    expect(handle.task.status).toBe("PAUSED");
    expect(handle.task.errorCode).toBeNull();

    resolve?.({
      runId: "run-2",
      status: "PAUSED",
      totalPages: 8,
      uploadedPages: 3,
      remainingPages: 5,
      nextPageNumber: 4,
    });
    await handle.promise;
    unsubscribe();
  });

  it("pauses after page upload retries are exhausted so the checkpoint can be resumed", async () => {
    startOrResumePdfVisualExtraction.mockRejectedValueOnce(new Error("pdf_visual_page_upload_retry_exhausted"));

    const manager = await import("./pdfVisualExtractionManager");
    const handle = manager.startPdfVisualExtractionTask({
      sourceId: "source-3",
      sourceVersionId: "version-3",
      originalUrl: "/original-3.pdf",
      title: "자료 C",
    });

    await handle.promise;

    expect(handle.task.status).toBe("PAUSED");
    expect(handle.task.errorCode).toBe("pdf_visual_page_upload_retry_exhausted");
  });
});
