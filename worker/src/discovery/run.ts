import { searchWorks, type OpenAlexWork } from "../lib/openalex";
import { uuid } from "../ingestion/ids";

const MAX_CANDIDATES_PER_RUN = 20;
const DISCOVERY_QUERIES_KEY = "discovery_queries_v1";

export interface DiscoveryRunResult {
  collected: number;
  keptExisting: number;
  queries: string[];
}

export async function momentumKeywords(db: D1Database, limit = 4): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT keyword, COUNT(*) AS n FROM keywords
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY keyword ORDER BY n DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ keyword: string }>();
  const kws = (rows.results ?? []).map((r) => r.keyword);
  if (kws.length < limit) {
    const fallback = await db
      .prepare(`SELECT keyword, COUNT(*) AS n FROM keywords GROUP BY keyword ORDER BY n DESC LIMIT ?`)
      .bind(limit)
      .all<{ keyword: string }>();
    for (const f of fallback.results ?? []) {
      if (!kws.includes(f.keyword)) kws.push(f.keyword);
      if (kws.length >= limit) break;
    }
  }
  return kws;
}

export async function customQueries(db: D1Database): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(DISCOVERY_QUERIES_KEY).first<{ value: string }>();
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as string[];
    return Array.isArray(v) ? v.filter((q) => typeof q === "string" && q.trim()).slice(0, 4) : [];
  } catch {
    return [];
  }
}

export async function setCustomQueries(db: D1Database, queries: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(DISCOVERY_QUERIES_KEY, JSON.stringify(queries.slice(0, 4)), new Date().toISOString())
    .run();
}

export async function runDiscovery(env: Env, divergence: number): Promise<DiscoveryRunResult> {
  const keywords = await momentumKeywords(env.DB);
  const extra = await customQueries(env.DB);
  const queries = [...extra, ...keywords].slice(0, 6);

  const existing = await env.DB.prepare("SELECT openalex_id FROM discovery_candidates WHERE openalex_id IS NOT NULL").all<{ openalex_id: string }>();
  const seen = new Set(existing.results?.map((r) => r.openalex_id) ?? []);

  const perQuery = Math.max(2, Math.round(MAX_CANDIDATES_PER_RUN / Math.max(queries.length, 1)));
  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let collected = 0;

  for (const q of queries) {
    const works: OpenAlexWork[] = await searchWorks(q, perQuery + 2);
    for (const w of works) {
      if (collected >= MAX_CANDIDATES_PER_RUN) break;
      if (!w.id || seen.has(w.id)) continue;
      seen.add(w.id);
      const relevance = scoreRelevance(w, keywords);
      stmts.push(
        env.DB
          .prepare(
            `INSERT INTO discovery_candidates (id, openalex_id, title, authors, year, abstract, relevance_score, status, query_used, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?)`
          )
          .bind(uuid(), w.id, w.title.slice(0, 300), w.authors ?? null, w.year, null, relevance, q, ts)
      );
      collected++;
    }
    if (collected >= MAX_CANDIDATES_PER_RUN) break;
  }

  if (stmts.length) await env.DB.batch(stmts);
  return { collected, keptExisting: seen.size, queries };
}

function scoreRelevance(w: OpenAlexWork, momentumKeywords: string[]): number {
  let score = 0.15;
  const title = w.title.toLowerCase();
  for (const kw of momentumKeywords) {
    if (kw.length >= 2 && title.includes(kw.toLowerCase())) score += 0.3;
  }
  if (w.citedByCount > 50) score += 0.1;
  if (w.year && w.year >= new Date().getFullYear() - 5) score += 0.15;
  if (w.openAccessUrl) score += 0.1;
  return Math.min(score, 1);
}
