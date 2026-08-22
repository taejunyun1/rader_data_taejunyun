import { Hono } from "hono";
import { runDiscovery, customQueries, setCustomQueries, customFeeds, setCustomFeeds } from "../discovery/run";
import { loadParams } from "../lib/params";
import { createSource } from "../ingestion/store";
import { searchWorks } from "../lib/openalex";
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { DISCOVERY_MIN_SCORE } from "@radar/shared/discovery";

const discover = new Hono<{ Bindings: Env }>();

discover.get("/sources", (c) => c.json({ items: DISCOVERY_SOURCE_PRESETS }));

discover.get("/candidates", async (c) => {
  const status = c.req.query("status") ?? "CANDIDATE";
  const query = status === "CANDIDATE"
    ? `SELECT id, openalex_id AS openalexId, title, authors, year, relevance_score AS relevanceScore,
              status, query_used AS queryUsed, created_at AS createdAt, provider, external_url AS externalUrl, access_status AS accessStatus
       FROM discovery_candidates
       WHERE status = ? AND relevance_score >= ${DISCOVERY_MIN_SCORE}
         AND access_status IN ('PDF', 'FREE_FULLTEXT')
       ORDER BY relevance_score DESC, created_at DESC LIMIT 8`
    : `SELECT id, openalex_id AS openalexId, title, authors, year, relevance_score AS relevanceScore,
              status, query_used AS queryUsed, created_at AS createdAt, provider, external_url AS externalUrl, access_status AS accessStatus
       FROM discovery_candidates WHERE status = ? ORDER BY relevance_score DESC, created_at DESC LIMIT 50`;
  const rows = await c.env.DB.prepare(query).bind(status).all<Record<string, unknown>>();
  return c.json({ items: rows.results ?? [] });
});

discover.post("/run", async (c) => {
  const params = await loadParams(c.env.DB);
  try {
    const result = await runDiscovery(c.env, params.divergence);
    return c.json(result);
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
      const match = detail.find((w) => w.id === cand.openalex_id);
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

discover.get("/feeds", async (c) => {
  return c.json({ feeds: await customFeeds(c.env.DB) });
});

discover.put("/feeds", async (c) => {
  const body = (await c.req.json<{ feeds?: string[] }>().catch(() => null)) as { feeds?: string[] } | null;
  if (!body?.feeds || !Array.isArray(body.feeds)) return c.json({ error: "feeds_required" }, 400);
  const clean = body.feeds.map((f) => String(f).trim()).filter((f) => /^https?:\/\//.test(f)).slice(0, 6);
  await setCustomFeeds(c.env.DB, clean);
  return c.json({ feeds: clean });
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
