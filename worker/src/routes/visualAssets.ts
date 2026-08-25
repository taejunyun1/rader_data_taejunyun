import { Hono } from "hono";
import { enqueueResearchJob } from "../jobs/enqueue";
import {
  ALLOWED_PERSONAL_VISUAL_TYPES,
  MAX_PERSONAL_VISUAL_BYTES,
} from "../visual/contracts";
import { validateVisualAnalysis } from "../visual/analysisSchema";
import { createPersonalVisual, getLatestVisualAnalysis, getVisualAsset, getVisualVersion, listVisualAssets, toVisualAssetSummary } from "../visual/store";

const visualAssets = new Hono<{ Bindings: Env }>();

function requestedBy(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
}

function hasSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.slice(0, 8).every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]);
  if (contentType === "image/gif") return new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a" || new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a";
  if (contentType === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

async function parentExists(db: D1Database, sourceId: string | null): Promise<boolean> {
  if (!sourceId) return true;
  const row = await db.prepare("SELECT id FROM sources WHERE id = ? LIMIT 1").bind(sourceId).first<{ id: string }>();
  return Boolean(row);
}

visualAssets.get("/", async (c) => {
  const sourceId = c.req.query("sourceId")?.trim() || undefined;
  const unassignedOnly = c.req.query("unassigned") === "1";
  return c.json(await listVisualAssets(c.env.DB, { parentSourceId: sourceId, unassignedOnly }));
});

visualAssets.post("/", async (c) => {
  const form = await c.req.raw.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file_required" }, 400);
  if (file.size <= 0) return c.json({ error: "file_empty" }, 400);
  if (file.size > MAX_PERSONAL_VISUAL_BYTES) return c.json({ error: "visual_file_too_large", maxBytes: MAX_PERSONAL_VISUAL_BYTES }, 413);

  const contentType = file.type.toLowerCase();
  if (!ALLOWED_PERSONAL_VISUAL_TYPES.has(contentType)) return c.json({ error: "unsupported_visual_type" }, 415);
  const bytes = await file.arrayBuffer();
  if (!hasSignature(new Uint8Array(bytes), contentType)) return c.json({ error: "visual_signature_invalid" }, 415);

  const parentSourceId = String(form?.get("parentSourceId") ?? "").trim() || null;
  if (!(await parentExists(c.env.DB, parentSourceId))) return c.json({ error: "parent_source_not_found" }, 404);

  try {
    const imageInfo = await c.env.IMAGES.info(new Response(bytes).body!);
    if (imageInfo.format === "image/svg+xml" || !("width" in imageInfo) || !imageInfo.width || !imageInfo.height) {
      return c.json({ error: "visual_dimensions_unavailable" }, 415);
    }

    const created = await createPersonalVisual(c.env, {
      bytes,
      filename: file.name || "upload",
      contentType,
      parentSourceId,
    });

    let jobId: string | null = null;
    let jobError: string | null = null;
    try {
      const result = await enqueueResearchJob(c.env, { kind: "VISUAL_TRANSFORM", input: { visualAssetId: created.asset.id } }, requestedBy(c));
      jobId = result.job.id;
    } catch (error) {
      jobError = error instanceof Error ? error.message.slice(0, 300) : "job_enqueue_failed";
      await c.env.DB.prepare("UPDATE visual_assets SET processing_status = 'TRANSFORM_PENDING', last_error = ?, updated_at = ? WHERE id = ?")
        .bind("job_enqueue_failed", new Date().toISOString(), created.asset.id).run();
    }

    return c.json({
      ok: true,
      asset: toVisualAssetSummary(created.asset),
      originalVersionId: created.originalVersion.id,
      jobId,
      retryable: Boolean(jobError),
      error: jobError,
    }, 202);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", scope: "visual-assets:upload", message: error instanceof Error ? error.message : String(error) }));
    return c.json({ error: "visual_asset_create_failed" }, 500);
  }
});

visualAssets.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  const variant = c.req.query("variant") === "ORIGINAL" ? "ORIGINAL" : "CAPSULE";
  const version = await getVisualVersion(c.env.DB, id, variant);
  if (!version?.r2Key) return c.json({ error: "visual_content_not_found" }, 404);
  const object = await c.env.ORIGINALS.get(version.r2Key);
  if (!object) return c.json({ error: "visual_content_not_found" }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", variant === "CAPSULE" ? "public, max-age=31536000, immutable" : "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
});

visualAssets.patch("/:id/analysis", async (c) => {
  const visualAssetId = c.req.param("id");
  const asset = await getVisualAsset(c.env.DB, visualAssetId);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ action?: unknown; payload?: unknown }>().catch(() => ({} as { action?: unknown; payload?: unknown }));
  const action = body.action === "accept" || body.action === "dismiss" || body.action === "edit" ? body.action : null;
  if (!action) return c.json({ error: "analysis_action_invalid" }, 400);
  const latest = await c.env.DB.prepare(
    `SELECT id, payload_json AS payloadJson FROM visual_analyses
     WHERE visual_asset_id = ? AND analysis_type = 'AUTO_SUGGESTION'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(visualAssetId).first<{ id: string; payloadJson: string }>();
  if (!latest) return c.json({ error: "analysis_not_found" }, 404);

  let nextPayload: string | null = null;
  if (action === "edit") {
    const payload = validateVisualAnalysis(body.payload);
    if (!payload) return c.json({ error: "analysis_payload_invalid" }, 400);
    nextPayload = JSON.stringify(payload);
  }
  const reviewStatus = action === "accept" ? "ACCEPTED" : action === "dismiss" ? "DISMISSED" : "EDITED";
  const timestamp = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE visual_analyses SET payload_json = COALESCE(?, payload_json), review_status = ?, reviewed_at = ? WHERE id = ? AND visual_asset_id = ?`
    ).bind(nextPayload, reviewStatus, timestamp, latest.id, visualAssetId),
    c.env.DB.prepare(
      `UPDATE visual_assets SET selection_status = ?, selection_reason = ?, updated_at = ? WHERE id = ?`
    ).bind(action === "dismiss" ? "REVIEW" : "SELECTED", action === "accept" ? "사용자 검토 완료" : action === "dismiss" ? "사용자가 제안을 보류함" : "사용자가 제안을 수정함", timestamp, visualAssetId),
  ]);
  const updated = await getVisualAsset(c.env.DB, visualAssetId);
  const capsule = await getVisualVersion(c.env.DB, visualAssetId, "CAPSULE");
  const analysis = await getLatestVisualAnalysis(c.env.DB, visualAssetId);
  return c.json({ asset: updated ? toVisualAssetSummary(updated, capsule?.id ?? null, analysis) : null });
});

visualAssets.get("/:id", async (c) => {
  const asset = await getVisualAsset(c.env.DB, c.req.param("id"));
  if (!asset) return c.json({ error: "not_found" }, 404);
  const capsule = await getVisualVersion(c.env.DB, asset.id, "CAPSULE");
  const analysis = await getLatestVisualAnalysis(c.env.DB, asset.id);
  return c.json({ asset: toVisualAssetSummary(asset, capsule?.id ?? null, analysis) });
});

export default visualAssets;
