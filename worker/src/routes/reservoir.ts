import { Hono } from "hono";
import { analyzeDeepSource } from "../analysis/deepAnalyze";
import { parseDeepProfile, DEEP_PROFILES } from "../analysis/deepProfiles";
import { monthSpendUsd } from "../lib/openai";
import { enqueueResearchJob } from "../jobs/enqueue";

const reservoir = new Hono<{ Bindings: Env }>();

interface ResearchCycleMeta {
  lastResearchAt: string | null;
  markSince: string;
}

async function researchCycleMeta(db: D1Database): Promise<ResearchCycleMeta> {
  const latest = await db.prepare("SELECT created_at FROM distill_sessions ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
  return {
    lastResearchAt: latest?.created_at ?? null,
    markSince: latest?.created_at ?? new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
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
  const budget = parseFloat(c.env.MONTHLY_BUDGET_USD) || 10;
  if ((await monthSpendUsd(c.env)) >= budget) return c.json({ error: "monthly_budget_exhausted" }, 429);
  try {
    const requestedBy = c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
    const result = await enqueueResearchJob(c.env, { kind: "DEEP_ANALYSIS", input: { sourceId, profile } }, requestedBy);
    return c.json(result, 202);
  } catch (err) {
    const message = (err as Error).message.slice(0, 200);
    const status = message === "source_not_found" ? 404 : message === "deep_analysis_text_missing" ? 422 : 500;
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

reservoir.get("/:sourceId", async (c) => {
  const id = c.req.param("sourceId");
  const cycle = await researchCycleMeta(c.env.DB);
  const src = await c.env.DB
    .prepare(
      `SELECT id, kind, title, authors, year, canonical_url AS canonicalUrl, doi, reliability,
              provenance_class AS provenanceClass, status, origin, origins_json AS origins, r2_key AS r2Key,
              topics, metadata_json AS metadata, created_at AS createdAt, updated_at AS updatedAt,
              CASE WHEN (SELECT us.action FROM user_signals us
                         WHERE us.source_id = sources.id AND us.action IN ('keep','develop','watch','ignore') AND us.created_at > ?
                         ORDER BY us.created_at DESC LIMIT 1) IN ('keep','develop') THEN 1 ELSE 0 END AS markedForNextResearch
              ,(SELECT us.action FROM user_signals us
                WHERE us.source_id = sources.id AND us.action IN ('keep','develop','watch','ignore')
                ORDER BY us.created_at DESC LIMIT 1) AS decisionStatus
       FROM sources WHERE id = ?`
    )
    .bind(cycle.markSince, id)
    .first<Record<string, unknown>>();
  if (!src) return c.json({ error: "not_found" }, 404);

  const [analysis, deepAnalysis, deepHistory, kws, qs, frags, versions, sigs] = await Promise.all([
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
    source: src,
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
  });
});

export default reservoir;
