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
import {
  VISUAL_EXTRACTION_VISION_CALL_LIMIT,
  type VisualExtractionVisionBlockReason,
  type VisualExtractionVisionPersistence,
  type VisualExtractionVisionPersistenceState,
} from "./visionBudget";

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
    visionCallLimit: Number(row.visionCallLimit ?? VISUAL_EXTRACTION_VISION_CALL_LIMIT),
    visionReservationUsd: Number(row.visionReservationUsd ?? 0),
    visionBudgetReserved: Number(row.visionBudgetReserved ?? 0) === 1,
    visionReservationId: nullableString(row.visionReservationId),
    visionReservationJobId: nullableString(row.visionReservationJobId),
    visionBudgetBlocked: Number(row.visionBudgetBlocked ?? 0),
    visionSlotsUsed: Number(row.visionSlotsUsed ?? 0),
    visionAttempted: Number(row.visionAttempted ?? 0),
    visionCompleted: Number(row.visionCompleted ?? 0),
    visionFailed: Number(row.visionFailed ?? 0),
    visionBlocked: Number(row.visionBlocked ?? 0),
    visionCapBlocked: Number(row.visionCapBlocked ?? 0),
  };
}

function visionStateFromRun(run: VisualExtractionRunRow): VisualExtractionVisionPersistenceState {
  return {
    diagnostics: {
      callLimit: run.visionCallLimit,
      reservationUsd: run.visionReservationUsd,
      budgetReserved: run.visionBudgetReserved,
      budgetBlocked: run.visionBudgetBlocked > 0 || !run.visionBudgetReserved,
      attempted: run.visionAttempted,
      completed: run.visionCompleted,
      failed: run.visionFailed,
      blocked: run.visionBlocked,
      capBlocked: run.visionCapBlocked,
    },
    slotsUsed: run.visionSlotsUsed,
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
            updated_at AS updatedAt, finished_at AS finishedAt,
            vision_call_limit AS visionCallLimit, vision_reservation_usd AS visionReservationUsd,
            vision_budget_reserved AS visionBudgetReserved, vision_budget_blocked AS visionBudgetBlocked,
            vision_reservation_id AS visionReservationId, vision_reservation_job_id AS visionReservationJobId,
            vision_slots_used AS visionSlotsUsed, vision_attempted AS visionAttempted,
            vision_completed AS visionCompleted, vision_failed AS visionFailed,
            vision_blocked AS visionBlocked, vision_cap_blocked AS visionCapBlocked
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
            updated_at AS updatedAt, finished_at AS finishedAt,
            vision_call_limit AS visionCallLimit, vision_reservation_usd AS visionReservationUsd,
            vision_budget_reserved AS visionBudgetReserved, vision_budget_blocked AS visionBudgetBlocked,
            vision_reservation_id AS visionReservationId, vision_reservation_job_id AS visionReservationJobId,
            vision_slots_used AS visionSlotsUsed, vision_attempted AS visionAttempted,
            vision_completed AS visionCompleted, vision_failed AS visionFailed,
            vision_blocked AS visionBlocked, vision_cap_blocked AS visionCapBlocked
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
     WHERE run_id = ?
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
  return units.filter((unit) => unit.status === "SUCCEEDED" || unit.status === "FAILED" || unit.status === "DELETED").length;
}

function deriveFinishedStatus(
  units: VisualExtractionUnitRow[],
  input: FinishExtractionRunInput,
): VisualExtractionRunRow["status"] {
  const hasNonTerminal = units.some((unit) => unit.status === "UPLOADED" || unit.status === "PROCESSING");
  if (hasNonTerminal) return "RUNNING";
  if (input.status) return input.status;
  const failed = units.filter((unit) => unit.status === "FAILED").length;
  if (failed === 0) return "SUCCEEDED";
  if (failed === units.length && units.length > 0) return "FAILED";
  return "PARTIAL";
}

function isTerminalRunStatus(status: VisualExtractionRunRow["status"]): boolean {
  return status === "SUCCEEDED" || status === "PARTIAL" || status === "FAILED" || status === "CANCELLED";
}

export const ExtractionStore = {
  async createOrResumeRun(db: D1Database, input: CreateOrResumeRunInput): Promise<VisualExtractionRunRow> {
    const timestamp = nowIso(input.now);
    await db.prepare(
      `INSERT OR IGNORE INTO visual_extraction_runs
       (id, parent_source_id, parent_version_id, origin_kind, status,
        total_units, uploaded_units, processed_units, selected_count,
        review_count, filtered_count, unavailable_count, error_code,
        error, created_at, updated_at, finished_at, vision_call_limit,
        vision_reservation_usd, vision_budget_reserved, vision_budget_blocked,
        vision_reservation_id, vision_reservation_job_id,
        vision_slots_used, vision_attempted, vision_completed, vision_failed,
        vision_blocked, vision_cap_blocked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      uuid(),
      input.parentSourceId,
      input.parentVersionId,
      input.originKind,
      "UPLOADING",
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      null,
      null,
      timestamp,
      timestamp,
      null,
      VISUAL_EXTRACTION_VISION_CALL_LIMIT,
      0,
      0,
      0,
      null,
      null,
      0,
      0,
      0,
      0,
      0,
      0,
    ).run();

    const canonical = await getActiveRun(db, input);
    if (!canonical) throw new Error("visual_extraction_run_not_found");
    return canonical;
  },

  async recordUnit(db: D1Database, input: RecordExtractionUnitInput): Promise<VisualExtractionUnitRow> {
    const createdAt = nowIso(input.createdAt);
    await db.prepare(
      `INSERT OR IGNORE INTO visual_extraction_units
       (id, run_id, unit_number, candidate_key, status, temp_r2_key,
        width, height, content_hash, error_code, error, created_at,
        processed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      uuid(),
      input.runId,
      input.unitNumber,
      input.candidateKey,
      "UPLOADED",
      input.tempR2Key ?? null,
      input.width ?? null,
      input.height ?? null,
      input.contentHash ?? null,
      null,
      null,
      createdAt,
      null,
      null,
    ).run();

    const canonical = await getUnit(db, input.runId, input.unitNumber, input.candidateKey);
    if (!canonical) throw new Error("visual_extraction_unit_not_found");
    return canonical;
  },

  async markUnitProcessed(db: D1Database, input: MarkExtractionUnitProcessedInput): Promise<VisualExtractionUnitRow> {
    const existing = await getUnit(db, input.runId, input.unitNumber, input.candidateKey);
    if (!existing) throw new Error("visual_extraction_unit_not_found");

    const terminalAt = nowIso(input.processedAt);
    const processedAt = input.status === "PROCESSING" ? null : terminalAt;
    const deletedAt = input.status === "DELETED" ? terminalAt : null;
    await db.prepare(
      `UPDATE visual_extraction_units
       SET status = ?, width = ?, height = ?, content_hash = ?,
           error_code = ?, error = ?, processed_at = ?, deleted_at = ?
       WHERE run_id = ? AND unit_number = ? AND candidate_key = ?`
    ).bind(
      input.status,
      input.width ?? existing.width,
      input.height ?? existing.height,
      input.contentHash ?? existing.contentHash,
      input.errorCode ?? null,
      input.error ?? null,
      processedAt,
      deletedAt,
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
      deletedAt,
    };
  },

  async finishRun(db: D1Database, input: FinishExtractionRunInput): Promise<VisualExtractionRunRow> {
    const existing = await getRun(db, input.runId);
    if (!existing) throw new Error("visual_extraction_run_not_found");

    const units = await listRunUnits(db, input.runId);
    const updatedAt = nowIso(input.finishedAt);
    const status = deriveFinishedStatus(units, input);
    const next: VisualExtractionRunRow = {
      ...existing,
      status,
      totalUnits: Math.max(existing.totalUnits, units.length),
      uploadedUnits: countUploaded(units),
      processedUnits: countProcessed(units),
      selectedCount: Math.max(existing.selectedCount, input.counts.selected),
      reviewCount: Math.max(existing.reviewCount, input.counts.review),
      filteredCount: Math.max(existing.filteredCount, input.counts.filtered),
      unavailableCount: Math.max(existing.unavailableCount, input.counts.unavailable),
      errorCode: input.errorCode ?? existing.errorCode,
      error: input.error ?? existing.error,
      updatedAt,
      finishedAt: isTerminalRunStatus(status) ? updatedAt : null,
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

    const units = await listRunUnits(db, input.runId);
    const cancelledAt = nowIso(input.cancelledAt);
    const next: VisualExtractionRunRow = {
      ...existing,
      status: "CANCELLED",
      totalUnits: Math.max(existing.totalUnits, units.length),
      uploadedUnits: countUploaded(units),
      processedUnits: countProcessed(units),
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

export function createVisualExtractionVisionPersistence(db: D1Database, runId: string): VisualExtractionVisionPersistence {
  const load = async (): Promise<VisualExtractionVisionPersistenceState> => {
    const run = await getRun(db, runId);
    if (!run) throw new Error("visual_extraction_run_not_found");
    return visionStateFromRun(run);
  };

  const updateAndLoad = async (query: string, ...params: unknown[]): Promise<VisualExtractionVisionPersistenceState> => {
    await db.prepare(query).bind(...params).run();
    return load();
  };

  return {
    load,
    async seed(input) {
      await updateAndLoad(
        `UPDATE visual_extraction_runs
         SET vision_call_limit = MAX(vision_call_limit, ?),
             vision_reservation_usd = MAX(vision_reservation_usd, ?),
             vision_budget_reserved = 0,
             vision_reservation_id = NULL,
             vision_reservation_job_id = NULL,
             updated_at = ?
         WHERE id = ?`,
        VISUAL_EXTRACTION_VISION_CALL_LIMIT,
        input.reservationUsd,
        new Date().toISOString(),
        runId,
      );
      if (input.budgetReserved && input.reservationId && input.researchJobId) {
        await db.prepare(
          `UPDATE visual_extraction_runs
           SET vision_budget_reserved = 1,
               vision_reservation_id = ?,
               vision_reservation_job_id = ?,
               updated_at = ?
           WHERE id = ?
             AND EXISTS (
               SELECT 1 FROM ai_budget_reservations
               WHERE id = ? AND research_job_id = ? AND status = 'RESERVED'
             )`
        ).bind(
          input.reservationId,
          input.researchJobId,
          new Date().toISOString(),
          runId,
          input.reservationId,
          input.researchJobId,
        ).run();
      }
      return load();
    },
    async recordRequest() {
      return updateAndLoad(
        `UPDATE visual_extraction_runs
         SET vision_attempted = vision_attempted + 1, updated_at = ?
         WHERE id = ?`,
        new Date().toISOString(),
        runId,
      );
    },
    async claimSlot() {
      const result = await db.prepare(
        `UPDATE visual_extraction_runs
         SET vision_slots_used = vision_slots_used + 1, updated_at = ?
         WHERE id = ? AND vision_budget_reserved = 1
           AND vision_slots_used < vision_call_limit
           AND vision_reservation_id IS NOT NULL
           AND vision_reservation_job_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM ai_budget_reservations
             WHERE id = vision_reservation_id
               AND research_job_id = vision_reservation_job_id
               AND status = 'RESERVED'
           )`
      ).bind(new Date().toISOString(), runId).run();
      const state = await load();
      if (Number(result.meta?.changes ?? 0) === 1) return { claimed: true, state };
      const authorization = await db.prepare(
        `SELECT CASE WHEN vision_budget_reserved = 1
                     AND vision_reservation_id IS NOT NULL
                     AND vision_reservation_job_id IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM ai_budget_reservations
                       WHERE id = vision_reservation_id
                         AND research_job_id = vision_reservation_job_id
                         AND status = 'RESERVED'
                     )
                    THEN 1 ELSE 0 END AS authorized
         FROM visual_extraction_runs WHERE id = ?`
      ).bind(runId).first<{ authorized: number }>();
      return {
        claimed: false,
        reason: Number(authorization?.authorized ?? 0) === 1
          ? "visual_extraction_call_limit"
          : "monthly_budget_exhausted",
        state,
      };
    },
    async recordBlocked(reason: VisualExtractionVisionBlockReason) {
      if (reason === "visual_extraction_call_limit") {
        return updateAndLoad(
          `UPDATE visual_extraction_runs
           SET vision_blocked = vision_blocked + 1,
               vision_cap_blocked = vision_cap_blocked + 1,
               updated_at = ?
           WHERE id = ?`,
          new Date().toISOString(),
          runId,
        );
      }
      return updateAndLoad(
        `UPDATE visual_extraction_runs
         SET vision_blocked = vision_blocked + 1,
             vision_budget_blocked = vision_budget_blocked + 1,
             updated_at = ?
         WHERE id = ?`,
        new Date().toISOString(),
        runId,
      );
    },
    async recordCompleted() {
      return updateAndLoad(
        `UPDATE visual_extraction_runs
         SET vision_completed = vision_completed + 1, updated_at = ?
         WHERE id = ?`,
        new Date().toISOString(),
        runId,
      );
    },
    async recordFailed() {
      return updateAndLoad(
        `UPDATE visual_extraction_runs
         SET vision_failed = vision_failed + 1, updated_at = ?
         WHERE id = ?`,
        new Date().toISOString(),
        runId,
      );
    },
  };
}
