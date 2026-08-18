import { Hono } from "hono";
import { ensureEmbedding, semanticSearch } from "../lib/embed";

const search = new Hono<{ Bindings: Env }>();

interface SearchHit {
  sourceId: string;
  title: string;
  kind: string;
  reliability: string;
  matched: string;
  snippet: string;
  score: number;
}

search.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ hits: [] });
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const hits = new Map<string, SearchHit>();

  async function addRows(
    sql: string,
    bind: (string | number)[],
    matched: string,
    score: number,
    snippetOf: (row: Record<string, unknown>) => string
  ) {
    const rows = await c.env.DB.prepare(sql).bind(...bind).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      const id = String(row.source_id ?? row.id ?? "");
      if (!id) continue;
      const existing = hits.get(id);
      if (existing) {
        existing.score += score;
        continue;
      }
      hits.set(id, {
        sourceId: id,
        title: String(row.title ?? ""),
        kind: String(row.kind ?? ""),
        reliability: String(row.reliability ?? ""),
        matched,
        snippet: snippetOf(row),
        score,
      });
    }
  }

  await addRows(
    `SELECT s.id AS source_id, s.title, s.kind, s.reliability FROM sources s
     WHERE s.title LIKE ? OR (s.authors LIKE ?) LIMIT 20`,
    [like, like],
    "title/author",
    100,
    (row) => String(row.title ?? "")
  );
  await addRows(
    `SELECT k.source_id, s.title, s.kind, s.reliability, k.keyword FROM keywords k
     JOIN sources s ON s.id = k.source_id WHERE k.keyword LIKE ? LIMIT 30`,
    [like],
    "keyword",
    60,
    (row) => String(row.keyword ?? "")
  );
  await addRows(
    `SELECT q.source_id, s.title, s.kind, s.reliability, q.question FROM questions q
     JOIN sources s ON s.id = q.source_id WHERE q.question LIKE ? LIMIT 20`,
    [like],
    "question",
    40,
    (row) => String(row.question ?? "")
  );
  await addRows(
    `SELECT a.source_id, s.title, s.kind, s.reliability FROM source_analysis a
     JOIN sources s ON s.id = a.source_id
     WHERE a.payload_json LIKE ? LIMIT 10`,
    [like],
    "summary",
    25,
    (row) => ""
  );
  await addRows(
    `SELECT f.source_id, s.title, s.kind, s.reliability, f.text FROM fragments f
     JOIN sources s ON s.id = f.source_id WHERE f.text LIKE ? LIMIT 15`,
    [like],
    "fragment",
    20,
    (row) => String(row.text ?? "").slice(0, 160)
  );

  const sorted = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 30);

  try {
    const semantic = await semanticSearch(c.env, q, 8);
    for (const s of semantic) {
      const existing = sorted.find((h) => h.sourceId === s.sourceId);
      if (existing) {
        existing.score += Math.round(s.score * 20);
        if (!existing.snippet) existing.matched += "+semantic";
      } else {
        const src = await c.env.DB
          .prepare("SELECT title, kind, reliability FROM sources WHERE id = ?")
          .bind(s.sourceId)
          .first<{ title: string; kind: string; reliability: string }>();
        if (src) {
          sorted.push({
            sourceId: s.sourceId,
            title: src.title,
            kind: src.kind,
            reliability: src.reliability,
            matched: "semantic",
            snippet: "",
            score: Math.round(s.score * 50),
          });
        }
      }
    }
  } catch {
    /* semantic layer unavailable — keyword results still returned */
  }

  sorted.sort((a, b) => b.score - a.score);
  return c.json({ query: q, hits: sorted.slice(0, 30) });
});

search.post("/embed-backfill", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "15", 10) || 15, 40);
  const rows = await c.env.DB.prepare(
    `SELECT s.id FROM sources s
     LEFT JOIN source_embeddings e ON e.source_id = s.id
     WHERE e.source_id IS NULL AND s.status IN ('indexed','analyzed','extracted')
     ORDER BY s.updated_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<{ id: string }>();

  let embedded = 0;
  const failures: { id: string; error: string }[] = [];
  for (const r of rows.results ?? []) {
    try {
      const did = await ensureEmbedding(c.env, r.id);
      if (did) embedded++;
    } catch (e) {
      failures.push({ id: r.id, error: (e as Error).message.slice(0, 100) });
    }
  }
  const remaining = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM sources s LEFT JOIN source_embeddings e ON e.source_id = s.id
       WHERE e.source_id IS NULL AND s.status IN ('indexed','analyzed','extracted')`
    )
    .first<{ n: number }>();
  return c.json({ embedded, attempted: rows.results?.length ?? 0, remaining: remaining?.n ?? 0, failures });
});

export default search;
