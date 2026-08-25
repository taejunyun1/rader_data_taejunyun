import { sha256Hex, uuid } from "../ingestion/ids";
import { getOriginalVisualVersion, getVisualAsset, getVisualVersion } from "./store";
import { imageDHash, VISUAL_HASH_METHOD } from "./perceptualHash";

export type VisualTransformProfile = "PHOTO_V1" | "GRAPHIC_V1";

const PROFILES: Record<VisualTransformProfile, { width: number; quality: number }> = {
  PHOTO_V1: { width: 768, quality: 78 },
  GRAPHIC_V1: { width: 1280, quality: 92 },
};

export interface TransformResult {
  visualAssetId: string;
  sourceId: string | null;
  capsuleVersionId: string;
  perceptualHash: string;
}

export async function transformVisualAsset(env: Env, visualAssetId: string, profile: VisualTransformProfile = "PHOTO_V1"): Promise<TransformResult> {
  const asset = await getVisualAsset(env.DB, visualAssetId);
  if (!asset) throw new Error("visual_asset_not_found");
  const originalVersion = await getOriginalVisualVersion(env.DB, visualAssetId);
  if (!originalVersion?.r2Key) throw new Error("VISUAL_ORIGINAL_MISSING");

  const existing = await getVisualVersion(env.DB, visualAssetId, "CAPSULE");
  if (existing?.id && existing.r2Key) {
    const existingObject = await env.ORIGINALS.get(existing.r2Key);
    if (existingObject) {
      const hash = asset.perceptualHash ?? await imageDHash(env, await existingObject.arrayBuffer());
      await env.DB.prepare("UPDATE visual_assets SET perceptual_hash = COALESCE(perceptual_hash, ?), perceptual_hash_method = COALESCE(perceptual_hash_method, ?), processing_status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(hash, VISUAL_HASH_METHOD, asset.assignmentStatus === "ASSIGNED" ? "ANALYSIS_PENDING" : "READY", new Date().toISOString(), visualAssetId).run();
      return { visualAssetId, sourceId: asset.parentSourceId, capsuleVersionId: existing.id, perceptualHash: hash };
    }
  }

  await env.DB.prepare("UPDATE visual_assets SET processing_status = 'TRANSFORMING', last_error = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), visualAssetId).run();
  const originalObject = await env.ORIGINALS.get(originalVersion.r2Key);
  if (!originalObject) throw new Error("VISUAL_ORIGINAL_MISSING");
  const originalBytes = await originalObject.arrayBuffer();
  const sourceInfo = await env.IMAGES.info(new Response(originalBytes).body!);
  if (!("width" in sourceInfo) || !sourceInfo.width || !sourceInfo.height) throw new Error("VISUAL_DIMENSIONS_UNAVAILABLE");

  const hash = await imageDHash(env, originalBytes);
  const options = PROFILES[profile];
  const transformed = await env.IMAGES
    .input(new Response(originalBytes).body!)
    .transform({ width: options.width, fit: "scale-down" })
    .output({ format: "image/webp", quality: options.quality, anim: false });
  const capsuleBytes = await transformed.response().arrayBuffer();
  if (!capsuleBytes.byteLength) throw new Error("VISUAL_CAPSULE_EMPTY");
  const capsuleInfo = await env.IMAGES.info(new Response(capsuleBytes).body!);
  if (!("width" in capsuleInfo) || !capsuleInfo.width || !capsuleInfo.height) throw new Error("VISUAL_CAPSULE_DIMENSIONS_UNAVAILABLE");

  const capsuleVersionId = uuid();
  const capsuleKey = `visuals/${visualAssetId}/capsule/1.webp`;
  const capsuleHash = await sha256Hex(capsuleBytes);
  await env.ORIGINALS.put(capsuleKey, capsuleBytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { visualAssetId, variant: "CAPSULE", profile },
  });
  try {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE visual_asset_versions SET width = ?, height = ? WHERE id = ?")
        .bind(sourceInfo.width, sourceInfo.height, originalVersion.id),
      env.DB.prepare(
        `INSERT INTO visual_asset_versions
         (id, visual_asset_id, version, variant, r2_key, mime_type, width, height, byte_size, content_hash, transform_profile_json, parent_asset_version_id, created_at)
         VALUES (?, ?, 1, 'CAPSULE', ?, 'image/webp', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(capsuleVersionId, visualAssetId, capsuleKey, capsuleInfo.width, capsuleInfo.height, capsuleBytes.byteLength, capsuleHash, JSON.stringify({ profile, sourceWidth: sourceInfo.width, sourceHeight: sourceInfo.height }), originalVersion.id, now),
      env.DB.prepare("UPDATE visual_assets SET perceptual_hash = ?, perceptual_hash_method = ?, processing_status = ?, last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(hash, VISUAL_HASH_METHOD, asset.assignmentStatus === "ASSIGNED" ? "ANALYSIS_PENDING" : "READY", now, visualAssetId),
    ]);
  } catch (error) {
    await env.ORIGINALS.delete(capsuleKey).catch(() => undefined);
    throw error;
  }

  return { visualAssetId, sourceId: asset.parentSourceId, capsuleVersionId, perceptualHash: hash };
}
