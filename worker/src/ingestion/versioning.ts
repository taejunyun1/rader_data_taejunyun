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

export interface ActiveVersion {
  id: string;
  source_id: string;
  version: number;
  r2_key: string | null;
  extracted_text: string | null;
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
}

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
      `SELECT v.id, v.source_id, v.version, v.r2_key, v.extracted_text, v.normalized_text,
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
  const activeVersion = await getActiveVersion(db, input.sourceId);
  const incomingOrigin = input.versionOrigin ?? "REEXTRACT";
  const row = await db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM source_versions WHERE source_id = ?")
    .bind(input.sourceId)
    .first<{ version: number }>();
  const version = (row?.version ?? 0) + 1;
  const versionId = uuid();
  const extractedText = input.extractedText.slice(0, 500_000);
  const normalized = normalizeIngestText(extractedText, input.inputFormat);
  const meaningfulChars = normalized.report.meaningfulChars;
  const qualityStatus = qualityStatusForTextScope(input.textScope, normalized.qualityStatus, meaningfulChars);
  const activateIncoming = shouldActivateAcquisitionVersion({
    activeVersion,
    textScope: input.textScope,
    qualityStatus,
    incomingMeaningfulChars: meaningfulChars,
    incomingOrigin,
  });
  const reviewStatus: VersionReviewStatus = activateIncoming ? "ACTIVE" : "PENDING_REVIEW";
  const contentHash = await sha256Hex(extractedText);
  const ts = input.acquiredAt ?? new Date().toISOString();

  await db.batch([
    db.prepare(
      `INSERT INTO source_versions
       (id, source_id, version, r2_key, extracted_text, char_count, content_hash, normalized_text,
        normalization_status, normalization_report_json, version_origin, parent_version_id, review_status, created_at,
        text_scope, extraction_method, extraction_error, content_type, final_url, acquired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      versionId,
      input.sourceId,
      version,
      input.r2Key,
      extractedText,
      extractedText.length,
      contentHash,
      normalized.normalizedText,
      JSON.stringify(normalized.report),
      incomingOrigin,
      input.parentVersionId ?? activeVersion?.id ?? null,
      reviewStatus,
      ts,
      input.textScope,
      input.extractionMethod,
      input.extractionError ?? null,
      input.contentType ?? null,
      input.finalUrl ?? null,
      input.acquiredAt ?? ts,
    ),
    db.prepare("UPDATE sources SET updated_at = ? WHERE id = ?").bind(ts, input.sourceId),
  ]);

  if (activateIncoming) {
    await activateVersion(db, input.sourceId, versionId, qualityStatus, ts);
  }

  return { versionId, version, qualityStatus };
}

export async function activateVersion(db: D1Database, sourceId: string, versionId: string, qualityStatus: QualityStatus, now = new Date().toISOString()): Promise<void> {
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
             file_hash = COALESCE((SELECT content_hash FROM source_versions WHERE id = ?), file_hash),
             quality_status = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(versionId, versionId, versionId, qualityStatus, now, sourceId),
  ]);
}

export async function rejectVersion(db: D1Database, sourceId: string, versionId: string, now = new Date().toISOString()): Promise<void> {
  const result = await db
    .prepare("UPDATE source_versions SET review_status = 'REJECTED', reviewed_at = ? WHERE id = ? AND source_id = ? AND review_status = 'PENDING_REVIEW'")
    .bind(now, versionId, sourceId)
    .run();
  if (!result.success) throw new Error("version_reject_failed");
}
