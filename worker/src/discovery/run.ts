import { searchWorks, type OpenAlexWork } from "../lib/openalex";
import { searchArxiv } from "../lib/arxiv";
import { fetchFeed } from "../lib/rss";
import { uuid } from "../ingestion/ids";
import { DEFAULT_DISCOVERY_FEEDS } from "@radar/shared";

const MAX_CANDIDATES_PER_RUN = 20;
const DISCOVERY_QUERIES_KEY = "discovery_queries_v1";
const DISCOVERY_FEEDS_KEY = "discovery_feeds_v1";

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
  return loadListKV(db, DISCOVERY_QUERIES_KEY, 4);
}

export async function customFeeds(db: D1Database): Promise<string[]> {
  return loadListKV(db, DISCOVERY_FEEDS_KEY, 6, DEFAULT_DISCOVERY_FEEDS);
}

export async function setCustomFeeds(db: D1Database, feeds: string[]): Promise<void> {
  await saveListKV(db, DISCOVERY_FEEDS_KEY, feeds, 6);
}

async function loadListKV(db: D1Database, key: string, max: number, fallback: string[] = []): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return fallback.slice(0, max);
  try {
    const v = JSON.parse(row.value) as string[];
    return Array.isArray(v) ? v.filter((q) => typeof q === "string" && q.trim()).slice(0, max) : [];
  } catch {
    return [];
  }
}

async function saveListKV(db: D1Database, key: string, list: string[], max: number): Promise<void> {
  await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(list.map((q) => q.trim()).filter(Boolean).slice(0, max)), new Date().toISOString())
    .run();
}

export async function setCustomQueries(db: D1Database, queries: string[]): Promise<void> {
  await saveListKV(db, DISCOVERY_QUERIES_KEY, queries, 4);
}

export async function runDiscovery(env: Env, divergence: number): Promise<DiscoveryRunResult> {
  const keywords = await momentumKeywords(env.DB);
  const extra = await customQueries(env.DB);
  const feeds = await customFeeds(env.DB);
  const queries = [...extra, ...keywords].slice(0, 6);

  const existing = await env.DB.prepare("SELECT openalex_id FROM discovery_candidates WHERE openalex_id IS NOT NULL").all<{ openalex_id: string }>();
  const seen = new Set(existing.results?.map((r) => r.openalex_id) ?? []);

  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let collected = 0;

  const push = (externalId: string, provider: string, title: string, authors: string | null, year: number | null, relevance: number, query: string, url: string | null) => {
    if (collected >= MAX_CANDIDATES_PER_RUN || seen.has(externalId)) return;
    seen.add(externalId);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO discovery_candidates (id, openalex_id, title, authors, year, abstract, relevance_score, status, query_used, created_at, provider, external_url)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'CANDIDATE', ?, ?, ?, ?)`
        )
        .bind(uuid(), externalId, title.slice(0, 300), authors, year, relevance, query, ts, provider, url)
    );
    collected++;
  };

  const openalexBudget = Math.max(8, MAX_CANDIDATES_PER_RUN - (feeds.length ? 6 : 0) - 4);
  const perQuery = Math.max(2, Math.round(openalexBudget / Math.max(queries.length, 1)));
  for (const q of queries) {
    const works: OpenAlexWork[] = await searchWorks(q, perQuery + 2);
    for (const w of works) {
      if (!w.id) continue;
      push(w.id, "openalex", w.title, w.authors ?? null, w.year, scoreRelevance(w, keywords), q, w.openAccessUrl ?? w.doi ?? null);
    }
    if (collected >= openalexBudget) break;
  }

  for (const q of keywords.slice(0, 2)) {
    const works = await searchArxiv(q, 3);
    for (const w of works) {
      push(w.id, "arxiv", w.title, w.authors || null, w.year, 0.45, `arxiv:${q}`, w.url);
    }
  }

  for (const feedUrl of feeds) {
    const items = await fetchFeed(feedUrl, 3);
    for (const item of items) {
      if (!item.url) continue;
      push(item.url, "rss", item.title, null, item.year, 0.35, feedUrl.slice(0, 80), item.url);
    }
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
