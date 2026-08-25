import { Hono } from "hono";
import { enqueueResearchJob } from "../jobs/enqueue";
import {
  ALLOWED_PERSONAL_VISUAL_TYPES,
  MAX_PERSONAL_VISUAL_BYTES,
} from "../visual/contracts";
import { createPersonalVisual, getVisualAsset, toVisualAssetSummary } from "../visual/store";

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

visualAssets.get("/:id", async (c) => {
  const asset = await getVisualAsset(c.env.DB, c.req.param("id"));
  return asset ? c.json({ asset: toVisualAssetSummary(asset) }) : c.json({ error: "not_found" }, 404);
});

export default visualAssets;
