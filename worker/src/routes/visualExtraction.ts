import { Hono } from "hono";
import { enqueueResearchJob } from "../jobs/enqueue";
import { ExtractionStore } from "../visual/extraction/store";
import type { VisualExtractionRunSummary } from "@radar/shared";
import type { InputFormat } from "@radar/shared/ingestion";

const visualExtraction = new Hono<{ Bindings: Env }>();
const MAX_PDF_PAGE_UPLOAD_BYTES = 12 * 1024 * 1024;

interface PdfSourceRow {
  source_id: string;
  input_format: InputFormat | null;
  active_version_id: string | null;
}

interface PdfOriginalRow extends PdfSourceRow {
  active_r2_key: string | null;
  title?: string | null;
}

interface RunRow {
  id: string;
  parentSourceId: string;
  parentVersionId: string;
  originKind: VisualExtractionRunSummary["originKind"];
  status: VisualExtractionRunSummary["status"];
  totalUnits: number;
  uploadedUnits: number;
  processedUnits: number;
  selectedCount: number;
  reviewCount: number;
  filteredCount: number;
  unavailableCount: number;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface RunUnitRow {
  unitNumber: number;
  status: string;
}

function isPdfFormat(value: InputFormat | null | undefined): value is "PDF_TEXT" | "PDF_SCAN" {
  return value === "PDF_TEXT" || value === "PDF_SCAN";
}

function b64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function hasWebpSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function loadPdfSourceVersion(db: D1Database, sourceId: string, versionId: string): Promise<PdfSourceRow | null> {
  const row = await db.prepare(
    `SELECT s.id AS source_id,
            s.input_format AS input_format,
            s.active_version_id AS active_version_id
     FROM sources s
     WHERE s.id = ? AND s.active_version_id = ?`
  ).bind(sourceId, versionId).first<PdfSourceRow>();
  if (!row || !isPdfFormat(row.input_format)) return null;
  return row;
}

async function loadRunRow(db: D1Database, runId: string): Promise<RunRow | null> {
  return db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId,
            origin_kind AS originKind, status, total_units AS totalUnits,
            uploaded_units AS uploadedUnits, processed_units AS processedUnits,
            selected_count AS selectedCount, review_count AS reviewCount,
            filtered_count AS filteredCount, unavailable_count AS unavailableCount,
            error_code AS errorCode, error, created_at AS createdAt,
            updated_at AS updatedAt, finished_at AS finishedAt
     FROM visual_extraction_runs WHERE id = ?`
  ).bind(runId).first<RunRow>();
}

async function loadRunUnits(db: D1Database, runId: string): Promise<RunUnitRow[]> {
  const rows = await db.prepare(
    `SELECT unit_number AS unitNumber, status
     FROM visual_extraction_units
     WHERE run_id = ?
     ORDER BY unit_number ASC`
  ).bind(runId).all<RunUnitRow>();
  return rows.results ?? [];
}

async function updateRunTotals(db: D1Database, runId: string, totalUnits: number, status?: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE visual_extraction_runs
     SET total_units = CASE WHEN total_units < ? THEN ? ELSE total_units END,
         status = COALESCE(?, status),
         updated_at = ?
     WHERE id = ?`
  ).bind(totalUnits, totalUnits, status ?? null, now, runId).run();
}

async function buildRunPayload(db: D1Database, runId: string, fallbackTotalPages?: number) {
  const run = await loadRunRow(db, runId);
  if (!run) return null;
  const units = await loadRunUnits(db, runId);
  const uploadedPages = units
    .filter((unit) => unit.status !== "DELETED")
    .map((unit) => unit.unitNumber)
    .sort((left, right) => left - right);
  const totalPages = Math.max(run.totalUnits, fallbackTotalPages ?? 0);
  const nextPageNumber = totalPages > 0
    ? Array.from({ length: totalPages }, (_, index) => index + 1).find((pageNumber) => !uploadedPages.includes(pageNumber)) ?? null
    : null;
  const remainingPages = totalPages > 0
    ? Array.from({ length: totalPages }, (_, index) => index + 1).filter((pageNumber) => !uploadedPages.includes(pageNumber)).length
    : 0;

  return {
    run: {
      ...run,
      totalUnits: totalPages,
      uploadedUnits: uploadedPages.length,
    },
    checkpoint: {
      uploadedPages,
      totalPages,
      remainingPages,
      nextPageNumber,
    },
  };
}

async function ensureRunMatches(db: D1Database, runId: string, sourceId: string, versionId: string): Promise<RunRow | null> {
  const run = await loadRunRow(db, runId);
  if (!run) return null;
  if (run.parentSourceId !== sourceId || run.parentVersionId !== versionId) return null;
  return run;
}

visualExtraction.post("/pdf/runs", async (c) => {
  const body = await c.req.json<{ sourceId?: string; versionId?: string; pageCount?: number }>().catch(() => null);
  const sourceId = body?.sourceId?.trim();
  const versionId = body?.versionId?.trim();
  const pageCount = Number(body?.pageCount ?? 0);
  if (!sourceId || !versionId || pageCount <= 0) return c.json({ error: "invalid_pdf_run_request" }, 400);

  const source = await loadPdfSourceVersion(c.env.DB, sourceId, versionId);
  if (!source) return c.json({ error: "pdf_active_version_not_found" }, 404);

  const run = await ExtractionStore.createOrResumeRun(c.env.DB, {
    parentSourceId: sourceId,
    parentVersionId: versionId,
    originKind: "PDF_PAGE_CROP",
  });
  await updateRunTotals(c.env.DB, run.id, pageCount);
  const payload = await buildRunPayload(c.env.DB, run.id, pageCount);
  if (!payload) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  return c.json(payload);
});

visualExtraction.get("/runs/:runId", async (c) => {
  const payload = await buildRunPayload(c.env.DB, c.req.param("runId"));
  if (!payload) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  return c.json(payload);
});

visualExtraction.put("/pdf/runs/:runId/pages/:pageNumber", async (c) => {
  const runId = c.req.param("runId");
  const pageNumber = Number(c.req.param("pageNumber"));
  const body = await c.req.json<{
    sourceId?: string;
    versionId?: string;
    width?: number;
    height?: number;
    contentHash?: string;
    imageBase64?: string;
  }>().catch(() => null);
  const sourceId = body?.sourceId?.trim();
  const versionId = body?.versionId?.trim();
  const imageBase64 = body?.imageBase64?.trim();
  const requestedHash = body?.contentHash?.trim().toLowerCase() ?? "";
  if (!sourceId || !versionId || !Number.isInteger(pageNumber) || pageNumber <= 0 || !imageBase64) {
    return c.json({ error: "invalid_pdf_page_upload" }, 400);
  }
  const source = await loadPdfSourceVersion(c.env.DB, sourceId, versionId);
  if (!source) return c.json({ error: "pdf_active_version_not_found" }, 404);
  const run = await ensureRunMatches(c.env.DB, runId, sourceId, versionId);
  if (!run) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  if (run.totalUnits <= 0 || pageNumber > run.totalUnits) return c.json({ error: "pdf_page_out_of_range" }, 400);

  const bytes = b64ToBytes(imageBase64);
  if (bytes.byteLength > MAX_PDF_PAGE_UPLOAD_BYTES) return c.json({ error: "pdf_page_too_large" }, 400);
  if (!hasWebpSignature(bytes)) return c.json({ error: "invalid_webp_signature" }, 400);
  const computedHash = await sha256Hex(bytes);
  if (!requestedHash || computedHash !== requestedHash) return c.json({ error: "pdf_page_hash_mismatch" }, 400);

  const key = `visual-temp/${runId}/page-${pageNumber}.webp`;
  await c.env.ORIGINALS.put(key, bytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { sourceId, versionId, runId, pageNumber: String(pageNumber) },
  });
  await ExtractionStore.recordUnit(c.env.DB, {
    runId,
    unitNumber: pageNumber,
    candidateKey: `page-${pageNumber}`,
    tempR2Key: key,
    width: typeof body?.width === "number" ? body.width : null,
    height: typeof body?.height === "number" ? body.height : null,
    contentHash: computedHash,
  });
  const payload = await buildRunPayload(c.env.DB, runId);
  if (!payload) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  return c.json(payload);
});

visualExtraction.post("/pdf/runs/:runId/finalize", async (c) => {
  const runId = c.req.param("runId");
  const body = await c.req.json<{ sourceId?: string; versionId?: string }>().catch(() => null);
  const sourceId = body?.sourceId?.trim();
  const versionId = body?.versionId?.trim();
  if (!sourceId || !versionId) return c.json({ error: "invalid_pdf_finalize_request" }, 400);

  const source = await loadPdfSourceVersion(c.env.DB, sourceId, versionId);
  if (!source) return c.json({ error: "pdf_active_version_not_found" }, 404);
  const run = await ensureRunMatches(c.env.DB, runId, sourceId, versionId);
  if (!run) return c.json({ error: "visual_extraction_run_not_found" }, 404);

  const payload = await buildRunPayload(c.env.DB, runId);
  if (!payload) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  if (payload.checkpoint.uploadedPages.length === 0) return c.json({ queued: false, ...payload });

  await updateRunTotals(c.env.DB, runId, payload.checkpoint.totalPages, "QUEUED");
  const requestedBy = c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
  const enqueued = await enqueueResearchJob(
    c.env,
    { kind: "VISUAL_EXTRACTION", input: { sourceId, sourceVersionId: versionId, extractionRunId: runId } },
    requestedBy,
  );
  const refreshed = await buildRunPayload(c.env.DB, runId, payload.checkpoint.totalPages);
  return c.json({
    queued: true,
    reused: enqueued.reused,
    job: enqueued.job,
    ...(refreshed ?? payload),
  }, 202);
});

visualExtraction.post("/runs/:runId/cancel", async (c) => {
  const cancelled = await ExtractionStore.cancelRun(c.env.DB, {
    runId: c.req.param("runId"),
    errorCode: "user_cancelled",
    error: "cancelled_from_reservoir",
  }).catch(() => null);
  if (!cancelled) return c.json({ error: "visual_extraction_run_not_found" }, 404);
  const payload = await buildRunPayload(c.env.DB, cancelled.id, cancelled.totalUnits);
  return c.json(payload ?? { run: cancelled });
});

export async function loadReservoirPdfOriginal(db: D1Database, sourceId: string, versionId: string): Promise<PdfOriginalRow | null> {
  const row = await db.prepare(
    `SELECT s.id AS source_id,
            s.input_format AS input_format,
            s.active_version_id AS active_version_id,
            v.r2_key AS active_r2_key,
            s.title
     FROM sources s LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id = ? AND s.active_version_id = ?`
  ).bind(sourceId, versionId).first<PdfOriginalRow>();
  if (!row || !isPdfFormat(row.input_format) || !row.active_r2_key) return null;
  return row;
}

export default visualExtraction;
