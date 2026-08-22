import { Hono } from "hono";
import { SOURCE_KINDS, type InboxDetail, type InboxItem, type ProcessingStatus, type SourceKind } from "@radar/shared";
import { normalizeIngestText, type InputFormat, type NormalizationReport, type QualityStatus, type VersionOrigin, type VersionReviewStatus } from "@radar/shared/ingestion";
import { analyzeSource } from "../analysis/analyze";
import { fetchAndExtract } from "../ingestion/extractUrl";
import { sha256Hex, uuid } from "../ingestion/ids";
import { normalizeDoi, normalizeUrl, titleNorm } from "../ingestion/normalize";
import { createSource } from "../ingestion/store";
import { activateVersion, decideIncomingVersion, getActiveVersion, rejectVersion } from "../ingestion/versioning";

const inbox = new Hono<{ Bindings: Env }>();

const KIND_SET = new Set<string>(SOURCE_KINDS);

inbox.get("/", async (c) => {
  const clauses = ["1 = 1"];
  const binds: unknown[] = [];
  const filter = (name: string, column: string) => {
    const value = c.req.query(name)?.trim();
    if (value) {
      clauses.push(`s.${column} = ?`);
      binds.push(value);
    }
  };
  filter("channel", "ingest_channel");
  filter("format", "input_format");
  filter("quality", "quality_status");
  const versionState = c.req.query("versionState")?.trim();
  if (versionState === "PENDING_REVIEW") clauses.push("EXISTS (SELECT 1 FROM source_versions pv WHERE pv.source_id = s.id AND pv.review_status = 'PENDING_REVIEW')");
  if (versionState === "ACTIVE") clauses.push("NOT EXISTS (SELECT 1 FROM source_versions pv WHERE pv.source_id = s.id AND pv.review_status = 'PENDING_REVIEW')");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 100);
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT s.id AS sourceId, s.title, s.kind, s.reliability, s.origin, s.ingest_channel AS ingestChannel,
            s.input_format AS inputFormat, s.quality_status AS qualityStatus, s.active_version_id AS activeVersionId,
            s.created_at AS createdAt, COALESCE(j.status, s.status) AS status, j.error, j.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM source_versions v2 WHERE v2.source_id = s.id) AS versionCount,
            (SELECT COUNT(*) FROM source_versions v3 WHERE v3.source_id = s.id AND v3.review_status = 'PENDING_REVIEW') AS pendingVersionCount,
            (SELECT COALESCE(v4.normalized_text, v4.extracted_text) FROM source_versions v4 WHERE v4.id = s.active_version_id) AS activeText,
            (SELECT char_count FROM source_versions v5 WHERE v5.id = s.active_version_id) AS charCount,
            CASE WHEN EXISTS (SELECT 1 FROM source_analysis aa WHERE aa.source_id = s.id AND aa.version_id = s.active_version_id) THEN 1 ELSE 0 END AS analysisFresh
     FROM sources s LEFT JOIN processing_jobs j ON j.source_id = s.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.created_at DESC LIMIT ?`
  ).bind(...binds).all<Omit<InboxItem, "analysisFresh"> & { activeText: string | null; analysisFresh: number }>();
  const items = (rows.results ?? []).map((row) => ({ ...row, analysisFresh: Boolean(row.analysisFresh) }));
  return c.json({ items });
});

inbox.get("/:sourceId/original", async (c) => {
  const source = await c.env.DB.prepare("SELECT r2_key, input_format, title FROM sources WHERE id = ?")
    .bind(c.req.param("sourceId"))
    .first<{ r2_key: string | null; input_format: InputFormat | null; title: string }>();
  if (!source) return c.json({ error: "not_found" }, 404);
  if (!source.r2_key) return c.json({ error: "original_not_available" }, 404);
  const object = await c.env.ORIGINALS.get(source.r2_key);
  if (!object) return c.json({ error: "original_not_available" }, 404);
  const contentType = source.input_format?.startsWith("PDF") ? "application/pdf" : "text/plain; charset=utf-8";
  return new Response(object.body, { headers: { "Content-Type": contentType, "Content-Disposition": `inline; filename="${safeDownloadName(source.title)}"` } });
});

inbox.get("/:sourceId", async (c) => {
  const sourceId = c.req.param("sourceId");
  const source = await c.env.DB.prepare(
    `SELECT s.id AS sourceId, s.title, s.kind, s.reliability, s.origin, s.ingest_channel AS ingestChannel,
            s.input_format AS inputFormat, s.quality_status AS qualityStatus, s.active_version_id AS activeVersionId,
            s.status, s.created_at AS createdAt, s.updated_at AS updatedAt, s.r2_key AS r2Key,
            COALESCE(j.status, s.status) AS jobStatus, j.error
     FROM sources s LEFT JOIN processing_jobs j ON j.source_id = s.id WHERE s.id = ?`
  ).bind(sourceId).first<Record<string, unknown>>();
  if (!source) return c.json({ error: "not_found" }, 404);
  const versions = await c.env.DB.prepare(
    `SELECT v.id, v.version, v.version_origin AS origin, v.review_status AS reviewStatus,
            v.normalization_status AS normalizationStatus, v.normalization_report_json AS reportJson,
            v.char_count AS charCount, v.created_at AS createdAt, v.reviewed_at AS reviewedAt,
            v.parent_version_id AS parentVersionId, CASE WHEN v.id = ? THEN 1 ELSE 0 END AS isActive
     FROM source_versions v WHERE v.source_id = ? ORDER BY v.version DESC`
  ).bind(source.activeVersionId ?? null, sourceId).all<Record<string, unknown>>();
  const active = source.activeVersionId
    ? await c.env.DB.prepare(
        `SELECT v.id, v.version, v.version_origin AS origin, v.review_status AS reviewStatus,
                v.normalization_status AS normalizationStatus, v.normalization_report_json AS reportJson,
                v.char_count AS charCount, v.created_at AS createdAt, v.reviewed_at AS reviewedAt,
                v.extracted_text AS extractedText, v.normalized_text AS normalizedText
         FROM source_versions v WHERE v.id = ? AND v.source_id = ?`
      ).bind(source.activeVersionId, sourceId).first<Record<string, unknown>>()
    : null;
  const item: InboxItem = {
    sourceId: String(source.sourceId),
    title: String(source.title),
    kind: source.kind as SourceKind,
    reliability: source.reliability as InboxItem["reliability"],
    origin: source.origin as string | null,
    ingestChannel: source.ingestChannel as InboxItem["ingestChannel"],
    inputFormat: source.inputFormat as InboxItem["inputFormat"],
    qualityStatus: source.qualityStatus as InboxItem["qualityStatus"],
    activeVersionId: source.activeVersionId as string | null,
    versionCount: versions.results?.length ?? 0,
    pendingVersionCount: (versions.results ?? []).filter((v) => v.reviewStatus === "PENDING_REVIEW").length,
    analysisFresh: Boolean(
      await c.env.DB.prepare("SELECT 1 FROM source_analysis WHERE source_id = ? AND version_id = ? LIMIT 1")
        .bind(sourceId, source.activeVersionId ?? "")
        .first()
    ),
    charCount: Number(active?.charCount ?? 0),
    status: (source.jobStatus ?? source.status) as ProcessingStatus,
    error: (source.error as string | null) ?? null,
    createdAt: String(source.createdAt),
    updatedAt: source.updatedAt as string | null,
  };
  const detail: InboxDetail = {
    item,
    original: { available: Boolean(source.r2Key), r2Key: source.r2Key as string | null, url: `/api/inbox/${sourceId}/original` },
    activeVersion: active ? { ...toVersionSummary(active, true), extractedText: active.extractedText as string | null, normalizedText: active.normalizedText as string | null, report: parseReport(active.reportJson as string | null) } : null,
    versions: (versions.results ?? []).map((version) => ({ ...toVersionSummary(version, Boolean(version.isActive)), parentVersionId: version.parentVersionId as string | null })),
  };
  return c.json(detail);
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
    if (!result.duplicateOf && result.qualityStatus === "READY") await analyzeSource(c.env, result.sourceId);
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
    if (!result.duplicateOf && result.qualityStatus === "READY") await analyzeSource(c.env, result.sourceId);
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
    if (!result.duplicateOf && result.qualityStatus === "READY") await analyzeSource(c.env, result.sourceId);
    return c.json({ ...result, scannedPdf: isScannedPdf || undefined });
  } catch (err) {
    console.error(JSON.stringify({ level: "error", scope: "inbox:file", message: (err as Error).message }));
    return c.json({ error: "create_failed" }, 500);
  }
});

inbox.post("/:sourceId/versions", async (c) => {
  const sourceId = c.req.param("sourceId");
  const body = await c.req.json<{ text?: string; title?: string }>().catch(() => null);
  const text = body?.text?.trim();
  if (!text) return c.json({ error: "text_required" }, 400);
  if (text.length > 1_000_000) return c.json({ error: "text_too_large" }, 400);
  const source = await loadSourceForVersion(c.env.DB, sourceId);
  if (!source) return c.json({ error: "not_found" }, 404);
  const active = await getActiveVersion(c.env.DB, sourceId);
  const result = await insertVersion(c.env, {
    sourceId,
    sourceTitle: body?.title?.trim() || source.title,
    original: text,
    extractedText: text,
    filename: `${source.title.replace(/[^a-zA-Z0-9가-힣._-]+/g, "_")}-manual.txt`,
    inputFormat: source.input_format as InputFormat,
    origin: "MANUAL_EDIT",
    versionOrigin: "MANUAL_EDIT",
    parentVersionId: active?.id ?? null,
    activeOrigin: active?.version_origin ?? null,
  });
  if (result.activateIncoming) {
    await activateVersion(c.env.DB, sourceId, result.versionId, result.qualityStatus);
    if (result.qualityStatus === "READY") await analyzeSource(c.env, sourceId);
  }
  return c.json({ ok: true, sourceId, versionId: result.versionId, version: result.version, status: result.reviewStatus, qualityStatus: result.qualityStatus });
});

inbox.post("/:sourceId/reextract", async (c) => {
  const sourceId = c.req.param("sourceId");
  const body = await c.req.json<{ text?: string; pageCount?: number }>().catch(() => null);
  const source = await loadSourceForVersion(c.env.DB, sourceId);
  if (!source) return c.json({ error: "not_found" }, 404);
  let original: string | ArrayBuffer;
  let extractedText = body?.text?.trim() ?? "";
  if (source.input_format === "URL_HTML") {
    if (!source.canonical_url) return c.json({ error: "url_not_available" }, 400);
    const page = await fetchAndExtract(source.canonical_url).catch((error: Error) => null);
    if (!page) return c.json({ error: "reextract_failed" }, 502);
    original = page.html;
    extractedText = page.text;
  } else {
    if (!extractedText) return c.json({ error: "extracted_text_required" }, 400);
    const object = source.r2_key ? await c.env.ORIGINALS.get(source.r2_key) : null;
    original = object ? await object.arrayBuffer() : extractedText;
  }
  const active = await getActiveVersion(c.env.DB, sourceId);
  const result = await insertVersion(c.env, {
    sourceId,
    sourceTitle: source.title,
    original,
    extractedText,
    inputFormat: source.input_format as InputFormat,
    origin: "REEXTRACT",
    versionOrigin: "REEXTRACT",
    parentVersionId: active?.id ?? null,
    activeOrigin: active?.version_origin ?? null,
    metadata: body?.pageCount ? { pageCount: body.pageCount } : undefined,
  });
  if (result.activateIncoming) {
    await activateVersion(c.env.DB, sourceId, result.versionId, result.qualityStatus);
    if (result.qualityStatus === "READY") await analyzeSource(c.env, sourceId);
  }
  return c.json({ ok: true, sourceId, versionId: result.versionId, version: result.version, status: result.reviewStatus, qualityStatus: result.qualityStatus });
});

inbox.post("/:sourceId/renormalize", async (c) => {
  const sourceId = c.req.param("sourceId");
  const source = await loadSourceForVersion(c.env.DB, sourceId);
  if (!source) return c.json({ error: "not_found" }, 404);
  const active = await getActiveVersion(c.env.DB, sourceId);
  if (!active) return c.json({ error: "active_version_not_found" }, 409);
  const extractedText = active.extracted_text ?? "";
  const originalObject = source.r2_key ? await c.env.ORIGINALS.get(source.r2_key) : null;
  const result = await insertVersion(c.env, {
    sourceId,
    sourceTitle: source.title,
    original: originalObject ? await originalObject.arrayBuffer() : extractedText,
    extractedText,
    inputFormat: source.input_format as InputFormat,
    origin: "RENORMALIZE",
    versionOrigin: "RENORMALIZE",
    parentVersionId: active.id,
    activeOrigin: active.version_origin,
    forceActivate: true,
  });
  await activateVersion(c.env.DB, sourceId, result.versionId, result.qualityStatus);
  if (result.qualityStatus === "READY") await analyzeSource(c.env, sourceId);
  return c.json({ ok: true, sourceId, versionId: result.versionId, version: result.version, qualityStatus: result.qualityStatus });
});

inbox.post("/:sourceId/versions/:versionId/activate", async (c) => {
  const sourceId = c.req.param("sourceId");
  const versionId = c.req.param("versionId");
  const row = await c.env.DB.prepare(
    "SELECT normalized_text, extracted_text, normalization_report_json FROM source_versions WHERE id = ? AND source_id = ?"
  ).bind(versionId, sourceId).first<{ normalized_text: string | null; extracted_text: string | null; normalization_report_json: string | null }>();
  if (!row) return c.json({ error: "version_not_found" }, 404);
  const source = await c.env.DB.prepare("SELECT input_format FROM sources WHERE id = ?").bind(sourceId).first<{ input_format: InputFormat }>();
  const qualityStatus = qualityFromReport(row.normalization_report_json, row.normalized_text ?? row.extracted_text, source?.input_format);
  await activateVersion(c.env.DB, sourceId, versionId, qualityStatus);
  if (qualityStatus === "READY") await analyzeSource(c.env, sourceId);
  return c.json({ ok: true, sourceId, versionId, qualityStatus });
});

inbox.post("/:sourceId/versions/:versionId/reject", async (c) => {
  const sourceId = c.req.param("sourceId");
  const versionId = c.req.param("versionId");
  await rejectVersion(c.env.DB, sourceId, versionId);
  return c.json({ ok: true, sourceId, versionId, status: "REJECTED" });
});

inbox.post("/:sourceId/analyze", async (c) => {
  const sourceId = c.req.param("sourceId");
  const result = await analyzeSource(c.env, sourceId);
  return c.json(result, result.status === "failed" && result.error === "not_found" ? 404 : 200);
});

inbox.post("/backfill", async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => null);
  const limit = Math.min(Math.max(Number(body?.limit ?? 20) || 20, 1), 20);
  const sources = await c.env.DB.prepare(
    `SELECT s.id, s.input_format AS inputFormat, s.active_version_id AS activeVersionId
     FROM sources s JOIN source_versions v ON v.source_id = s.id
     WHERE v.normalized_text IS NULL ORDER BY s.updated_at ASC LIMIT ?`
  ).bind(limit).all<{ id: string; inputFormat: InputFormat; activeVersionId: string | null }>();
  let processed = 0;
  for (const source of sources.results ?? []) {
    const versions = await c.env.DB.prepare("SELECT id, extracted_text FROM source_versions WHERE source_id = ? AND normalized_text IS NULL ORDER BY version")
      .bind(source.id).all<{ id: string; extracted_text: string | null }>();
    for (const version of versions.results ?? []) {
      const normalized = normalizeIngestText(version.extracted_text ?? "", source.inputFormat);
      await c.env.DB.prepare(
        "UPDATE source_versions SET normalized_text = ?, normalization_status = 'READY', normalization_report_json = ? WHERE id = ?"
      ).bind(normalized.normalizedText, JSON.stringify(normalized.report), version.id).run();
    }
    const active = source.activeVersionId
      ? await c.env.DB.prepare("SELECT normalized_text, extracted_text, normalization_report_json FROM source_versions WHERE id = ?").bind(source.activeVersionId).first<{ normalized_text: string | null; extracted_text: string | null; normalization_report_json: string | null }>()
      : null;
    const qualityStatus = active ? qualityFromReport(active.normalization_report_json, active.normalized_text ?? active.extracted_text, source.inputFormat) : "EMPTY";
    await c.env.DB.prepare("UPDATE sources SET quality_status = ?, updated_at = ? WHERE id = ?")
      .bind(qualityStatus, new Date().toISOString(), source.id).run();
    processed++;
  }
  return c.json({ ok: true, processed, limit });
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
    const source = await loadSourceForVersion(c.env.DB, sourceId);
    if (!source) return c.json({ error: "not_found" }, 404);
    const active = await getActiveVersion(c.env.DB, sourceId);
    const result = await insertVersion(c.env, {
      sourceId,
      sourceTitle: source.title,
      original: page.html,
      extractedText: page.text,
      inputFormat: "URL_HTML",
      origin: "REEXTRACT",
      versionOrigin: "REEXTRACT",
      parentVersionId: active?.id ?? null,
      activeOrigin: active?.version_origin ?? null,
    });
    if (result.activateIncoming) {
      await activateVersion(c.env.DB, sourceId, result.versionId, result.qualityStatus);
      if (result.qualityStatus === "READY") await analyzeSource(c.env, sourceId);
    }
    await c.env.DB.prepare("UPDATE processing_jobs SET retry_count = retry_count + 1 WHERE source_id = ?").bind(sourceId).run();
    return c.json({ ok: true, versionId: result.versionId, version: result.version, status: result.reviewStatus });
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

interface SourceForVersion {
  id: string;
  title: string;
  input_format: InputFormat;
  canonical_url: string | null;
  r2_key: string | null;
}

interface InsertVersionInput {
  sourceId: string;
  sourceTitle: string;
  original: string | ArrayBuffer;
  extractedText: string;
  filename?: string;
  inputFormat: InputFormat;
  origin: string;
  versionOrigin: VersionOrigin;
  parentVersionId: string | null;
  activeOrigin: string | null;
  metadata?: Record<string, unknown>;
  forceActivate?: boolean;
}

interface InsertVersionResult {
  versionId: string;
  version: number;
  reviewStatus: VersionReviewStatus;
  activateIncoming: boolean;
  qualityStatus: QualityStatus;
}

async function loadSourceForVersion(db: D1Database, sourceId: string): Promise<SourceForVersion | null> {
  return db.prepare("SELECT id, title, input_format, canonical_url, r2_key FROM sources WHERE id = ?")
    .bind(sourceId).first<SourceForVersion>();
}

async function insertVersion(env: Env, input: InsertVersionInput): Promise<InsertVersionResult> {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM source_versions WHERE source_id = ?")
    .bind(input.sourceId).first<{ version: number }>();
  const version = (row?.version ?? 0) + 1;
  const versionId = uuid();
  const r2Key = `originals/${input.sourceId}/v${version}${input.filename ? `-${input.filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120)}` : ""}`;
  const extractedText = input.extractedText.slice(0, 500_000);
  const normalized = normalizeIngestText(extractedText, input.inputFormat);
  const contentHash = await sha256Hex(extractedText || input.original);
  const decision = input.forceActivate
    ? { activateIncoming: true, reviewStatus: "ACTIVE" as VersionReviewStatus }
    : decideIncomingVersion({ activeOrigin: input.activeOrigin, incomingOrigin: input.versionOrigin });
  const ts = new Date().toISOString();

  await env.ORIGINALS.put(r2Key, input.original, {
    customMetadata: { sourceId: input.sourceId, version: String(version), origin: input.origin },
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO source_versions
       (id, source_id, version, r2_key, extracted_text, char_count, content_hash, normalized_text,
        normalization_status, normalization_report_json, version_origin, parent_version_id, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?)`
    ).bind(
      versionId, input.sourceId, version, r2Key, extractedText, extractedText.length, contentHash,
      normalized.normalizedText, JSON.stringify({ ...normalized.report, metadata: { ...normalized.metadata, ...(input.metadata ?? {}) } }),
      input.versionOrigin, input.parentVersionId, decision.reviewStatus, ts
    ),
    env.DB.prepare("UPDATE sources SET updated_at = ? WHERE id = ?").bind(ts, input.sourceId),
  ]);
  return { versionId, version, reviewStatus: decision.reviewStatus, activateIncoming: decision.activateIncoming, qualityStatus: normalized.qualityStatus };
}

function toVersionSummary(value: Record<string, unknown>, isActive: boolean) {
  return {
    id: String(value.id),
    version: Number(value.version ?? 0),
    origin: String(value.origin ?? "INITIAL_INGEST") as VersionOrigin,
    reviewStatus: String(value.reviewStatus ?? "PENDING_REVIEW") as VersionReviewStatus,
    normalizationStatus: String(value.normalizationStatus ?? "PENDING"),
    qualityStatus: qualityFromReport(value.reportJson as string | null, String(value.normalizedText ?? value.extractedText ?? "")),
    charCount: Number(value.charCount ?? 0),
    createdAt: String(value.createdAt ?? ""),
    reviewedAt: (value.reviewedAt as string | null) ?? null,
    isActive,
  };
}

function parseReport(raw: string | null): NormalizationReport | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NormalizationReport;
  } catch {
    return null;
  }
}

function qualityFromReport(raw: string | null, text: string | null, format?: InputFormat): QualityStatus {
  let report: { meaningfulChars?: number; warnings?: string[] } = {};
  try { report = raw ? JSON.parse(raw) as { meaningfulChars?: number; warnings?: string[] } : {}; } catch { report = {}; }
  const meaningful = Number(report.meaningfulChars ?? text?.replace(/\[[^\]]*\]/g, "").match(/[\p{L}\p{N}]/gu)?.length ?? 0);
  if (!meaningful) return "EMPTY";
  if (format === "PDF_SCAN") return "REVIEW";
  const minimum = format === "PLAIN_TEXT" || format === "MARKDOWN" || format === "OBSIDIAN_MARKDOWN" ? 40 : 200;
  return meaningful < minimum || (report.warnings?.length ?? 0) > 0 ? "REVIEW" : "READY";
}

function safeDownloadName(title: string): string {
  return `${title.replace(/[^a-zA-Z0-9가-힣._-]+/g, "_").slice(0, 100) || "original"}.txt`;
}

function b64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export default inbox;
