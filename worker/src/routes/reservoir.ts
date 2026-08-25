import { Hono } from "hono";
import { isDeepAnalysisReady } from "../analysis/deepAnalyze";
import type { QualityStatus, TextScope } from "@radar/shared/ingestion";
import { parseDeepProfile, DEEP_PROFILES } from "../analysis/deepProfiles";
import { monthSpendUsd } from "../lib/openai";
import { enqueueResearchJob } from "../jobs/enqueue";
import { listVisualAssets } from "../visual/store";
import { loadReservoirPdfOriginal } from "./visualExtraction";

const reservoir = new Hono<{ Bindings: Env }>();
const MAX_SOURCE_TEXT_CHARS = 500_000;

interface AcquisitionColumns {
  acquisitionTextScope: TextScope | null;
  acquisitionExtractionMethod: string | null;
  acquisitionQualityStatus: QualityStatus | null;
  acquisitionCharCount: number | null;
  acquisitionError: string | null;
  acquisitionHasNormalizedText: number | boolean | null;
}

interface ResearchCycleMeta {
  lastResearchAt: string | null;
  markSince: string;
}

interface ReservoirPdfExtraction {
  runId: string;
  status: string;
  totalPages: number;
  uploadedPages: number;
  remainingPages: number;
  nextPageNumber: number | null;
}

async function researchCycleMeta(db: D1Database): Promise<ResearchCycleMeta> {
  const latest = await db.prepare("SELECT created_at FROM distill_sessions ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  return {
    lastResearchAt: latest?.created_at ?? null,
    markSince: latest?.created_at ?? new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
  };
}

function acquisitionLabel(textScope: TextScope, charCount: number): string {
  if (textScope === "FULLTEXT") return `원문 저장됨 · ${charCount.toLocaleString("ko-KR")}자`;
  if (textScope === "PARTIAL") return `원문 일부 저장됨 · ${charCount.toLocaleString("ko-KR")}자`;
  if (textScope === "METADATA_ONLY") return "메타데이터만 저장됨";
  if (textScope === "EMPTY") return "읽을 텍스트 없음";
  return "원문 상태 확인 필요";
}

function sourceAcquisitionView(sourceId: string, row: AcquisitionColumns) {
  const textScope = row.acquisitionTextScope ?? "UNKNOWN";
  const extractionMethod = row.acquisitionExtractionMethod ?? "LEGACY";
  const qualityStatus = row.acquisitionQualityStatus ?? "UNREVIEWED";
  const charCount = Number(row.acquisitionCharCount ?? 0);
  const hasNormalizedText = Boolean(row.acquisitionHasNormalizedText);
  const readiness = isDeepAnalysisReady({ textScope, qualityStatus, charCount, normalizedText: hasNormalizedText ? "available" : null });

  return {
    textScope,
    extractionMethod,
    qualityStatus,
    charCount,
    acquisitionLabel: acquisitionLabel(textScope, charCount),
    canDeepAnalyze: readiness.ok,
    originalTextUrl: hasNormalizedText ? `/api/reservoir/${sourceId}/original-text` : null,
    ...(row.acquisitionError ? { acquisitionError: row.acquisitionError } : {}),
  };
}

async function activePdfExtraction(db: D1Database, versionId: string | null): Promise<ReservoirPdfExtraction | null> {
  if (!versionId) return null;
  const run = await db.prepare(
    `SELECT id, status, total_units AS totalUnits
     FROM visual_extraction_runs
     WHERE parent_version_id = ? AND origin_kind = 'PDF_PAGE_CROP'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(versionId).first<{ id: string; status: string; totalUnits: number }>();
  if (!run) return null;
  const units = await db.prepare(
    `SELECT unit_number AS unitNumber, status
     FROM visual_extraction_units
     WHERE run_id = ? AND status <> 'DELETED'
     ORDER BY unit_number ASC`
  ).bind(run.id).all<{ unitNumber: number; status: string }>();
  const uploadedPages = (units.results ?? []).map((unit) => unit.unitNumber);
  const totalPages = Number(run.totalUnits ?? 0);
  const remainingPages = totalPages > 0
    ? Array.from({ length: totalPages }, (_, index) => index + 1).filter((pageNumber) => !uploadedPages.includes(pageNumber)).length
    : 0;
  const nextPageNumber = totalPages > 0
    ? Array.from({ length: totalPages }, (_, index) => index + 1).find((pageNumber) => !uploadedPages.includes(pageNumber)) ?? null
    : null;
  return {
    runId: run.id,
    status: run.status,
    totalPages,
    uploadedPages: uploadedPages.length,
    remainingPages,
    nextPageNumber,
  };
}

reservoir.get("/", async (c) => {
  const kind = c.req.query("kind");
  const status = c.req.query("status");
  const topic = c.req.query("topic");
  const decision = c.req.query("decision") ?? "active";
  const cycle = await researchCycleMeta(c.env.DB);
  const params: (string | number)[] = [cycle.markSince];
  const latestDecision = "(SELECT us.action FROM user_signals us WHERE us.source_id = s.id AND us.action IN ('keep','develop','watch','ignore') ORDER BY us.created_at DESC LIMIT 1)";
  let where = "1=1";
  if (kind) {
    params.push(kind);
    where += " AND s.kind = ?";
  }
  if (status) {
    params.push(status);
    where += " AND s.status = ?";
  }
  if (topic) {
    params.push(`%"${topic}"%`);
    where += " AND s.topics LIKE ?";
  }
  if (decision === "ignored") where += ` AND ${latestDecision} = 'ignore'`;
  else if (decision === "watching") where += ` AND ${latestDecision} = 'watch'`;
  else if (decision === "marked") {
    params.push(cycle.markSince);
    where += " AND (SELECT us.action FROM user_signals us WHERE us.source_id = s.id AND us.action IN ('keep','develop','watch','ignore') AND us.created_at > ? ORDER BY us.created_at DESC LIMIT 1) IN ('keep','develop')";
  } else if (decision !== "all") where += ` AND (${latestDecision} IS NULL OR ${latestDecision} <> 'ignore')`;
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.kind, s.reliability, s.status, s.origin, s.year, s.topics AS topics,
            s.canonical_url AS canonicalUrl, s.created_at AS createdAt,
            CASE WHEN (SELECT us.action FROM user_signals us
                       WHERE us.source_id = s.id AND us.action IN ('keep','develop','watch','ignore') AND us.created_at > ?
                       ORDER BY us.created_at DESC LIMIT 1) IN ('keep','develop') THEN 1 ELSE 0 END AS markedForNextResearch,
            ${latestDecision} AS decisionStatus,
            (SELECT COUNT(*) FROM keywords k WHERE k.source_id = s.id) AS keywordCount,
            (SELECT COUNT(*) FROM user_signals us WHERE us.source_id = s.id AND us.action IN ('keep','develop','watch','ignore')) AS signalCount
     FROM sources s WHERE ${where}
     ORDER BY s.created_at DESC LIMIT ?`
  )
    .bind(...params, limit)
    .all<Record<string, unknown>>();

  const items = rows.results ?? [];
  const markedCountRow = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM sources s
       WHERE (SELECT us.action FROM user_signals us
              WHERE us.source_id = s.id AND us.action IN ('keep','develop','watch','ignore') AND us.created_at > ?
              ORDER BY us.created_at DESC LIMIT 1) IN ('keep','develop')`
    )
    .bind(cycle.markSince)
    .first<{ n: number }>();
  return c.json({
    items,
    nextResearch: {
      markedCount: markedCountRow?.n ?? 0,
      lastResearchAt: cycle.lastResearchAt,
      resetsOn: "next_distill",
    },
  });
});

reservoir.get("/topics", async (c) => {
  const rows = await c.env.DB
    .prepare(`SELECT topics FROM sources WHERE topics IS NOT NULL`)
    .all<{ topics: string }>();
  const counts = new Map<string, number>();
  for (const r of rows.results ?? []) {
    try {
      for (const t of JSON.parse(r.topics) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
    } catch {
      /* skip */
    }
  }
  const topics = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([topic, n]) => ({ topic, count: n }));
  return c.json({ topics });
});

reservoir.post("/retag-all", async (c) => {
  const { inferTopics } = await import("../analysis/topics");
  const rows = await c.env.DB
    .prepare(
      `SELECT s.id, a.payload_json FROM sources s
       JOIN source_analysis a ON a.source_id = s.id
       WHERE a.analysis_type = 'basic'
         AND a.id IN (SELECT MAX(id) FROM source_analysis WHERE analysis_type = 'basic' GROUP BY source_id)`
    )
    .all<{ id: string; payload_json: string }>();

  const stmts: D1PreparedStatement[] = [];
  const ts = new Date().toISOString();
  for (const r of rows.results ?? []) {
    try {
      const payload = JSON.parse(r.payload_json) as { keywords?: string[]; important_fragments?: string[]; summary?: string };
      const topics = inferTopics(payload);
      stmts.push(
        c.env.DB
          .prepare("UPDATE sources SET topics = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(topics), ts, r.id)
      );
    } catch {
      /* skip */
    }
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ retagged: stmts.length });
});

reservoir.post("/:sourceId/deep-analysis", async (c) => {
  const sourceId = c.req.param("sourceId");
  const body: { profile?: unknown } = await c.req.json<{ profile?: unknown }>().catch(() => ({} as { profile?: unknown }));
  const profile = parseDeepProfile(body.profile);
  const active = await c.env.DB.prepare(
    `SELECT s.id AS source_id, s.quality_status, v.text_scope, v.char_count, v.normalized_text
     FROM sources s LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id = ?`
  ).bind(sourceId).first<{
    source_id: string;
    quality_status: QualityStatus;
    text_scope: TextScope | null;
    char_count: number | null;
    normalized_text: string | null;
  }>();
  if (!active) return c.json({ error: "source_not_found" }, 404);
  const readiness = isDeepAnalysisReady({
    textScope: active.text_scope ?? "UNKNOWN",
    qualityStatus: active.quality_status,
    charCount: Number(active.char_count ?? 0),
    normalizedText: active.normalized_text,
  });
  if (!readiness.ok) return c.json(readiness, 422);
  const budget = parseFloat(c.env.MONTHLY_BUDGET_USD) || 10;
  // Fast UX guard only; the workflow's D1 reservation is the race-safe final budget check.
  if ((await monthSpendUsd(c.env)) >= budget) return c.json({ error: "monthly_budget_exhausted" }, 429);
  try {
    const requestedBy = c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
    const result = await enqueueResearchJob(c.env, { kind: "DEEP_ANALYSIS", input: { sourceId, profile } }, requestedBy);
    return c.json(result, 202);
  } catch (err) {
    const message = (err as Error).message.slice(0, 200);
    const status = message === "source_not_found" ? 404 : message === "deep_analysis_text_not_ready" || message === "deep_analysis_text_missing" ? 422 : 500;
    return c.json({ error: message }, status);
  }
});

reservoir.get("/:sourceId/deep-analysis/:analysisId", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT payload_json, model, prompt_version AS promptVersion, created_at AS createdAt
     FROM source_analysis WHERE id = ? AND source_id = ? AND analysis_type = 'deep'`
  ).bind(c.req.param("analysisId"), c.req.param("sourceId")).first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);
  let analysis: unknown = null;
  try { analysis = JSON.parse(String(row.payload_json)); } catch { return c.json({ error: "invalid_analysis" }, 500); }
  return c.json({ analysis, meta: { model: row.model, promptVersion: row.promptVersion, createdAt: row.createdAt } });
});

reservoir.get("/:sourceId/original-text", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT s.id AS source_id,
            v.normalized_text AS active_text
     FROM sources s LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id = ?`
  ).bind(c.req.param("sourceId")).first<{
    source_id: string;
    active_text: string | null;
  }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const text = row.active_text;
  if (!text?.trim()) return c.json({ error: "original_text_not_available" }, 404);
  return new Response(text.slice(0, MAX_SOURCE_TEXT_CHARS), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

reservoir.get("/:sourceId/original", async (c) => {
  const versionId = c.req.query("version")?.trim() ?? "";
  if (!versionId) return c.json({ error: "version_required" }, 400);
  const row = await loadReservoirPdfOriginal(c.env.DB, c.req.param("sourceId"), versionId);
  if (!row) return c.json({ error: "original_not_available" }, 404);
  const object = await c.env.ORIGINALS.get(row.active_r2_key!);
  if (!object?.body) return c.json({ error: "original_not_available" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="${safePdfDownloadName(row.title ?? "original")}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

reservoir.get("/:sourceId", async (c) => {
  const id = c.req.param("sourceId");
  const cycle = await researchCycleMeta(c.env.DB);
  const src = await c.env.DB
    .prepare(
      `SELECT sources.id, sources.kind, sources.title, sources.authors, sources.year,
              sources.canonical_url AS canonicalUrl, sources.doi, sources.reliability,
              sources.provenance_class AS provenanceClass, sources.status, sources.origin,
              sources.origins_json AS origins, sources.r2_key AS r2Key, sources.topics,
              sources.input_format AS inputFormat, sources.active_version_id AS activeVersionId,
              sources.metadata_json AS metadata, sources.created_at AS createdAt, sources.updated_at AS updatedAt,
              active.text_scope AS acquisitionTextScope,
              active.extraction_method AS acquisitionExtractionMethod,
              sources.quality_status AS acquisitionQualityStatus,
              active.char_count AS acquisitionCharCount,
              active.extraction_error AS acquisitionError,
              CASE WHEN LENGTH(TRIM(COALESCE(active.normalized_text, ''))) > 0 THEN 1 ELSE 0 END AS acquisitionHasNormalizedText,
              CASE WHEN (SELECT us.action FROM user_signals us
                         WHERE us.source_id = sources.id AND us.action IN ('keep','develop','watch','ignore') AND us.created_at > ?
                         ORDER BY us.created_at DESC LIMIT 1) IN ('keep','develop') THEN 1 ELSE 0 END AS markedForNextResearch
              ,(SELECT us.action FROM user_signals us
                WHERE us.source_id = sources.id AND us.action IN ('keep','develop','watch','ignore')
                ORDER BY us.created_at DESC LIMIT 1) AS decisionStatus
       FROM sources LEFT JOIN source_versions active ON active.id = sources.active_version_id
       WHERE sources.id = ?`
    )
    .bind(cycle.markSince, id)
    .first<Record<string, unknown> & AcquisitionColumns>();
  if (!src) return c.json({ error: "not_found" }, 404);

  const {
    acquisitionTextScope,
    acquisitionExtractionMethod,
    acquisitionQualityStatus,
    acquisitionCharCount,
    acquisitionError,
    acquisitionHasNormalizedText,
    ...source
  } = src;
  const acquisition = sourceAcquisitionView(id, {
    acquisitionTextScope,
    acquisitionExtractionMethod,
    acquisitionQualityStatus,
    acquisitionCharCount,
    acquisitionError,
    acquisitionHasNormalizedText,
  });
  const pdfExtraction = await activePdfExtraction(c.env.DB, typeof source.activeVersionId === "string" ? source.activeVersionId : null);

  const [analysis, deepAnalysis, deepHistory, kws, qs, frags, versions, sigs, visuals] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT payload_json, model, prompt_version, created_at FROM source_analysis
         WHERE source_id = ? AND analysis_type = 'basic' ORDER BY created_at DESC LIMIT 1`
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT payload_json, model, prompt_version, created_at FROM source_analysis
       WHERE source_id = ? AND analysis_type = 'deep' ORDER BY created_at DESC LIMIT 1`
    ).bind(id).first<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, analysis_type AS analysisType, model, prompt_version AS promptVersion, cost_usd AS costUsd, created_at AS createdAt
       FROM source_analysis WHERE source_id = ? AND analysis_type = 'deep' ORDER BY created_at DESC LIMIT 10`
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare("SELECT keyword, weight FROM keywords WHERE source_id = ?").bind(id).all<{ keyword: string; weight: number }>(),
    c.env.DB.prepare("SELECT question, status FROM questions WHERE source_id = ?").bind(id).all<{ question: string; status: string }>(),
    c.env.DB.prepare("SELECT text FROM fragments WHERE source_id = ? LIMIT 10").bind(id).all<{ text: string }>(),
    c.env.DB
      .prepare("SELECT version, char_count, created_at FROM source_versions WHERE source_id = ? ORDER BY version")
      .bind(id)
      .all<{ version: number; char_count: number; created_at: string }>(),
    c.env.DB
      .prepare("SELECT action, created_at FROM user_signals WHERE source_id = ? ORDER BY created_at DESC LIMIT 20")
      .bind(id)
      .all<{ action: string; created_at: string }>(),
    listVisualAssets(c.env.DB, { parentSourceId: id }),
  ]);

  let analysisPayload: unknown = null;
  try {
    const pj = analysis.results?.[0]?.payload_json;
    if (typeof pj === "string") analysisPayload = JSON.parse(pj);
  } catch {
    analysisPayload = null;
  }

  let deepAnalysisPayload: unknown = null;
  try {
    if (typeof deepAnalysis?.payload_json === "string") deepAnalysisPayload = JSON.parse(deepAnalysis.payload_json);
  } catch {
    deepAnalysisPayload = null;
  }

  return c.json({
    source,
    acquisition,
    pdfExtraction,
    analysis: analysisPayload,
    analysisMeta: analysis.results?.[0]
      ? { model: analysis.results[0].model, promptVersion: analysis.results[0].prompt_version, createdAt: analysis.results[0].created_at }
      : null,
    deepAnalysis: deepAnalysisPayload,
    deepAnalysisMeta: deepAnalysis
      ? { model: deepAnalysis.model, promptVersion: deepAnalysis.prompt_version, createdAt: deepAnalysis.created_at }
      : null,
    deepAnalysisHistory: deepHistory.results ?? [],
    keywords: kws.results ?? [],
    questions: qs.results ?? [],
    fragments: frags.results ?? [],
    versions: versions.results ?? [],
    signals: sigs.results ?? [],
    visuals: visuals.items,
  });
});

function safePdfDownloadName(title: string): string {
  return `${title.replace(/[^a-zA-Z0-9가-힣._-]+/g, "_").slice(0, 100) || "original"}.pdf`;
}

export default reservoir;
