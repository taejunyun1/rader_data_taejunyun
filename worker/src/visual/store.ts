import type { VisualAssetSummary } from "@radar/shared";
import { sha256Hex, uuid } from "../ingestion/ids";
import type { CreatePersonalVisualInput, VisualAssetRow, VisualAssetVersionRow } from "./contracts";
import { extensionForVisualType, safeVisualFilename } from "./contracts";

type DbRow = Record<string, unknown>;

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
    caption: nullableString(row.caption),
    nearbyText: nullableString(row.nearbyText),
    assetRole: String(row.assetRole) as VisualAssetRow["assetRole"],
    visualKind: String(row.visualKind) as VisualAssetRow["visualKind"],
    selectionStatus: String(row.selectionStatus) as VisualAssetRow["selectionStatus"],
    selectionReason: nullableString(row.selectionReason),
    rightsStatus: String(row.rightsStatus) as VisualAssetRow["rightsStatus"],
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

export async function getVisualAsset(db: D1Database, id: string): Promise<VisualAssetRow | null> {
  const row = await db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId,
            origin_kind AS originKind, source_url AS sourceUrl, page_number AS pageNumber,
            figure_label AS figureLabel, caption, nearby_text AS nearbyText, asset_role AS assetRole,
            visual_kind AS visualKind, selection_status AS selectionStatus, selection_reason AS selectionReason,
            rights_status AS rightsStatus, assignment_status AS assignmentStatus, storage_state AS storageState,
            pending_storage_state AS pendingStorageState, processing_status AS processingStatus,
            last_error AS lastError, content_hash AS contentHash, perceptual_hash AS perceptualHash,
            perceptual_hash_method AS perceptualHashMethod, created_at AS createdAt, updated_at AS updatedAt,
            deleted_at AS deletedAt
     FROM visual_assets WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<DbRow>();
  return row ? mapVisualAsset(row) : null;
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

export function toVisualAssetSummary(asset: VisualAssetRow, capsuleVersionId: string | null = null): VisualAssetSummary {
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
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}
