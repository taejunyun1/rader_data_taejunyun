import { useSyncExternalStore } from "react";
import {
  startOrResumePdfVisualExtraction,
  type PdfVisualExtractionProgressContext,
  type PdfVisualExtractionResult,
} from "./pdfVisualExtraction";

export type PdfPreparationTaskStatus = "PREPARING" | "UPLOADING" | "PAUSED" | "FINALIZING" | "QUEUED" | "FAILED";

export interface PdfPreparationTask {
  runId: string;
  sourceId: string;
  sourceVersionId: string;
  title: string;
  status: PdfPreparationTaskStatus;
  totalPages: number;
  uploadedPages: number;
  currentPage: number | null;
  errorCode: string | null;
}

interface StartPdfPreparationInput {
  sourceId: string;
  sourceVersionId: string;
  originalUrl: string;
  title: string;
}

interface TaskRecord {
  task: PdfPreparationTask;
  input: StartPdfPreparationInput;
  controller: AbortController;
  promise: Promise<PdfVisualExtractionResult | null>;
}

type Listener = (tasks: PdfPreparationTask[]) => void;

const records = new Map<string, TaskRecord>();
const listeners = new Set<Listener>();
let snapshot: PdfPreparationTask[] = [];

function taskKey(input: Pick<StartPdfPreparationInput, "sourceId" | "sourceVersionId">): string {
  return `${input.sourceId}:${input.sourceVersionId}`;
}

function publish(): void {
  snapshot = Array.from(records.values(), (record) => record.task);
  listeners.forEach((listener) => listener(snapshot));
}

function applyProgress(task: PdfPreparationTask, result: PdfVisualExtractionResult, context: PdfVisualExtractionProgressContext): void {
  if (task.status === "PAUSED") return;
  task.runId = result.runId;
  task.status = context.stage === "QUEUED" ? "QUEUED" : context.stage;
  task.totalPages = result.totalPages;
  task.uploadedPages = result.uploadedPages;
  task.currentPage = context.currentPage;
  task.errorCode = null;
  publish();
}

function statusFromResult(result: PdfVisualExtractionResult): PdfPreparationTaskStatus {
  if (result.status === "PAUSED") return "PAUSED";
  if (result.status === "FAILED") return "FAILED";
  // A resumable checkpoint must never be presented as queued analysis, even if
  // an older/mock endpoint reports the run as QUEUED before all pages exist.
  if (result.remainingPages > 0) return "PAUSED";
  if (result.status === "QUEUED" || result.status === "RUNNING") return "QUEUED";
  return "FINALIZING";
}

export function subscribePdfVisualExtraction(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot);
  return () => listeners.delete(listener);
}

export function getPdfVisualExtractionTasks(): PdfPreparationTask[] {
  return snapshot;
}

export function usePdfVisualExtractionTasks(): PdfPreparationTask[] {
  return useSyncExternalStore(subscribePdfVisualExtraction, getPdfVisualExtractionTasks, getPdfVisualExtractionTasks);
}

export function startPdfVisualExtractionTask(input: StartPdfPreparationInput): {
  task: PdfPreparationTask;
  promise: Promise<PdfVisualExtractionResult | null>;
  stop: () => void;
} {
  const key = taskKey(input);
  const existing = records.get(key);
  if (existing && ["PREPARING", "UPLOADING", "FINALIZING", "QUEUED"].includes(existing.task.status)) {
    return { task: existing.task, promise: existing.promise, stop: () => stopPdfVisualExtractionTask(input.sourceId, input.sourceVersionId) };
  }

  const controller = new AbortController();
  const task: PdfPreparationTask = {
    runId: "",
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    title: input.title,
    status: "PREPARING",
    totalPages: 0,
    uploadedPages: 0,
    currentPage: null,
    errorCode: null,
  };
  const record = {
    task,
    input,
    controller,
    promise: Promise.resolve(null) as Promise<PdfVisualExtractionResult | null>,
  } satisfies TaskRecord;
  records.set(key, record);
  publish();

  record.promise = startOrResumePdfVisualExtraction({
    sourceId: input.sourceId,
    versionId: input.sourceVersionId,
    originalUrl: input.originalUrl,
    signal: controller.signal,
    onProgress: (result, context) => applyProgress(task, result, context),
  }).then((result) => {
    if (task.status !== "PAUSED") {
      task.runId = result.runId;
      task.status = statusFromResult(result);
      task.totalPages = result.totalPages;
      task.uploadedPages = result.uploadedPages;
      task.currentPage = null;
      task.errorCode = null;
      publish();
    }
    return result;
  }).catch((error: unknown) => {
    if (task.status === "PAUSED" || (error instanceof Error && error.name === "AbortError")) {
      task.status = "PAUSED";
      task.errorCode = null;
    } else if (error instanceof Error && error.message === "pdf_visual_page_upload_retry_exhausted") {
      task.status = "PAUSED";
      task.errorCode = error.message;
    } else {
      task.status = "FAILED";
      task.errorCode = error instanceof Error ? error.message : "pdf_visual_extraction_failed";
    }
    publish();
    return null;
  });

  return { task, promise: record.promise, stop: () => stopPdfVisualExtractionTask(input.sourceId, input.sourceVersionId) };
}

export function stopPdfVisualExtractionTask(sourceId: string, sourceVersionId: string): void {
  const record = records.get(taskKey({ sourceId, sourceVersionId }));
  if (!record || !["PREPARING", "UPLOADING", "FINALIZING"].includes(record.task.status)) return;
  record.controller.abort();
  record.task.status = "PAUSED";
  record.task.currentPage = null;
  record.task.errorCode = null;
  publish();
}

export function resumePdfVisualExtractionTask(sourceId: string, sourceVersionId: string): ReturnType<typeof startPdfVisualExtractionTask> | null {
  const record = records.get(taskKey({ sourceId, sourceVersionId }));
  if (!record) return null;
  return startPdfVisualExtractionTask(record.input);
}

export function dismissPdfVisualExtractionTask(sourceId: string, sourceVersionId: string): void {
  if (!records.delete(taskKey({ sourceId, sourceVersionId }))) return;
  publish();
}

export function resetPdfVisualExtractionManagerForTests(): void {
  records.forEach((record) => record.controller.abort());
  records.clear();
  snapshot = [];
  listeners.clear();
}
