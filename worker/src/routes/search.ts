import { Hono } from "hono";

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
  return c.json({ query: q, hits: sorted });
});

export default search;
