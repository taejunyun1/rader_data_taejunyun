import { uuid } from "../../ingestion/ids";
import type {
  CancelExtractionRunInput,
  CreateOrResumeRunInput,
  FinishExtractionRunInput,
  ListExpiredExtractionUnitsInput,
  MarkExtractionUnitProcessedInput,
  RecordExtractionUnitInput,
  VisualExtractionRunRow,
  VisualExtractionUnitRow,
} from "./contracts";

type DbRow = Record<string, unknown>;

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mapRun(row: DbRow): VisualExtractionRunRow {
  return {
    id: String(row.id),
    parentSourceId: String(row.parentSourceId),
    parentVersionId: String(row.parentVersionId),
    originKind: String(row.originKind) as VisualExtractionRunRow["originKind"],
    status: String(row.status) as VisualExtractionRunRow["status"],
    totalUnits: Number(row.totalUnits),
    uploadedUnits: Number(row.uploadedUnits),
    processedUnits: Number(row.processedUnits),
    selectedCount: Number(row.selectedCount),
    reviewCount: Number(row.reviewCount),
    filteredCount: Number(row.filteredCount),
    unavailableCount: Number(row.unavailableCount),
    errorCode: nullableString(row.errorCode),
    error: nullableString(row.error),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    finishedAt: nullableString(row.finishedAt),
  };
}

function mapUnit(row: DbRow): VisualExtractionUnitRow {
  return {
    id: String(row.id),
    runId: String(row.runId),
    unitNumber: Number(row.unitNumber),
    candidateKey: String(row.candidateKey),
    status: String(row.status) as VisualExtractionUnitRow["status"],
    tempR2Key: nullableString(row.tempR2Key),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    contentHash: nullableString(row.contentHash),
    errorCode: nullableString(row.errorCode),
    error: nullableString(row.error),
    createdAt: String(row.createdAt),
    processedAt: nullableString(row.processedAt),
    deletedAt: nullableString(row.deletedAt),
  };
}

async function getActiveRun(db: D1Database, input: CreateOrResumeRunInput): Promise<VisualExtractionRunRow | null> {
  const row = await db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId,
            origin_kind AS originKind, status, total_units AS totalUnits,
            uploaded_units AS uploadedUnits, processed_units AS processedUnits,
            selected_count AS selectedCount, review_count AS reviewCount,
            filtered_count AS filteredCount, unavailable_count AS unavailableCount,
            error_code AS errorCode, error, created_at AS createdAt,
            updated_at AS updatedAt, finished_at AS finishedAt
     FROM visual_extraction_runs
     WHERE parent_source_id = ? AND parent_version_id = ? AND origin_kind = ?
       AND status IN ('UPLOADING', 'QUEUED', 'RUNNING')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(input.parentSourceId, input.parentVersionId, input.originKind).first<DbRow>();
  return row ? mapRun(row) : null;
}

async function getRun(db: D1Database, runId: string): Promise<VisualExtractionRunRow | null> {
  const row = await db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId,
            origin_kind AS originKind, status, total_units AS totalUnits,
            uploaded_units AS uploadedUnits, processed_units AS processedUnits,
            selected_count AS selectedCount, review_count AS reviewCount,
            filtered_count AS filteredCount, unavailable_count AS unavailableCount,
            error_code AS errorCode, error, created_at AS createdAt,
            updated_at AS updatedAt, finished_at AS finishedAt
     FROM visual_extraction_runs WHERE id = ?`
  ).bind(runId).first<DbRow>();
  return row ? mapRun(row) : null;
}

async function getUnit(db: D1Database, runId: string, unitNumber: number, candidateKey: string): Promise<VisualExtractionUnitRow | null> {
  const row = await db.prepare(
    `SELECT id, run_id AS runId, unit_number AS unitNumber, candidate_key AS candidateKey,
            status, temp_r2_key AS tempR2Key, width, height, content_hash AS contentHash,
            error_code AS errorCode, error, created_at AS createdAt,
            processed_at AS processedAt, deleted_at AS deletedAt
     FROM visual_extraction_units
     WHERE run_id = ? AND unit_number = ? AND candidate_key = ?`
  ).bind(runId, unitNumber, candidateKey).first<DbRow>();
  return row ? mapUnit(row) : null;
}

async function listRunUnits(db: D1Database, runId: string): Promise<VisualExtractionUnitRow[]> {
  const rows = await db.prepare(
    `SELECT id, run_id AS runId, unit_number AS unitNumber, candidate_key AS candidateKey,
            status, temp_r2_key AS tempR2Key, width, height, content_hash AS contentHash,
            error_code AS errorCode, error, created_at AS createdAt,
            processed_at AS processedAt, deleted_at AS deletedAt
     FROM visual_extraction_units
     WHERE run_id = ? AND deleted_at IS NULL
     ORDER BY unit_number ASC`
  ).bind(runId).all<DbRow>();
  return (rows.results ?? []).map(mapUnit);
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function countUploaded(units: VisualExtractionUnitRow[]): number {
  return units.filter((unit) => unit.deletedAt == null && unit.status !== "DELETED").length;
}

function countProcessed(units: VisualExtractionUnitRow[]): number {
  return units.filter((unit) => unit.processedAt != null || unit.status === "SUCCEEDED" || unit.status === "FAILED" || unit.status === "DELETED").length;
}

function deriveFinishedStatus(
  units: VisualExtractionUnitRow[],
  input: FinishExtractionRunInput,
): VisualExtractionRunRow["status"] {
  if (input.status) return input.status;
  const failed = units.filter((unit) => unit.status === "FAILED").length;
  if (failed === 0) return "SUCCEEDED";
  if (failed === units.length && units.length > 0) return "FAILED";
  return "PARTIAL";
}

export const ExtractionStore = {
  async createOrResumeRun(db: D1Database, input: CreateOrResumeRunInput): Promise<VisualExtractionRunRow> {
    const existing = await getActiveRun(db, input);
    if (existing) return existing;

    const timestamp = nowIso(input.now);
    const run: VisualExtractionRunRow = {
      id: uuid(),
      parentSourceId: input.parentSourceId,
      parentVersionId: input.parentVersionId,
      originKind: input.originKind,
      status: "UPLOADING",
      totalUnits: 0,
      uploadedUnits: 0,
      processedUnits: 0,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      errorCode: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
    };

    await db.prepare(
      `INSERT INTO visual_extraction_runs
       (id, parent_source_id, parent_version_id, origin_kind, status,
        total_units, uploaded_units, processed_units, selected_count,
        review_count, filtered_count, unavailable_count, error_code,
        error, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      run.id,
      run.parentSourceId,
      run.parentVersionId,
      run.originKind,
      run.status,
      run.totalUnits,
      run.uploadedUnits,
      run.processedUnits,
      run.selectedCount,
      run.reviewCount,
      run.filteredCount,
      run.unavailableCount,
      run.errorCode,
      run.error,
      run.createdAt,
      run.updatedAt,
      run.finishedAt,
    ).run();

    return run;
  },

  async recordUnit(db: D1Database, input: RecordExtractionUnitInput): Promise<VisualExtractionUnitRow> {
    const existing = await getUnit(db, input.runId, input.unitNumber, input.candidateKey);
    if (existing) return existing;

    const unit: VisualExtractionUnitRow = {
      id: uuid(),
      runId: input.runId,
      unitNumber: input.unitNumber,
      candidateKey: input.candidateKey,
      status: "UPLOADED",
      tempR2Key: input.tempR2Key ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      contentHash: input.contentHash ?? null,
      errorCode: null,
      error: null,
      createdAt: nowIso(input.createdAt),
      processedAt: null,
      deletedAt: null,
    };

    await db.prepare(
      `INSERT INTO visual_extraction_units
       (id, run_id, unit_number, candidate_key, status, temp_r2_key,
        width, height, content_hash, error_code, error, created_at,
        processed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      unit.id,
      unit.runId,
      unit.unitNumber,
      unit.candidateKey,
      unit.status,
      unit.tempR2Key,
      unit.width,
      unit.height,
      unit.contentHash,
      unit.errorCode,
      unit.error,
      unit.createdAt,
      unit.processedAt,
      unit.deletedAt,
    ).run();

    return unit;
  },

  async markUnitProcessed(db: D1Database, input: MarkExtractionUnitProcessedInput): Promise<VisualExtractionUnitRow> {
    const existing = await getUnit(db, input.runId, input.unitNumber, input.candidateKey);
    if (!existing) throw new Error("visual_extraction_unit_not_found");

    const processedAt = nowIso(input.processedAt);
    await db.prepare(
      `UPDATE visual_extraction_units
       SET status = ?, width = ?, height = ?, content_hash = ?,
           error_code = ?, error = ?, processed_at = ?
       WHERE run_id = ? AND unit_number = ? AND candidate_key = ?`
    ).bind(
      input.status,
      input.width ?? existing.width,
      input.height ?? existing.height,
      input.contentHash ?? existing.contentHash,
      input.errorCode ?? null,
      input.error ?? null,
      processedAt,
      input.runId,
      input.unitNumber,
      input.candidateKey,
    ).run();

    return {
      ...existing,
      status: input.status,
      width: input.width ?? existing.width,
      height: input.height ?? existing.height,
      contentHash: input.contentHash ?? existing.contentHash,
      errorCode: input.errorCode ?? null,
      error: input.error ?? null,
      processedAt,
    };
  },

  async finishRun(db: D1Database, input: FinishExtractionRunInput): Promise<VisualExtractionRunRow> {
    const existing = await getRun(db, input.runId);
    if (!existing) throw new Error("visual_extraction_run_not_found");

    const units = await listRunUnits(db, input.runId);
    const finishedAt = nowIso(input.finishedAt);
    const next: VisualExtractionRunRow = {
      ...existing,
      status: deriveFinishedStatus(units, input),
      totalUnits: units.length,
      uploadedUnits: countUploaded(units),
      processedUnits: countProcessed(units),
      selectedCount: input.counts.selected,
      reviewCount: input.counts.review,
      filteredCount: input.counts.filtered,
      unavailableCount: input.counts.unavailable,
      errorCode: input.errorCode ?? existing.errorCode,
      error: input.error ?? existing.error,
      updatedAt: finishedAt,
      finishedAt,
    };

    await db.prepare(
      `UPDATE visual_extraction_runs
       SET status = ?, total_units = ?, uploaded_units = ?, processed_units = ?,
           selected_count = ?, review_count = ?, filtered_count = ?, unavailable_count = ?,
           error_code = ?, error = ?, updated_at = ?, finished_at = ?
       WHERE id = ?`
    ).bind(
      next.status,
      next.totalUnits,
      next.uploadedUnits,
      next.processedUnits,
      next.selectedCount,
      next.reviewCount,
      next.filteredCount,
      next.unavailableCount,
      next.errorCode,
      next.error,
      next.updatedAt,
      next.finishedAt,
      next.id,
    ).run();

    return next;
  },

  async cancelRun(db: D1Database, input: CancelExtractionRunInput): Promise<VisualExtractionRunRow> {
    const existing = await getRun(db, input.runId);
    if (!existing) throw new Error("visual_extraction_run_not_found");

    const cancelledAt = nowIso(input.cancelledAt);
    const next: VisualExtractionRunRow = {
      ...existing,
      status: "CANCELLED",
      errorCode: input.errorCode ?? existing.errorCode,
      error: input.error ?? existing.error,
      updatedAt: cancelledAt,
      finishedAt: cancelledAt,
    };

    await db.prepare(
      `UPDATE visual_extraction_runs
       SET status = ?, total_units = ?, uploaded_units = ?, processed_units = ?,
           selected_count = ?, review_count = ?, filtered_count = ?, unavailable_count = ?,
           error_code = ?, error = ?, updated_at = ?, finished_at = ?
       WHERE id = ?`
    ).bind(
      next.status,
      next.totalUnits,
      next.uploadedUnits,
      next.processedUnits,
      next.selectedCount,
      next.reviewCount,
      next.filteredCount,
      next.unavailableCount,
      next.errorCode,
      next.error,
      next.updatedAt,
      next.finishedAt,
      next.id,
    ).run();

    return next;
  },

  async listExpiredUnits(db: D1Database, input: ListExpiredExtractionUnitsInput): Promise<VisualExtractionUnitRow[]> {
    const rows = await db.prepare(
      `SELECT id, run_id AS runId, unit_number AS unitNumber, candidate_key AS candidateKey,
              status, temp_r2_key AS tempR2Key, width, height, content_hash AS contentHash,
              error_code AS errorCode, error, created_at AS createdAt,
              processed_at AS processedAt, deleted_at AS deletedAt
       FROM visual_extraction_units
       WHERE temp_r2_key IS NOT NULL
         AND deleted_at IS NULL
         AND status IN ('UPLOADED', 'FAILED')
         AND created_at < ?
       ORDER BY created_at ASC`
    ).bind(input.olderThan).all<DbRow>();
    return (rows.results ?? []).map(mapUnit);
  },
};
