import { Hono } from "hono";
import { runDiscovery, customQueries, setCustomQueries } from "../discovery/run";
import { loadParams } from "../lib/params";
import { createSource } from "../ingestion/store";
import { searchWorks } from "../lib/openalex";

const discover = new Hono<{ Bindings: Env }>();

discover.get("/candidates", async (c) => {
  const status = c.req.query("status") ?? "CANDIDATE";
  const rows = await c.env.DB
    .prepare(
      `SELECT id, openalex_id AS openalexId, title, authors, year, relevance_score AS relevanceScore,
              status, query_used AS queryUsed, created_at AS createdAt
       FROM discovery_candidates WHERE status = ? ORDER BY relevance_score DESC, created_at DESC LIMIT 50`
    )
    .bind(status)
    .all<Record<string, unknown>>();
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
    .prepare("SELECT id, openalex_id, title, authors, year, status FROM discovery_candidates WHERE id = ?")
    .bind(id)
    .first<{ id: string; openalex_id: string | null; title: string; authors: string | null; year: number | null; status: string }>();
  if (!cand) return c.json({ error: "not_found" }, 404);

  const newStatus = action === "keep" ? "KEPT" : action === "watch" ? "WATCHED" : "IGNORED";
  await c.env.DB.prepare("UPDATE discovery_candidates SET status = ? WHERE id = ?").bind(newStatus, id).run();

  let sourceId: string | null = null;
  if (action === "keep" && cand.openalex_id) {
    const detail = await searchWorks(cand.title, 1);
    const match = detail.find((w) => w.id === cand.openalex_id);
    const r = await createSource(c.env, {
      kind: "DISCOVERY",
      title: cand.title,
      authors: cand.authors ?? undefined,
      year: cand.year ?? undefined,
      canonicalUrl: cand.openalex_id,
      doi: match?.doi?.replace("https://doi.org/", "") ?? undefined,
      origin: "discovery",
      original: cand.title,
      extractedText: undefined,
      metadata: { openalexId: cand.openalex_id, oaUrl: match?.openAccessUrl ?? null },
    });
    sourceId = r.sourceId;
  }

  return c.json({ ok: true, status: newStatus, sourceId });
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
