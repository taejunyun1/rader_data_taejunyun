import { Hono } from "hono";
import { enqueueResearchJob } from "../jobs/enqueue";
import {
  ALLOWED_PERSONAL_VISUAL_TYPES,
  MAX_PERSONAL_VISUAL_BYTES,
} from "../visual/contracts";
import { validateVisualAnalysis } from "../visual/analysisSchema";
import {
  createPersonalVisual,
  createUserVerifiedVisualAnalysis,
  getLatestVisualAnalysisForVersion,
  getLatestVisualAnalysisRowForVersion,
  getOriginalVisualVersion,
  getVisualAnalysisRowForVersion,
  getVisualAsset,
  getVisualAssetDetail,
  getVisualVersion,
  getVisualVersionForAnalysis,
  listVisualAssets,
  toVisualAssetSummary,
  updateAutoSuggestionReviewStatus,
} from "../visual/store";
import { uuid } from "../ingestion/ids";

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

function parseRightsStatus(value: unknown): "PERSONAL" | "PERMITTED" | "PUBLIC_LINK" | "UNKNOWN" | "RESTRICTED" | null {
  return value === "PERSONAL" || value === "PERMITTED" || value === "PUBLIC_LINK" || value === "UNKNOWN" || value === "RESTRICTED"
    ? value
    : null;
}

async function loadAssetSummary(db: D1Database, visualAssetId: string) {
  const asset = await getVisualAsset(db, visualAssetId);
  if (!asset) return null;
  const capsule = await getVisualVersion(db, visualAssetId, "CAPSULE");
  const analysisVersion = await getVisualVersionForAnalysis(db, visualAssetId);
  const analysis = analysisVersion ? await getLatestVisualAnalysisForVersion(db, visualAssetId, analysisVersion.id) : null;
  return toVisualAssetSummary(asset, capsule?.id ?? null, analysis);
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
  const analysisVersion = await getVisualVersionForAnalysis(c.env.DB, visualAssetId);
  if (!analysisVersion) return c.json({ error: "visual_capsule_not_ready" }, 409);
  const currentAutoSuggestion = await getVisualAnalysisRowForVersion(c.env.DB, visualAssetId, "AUTO_SUGGESTION", analysisVersion.id);
  if (!currentAutoSuggestion) return c.json({ error: "analysis_not_found" }, 404);

  if (action === "edit") {
    const payload = validateVisualAnalysis(body.payload);
    if (!payload) return c.json({ error: "analysis_payload_invalid" }, 400);
    const editBase = await getLatestVisualAnalysisRowForVersion(c.env.DB, visualAssetId, analysisVersion.id);
    if (!editBase) return c.json({ error: "analysis_not_found" }, 404);
    const created = await createUserVerifiedVisualAnalysis(c.env.DB, {
      visualAssetId,
      payload,
      reviewStatus: "EDITED",
      baseAnalysisId: editBase.id,
      baseVisualVersionId: editBase.visualVersionId,
    });
    if (!created) return c.json({ error: "analysis_base_stale" }, 409);
  } else if (action === "accept") {
    const created = await createUserVerifiedVisualAnalysis(c.env.DB, {
      visualAssetId,
      payload: currentAutoSuggestion.payload,
      reviewStatus: "ACCEPTED",
      baseAnalysisId: currentAutoSuggestion.id,
      baseVisualVersionId: currentAutoSuggestion.visualVersionId,
    });
    if (!created) return c.json({ error: "analysis_base_stale" }, 409);
  } else {
    await updateAutoSuggestionReviewStatus(c.env.DB, visualAssetId, "DISMISSED", currentAutoSuggestion.visualVersionId);
  }
  return c.json({ asset: await loadAssetSummary(c.env.DB, visualAssetId) });
});

visualAssets.patch("/:id/assignment", async (c) => {
  const visualAssetId = c.req.param("id");
  const asset = await getVisualAsset(c.env.DB, visualAssetId);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ sourceId?: unknown; sourceVersionId?: unknown }>().catch(() => ({} as { sourceId?: unknown; sourceVersionId?: unknown }));
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  if (!sourceId) return c.json({ error: "assignment_source_required" }, 400);
  const expectedVersionId = typeof body.sourceVersionId === "string" ? body.sourceVersionId.trim() : null;

  const source = await c.env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first<{ id: string }>();
  if (!source) return c.json({ error: "assignment_source_not_found" }, 404);

  const result = await c.env.DB.prepare(
    `UPDATE visual_assets
     SET parent_source_id = ?,
         parent_version_id = (
           SELECT v.id
           FROM sources s
           JOIN source_versions v ON v.id = s.active_version_id AND v.source_id = s.id
           WHERE s.id = ? AND (? IS NULL OR v.id = ?)
         ),
         assignment_status = 'ASSIGNED',
         updated_at = ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1
         FROM sources s
         JOIN source_versions v ON v.id = s.active_version_id AND v.source_id = s.id
         WHERE s.id = ? AND (? IS NULL OR v.id = ?)
       )`
  ).bind(
    source.id,
    source.id,
    expectedVersionId,
    expectedVersionId,
    new Date().toISOString(),
    visualAssetId,
    source.id,
    expectedVersionId,
    expectedVersionId,
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    return c.json({ error: expectedVersionId ? "assignment_source_active_version_mismatch" : "assignment_source_active_version_missing" }, 409);
  }

  return c.json({ asset: await loadAssetSummary(c.env.DB, visualAssetId) });
});

visualAssets.patch("/:id/rights", async (c) => {
  const visualAssetId = c.req.param("id");
  const asset = await getVisualAsset(c.env.DB, visualAssetId);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ rightsStatus?: unknown; rightsBasis?: unknown }>().catch(() => ({} as { rightsStatus?: unknown; rightsBasis?: unknown }));
  const rightsStatus = parseRightsStatus(body.rightsStatus);
  if (!rightsStatus) return c.json({ error: "rights_status_invalid" }, 400);
  const rightsBasis = typeof body.rightsBasis === "string" ? body.rightsBasis.trim() : "";
  if (rightsStatus === "PERMITTED" && !rightsBasis) return c.json({ error: "rights_basis_required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE visual_assets
     SET rights_status = ?,
         rights_basis = ?,
         rights_reviewed_at = ?,
         is_personal_work = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    rightsStatus,
    rightsBasis || null,
    now,
    rightsStatus === "PERSONAL" ? 1 : 0,
    now,
    visualAssetId,
  ).run();
  return c.json({ asset: await loadAssetSummary(c.env.DB, visualAssetId) });
});

visualAssets.post("/:id/retry", async (c) => {
  const visualAssetId = c.req.param("id");
  const asset = await getVisualAsset(c.env.DB, visualAssetId);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const requester = requestedBy(c);
  const original = await getOriginalVisualVersion(c.env.DB, visualAssetId);
  if ((asset.processingStatus === "TRANSFORM_PENDING" || asset.processingStatus === "FAILED") && original?.r2Key) {
    const result = await enqueueResearchJob(c.env, { kind: "VISUAL_TRANSFORM", input: { visualAssetId } }, requester);
    return c.json(result, 202);
  }

  const capsule = await getVisualVersion(c.env.DB, visualAssetId, "CAPSULE");
  const latestAnalysis = capsule ? await getLatestVisualAnalysisForVersion(c.env.DB, visualAssetId, capsule.id) : null;
  if (capsule?.id && !latestAnalysis) {
    const result = await enqueueResearchJob(c.env, { kind: "VISUAL_ANALYSIS", input: { visualAssetId, versionId: capsule.id } }, requester);
    return c.json(result, 202);
  }

  if (asset.parentSourceId && asset.parentVersionId && asset.originKind !== "PERSONAL_UPLOAD") {
    const run = await c.env.DB.prepare(
      `SELECT id
       FROM visual_extraction_runs
       WHERE parent_source_id = ? AND parent_version_id = ? AND origin_kind = ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(asset.parentSourceId, asset.parentVersionId, asset.originKind).first<{ id: string }>();
    if (run?.id) {
      const result = await enqueueResearchJob(
        c.env,
        { kind: "VISUAL_EXTRACTION", input: { sourceId: asset.parentSourceId, sourceVersionId: asset.parentVersionId, extractionRunId: run.id } },
        requester,
      );
      return c.json(result, 202);
    }
  }

  return c.json({ error: "visual_retry_not_available" }, 409);
});

visualAssets.post("/:id/storage-transition", async (c) => {
  const visualAssetId = c.req.param("id");
  const asset = await getVisualAsset(c.env.DB, visualAssetId);
  if (!asset) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ target?: unknown; confirmation?: unknown }>().catch(() => ({} as { target?: unknown; confirmation?: unknown }));
  const target = body.target === "CAPSULE" || body.target === "TEXT_ONLY" ? body.target : null;
  const confirmation = body.confirmation === "DELETE_ORIGINAL" || body.confirmation === "DELETE_CAPSULE" ? body.confirmation : null;
  if (!target || !confirmation) return c.json({ error: "storage_transition_invalid" }, 400);
  const operationKind = target === "CAPSULE" ? "DELETE_ORIGINAL" : "DELETE_CAPSULE";
  if (confirmation !== operationKind) return c.json({ error: "storage_transition_confirmation_invalid" }, 400);
  if (asset.pendingStorageState && asset.pendingStorageState !== target) return c.json({ error: "storage_transition_pending" }, 409);

  const capsule = await getVisualVersion(c.env.DB, visualAssetId, "CAPSULE");
  if (!capsule?.r2Key) return c.json({ error: "visual_capsule_not_ready" }, 409);
  const verified = await getVisualAnalysisRowForVersion(c.env.DB, visualAssetId, "USER_VERIFIED", capsule.id);
  if (!verified) return c.json({ error: "visual_user_verification_required" }, 409);
  const sourceVersion = target === "CAPSULE"
    ? await getOriginalVisualVersion(c.env.DB, visualAssetId)
    : capsule;
  if (!sourceVersion?.r2Key) return c.json({ error: target === "CAPSULE" ? "visual_original_not_found" : "visual_capsule_not_ready" }, 409);

  const pending = await c.env.DB.prepare(
    `SELECT id, status
     FROM visual_asset_operations
     WHERE visual_asset_id = ? AND operation_kind = ? AND to_state = ?
       AND status IN ('PENDING', 'FAILED')
     ORDER BY created_at DESC LIMIT 1`
  ).bind(visualAssetId, operationKind, target).first<{ id: string; status: "PENDING" | "FAILED" }>();
  if (asset.pendingStorageState && !pending) return c.json({ error: "storage_transition_recovery_required" }, 409);

  const now = new Date().toISOString();
  const operationId = pending?.id ?? uuid();
  if (!pending) {
    if (target === "CAPSULE" && asset.storageState !== "ARCHIVAL") return c.json({ error: "storage_transition_invalid_state" }, 409);
    if (target === "TEXT_ONLY" && asset.storageState !== "CAPSULE") return c.json({ error: "storage_transition_invalid_state" }, 409);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO visual_asset_operations
         (id, visual_asset_id, operation_kind, from_state, to_state, status, error, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', NULL, ?, NULL)`
      ).bind(operationId, visualAssetId, operationKind, asset.storageState, target, now),
      c.env.DB.prepare(
        `UPDATE visual_assets
         SET pending_storage_state = ?,
             updated_at = ?
         WHERE id = ?`
      ).bind(target, now, visualAssetId),
    ]);
  } else if (pending.status === "FAILED") {
    await c.env.DB.prepare(
      `UPDATE visual_asset_operations
       SET status = 'PENDING', error = NULL, finished_at = NULL
       WHERE id = ? AND status = 'FAILED'`
    ).bind(operationId).run();
  }

  let r2DeleteCompleted = false;
  try {
    await c.env.ORIGINALS.delete(sourceVersion.r2Key);
    r2DeleteCompleted = true;
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE visual_asset_versions SET deleted_at = ? WHERE id = ?").bind(now, sourceVersion.id),
      c.env.DB.prepare(
        `UPDATE visual_assets
         SET storage_state = ?,
             pending_storage_state = NULL,
             updated_at = ?
         WHERE id = ?`
      ).bind(target, now, visualAssetId),
      c.env.DB.prepare(
        `UPDATE visual_asset_operations
         SET status = 'SUCCEEDED', error = NULL, finished_at = ?
         WHERE id = ?`
      ).bind(now, operationId),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : String(error);
    await c.env.DB.prepare(
      `UPDATE visual_asset_operations
       SET status = 'FAILED', error = ?, finished_at = ?
       WHERE id = ? AND status = 'PENDING'`
    ).bind(
      r2DeleteCompleted ? `r2_delete_succeeded_db_finalize_failed:${detail}` : `r2_delete_uncertain:${detail}`,
      now,
      operationId,
    ).run().catch(() => undefined);
    return c.json({ error: r2DeleteCompleted ? "visual_storage_transition_recovery_required" : "visual_storage_delete_failed" }, 500);
  }
  return c.json({ asset: await loadAssetSummary(c.env.DB, visualAssetId) });
});

visualAssets.get("/:id", async (c) => {
  const asset = await getVisualAssetDetail(c.env.DB, c.req.param("id"));
  if (!asset) return c.json({ error: "not_found" }, 404);
  return c.json({ asset });
});

export default visualAssets;
