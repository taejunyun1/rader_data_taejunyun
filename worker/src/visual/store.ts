import type {
  NormalizedVisualBbox,
  VisualAnalysisSummary,
  VisualAssetDetail,
  VisualAssetListResponse,
  VisualAssetSummary,
  VisualExtractionRunSummary,
  VisualRelationSummary,
} from "@radar/shared";
import { sha256Hex, uuid } from "../ingestion/ids";
import type { CreatePersonalVisualInput, VisualAssetRow, VisualAssetVersionRow } from "./contracts";
import { extensionForVisualType, safeVisualFilename } from "./contracts";

type DbRow = Record<string, unknown>;

interface VisualAnalysisRow extends VisualAnalysisSummary {
  visualVersionId: string;
  analysisType: "AUTO_SUGGESTION" | "USER_VERIFIED";
  parentAnalysisId: string | null;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function mapVisualAsset(row: DbRow): VisualAssetRow {
  return {
    id: String(row.id),
    parentSourceId: nullableString(row.parentSourceId),
    parentVersionId: nullableString(row.parentVersionId),
    originKind: String(row.originKind) as VisualAssetRow["originKind"],
    sourceUrl: nullableString(row.sourceUrl),
    pageNumber: row.pageNumber == null ? null : Number(row.pageNumber),
    figureLabel: nullableString(row.figureLabel),
    bboxJson: nullableString(row.bboxJson),
    candidateKey: nullableString(row.candidateKey),
    caption: nullableString(row.caption),
    nearbyText: nullableString(row.nearbyText),
    assetRole: String(row.assetRole) as VisualAssetRow["assetRole"],
    visualKind: String(row.visualKind) as VisualAssetRow["visualKind"],
    selectionStatus: String(row.selectionStatus) as VisualAssetRow["selectionStatus"],
    selectionReason: nullableString(row.selectionReason),
    rightsStatus: String(row.rightsStatus) as VisualAssetRow["rightsStatus"],
    rightsBasis: nullableString(row.rightsBasis),
    rightsReviewedAt: nullableString(row.rightsReviewedAt),
    assignmentStatus: String(row.assignmentStatus) as VisualAssetRow["assignmentStatus"],
    storageState: String(row.storageState) as VisualAssetRow["storageState"],
    pendingStorageState: nullableString(row.pendingStorageState) as VisualAssetRow["pendingStorageState"],
    processingStatus: String(row.processingStatus) as VisualAssetRow["processingStatus"],
    lastError: nullableString(row.lastError),
    contentHash: nullableString(row.contentHash),
    perceptualHash: nullableString(row.perceptualHash),
    perceptualHashMethod: nullableString(row.perceptualHashMethod) as VisualAssetRow["perceptualHashMethod"],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    deletedAt: nullableString(row.deletedAt),
  };
}

const ANALYSIS_SELECT = `SELECT id, visual_version_id AS visualVersionId, analysis_type AS analysisType,
  provenance_class AS provenanceClass, payload_json AS payload, confidence,
  review_status AS reviewStatus, model_id AS modelId, prompt_version AS promptVersion,
  created_at AS createdAt, parent_analysis_id AS parentAnalysisId
  FROM visual_analyses`;

export async function getVisualAsset(db: D1Database, id: string): Promise<VisualAssetRow | null> {
  const row = await db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId,
            origin_kind AS originKind, source_url AS sourceUrl, page_number AS pageNumber,
            figure_label AS figureLabel, bbox_json AS bboxJson, candidate_key AS candidateKey,
            caption, nearby_text AS nearbyText, asset_role AS assetRole,
            visual_kind AS visualKind, selection_status AS selectionStatus, selection_reason AS selectionReason,
            rights_status AS rightsStatus, rights_basis AS rightsBasis, rights_reviewed_at AS rightsReviewedAt,
            assignment_status AS assignmentStatus, storage_state AS storageState,
            pending_storage_state AS pendingStorageState, processing_status AS processingStatus,
            last_error AS lastError, content_hash AS contentHash, perceptual_hash AS perceptualHash,
            perceptual_hash_method AS perceptualHashMethod, created_at AS createdAt, updated_at AS updatedAt,
            deleted_at AS deletedAt
     FROM visual_assets WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<DbRow>();
  return row ? mapVisualAsset(row) : null;
}

export async function listVisualAssets(
  db: D1Database,
  options: { parentSourceId?: string | null; unassignedOnly?: boolean; limit?: number } = {},
): Promise<VisualAssetListResponse> {
  const params: (string | number)[] = [];
  let where = "a.deleted_at IS NULL";
  if (options.unassignedOnly) {
    where += " AND a.assignment_status = 'UNASSIGNED'";
  } else if (options.parentSourceId) {
    params.push(options.parentSourceId);
    where += " AND a.parent_source_id = ?";
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  params.push(limit);
  const rows = await db.prepare(
    `SELECT a.id, a.parent_source_id AS parentSourceId, a.parent_version_id AS parentVersionId,
            a.origin_kind AS originKind, a.source_url AS sourceUrl, a.page_number AS pageNumber,
            a.figure_label AS figureLabel, a.bbox_json AS bboxJson, a.candidate_key AS candidateKey,
            a.caption, a.nearby_text AS nearbyText, a.asset_role AS assetRole,
            a.visual_kind AS visualKind, a.selection_status AS selectionStatus, a.selection_reason AS selectionReason,
            a.rights_status AS rightsStatus, a.rights_basis AS rightsBasis, a.rights_reviewed_at AS rightsReviewedAt,
            a.assignment_status AS assignmentStatus, a.storage_state AS storageState,
            a.pending_storage_state AS pendingStorageState, a.processing_status AS processingStatus,
            a.last_error AS lastError, a.content_hash AS contentHash, a.perceptual_hash AS perceptualHash,
            a.perceptual_hash_method AS perceptualHashMethod, a.created_at AS createdAt, a.updated_at AS updatedAt,
            a.deleted_at AS deletedAt,
            (SELECT v.id FROM visual_asset_versions v
             WHERE v.visual_asset_id = a.id AND v.variant = 'CAPSULE' AND v.deleted_at IS NULL
             ORDER BY v.version DESC LIMIT 1) AS capsuleVersionId,
            (SELECT an.id FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisId,
            (SELECT an.payload_json FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisPayload,
            (SELECT an.provenance_class FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisProvenanceClass,
            (SELECT an.confidence FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisConfidence,
            (SELECT an.review_status FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisReviewStatus,
            (SELECT an.model_id FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisModelId,
            (SELECT an.prompt_version FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisPromptVersion,
            (SELECT an.created_at FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
             ORDER BY an.created_at DESC LIMIT 1) AS analysisCreatedAt
     FROM visual_assets a
     WHERE ${where}
     ORDER BY a.created_at DESC LIMIT ?`
  ).bind(...params).all<DbRow & { capsuleVersionId?: string | null }>();
  return { items: (rows.results ?? []).map((row) => toVisualAssetSummary(
    mapVisualAsset(row),
    nullableString(row.capsuleVersionId),
    toVisualAnalysisSummary({
      id: row.analysisId,
      payload: row.analysisPayload,
      provenanceClass: row.analysisProvenanceClass,
      confidence: row.analysisConfidence,
      reviewStatus: row.analysisReviewStatus,
      modelId: row.analysisModelId,
      promptVersion: row.analysisPromptVersion,
      createdAt: row.analysisCreatedAt,
    }),
  )) };
}

export async function createPersonalVisual(
  env: Env,
  input: CreatePersonalVisualInput,
): Promise<{ asset: VisualAssetRow; originalVersion: VisualAssetVersionRow; r2Key: string }> {
  const id = uuid();
  const versionId = uuid();
  const timestamp = new Date().toISOString();
  const contentHash = await sha256Hex(input.bytes);
  const filename = safeVisualFilename(input.filename);
  const extension = extensionForVisualType(input.contentType, filename);
  const r2Key = `visuals/${id}/original/1.${extension}`;
  const assignmentStatus = input.parentSourceId ? "ASSIGNED" : "UNASSIGNED";

  await env.ORIGINALS.put(r2Key, input.bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: { visualAssetId: id, variant: "ORIGINAL", source: "PERSONAL_UPLOAD" },
  });

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visual_assets
         (id, parent_source_id, origin_kind, asset_role, visual_kind, selection_status, rights_status,
          is_personal_work, assignment_status, storage_state, processing_status, content_hash,
          perceptual_hash, perceptual_hash_method, created_at, updated_at)
         VALUES (?, ?, 'PERSONAL_UPLOAD', 'PERSONAL_WORK', 'OTHER', 'SELECTED', 'PERSONAL', 1, ?, 'ARCHIVAL', 'TRANSFORM_PENDING', ?, NULL, NULL, ?, ?)`
      ).bind(id, input.parentSourceId, assignmentStatus, contentHash, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO visual_asset_versions
         (id, visual_asset_id, version, variant, r2_key, mime_type, byte_size, content_hash, created_at)
         VALUES (?, ?, 1, 'ORIGINAL', ?, ?, ?, ?, ?)`
      ).bind(versionId, id, r2Key, input.contentType, input.bytes.byteLength, contentHash, timestamp),
    ]);
  } catch (error) {
    await env.ORIGINALS.delete(r2Key).catch(() => undefined);
    throw error;
  }

  const asset = await getVisualAsset(env.DB, id);
  if (!asset) throw new Error("visual_asset_create_failed");
  return {
    asset,
    originalVersion: {
      id: versionId,
      visualAssetId: id,
      version: 1,
      variant: "ORIGINAL",
      r2Key,
      mimeType: input.contentType,
      width: null,
      height: null,
      byteSize: input.bytes.byteLength,
      contentHash,
      parentAssetVersionId: null,
      deletedAt: null,
    },
    r2Key,
  };
}

export async function markVisualProcessingError(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare("UPDATE visual_assets SET processing_status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?")
    .bind(error.slice(0, 300), new Date().toISOString(), id).run();
}

export async function getOriginalVisualVersion(db: D1Database, visualAssetId: string): Promise<VisualAssetVersionRow | null> {
  const row = await db.prepare(
    `SELECT id, visual_asset_id AS visualAssetId, version, variant, r2_key AS r2Key, mime_type AS mimeType,
            width, height, byte_size AS byteSize, content_hash AS contentHash,
            parent_asset_version_id AS parentAssetVersionId, deleted_at AS deletedAt
     FROM visual_asset_versions
     WHERE visual_asset_id = ? AND variant = 'ORIGINAL' AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`
  ).bind(visualAssetId).first<DbRow>();
  if (!row) return null;
  return {
    id: String(row.id),
    visualAssetId: String(row.visualAssetId),
    version: Number(row.version),
    variant: String(row.variant) as VisualAssetVersionRow["variant"],
    r2Key: nullableString(row.r2Key),
    mimeType: String(row.mimeType),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    byteSize: Number(row.byteSize),
    contentHash: String(row.contentHash),
    parentAssetVersionId: nullableString(row.parentAssetVersionId),
    deletedAt: nullableString(row.deletedAt),
  };
}

export async function getVisualVersion(db: D1Database, visualAssetId: string, variant: "ORIGINAL" | "CAPSULE"): Promise<VisualAssetVersionRow | null> {
  const row = await db.prepare(
    `SELECT id, visual_asset_id AS visualAssetId, version, variant, r2_key AS r2Key, mime_type AS mimeType,
            width, height, byte_size AS byteSize, content_hash AS contentHash,
            parent_asset_version_id AS parentAssetVersionId, deleted_at AS deletedAt
     FROM visual_asset_versions
     WHERE visual_asset_id = ? AND variant = ? AND deleted_at IS NULL
     ORDER BY version DESC LIMIT 1`
  ).bind(visualAssetId, variant).first<DbRow>();
  if (!row) return null;
  return {
    id: String(row.id),
    visualAssetId: String(row.visualAssetId),
    version: Number(row.version),
    variant: String(row.variant) as VisualAssetVersionRow["variant"],
    r2Key: nullableString(row.r2Key),
    mimeType: String(row.mimeType),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    byteSize: Number(row.byteSize),
    contentHash: String(row.contentHash),
    parentAssetVersionId: nullableString(row.parentAssetVersionId),
    deletedAt: nullableString(row.deletedAt),
  };
}

/** Resolve the version that owns the visual analysis, including metadata-only LINK_ONLY ORIGINALs. */
export async function getVisualVersionForAnalysis(db: D1Database, visualAssetId: string): Promise<VisualAssetVersionRow | null> {
  return (await getVisualVersion(db, visualAssetId, "CAPSULE"))
    ?? getOriginalVisualVersion(db, visualAssetId);
}

export async function getLatestVisualAnalysis(db: D1Database, visualAssetId: string): Promise<VisualAnalysisSummary | null> {
  const row = await db.prepare(`${ANALYSIS_SELECT} WHERE visual_asset_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(visualAssetId).first<DbRow>();
  return toVisualAnalysisSummary(row);
}

export async function getLatestVisualAnalysisForVersion(
  db: D1Database,
  visualAssetId: string,
  visualVersionId: string,
): Promise<VisualAnalysisSummary | null> {
  const row = await db.prepare(`${ANALYSIS_SELECT} WHERE visual_asset_id = ? AND visual_version_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(visualAssetId, visualVersionId).first<DbRow>();
  return toVisualAnalysisSummary(row);
}

export async function getLatestVisualAnalysisRowForVersion(
  db: D1Database,
  visualAssetId: string,
  visualVersionId: string,
): Promise<VisualAnalysisRow | null> {
  const row = await db.prepare(
    `${ANALYSIS_SELECT}
     WHERE visual_asset_id = ? AND visual_version_id = ?
       AND analysis_type IN ('AUTO_SUGGESTION', 'USER_VERIFIED')
     ORDER BY created_at DESC, id DESC LIMIT 1`
  ).bind(visualAssetId, visualVersionId).first<DbRow>();
  return toVisualAnalysisRow(row);
}

export async function getVisualAnalysisRow(
  db: D1Database,
  visualAssetId: string,
  analysisType: "AUTO_SUGGESTION" | "USER_VERIFIED",
): Promise<VisualAnalysisRow | null> {
  const row = await db.prepare(`${ANALYSIS_SELECT} WHERE visual_asset_id = ? AND analysis_type = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(visualAssetId, analysisType).first<DbRow>();
  return toVisualAnalysisRow(row);
}

export async function getVisualAnalysisRowForVersion(
  db: D1Database,
  visualAssetId: string,
  analysisType: "AUTO_SUGGESTION" | "USER_VERIFIED",
  visualVersionId: string,
): Promise<VisualAnalysisRow | null> {
  const row = await db.prepare(`${ANALYSIS_SELECT} WHERE visual_asset_id = ? AND analysis_type = ? AND visual_version_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(visualAssetId, analysisType, visualVersionId).first<DbRow>();
  return toVisualAnalysisRow(row);
}

export async function getVisualAssetDetail(db: D1Database, id: string): Promise<VisualAssetDetail | null> {
  const asset = await getVisualAsset(db, id);
  if (!asset) return null;

  const [capsule, analysisVersion] = await Promise.all([
    getVisualVersion(db, id, "CAPSULE"),
    getVisualVersionForAnalysis(db, id),
  ]);
  const [autoSuggestion, userVerified, relations, extractionRun] = await Promise.all([
    analysisVersion ? getVisualAnalysisRowForVersion(db, id, "AUTO_SUGGESTION", analysisVersion.id) : Promise.resolve(null),
    analysisVersion ? getVisualAnalysisRowForVersion(db, id, "USER_VERIFIED", analysisVersion.id) : Promise.resolve(null),
    listVisualRelations(db, id),
    getVisualExtractionRunForAsset(db, asset),
  ]);

  return toVisualAssetDetail(
    asset,
    autoSuggestion,
    userVerified,
    relations,
    extractionRun,
    capsule?.id ?? null,
  );
}

export async function createUserVerifiedVisualAnalysis(
  db: D1Database,
  input: {
    visualAssetId: string;
    payload: unknown;
    reviewStatus: "ACCEPTED" | "EDITED";
    baseAnalysisId: string;
    baseVisualVersionId: string;
  },
): Promise<VisualAnalysisSummary | null> {
  const parent = await db.prepare(
    `${ANALYSIS_SELECT}
     WHERE id = ? AND visual_asset_id = ? AND visual_version_id = ?
       AND analysis_type IN ('AUTO_SUGGESTION', 'USER_VERIFIED')
       AND visual_version_id = (
         SELECT current_version.id
         FROM visual_asset_versions current_version
         WHERE current_version.visual_asset_id = ?
           AND current_version.deleted_at IS NULL
           AND (
             current_version.variant = 'CAPSULE'
             OR (
               current_version.variant = 'ORIGINAL'
               AND NOT EXISTS (
                 SELECT 1
                 FROM visual_asset_versions capsule_version
                 WHERE capsule_version.visual_asset_id = current_version.visual_asset_id
                   AND capsule_version.variant = 'CAPSULE'
                   AND capsule_version.deleted_at IS NULL
               )
             )
           )
         ORDER BY CASE WHEN current_version.variant = 'CAPSULE' THEN 0 ELSE 1 END, current_version.version DESC
         LIMIT 1
       )`
  ).bind(input.baseAnalysisId, input.visualAssetId, input.baseVisualVersionId, input.visualAssetId).first<DbRow>();
  const parentRow = toVisualAnalysisRow(parent);
  if (!parentRow) return null;
  const id = uuid();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO visual_analyses
     (id, visual_asset_id, visual_version_id, analysis_type, provenance_class, payload_json,
      model_id, prompt_version, cost_usd, confidence, review_status, created_at, reviewed_at, parent_analysis_id)
     VALUES (?, ?, ?, 'USER_VERIFIED', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    input.visualAssetId,
    parentRow.visualVersionId,
    parentRow.provenanceClass,
    JSON.stringify(input.payload),
    parentRow.modelId,
    parentRow.promptVersion,
    parentRow.confidence,
    input.reviewStatus,
    now,
    now,
    parentRow.id,
  ).run();
  await db.prepare(
    `UPDATE visual_assets
     SET selection_status = 'SELECTED',
         selection_reason = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    input.reviewStatus === "ACCEPTED" ? "사용자 검토 완료" : "사용자가 제안을 수정함",
    now,
    input.visualAssetId,
  ).run();
  return getLatestVisualAnalysisForVersion(db, input.visualAssetId, input.baseVisualVersionId);
}

export async function updateAutoSuggestionReviewStatus(
  db: D1Database,
  visualAssetId: string,
  reviewStatus: VisualAnalysisSummary["reviewStatus"],
  visualVersionId: string,
): Promise<boolean> {
  const autoSuggestion = await getVisualAnalysisRowForVersion(db, visualAssetId, "AUTO_SUGGESTION", visualVersionId);
  if (!autoSuggestion) return false;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `UPDATE visual_analyses
       SET review_status = ?, reviewed_at = ?
       WHERE id = ?`
    ).bind(reviewStatus, now, autoSuggestion.id),
    db.prepare(
      `UPDATE visual_assets
       SET selection_status = 'REVIEW',
           selection_reason = ?,
           updated_at = ?
       WHERE id = ?`
    ).bind("사용자가 제안을 보류함", now, visualAssetId),
  ]);
  return true;
}

function toVisualAnalysisSummary(row: DbRow | null | undefined): VisualAnalysisSummary | null {
  if (!row?.id || typeof row.payload !== "string") return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      id: String(row.id),
      payload,
      provenanceClass: String(row.provenanceClass) === "ARTISTIC_PROPOSITION" ? "ARTISTIC_PROPOSITION" : "INTERPRETATION",
      confidence: row.confidence == null ? null : Number(row.confidence),
      reviewStatus: String(row.reviewStatus) as VisualAnalysisSummary["reviewStatus"],
      modelId: nullableString(row.modelId),
      promptVersion: nullableString(row.promptVersion),
      createdAt: String(row.createdAt),
    };
  } catch {
    return null;
  }
}

function toVisualAnalysisRow(row: DbRow | null | undefined): VisualAnalysisRow | null {
  const summary = toVisualAnalysisSummary(row);
  if (!summary || !row?.visualVersionId || !row?.analysisType) return null;
  return {
    ...summary,
    visualVersionId: String(row.visualVersionId),
    analysisType: String(row.analysisType) as VisualAnalysisRow["analysisType"],
    parentAnalysisId: nullableString(row.parentAnalysisId),
  };
}

async function listVisualRelations(db: D1Database, visualAssetId: string): Promise<VisualRelationSummary[]> {
  const rows = await db.prepare(
    `SELECT id, relation_kind AS relationKind, created_by AS createdBy, description,
            to_visual_asset_id AS toVisualAssetId, related_source_id AS relatedSourceId,
            related_thread_id AS relatedThreadId, created_at AS createdAt
     FROM visual_relations
     WHERE from_visual_asset_id = ?
     ORDER BY created_at DESC, id DESC`
  ).bind(visualAssetId).all<DbRow>();
  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    relationKind: String(row.relationKind),
    createdBy: String(row.createdBy) === "USER" ? "USER" : "SYSTEM",
    description: nullableString(row.description),
    toVisualAssetId: nullableString(row.toVisualAssetId),
    relatedSourceId: nullableString(row.relatedSourceId),
    relatedThreadId: nullableString(row.relatedThreadId),
    createdAt: String(row.createdAt),
  }));
}

async function getVisualExtractionRunForAsset(
  db: D1Database,
  asset: VisualAssetRow,
): Promise<VisualExtractionRunSummary | null> {
  if (!asset.parentSourceId || !asset.parentVersionId || asset.originKind === "PERSONAL_UPLOAD") return null;
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
     ORDER BY created_at DESC LIMIT 1`
  ).bind(asset.parentSourceId, asset.parentVersionId, asset.originKind).first<DbRow>();
  if (!row?.id) return null;
  return {
    id: String(row.id),
    parentSourceId: String(row.parentSourceId),
    parentVersionId: String(row.parentVersionId),
    originKind: String(row.originKind) as VisualExtractionRunSummary["originKind"],
    status: String(row.status) as VisualExtractionRunSummary["status"],
    totalUnits: Number(row.totalUnits ?? 0),
    uploadedUnits: Number(row.uploadedUnits ?? 0),
    processedUnits: Number(row.processedUnits ?? 0),
    selectedCount: Number(row.selectedCount ?? 0),
    reviewCount: Number(row.reviewCount ?? 0),
    filteredCount: Number(row.filteredCount ?? 0),
    unavailableCount: Number(row.unavailableCount ?? 0),
    errorCode: nullableString(row.errorCode),
    error: nullableString(row.error),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    finishedAt: nullableString(row.finishedAt),
  };
}

function parseNormalizedVisualBbox(value: string | null): NormalizedVisualBbox | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number" || typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return null;
    }
    return {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
      page: parsed.page == null ? null : Number(parsed.page),
    };
  } catch {
    return null;
  }
}

export function toVisualAssetSummary(asset: VisualAssetRow, capsuleVersionId: string | null = null, analysis: VisualAnalysisSummary | null = null): VisualAssetSummary {
  return {
    id: asset.id,
    parentSourceId: asset.parentSourceId,
    parentVersionId: asset.parentVersionId,
    originKind: asset.originKind,
    sourceUrl: asset.sourceUrl,
    pageNumber: asset.pageNumber,
    figureLabel: asset.figureLabel,
    caption: asset.caption,
    visualKind: asset.visualKind,
    selectionStatus: asset.selectionStatus,
    selectionReason: asset.selectionReason,
    rightsStatus: asset.rightsStatus,
    storageState: asset.storageState,
    pendingStorageState: asset.pendingStorageState,
    processingStatus: asset.processingStatus,
    perceptualHash: asset.perceptualHash,
    capsuleVersionId,
    thumbnailUrl: capsuleVersionId ? `/api/visual-assets/${asset.id}/content?variant=CAPSULE` : null,
    analysis,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

export function toVisualAssetDetail(
  asset: VisualAssetRow,
  autoSuggestion: VisualAnalysisSummary | null = null,
  userVerified: VisualAnalysisSummary | null = null,
  relations: VisualRelationSummary[] = [],
  extractionRun: VisualExtractionRunSummary | null = null,
  capsuleVersionId: string | null = null,
): VisualAssetDetail {
  return {
    ...toVisualAssetSummary(asset, capsuleVersionId, userVerified ?? autoSuggestion),
    candidateKey: asset.candidateKey,
    bbox: parseNormalizedVisualBbox(asset.bboxJson),
    nearbyText: asset.nearbyText,
    rightsBasis: asset.rightsBasis,
    rightsReviewedAt: asset.rightsReviewedAt,
    autoSuggestion,
    userVerified,
    relations,
    extractionRun,
  };
}
