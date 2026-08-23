import { Hono } from "hono";
import { runDiscovery, customQueries, setCustomQueries, customFeeds, setCustomFeeds } from "../discovery/run";
import { loadParams } from "../lib/params";
import { createSource } from "../ingestion/store";
import { searchWorks } from "../lib/openalex";
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { DISCOVERY_MIN_SCORE } from "@radar/shared/discovery";
import { loadDiscoveryProfile, saveDiscoveryProfile } from "../discovery/profile";
import { buildDiscoveryRecommendations } from "../discovery/recommendations";
import { enqueueResearchJob } from "../jobs/enqueue";

const discover = new Hono<{ Bindings: Env }>();
const FIELD_SIGNAL_STATUSES = new Set(["NEW", "SAVED", "DISMISSED"]);
const FIELD_SIGNAL_TYPES = new Set([
  "CONFERENCE", "CALL_FOR_PAPERS", "EXHIBITION", "GRANT",
  "RESIDENCY", "WORKSHOP", "INSTITUTION_NEWS", "OTHER",
]);

function parseMatchedTerms(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((term): term is string => typeof term === "string")
      : [];
  } catch {
    return [];
  }
}

discover.get("/sources", (c) => c.json({ items: DISCOVERY_SOURCE_PRESETS }));

discover.get("/candidates", async (c) => {
  const status = c.req.query("status") ?? "CANDIDATE";
  const lane = c.req.query("lane");
  const laneClause = lane === "ORIGINAL" || lane === "COUNTER" ? " AND discovery_lane = ?" : "";
  const query = status === "CANDIDATE"
    ? `SELECT id, openalex_id AS openalexId, title, authors, year, relevance_score AS relevanceScore,
              status, query_used AS queryUsed, created_at AS createdAt, provider, external_url AS externalUrl, access_status AS accessStatus,
              discovery_lane AS discoveryLane, query_source AS querySource, source_id AS sourceId
       FROM discovery_candidates
       WHERE status = ? AND relevance_score >= ${DISCOVERY_MIN_SCORE}
         AND access_status IN ('PDF', 'FREE_FULLTEXT')${laneClause}
       ORDER BY relevance_score DESC, created_at DESC LIMIT 8`
    : `SELECT id, openalex_id AS openalexId, title, authors, year, relevance_score AS relevanceScore,
              status, query_used AS queryUsed, created_at AS createdAt, provider, external_url AS externalUrl, access_status AS accessStatus,
              discovery_lane AS discoveryLane, query_source AS querySource, source_id AS sourceId
       FROM discovery_candidates WHERE status = ?${laneClause} ORDER BY relevance_score DESC, created_at DESC LIMIT 50`;
  const rows = await c.env.DB.prepare(query).bind(...(laneClause ? [status, lane] : [status])).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

discover.get("/profile", async (c) => c.json({ profile: await loadDiscoveryProfile(c.env.DB) }));

discover.put("/profile", async (c) => {
  const body = await c.req.json<{ profile?: unknown }>().catch(() => null);
  const value = body && typeof body === "object" && "profile" in body ? body.profile : body;
  if (!value) return c.json({ error: "profile_required" }, 400);
  return c.json({ profile: await saveDiscoveryProfile(c.env.DB, value) });
});

discover.get("/recommendations", async (c) => {
  const profile = await loadDiscoveryProfile(c.env.DB);
  return c.json({ recommendations: await buildDiscoveryRecommendations(c.env.DB, profile) });
});

discover.post("/run", async (c) => {
  const params = await loadParams(c.env.DB);
  const profile = await loadDiscoveryProfile(c.env.DB);
  const requestedBy = c.req.header("CF-Access-Authenticated-User-Email") ?? "local";
  try {
    const result = await enqueueResearchJob(c.env, { kind: "DISCOVERY_RUN", input: { divergence: params.divergence, profile } }, requestedBy);
    return c.json(result, 202);
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    console.error(JSON.stringify({ level: "error", scope: "discover:run", message }));
    return c.json({ error: message }, 500);
  }
});

discover.post("/candidates/:id/:action", async (c) => {
  const id = c.req.param("id");
  const action = c.req.param("action");
  if (!["keep", "watch", "ignore"].includes(action)) return c.json({ error: "invalid_action" }, 400);

  const cand = await c.env.DB
    .prepare("SELECT id, openalex_id, title, authors, year, status, provider, external_url, access_status FROM discovery_candidates WHERE id = ?")
    .bind(id)
    .first<{ id: string; openalex_id: string | null; title: string; authors: string | null; year: number | null; status: string; provider: string; external_url: string | null; access_status: string | null }>();
  if (!cand) return c.json({ error: "not_found" }, 404);

  const newStatus = action === "keep" ? "KEPT" : action === "watch" ? "WATCHED" : "IGNORED";
  await c.env.DB.prepare("UPDATE discovery_candidates SET status = ? WHERE id = ?").bind(newStatus, id).run();

  let sourceId: string | null = null;
  if (action === "keep" && cand.openalex_id) {
    const link = cand.external_url ?? cand.openalex_id;
    let doi: string | undefined;
    let oaUrl: string | null = null;
    if (cand.provider === "openalex") {
      const detail = await searchWorks(cand.title, 1);
      const match = detail.items.find((w) => w.id === cand.openalex_id);
      doi = match?.doi?.replace("https://doi.org/", "") ?? undefined;
      oaUrl = match?.openAccessUrl ?? null;
    }
    const r = await createSource(c.env, {
      kind: "DISCOVERY",
      title: cand.title,
      authors: cand.authors ?? undefined,
      year: cand.year ?? undefined,
      canonicalUrl: link,
      doi,
      origin: `discovery:${cand.provider}`,
      original: cand.title,
      extractedText: undefined,
      metadata: { provider: cand.provider, externalId: cand.openalex_id, oaUrl, accessStatus: cand.access_status },
    });
    sourceId = r.sourceId;
  }

  return c.json({ ok: true, status: newStatus, sourceId });
});

discover.get("/signals", async (c) => {
  const status = FIELD_SIGNAL_STATUSES.has(c.req.query("status") ?? "") ? c.req.query("status")! : "NEW";
  const type = c.req.query("type") ?? "";
  const typeClause = FIELD_SIGNAL_TYPES.has(type) ? " AND signal_type = ?" : "";
  const rows = await c.env.DB.prepare(
    `SELECT id, source_id AS sourceId, external_url AS externalUrl, title, summary,
            signal_type AS signalType, published_at AS publishedAt, event_at AS eventAt,
            deadline_at AS deadlineAt, matched_terms_json AS matchedTermsJson,
            relevance_score AS relevanceScore, status, created_at AS createdAt, updated_at AS updatedAt
     FROM discovery_field_signals
     WHERE status = ?${typeClause}
     ORDER BY relevance_score DESC,
              CASE WHEN deadline_at IS NOT NULL OR event_at IS NOT NULL THEN 0 ELSE 1 END ASC,
              COALESCE(deadline_at, event_at) ASC,
              COALESCE(published_at, created_at) DESC
     LIMIT 50`,
  ).bind(...(typeClause ? [status, type] : [status])).all<Record<string, unknown>>();
  const sourceNames = new Map(DISCOVERY_SOURCE_PRESETS.map((source) => [source.id, source.name]));
  const items = (rows.results ?? []).map((row) => ({
    ...row,
    sourceName: sourceNames.get(String(row.sourceId)) ?? String(row.sourceId),
    matchedTerms: parseMatchedTerms(row.matchedTermsJson),
    matchedTermsJson: undefined,
  }));
  return c.json({ items });
});

discover.post("/signals/:id/:action", async (c) => {
  const action = c.req.param("action");
  const nextStatus = action === "save" ? "SAVED" : action === "dismiss" ? "DISMISSED" : action === "restore" ? "NEW" : null;
  if (!nextStatus) return c.json({ error: "invalid_action" }, 400);
  const updatedAt = new Date().toISOString();
  const result = await c.env.DB.prepare(
    "UPDATE discovery_field_signals SET status = ?, updated_at = ? WHERE id = ?",
  ).bind(nextStatus, updatedAt, c.req.param("id")).run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true, status: nextStatus, updatedAt });
});

discover.get("/feeds", async (c) => {
  return c.json({ feeds: await customFeeds(c.env.DB) });
});

discover.put("/feeds", async (c) => {
  const body = (await c.req.json<{ feeds?: string[] }>().catch(() => null)) as { feeds?: string[] } | null;
  if (!body?.feeds || !Array.isArray(body.feeds)) return c.json({ error: "feeds_required" }, 400);
  const clean = body.feeds.map((f) => String(f).trim()).filter((f) => /^https?:\/\//.test(f)).slice(0, 6);
  await setCustomFeeds(c.env.DB, clean);
  return c.json({ feeds: await customFeeds(c.env.DB) });
});

discover.get("/queries", async (c) => {
  return c.json({ queries: await customQueries(c.env.DB) });
});

discover.put("/queries", async (c) => {
  const body = (await c.req.json<{ queries?: string[] }>().catch(() => null)) as { queries?: string[] } | null;
  if (!body?.queries || !Array.isArray(body.queries)) return c.json({ error: "queries_required" }, 400);
  const clean = body.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  await setCustomQueries(c.env.DB, clean);
  return c.json({ queries: clean });
});

export default discover;
