import {
  normalizeIngestText,
  type ExtractionMethod,
  type InputFormat,
  type QualityStatus,
  type TextScope,
  type VersionOrigin,
  type VersionReviewStatus,
} from "@radar/shared/ingestion";
import { sha256Hex, uuid } from "./ids";
import { assertSourceDeletionNotClaimed } from "../reservoir/deletionClaim";

export interface ActiveVersion {
  id: string;
  source_id: string;
  version: number;
  r2_key: string | null;
  extracted_text: string | null;
  char_count: number;
  normalized_text: string | null;
  normalization_status: string;
  normalization_report_json: string | null;
  version_origin: string;
  parent_version_id: string | null;
  review_status: VersionReviewStatus;
  created_at: string;
  text_scope: TextScope;
  extraction_method: ExtractionMethod;
  extraction_error: string | null;
  content_type: string | null;
  final_url: string | null;
  acquired_at: string | null;
}

export interface IncomingVersionDecision {
  activateIncoming: boolean;
  reviewStatus: VersionReviewStatus;
}

export function decideIncomingVersion(input: { activeOrigin: string | null; incomingOrigin: string }): IncomingVersionDecision {
  if (input.incomingOrigin === "MANUAL_EDIT") {
    return { activateIncoming: true, reviewStatus: "ACTIVE" };
  }
  if (input.activeOrigin === "MANUAL_EDIT") {
    return { activateIncoming: false, reviewStatus: "PENDING_REVIEW" };
  }
  return { activateIncoming: true, reviewStatus: "ACTIVE" };
}

export interface AppendAcquisitionVersionInput {
  versionId?: string;
  sourceId: string;
  r2Key: string | null;
  extractedText: string;
  inputFormat: InputFormat;
  textScope: TextScope;
  extractionMethod: ExtractionMethod;
  extractionError?: string | null;
  contentType?: string | null;
  finalUrl?: string | null;
  acquiredAt?: string | null;
  versionOrigin?: VersionOrigin;
  parentVersionId?: string | null;
  rawContentHash?: string | null;
}

const MAX_VERSION_RESERVATION_ATTEMPTS = 5;

function meaningfulCharsFromReport(raw: string | null, text: string | null): number {
  try {
    const report = raw ? JSON.parse(raw) as { meaningfulChars?: number } : {};
    if (typeof report.meaningfulChars === "number") return report.meaningfulChars;
  } catch {
    // fall back to the text content below
  }
  return [...(text ?? "").replace(/\[[^\]]*\]/g, "").matchAll(/[\p{L}\p{N}]/gu)].length;
}

function qualityStatusForTextScope(scope: TextScope, normalizedStatus: QualityStatus, meaningfulChars: number): QualityStatus {
  if (scope === "EMPTY") return "EMPTY";
  if (scope === "PARTIAL" || scope === "METADATA_ONLY") return meaningfulChars > 0 ? "REVIEW" : "EMPTY";
  return normalizedStatus;
}

function shouldActivateAcquisitionVersion(input: {
  activeVersion: ActiveVersion | null;
  textScope: TextScope;
  qualityStatus: QualityStatus;
  incomingMeaningfulChars: number;
  incomingOrigin: VersionOrigin;
}): boolean {
  const decision = decideIncomingVersion({
    activeOrigin: input.activeVersion?.version_origin ?? null,
    incomingOrigin: input.incomingOrigin,
  });
  if (!decision.activateIncoming) return false;
  if (!input.activeVersion) return true;
  if (input.textScope === "FULLTEXT") return input.qualityStatus === "READY";
  if (input.textScope === "PARTIAL") {
    const activeMeaningfulChars = meaningfulCharsFromReport(
      input.activeVersion?.normalization_report_json ?? null,
      input.activeVersion?.normalized_text ?? input.activeVersion?.extracted_text ?? null,
    );
    return input.incomingMeaningfulChars > activeMeaningfulChars;
  }
  return false;
}

export async function getActiveVersion(db: D1Database, sourceId: string): Promise<ActiveVersion | null> {
  return db
    .prepare(
      `SELECT v.id, v.source_id, v.version, v.r2_key, v.extracted_text, v.char_count, v.normalized_text,
              v.normalization_status, v.normalization_report_json, v.version_origin,
              v.parent_version_id, v.review_status, v.created_at, v.text_scope,
              v.extraction_method, v.extraction_error, v.content_type, v.final_url, v.acquired_at
       FROM sources s JOIN source_versions v ON v.id = s.active_version_id
       WHERE s.id = ?`
    )
    .bind(sourceId)
    .first<ActiveVersion>();
}

export async function appendAcquisitionVersion(
  db: D1Database,
  input: AppendAcquisitionVersionInput,
): Promise<{ versionId: string; version: number; qualityStatus: QualityStatus }> {
  await assertSourceDeletionNotClaimed(db, input.sourceId);
  const activeVersion = await getActiveVersion(db, input.sourceId);
  const incomingOrigin = input.versionOrigin ?? "REEXTRACT";
  const versionId = input.versionId ?? uuid();
  const extractedText = input.extractedText.slice(0, 500_000);
  const normalized = normalizeIngestText(extractedText, input.inputFormat);
  const meaningfulChars = normalized.report.meaningfulChars;
  const qualityStatus = qualityStatusForTextScope(input.textScope, normalized.qualityStatus, meaningfulChars);
  const contentHash = await sha256Hex(extractedText);
  const normalizedContentHash = await sha256Hex(normalized.normalizedText);
  const ts = input.acquiredAt ?? new Date().toISOString();
  const parentVersionId = input.parentVersionId ?? activeVersion?.id ?? null;
  const { version } = await insertAcquisitionVersion(db, {
    versionId,
    sourceId: input.sourceId,
    r2Key: input.r2Key,
    extractedText,
    contentHash,
    rawContentHash: input.rawContentHash ?? null,
    normalizedContentHash,
    normalizedText: normalized.normalizedText,
    normalizationReportJson: JSON.stringify(normalized.report),
    versionOrigin: incomingOrigin,
    parentVersionId,
    createdAt: ts,
    textScope: input.textScope,
    extractionMethod: input.extractionMethod,
    extractionError: input.extractionError ?? null,
    contentType: input.contentType ?? null,
    finalUrl: input.finalUrl ?? null,
    acquiredAt: input.acquiredAt ?? ts,
  });

  await db.prepare("UPDATE sources SET updated_at = ? WHERE id = ?").bind(ts, input.sourceId).run();

  const currentActiveVersion = await getActiveVersion(db, input.sourceId);
  const activateIncoming = shouldActivateAcquisitionVersion({
    activeVersion: currentActiveVersion,
    textScope: input.textScope,
    qualityStatus,
    incomingMeaningfulChars: meaningfulChars,
    incomingOrigin,
  });

  if (activateIncoming) {
    await activateVersion(db, input.sourceId, versionId, qualityStatus, ts);
  }

  return { versionId, version, qualityStatus };
}

async function insertAcquisitionVersion(
  db: D1Database,
  input: {
    versionId: string;
    sourceId: string;
    r2Key: string | null;
    extractedText: string;
    contentHash: string;
    rawContentHash: string | null;
    normalizedContentHash: string;
    normalizedText: string;
    normalizationReportJson: string;
    versionOrigin: VersionOrigin;
    parentVersionId: string | null;
    createdAt: string;
    textScope: TextScope;
    extractionMethod: ExtractionMethod;
    extractionError: string | null;
    contentType: string | null;
    finalUrl: string | null;
    acquiredAt: string;
  },
): Promise<{ version: number }> {
  for (let attempt = 0; attempt < MAX_VERSION_RESERVATION_ATTEMPTS; attempt++) {
    const row = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM source_versions WHERE source_id = ?")
      .bind(input.sourceId)
      .first<{ version: number }>();
    const version = (row?.version ?? 0) + 1;

    try {
      await db.prepare(
        `INSERT INTO source_versions
         (id, source_id, version, r2_key, extracted_text, char_count, content_hash, raw_content_hash, normalized_content_hash, normalized_text,
          normalization_status, normalization_report_json, version_origin, parent_version_id, review_status, created_at,
          text_scope, extraction_method, extraction_error, content_type, final_url, acquired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, 'PENDING_REVIEW', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        input.versionId,
        input.sourceId,
        version,
        input.r2Key,
        input.extractedText,
        input.extractedText.length,
        input.contentHash,
        input.rawContentHash,
        input.normalizedContentHash,
        input.normalizedText,
        input.normalizationReportJson,
        input.versionOrigin,
        input.parentVersionId,
        input.createdAt,
        input.textScope,
        input.extractionMethod,
        input.extractionError,
        input.contentType,
        input.finalUrl,
        input.acquiredAt,
      ).run();
      return { version };
    } catch (error) {
      if (attempt < MAX_VERSION_RESERVATION_ATTEMPTS - 1 && isVersionReservationConflict(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("version_reservation_failed");
}

function isVersionReservationConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("source_versions.source_id, source_versions.version");
}

export async function activateVersion(db: D1Database, sourceId: string, versionId: string, qualityStatus: QualityStatus, now = new Date().toISOString()): Promise<void> {
  await assertSourceDeletionNotClaimed(db, sourceId);
  const candidate = await db
    .prepare("SELECT id FROM source_versions WHERE id = ? AND source_id = ?")
    .bind(versionId, sourceId)
    .first<{ id: string }>();
  if (!candidate) throw new Error("version_not_found");

  await db.batch([
    db
      .prepare("UPDATE source_versions SET review_status = 'SUPERSEDED', reviewed_at = ? WHERE source_id = ? AND review_status = 'ACTIVE' AND id <> ?")
      .bind(now, sourceId, versionId),
    db
      .prepare("UPDATE source_versions SET review_status = 'ACTIVE', reviewed_at = ? WHERE id = ? AND source_id = ?")
      .bind(now, versionId, sourceId),
    db
      .prepare(
        `UPDATE sources
         SET active_version_id = ?,
             r2_key = (SELECT r2_key FROM source_versions WHERE id = ?),
             file_hash = COALESCE((SELECT raw_content_hash FROM source_versions WHERE id = ?), file_hash),
             quality_status = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(versionId, versionId, versionId, qualityStatus, now, sourceId),
  ]);
}

export async function rejectVersion(db: D1Database, sourceId: string, versionId: string, now = new Date().toISOString()): Promise<void> {
  await assertSourceDeletionNotClaimed(db, sourceId);
  const result = await db
    .prepare("UPDATE source_versions SET review_status = 'REJECTED', reviewed_at = ? WHERE id = ? AND source_id = ? AND review_status = 'PENDING_REVIEW'")
    .bind(now, versionId, sourceId)
    .run();
  if (!result.success) throw new Error("version_reject_failed");
}
