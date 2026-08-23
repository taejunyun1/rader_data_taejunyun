import { searchWorks, type OpenAlexWork } from "../lib/openalex";
import { searchArxiv } from "../lib/arxiv";
import { fetchFeed } from "../lib/rss";
import { uuid } from "../ingestion/ids";
import { DEFAULT_DISCOVERY_FEEDS } from "@radar/shared";
import {
  assessDiscoveryCandidate,
  classifyDiscoveryAccess,
  isUsableDiscoveryQuery,
  normalizeDiscoveryTitle,
  discoveryProviderQuery,
  selectDiscoveryCandidatesByLane,
  strengthFetchLimit,
  strengthQueryLimit,
  type DiscoveryAccessStatus,
  type DiscoveryLane,
  type DiscoveryProfile,
  type DiscoveryQuerySource,
  type SelectableDiscoveryCandidate,
} from "@radar/shared/discovery";
import { loadDiscoveryProfile } from "./profile";

const MAX_CANDIDATES_PER_RUN = 8;
const MAX_OPENALEX_CANDIDATES = 10;
const DISCOVERY_QUERIES_KEY = "discovery_queries_v1";
const DISCOVERY_FEEDS_KEY = "discovery_feeds_v1";

interface PendingCandidate extends SelectableDiscoveryCandidate {
  authors: string | null;
  year: number | null;
  abstract: string | null;
  query: string;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  url: string | null;
  accessStatus: DiscoveryAccessStatus;
}

export interface DiscoveryRunResult {
  collected: number;
  keptExisting: number;
  queries: string[];
}

export async function momentumKeywords(db: D1Database, limit = 4): Promise<string[]> {
  const homepage = await homepageKeywords(db, Math.min(2, limit));
  const rows = await db
    .prepare(
      `SELECT keyword, COUNT(*) AS n FROM keywords
       WHERE created_at >= datetime('now', '-30 days')
       GROUP BY keyword ORDER BY n DESC LIMIT ?`
    )
    .bind(limit)
    .all<{ keyword: string }>();
  const kws = [...homepage, ...(rows.results ?? []).map((r) => r.keyword)];
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
  return [...new Set(kws)].filter(isUsableDiscoveryQuery).slice(0, limit);
}

async function homepageKeywords(db: D1Database, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db
    .prepare(
      `SELECT k.keyword, COUNT(*) AS n
       FROM keywords k
       JOIN sources s ON s.id = k.source_id
       WHERE s.origin = 'homepage'
       GROUP BY k.keyword
       ORDER BY n DESC, k.keyword ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<{ keyword: string }>();
  return (rows.results ?? []).map((r) => r.keyword).filter(Boolean).filter(isUsableDiscoveryQuery);
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

export async function runDiscovery(env: Env, input: number | { divergence: number; profile?: DiscoveryProfile }): Promise<DiscoveryRunResult> {
  const divergence = typeof input === "number" ? input : input.divergence;
  const profile = typeof input === "number" ? await loadDiscoveryProfile(env.DB) : input.profile ?? await loadDiscoveryProfile(env.DB);
  const momentum = await momentumKeywords(env.DB, 4);
  const legacy = (await customQueries(env.DB)).filter(isUsableDiscoveryQuery);
  const feeds = await customFeeds(env.DB);
  const originalKeywords = [...profile.original.keywords, ...legacy, ...momentum].filter(isUsableDiscoveryQuery);
  const originalQueries = [...new Set(originalKeywords)].slice(0, strengthQueryLimit(profile.original.strength));
  const counterQueries = [...new Set(profile.counter.keywords)].filter(isUsableDiscoveryQuery).slice(0, strengthQueryLimit(profile.counter.strength));
  if (originalQueries.length === 0 && counterQueries.length === 0) throw new Error("discovery_profile_empty");
  const queryDescriptors = [
    ...originalQueries.map((query, index) => ({ query, lane: "ORIGINAL" as const, querySource: index < profile.original.keywords.length ? "SAVED" as const : "MOMENTUM" as const })),
    ...counterQueries.map((query, index) => ({ query, lane: "COUNTER" as const, querySource: index < profile.counter.keywords.length ? "SAVED" as const : "RECOMMENDED" as const })),
  ];
  const queries = queryDescriptors.map((item) => item.query);

  const existing = await env.DB
    .prepare(
      `SELECT id, openalex_id, title, abstract, year, provider, external_url, access_status, status, relevance_score, created_at
       FROM discovery_candidates
       ORDER BY relevance_score DESC, created_at ASC`
    )
    .all<{
      id: string;
      openalex_id: string | null;
      title: string;
      abstract: string | null;
      year: number | null;
      provider: string;
      external_url: string | null;
      access_status: DiscoveryAccessStatus | null;
      status: string;
      relevance_score: number;
      created_at: string;
    }>();

  const existingRows = existing.results ?? [];
  const seenExternalIds = new Set(existingRows.map((row) => row.openalex_id ?? row.external_url ?? row.id));
  const activeTitles = new Set(
    existingRows
      .filter((row) => row.status === "KEPT" || row.status === "WATCHED")
      .map((row) => normalizeDiscoveryTitle(row.title))
      .filter(Boolean),
  );

  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const maintenance: D1PreparedStatement[] = [];

  for (const candidate of existingRows) {
    if (candidate.status !== "CANDIDATE") continue;
    const accessStatus = classifyDiscoveryAccess(candidate.provider, candidate.external_url);
    const assessment = assessDiscoveryCandidate({
      provider: candidate.provider,
      title: candidate.title,
      summary: candidate.abstract,
      year: candidate.year,
      accessStatus,
    });
    const titleKey = normalizeDiscoveryTitle(candidate.title);
    const duplicate = Boolean(titleKey && activeTitles.has(titleKey));
    const nextStatus = assessment.accepted && !duplicate ? "CANDIDATE" : "IGNORED";
    if (nextStatus === "CANDIDATE" && titleKey) activeTitles.add(titleKey);
    maintenance.push(
      env.DB
        .prepare("UPDATE discovery_candidates SET status = ?, relevance_score = ?, access_status = ? WHERE id = ?")
        .bind(nextStatus, assessment.score, accessStatus, candidate.id),
    );
  }

  const pending: PendingCandidate[] = [];
  const pendingIds = new Set<string>();
  const addPending = (candidate: PendingCandidate) => {
    if (!candidate.externalId || seenExternalIds.has(candidate.externalId) || pendingIds.has(candidate.externalId)) return;
    pendingIds.add(candidate.externalId);
    pending.push(candidate);
  };

  for (const descriptor of queryDescriptors) {
    const fetchLimit = strengthFetchLimit(descriptor.lane === "ORIGINAL" ? profile.original.strength : profile.counter.strength);
    const providerQuery = discoveryProviderQuery(descriptor.query);
    const openAlexResult = await searchWorks(providerQuery, Math.min(fetchLimit || 1, 6));
    const works: OpenAlexWork[] = openAlexResult.items;
    for (const w of works) {
      if (!w.id || !w.openAccessUrl) continue;
      const accessStatus: DiscoveryAccessStatus = "FREE_FULLTEXT";
      const assessment = assessDiscoveryCandidate({ provider: "openalex", title: w.title, summary: w.abstract, year: w.year, accessStatus });
      if (!assessment.accepted) continue;
      addPending({
        externalId: w.id,
        provider: "openalex",
        title: w.title,
        authors: w.authors ?? null,
        year: w.year,
        abstract: w.abstract,
        score: assessment.score,
        keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
        query: descriptor.query,
        lane: descriptor.lane,
        querySource: descriptor.querySource,
        url: w.openAccessUrl,
        accessStatus,
      });
    }
    if (pending.filter((candidate) => candidate.provider === "openalex").length >= MAX_OPENALEX_CANDIDATES) break;
  }

  const arxivQueries = queryDescriptors.filter((item) => /photograph|visual|image|사진|이미지/i.test(item.query));
  for (const descriptor of arxivQueries) {
    const fetchLimit = strengthFetchLimit(descriptor.lane === "ORIGINAL" ? profile.original.strength : profile.counter.strength);
    const arxivResult = await searchArxiv(discoveryProviderQuery(descriptor.query), Math.min(fetchLimit || 1, 6));
    const works = arxivResult.items;
    for (const w of works) {
      const assessment = assessDiscoveryCandidate({ provider: "arxiv", title: w.title, summary: w.abstract, year: w.year, categories: w.categories, accessStatus: "PDF" });
      if (!assessment.accepted) continue;
      addPending({
        externalId: w.id,
        provider: "arxiv",
        title: w.title,
        authors: w.authors || null,
        year: w.year,
        abstract: w.abstract,
        score: assessment.score,
        keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
        query: `arxiv:${descriptor.query}`,
        lane: descriptor.lane,
        querySource: descriptor.querySource,
        url: w.url,
        accessStatus: "PDF",
      });
    }
  }

  for (const feedUrl of feeds) {
    const feedResult = await fetchFeed(feedUrl, 8);
    const items = feedResult.items;
    for (const item of items) {
      if (!item.url) continue;
      const accessStatus = classifyDiscoveryAccess("rss", item.url);
      const assessment = assessDiscoveryCandidate({ provider: "rss", title: item.title, summary: item.summary, year: item.year, accessStatus });
      if (!assessment.accepted) continue;
      addPending({
        externalId: item.url,
        provider: "rss",
        title: item.title,
        authors: null,
        year: item.year,
        abstract: item.summary,
        score: assessment.score,
        keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
        query: feedUrl.slice(0, 80),
        lane: "ORIGINAL",
        querySource: "FEED",
        url: item.url,
        accessStatus,
      });
    }
  }

  const selected = selectDiscoveryCandidatesByLane(pending, profile.original.strength, profile.counter.strength, divergence, MAX_CANDIDATES_PER_RUN);
  const selectedTitles = new Set(activeTitles);
  let collected = 0;
  for (const candidate of selected) {
    const titleKey = normalizeDiscoveryTitle(candidate.title);
    if (!titleKey || selectedTitles.has(titleKey)) continue;
    selectedTitles.add(titleKey);
    seenExternalIds.add(candidate.externalId);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO discovery_candidates (id, openalex_id, title, authors, year, abstract, relevance_score, status, query_used, created_at, provider, external_url, access_status, discovery_lane, query_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CANDIDATE', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uuid(),
          candidate.externalId,
          candidate.title.slice(0, 300),
          candidate.authors,
          candidate.year,
          candidate.abstract?.slice(0, 4000) ?? null,
          candidate.score,
          candidate.query,
          ts,
          candidate.provider,
          candidate.url,
          candidate.accessStatus,
          candidate.lane,
          candidate.querySource,
        ),
    );
    collected++;
    if (collected >= MAX_CANDIDATES_PER_RUN) break;
  }

  if (maintenance.length || stmts.length) await env.DB.batch([...maintenance, ...stmts]);
  return {
    collected,
    keptExisting: existingRows.filter((row) => row.status === "KEPT" || row.status === "WATCHED" || row.status === "CANDIDATE").length,
    queries,
  };
}
