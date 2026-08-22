import type { QualityStatus, VersionReviewStatus } from "@radar/shared/ingestion";

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

export async function getActiveVersion(db: D1Database, sourceId: string): Promise<ActiveVersion | null> {
  return db
    .prepare(
      `SELECT v.id, v.source_id, v.version, v.r2_key, v.extracted_text, v.normalized_text,
              v.normalization_status, v.normalization_report_json, v.version_origin,
              v.parent_version_id, v.review_status, v.created_at
       FROM sources s JOIN source_versions v ON v.id = s.active_version_id
       WHERE s.id = ?`
    )
    .bind(sourceId)
    .first<ActiveVersion>();
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
