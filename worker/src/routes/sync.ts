import { Hono } from "hono";
import { analyzeSource } from "../analysis/analyze";
import { sha256Hex, uuid } from "../ingestion/ids";
import { createSource } from "../ingestion/store";

const sync = new Hono<{ Bindings: Env }>();

sync.post("/obsidian", async (c) => {
  const body = await c.req
    .json<{ path?: string; filename?: string; text?: string; mtime?: number }>()
    .catch(() => null);

  const vaultPath = body?.path?.trim();
  const text = body?.text;
  if (!vaultPath || typeof text !== "string" || !text.trim()) {
    return c.json({ error: "path_and_text_required" }, 400);
  }
  if (text.length > 1_000_000) return c.json({ error: "text_too_large" }, 400);

  const filename = body?.filename?.trim() || vaultPath.split("/").pop() || "note.md";
  const title = filename.replace(/\.[^.]+$/, "");
  const origin = `obsidian:${vaultPath}`;
  const hash = await sha256Hex(text);
  const ts = new Date().toISOString();

  const existing = await c.env.DB
    .prepare("SELECT id, file_hash FROM sources WHERE origin = ? OR origins_json LIKE ? LIMIT 1")
    .bind(origin, `%"${origin}"%`)
    .first<{ id: string; file_hash: string | null }>();

  if (!existing) {
    const r = await createSource(c.env, {
      kind: "NOTE",
      title,
      origin,
      original: text,
      extractedText: text,
      filename,
      metadata: { vaultPath, mtime: body?.mtime ?? null },
    });
    c.executionCtx.waitUntil(analyzeSource(c.env, r.sourceId).catch(() => undefined));
    return c.json({ sourceId: r.sourceId, status: "created" });
  }

  if (existing.file_hash === hash) {
    return c.json({ sourceId: existing.id, status: "unchanged" });
  }

  const vRow = await c.env.DB
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM source_versions WHERE source_id = ?")
    .bind(existing.id)
    .first<{ v: number }>();
  const nextV = (vRow?.v ?? 0) + 1;
  const r2Key = `originals/${existing.id}/v${nextV}-${filename.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  await c.env.ORIGINALS.put(r2Key, text, { customMetadata: { sourceId: existing.id, origin } });

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO source_versions (id, source_id, version, r2_key, extracted_text, char_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(uuid(), existing.id, nextV, r2Key, text.slice(0, 500_000), text.length, ts),
    c.env.DB
      .prepare("UPDATE sources SET file_hash = ?, r2_key = ?, status = 'extracted', updated_at = ? WHERE id = ?")
      .bind(hash, r2Key, ts, existing.id),
    c.env.DB
      .prepare("UPDATE processing_jobs SET status = 'extracted', error = NULL, updated_at = ? WHERE source_id = ?")
      .bind(ts, existing.id),
  ]);

  c.executionCtx.waitUntil(analyzeSource(c.env, existing.id).catch(() => undefined));
  return c.json({ sourceId: existing.id, status: "updated", version: nextV });
});

sync.get("/obsidian/status", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.origin, s.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM source_versions v WHERE v.source_id = s.id) AS versions
     FROM sources s WHERE s.origin LIKE 'obsidian:%' ORDER BY s.updated_at DESC LIMIT 200`
  ).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

export default sync;
