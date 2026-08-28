import { Hono } from "hono";
import { normalizeIngestText } from "@radar/shared/ingestion";
import { analyzeSource } from "../analysis/analyze";
import { sha256Hex, uuid } from "../ingestion/ids";
import { createSource } from "../ingestion/store";
import { activateVersion, decideIncomingVersion, getActiveVersion } from "../ingestion/versioning";
import { readJson } from "../lib/requestBody";

function asciiOnly(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/^[\x20-\x7E]*$/.test(v)) out[k] = v.slice(0, 500);
  }
  return out;
}

const sync = new Hono<{ Bindings: Env }>();

sync.post("/obsidian", async (c) => {
  const body = await readJson<{ path?: string; filename?: string; text?: string; mtime?: number }>(c) as {
    path?: string;
    filename?: string;
    text?: string;
    mtime?: number;
  } | null;
  try {
    return await handleObsidianSync(c.env, c.executionCtx as ExecutionContext<unknown>, body);
  } catch (err) {
    const e = err as Error;
    console.error(JSON.stringify({ level: "error", scope: "sync:obsidian", message: e.message, stack: e.stack?.slice(0, 500) }));
    return c.json({ error: "sync_failed", detail: e.message.slice(0, 200) }, 500);
  }
});

async function handleObsidianSync(
  env: Env,
  ctx: ExecutionContext<unknown>,
  body: { path?: string; filename?: string; text?: string; mtime?: number } | null
): Promise<Response> {
  const vaultPath = body?.path?.trim();
  const text = body?.text;
  if (!vaultPath || typeof text !== "string" || !text.trim()) {
    return Response.json({ error: "path_and_text_required" }, { status: 400 });
  }
  if (text.length > 1_000_000) return Response.json({ error: "text_too_large" }, { status: 400 });

  const filename = body?.filename?.trim() || vaultPath.split("/").pop() || "note.md";
  const title = filename.replace(/\.[^.]+$/, "");
  const origin = `obsidian:${vaultPath}`;
  const hash = await sha256Hex(text);
  const ts = new Date().toISOString();

  const existing = await env.DB
    .prepare(
      `SELECT id, file_hash FROM sources
       WHERE origin = ? OR EXISTS (
         SELECT 1 FROM json_each(COALESCE(NULLIF(origins_json, ''), '[]')) je
         WHERE je.value = ?
       ) LIMIT 1`
    )
    .bind(origin, origin)
    .first<{ id: string; file_hash: string | null }>();

  if (!existing) {
    const r = await createSource(env, {
      kind: "NOTE",
      title,
      origin,
      original: text,
      extractedText: text,
      filename,
      metadata: { vaultPath, mtime: body?.mtime ?? null },
    });
    if (r.qualityStatus === "READY") ctx.waitUntil(analyzeSource(env, r.sourceId).catch(() => undefined));
    return Response.json({ sourceId: r.sourceId, status: "created" });
  }

  if (existing.file_hash === hash) {
    return Response.json({ sourceId: existing.id, status: "unchanged" });
  }

  const active = await getActiveVersion(env.DB, existing.id);
  const vRow = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM source_versions WHERE source_id = ?")
    .bind(existing.id).first<{ v: number }>();
  const nextV = (vRow?.v ?? 0) + 1;
  const versionId = uuid();
  const r2Key = `originals/${existing.id}/v${nextV}-${filename.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  const normalized = normalizeIngestText(text, "OBSIDIAN_MARKDOWN");
  const decision = decideIncomingVersion({ activeOrigin: active?.version_origin ?? null, incomingOrigin: "OBSIDIAN_SYNC" });
  await env.ORIGINALS.put(r2Key, text, {
    customMetadata: asciiOnly({ sourceId: existing.id, origin }),
  });

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO source_versions
         (id, source_id, version, r2_key, extracted_text, char_count, content_hash, normalized_text,
          normalization_status, normalization_report_json, version_origin, parent_version_id, review_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, 'OBSIDIAN_SYNC', ?, ?, ?)`
      )
      .bind(versionId, existing.id, nextV, r2Key, text.slice(0, 500_000), text.length, hash, normalized.normalizedText, JSON.stringify({ ...normalized.report, metadata: normalized.metadata }), active?.id ?? null, decision.reviewStatus, ts),
    env.DB
      .prepare("UPDATE sources SET file_hash = ?, r2_key = ?, status = 'extracted', updated_at = ? WHERE id = ?")
      .bind(hash, decision.activateIncoming ? r2Key : active?.r2_key ?? null, ts, existing.id),
    env.DB
      .prepare("UPDATE processing_jobs SET status = 'extracted', error = NULL, updated_at = ? WHERE source_id = ?")
      .bind(ts, existing.id),
  ]);

  if (decision.activateIncoming) {
    await activateVersion(env.DB, existing.id, versionId, normalized.qualityStatus, ts);
    if (normalized.qualityStatus === "READY") ctx.waitUntil(analyzeSource(env, existing.id).catch(() => undefined));
  }
  return Response.json({ sourceId: existing.id, status: decision.activateIncoming ? "updated" : "review_required", version: nextV, qualityStatus: normalized.qualityStatus });
}

sync.get("/obsidian/status", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.origin, s.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM source_versions v WHERE v.source_id = s.id) AS versions
     FROM sources s WHERE s.origin LIKE 'obsidian:%' ORDER BY s.updated_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

export default sync;
