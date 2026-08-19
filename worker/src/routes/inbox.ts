import { Hono } from "hono";
import { SOURCE_KINDS, type InboxItem, type ProcessingStatus, type SourceKind } from "@radar/shared";
import { analyzeSource } from "../analysis/analyze";
import { fetchAndExtract } from "../ingestion/extractUrl";
import { uuid } from "../ingestion/ids";
import { normalizeDoi, normalizeUrl, titleNorm } from "../ingestion/normalize";
import { createSource } from "../ingestion/store";

const inbox = new Hono<{ Bindings: Env }>();

const KIND_SET = new Set<string>(SOURCE_KINDS);

inbox.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id AS sourceId, s.title, s.kind, s.reliability, s.origin, s.created_at AS createdAt,
            COALESCE(j.status, s.status) AS status, j.error, j.updated_at AS updatedAt
     FROM sources s
     LEFT JOIN processing_jobs j ON j.source_id = s.id
     ORDER BY s.created_at DESC
     LIMIT 100`
  ).all<InboxItem & { error: string | null }>();
  return c.json({ items: rows.results ?? [] });
});

inbox.post("/text", async (c) => {
  const body = await c.req
    .json<{ text?: string; title?: string; authors?: string; year?: number; kind?: string; doi?: string; canonicalUrl?: string }>()
    .catch(() => null);

  const text = body?.text?.trim();
  if (!text) return c.json({ error: "text_required" }, 400);
  if (text.length > 1_000_000) return c.json({ error: "text_too_large" }, 400);

  const kind = (body?.kind && KIND_SET.has(body.kind) ? body.kind : "NOTE") as SourceKind;
  const title = body?.title?.trim() || text.slice(0, 80);

  try {
    const result = await createSource(c.env, {
      kind,
      title,
      authors: body?.authors?.trim() || undefined,
      year: body?.year,
      doi: body?.doi ? normalizeDoi(body.doi) : undefined,
      canonicalUrl: body?.canonicalUrl ? (normalizeUrl(body.canonicalUrl) ?? undefined) : undefined,
      origin: "manual",
      original: text,
      extractedText: text,
    });
    if (!result.duplicateOf) await analyzeSource(c.env, result.sourceId);
    return c.json(result);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", scope: "inbox:text", message: (err as Error).message }));
    return c.json({ error: "create_failed" }, 500);
  }
});

inbox.post("/url", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null);
  const raw = body?.url?.trim();
  if (!raw) return c.json({ error: "url_required" }, 400);

  const normalized = normalizeUrl(raw);
  if (!normalized) return c.json({ error: "invalid_url" }, 400);

  try {
    const page = await fetchAndExtract(normalized);
    const result = await createSource(c.env, {
      kind: "WEB",
      title: page.title || normalized,
      canonicalUrl: normalized,
      origin: "url",
      original: page.html,
      extractedText: page.text,
      metadata: {
        siteName: page.siteName,
        description: page.description,
        finalUrl: normalized,
      },
    });
    if (!result.duplicateOf) await analyzeSource(c.env, result.sourceId);
    return c.json(result);
  } catch (err) {
    const message = (err as Error).message.slice(0, 200);
    const sourceId = await createFailedUrlSource(c.env, normalized, raw, message);
    return c.json({ ok: false, sourceId, title: raw, error: message });
  }
});

inbox.post("/file", async (c) => {
  const body = await c.req
    .json<{ filename?: string; text?: string; originalBase64?: string; contentType?: string }>()
    .catch(() => null);

  const filename = body?.filename?.trim();
  if (!filename) return c.json({ error: "filename_required" }, 400);
  if (body?.originalBase64 && body.originalBase64.length > 40_000_000) {
    return c.json({ error: "file_too_large" }, 400);
  }

  let original: string | ArrayBuffer;
  let text = body?.text;
  if (body?.originalBase64) {
    original = b64ToBuffer(body.originalBase64);
    if (!text) text = new TextDecoder().decode(original);
  } else if (typeof text === "string" && text.length > 0) {
    original = text;
  } else {
    return c.json({ error: "content_required" }, 400);
  }

  const isTextFile = /\.(md|markdown|txt)$/i.test(filename);
  const isPdf = /\.pdf$/i.test(filename);
  if (!isTextFile && !isPdf && !body?.originalBase64) {
    return c.json({ error: "unsupported_file_type" }, 400);
  }
  if (isPdf && !body?.originalBase64) {
    return c.json({ error: "pdf_requires_binary" }, 400);
  }

  const kind: SourceKind = isPdf ? "PAPER_ACADEMIC" : "NOTE";
  const textStr = typeof text === "string" ? text : "";
  const isScannedPdf = isPdf && textStr.replace(/\[page \d+\]|\s/g, "").length < 20;

  try {
    const result = await createSource(c.env, {
      kind,
      title: filename.replace(/\.[^.]+$/, ""),
      origin: isPdf ? "upload:pdf" : isTextFile ? "upload:md" : "upload:file",
      original,
      extractedText: text,
      filename,
      metadata: {
        contentType: body?.contentType,
        pdfPages: textStr ? (textStr.match(/\[page \d+\]/g) ?? []).length : undefined,
        scannedPdf: isScannedPdf || undefined,
      },
    });
    if (!result.duplicateOf) await analyzeSource(c.env, result.sourceId);
    return c.json({ ...result, scannedPdf: isScannedPdf || undefined });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", scope: "inbox:file", message: (err as Error).message }));
    return c.json({ error: "create_failed" }, 500);
  }
});

inbox.post("/retry/:sourceId", async (c) => {
  const sourceId = c.req.param("sourceId");

  if (c.req.query("analyze") === "1") {
    const result = await analyzeSource(c.env, sourceId);
    return c.json(result);
  }

  const src = await c.env.DB
    .prepare("SELECT id, canonical_url FROM sources WHERE id = ?")
    .bind(sourceId)
    .first<{ id: string; canonical_url: string | null }>();
  if (!src) return c.json({ error: "not_found" }, 404);
  if (!src.canonical_url) return c.json({ error: "not_retryable" }, 400);

  await setJobStatus(c.env.DB, sourceId, "received", null);
  try {
    const page = await fetchAndExtract(src.canonical_url);
    const ts = new Date().toISOString();
    const vRow = await c.env.DB
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM source_versions WHERE source_id = ?")
      .bind(sourceId)
      .first<{ v: number }>();
    const nextV = (vRow?.v ?? 0) + 1;
    const r2Key = `originals/${sourceId}/v${nextV}`;
    await c.env.ORIGINALS.put(r2Key, page.html, { customMetadata: { sourceId, retry: "true" } });

    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO source_versions (id, source_id, version, r2_key, extracted_text, char_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(uuid(), sourceId, nextV, r2Key, page.text, page.text.length, ts),
      c.env.DB
        .prepare("UPDATE sources SET status = 'extracted', updated_at = ? WHERE id = ?")
        .bind(ts, sourceId),
      c.env.DB
        .prepare(
          `UPDATE processing_jobs SET status = 'extracted', error = NULL, retry_count = retry_count + 1, updated_at = ?
           WHERE source_id = ?`
        )
        .bind(ts, sourceId),
    ]);
    return c.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await c.env.DB
      .prepare(
        `UPDATE processing_jobs SET status = 'failed', error = ?, retry_count = retry_count + 1, updated_at = ?
         WHERE source_id = ?`
      )
      .bind(message, new Date().toISOString(), sourceId)
      .run();
    return c.json({ ok: false, error: message });
  }
});

async function setJobStatus(db: D1Database, sourceId: string, status: ProcessingStatus | "received", error: string | null) {
  await db
    .prepare("UPDATE processing_jobs SET status = ?, error = ?, updated_at = ? WHERE source_id = ?")
    .bind(status, error, new Date().toISOString(), sourceId)
    .run();
}

async function createFailedUrlSource(env: Env, normalized: string, rawUrl: string, errMsg: string): Promise<string> {
  const dup = await env.DB.prepare("SELECT id FROM sources WHERE canonical_url = ?")
    .bind(normalized)
    .first<{ id: string }>();
  if (dup) {
    await setJobStatus(env.DB, dup.id, "failed", errMsg);
    return dup.id;
  }
  const id = uuid();
  const ts = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO sources (id, kind, title, title_norm, canonical_url, reliability, status, origin, origins_json, created_at, updated_at)
         VALUES (?, 'WEB', ?, ?, ?, 'DISCOVERY', 'failed', 'url', ?, ?, ?)`
      )
      .bind(id, rawUrl, titleNorm(rawUrl), normalized, JSON.stringify(["url"]), ts, ts),
    env.DB
      .prepare(
        `INSERT INTO processing_jobs (id, source_id, stage, status, error, retry_count, created_at, updated_at)
         VALUES (?, ?, 'ingest', 'failed', ?, 0, ?, ?)`
      )
      .bind(uuid(), id, errMsg, ts, ts),
  ]);
  return id;
}

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export default inbox;
