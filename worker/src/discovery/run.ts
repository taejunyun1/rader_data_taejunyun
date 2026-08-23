import { searchWorks, type OpenAlexWork } from "../lib/openalex";
import { searchArxiv, type ArxivWork } from "../lib/arxiv";
import { fetchFeed, type FeedItem } from "../lib/rss";
import { uuid } from "../ingestion/ids";
import { DEFAULT_DISCOVERY_FEEDS } from "@radar/shared";
import {
  assessDiscoveryCandidate,
  classifyDiscoveryAccess,
  isUsableDiscoveryQuery,
  normalizeDiscoveryTitle,
  resolveDiscoveryAccessForExisting,
  selectDiscoveryCandidatesByLane,
  strengthFetchLimit,
  type DiscoveryAccessStatus,
  type DiscoveryLane,
  type DiscoveryProfile,
  type DiscoveryQuerySource,
  type SelectableDiscoveryCandidate,
} from "@radar/shared/discovery";
import type {
  DiscoveryProviderResult,
  DiscoveryRunDiagnostics,
  DiscoveryRunResult as SharedDiscoveryRunResult,
} from "@radar/shared/discoveryRun";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";
import { loadDiscoveryProfile } from "./profile";
import { buildDiscoveryQueryPlan } from "./queryPlan";
import { recordCandidateOutcome, recordProviderResult } from "./diagnostics";

const MAX_CANDIDATES_PER_RUN = 8;
const MAX_OPENALEX_CANDIDATES = 10;
const DISCOVERY_QUERIES_KEY = "discovery_queries_v1";
const DISCOVERY_FEEDS_KEY = "discovery_feeds_v1";

export type DiscoveryRunResult = SharedDiscoveryRunResult;

export interface PendingCandidate extends SelectableDiscoveryCandidate {
  authors: string | null;
  year: number | null;
  abstract: string | null;
  query: string;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  url: string | null;
  accessStatus: DiscoveryAccessStatus;
}

export interface DiscoveryProviderClients {
  openalex: (query: string, limit: number) => Promise<DiscoveryProviderResult<OpenAlexWork>>;
  arxiv: (query: string, limit: number) => Promise<DiscoveryProviderResult<ArxivWork>>;
  rss: (feedUrl: string, limit: number) => Promise<DiscoveryProviderResult<FeedItem>>;
}

export interface DiscoveryCollectionInput {
  profile: DiscoveryProfile;
  homepageKeywords: string[];
  momentumKeywords: string[];
  legacyQueries: string[];
  feeds: string[];
  existingExternalIds: Set<string>;
  activeTitles: Set<string>;
  divergence: number;
  clients: DiscoveryProviderClients;
}

export interface DiscoveryCollectionResult {
  pending: PendingCandidate[];
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
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

function recordAssessment(
  diagnostics: DiscoveryRunDiagnostics,
  provider: "openalex" | "arxiv" | "rss",
  assessment: ReturnType<typeof assessDiscoveryCandidate>,
): boolean {
  if (assessment.accepted || assessment.reason === "RELEVANT") return true;
  if (assessment.reason === "PAYWALLED" || assessment.reason === "ACCESS_UNKNOWN") {
    recordCandidateOutcome(diagnostics, provider, { kind: "MISSING_ACCESS", reason: assessment.reason });
  } else {
    recordCandidateOutcome(diagnostics, provider, { kind: "REJECTED", reason: assessment.reason });
  }
  return false;
}

export async function collectDiscoveryCandidates(input: DiscoveryCollectionInput): Promise<DiscoveryCollectionResult> {
  const plan = buildDiscoveryQueryPlan({
    profile: input.profile,
    homepageKeywords: input.homepageKeywords,
    momentumKeywords: input.momentumKeywords,
    legacyQueries: input.legacyQueries,
  });
  const diagnostics = createEmptyDiscoveryDiagnostics();
  diagnostics.plannedQueries = plan.length;
  diagnostics.readyQueries = plan.filter((item) => item.status === "READY").length;
  diagnostics.unsupportedQueries = plan.filter((item) => item.status === "UNSUPPORTED").length;
  const pending: PendingCandidate[] = [];
  const pendingIds = new Set<string>();
  const seenExternalIds = new Set(input.existingExternalIds);
  let openAlexCapReached = false;

  const addPending = (candidate: PendingCandidate): void => {
    if (!candidate.externalId) return;
    if (seenExternalIds.has(candidate.externalId) || pendingIds.has(candidate.externalId)) {
      recordCandidateOutcome(diagnostics, candidate.provider as "openalex" | "arxiv" | "rss", { kind: "DUPLICATE" });
      return;
    }
    if (candidate.provider === "openalex" && (openAlexCapReached || pending.filter((item) => item.provider === "openalex").length >= MAX_OPENALEX_CANDIDATES)) {
      openAlexCapReached = true;
      recordCandidateOutcome(diagnostics, "openalex", { kind: "QUOTA_EXCLUDED" });
      return;
    }
    pendingIds.add(candidate.externalId);
    pending.push(candidate);
    if (candidate.provider === "openalex" && pending.filter((item) => item.provider === "openalex").length >= MAX_OPENALEX_CANDIDATES) {
      openAlexCapReached = true;
    }
  };

  const addOpenAlexItems = (items: OpenAlexWork[], query: (typeof plan)[number]): void => {
    for (const work of items) {
      if (!work.id) continue;
      if (!work.openAccessUrl) {
        recordCandidateOutcome(diagnostics, "openalex", { kind: "MISSING_ACCESS", reason: "ACCESS_UNKNOWN" });
        continue;
      }
      const accessStatus: DiscoveryAccessStatus = "FREE_FULLTEXT";
      const assessment = assessDiscoveryCandidate({ provider: "openalex", title: work.title, summary: work.abstract, year: work.year, accessStatus });
      if (!recordAssessment(diagnostics, "openalex", assessment)) continue;
      addPending({
        externalId: work.id,
        provider: "openalex",
        title: work.title,
        authors: work.authors ?? null,
        year: work.year,
        abstract: work.abstract,
        score: assessment.score,
        keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
        query: query.sourceQuery,
        lane: query.lane,
        querySource: query.querySource,
        url: work.openAccessUrl,
        accessStatus,
      });
    }
  };

  const addArxivItems = (items: ArxivWork[], query: (typeof plan)[number]): void => {
    for (const work of items) {
      if (!work.id) continue;
      const assessment = assessDiscoveryCandidate({ provider: "arxiv", title: work.title, summary: work.abstract, year: work.year, categories: work.categories, accessStatus: "PDF" });
      if (!recordAssessment(diagnostics, "arxiv", assessment)) continue;
      addPending({
        externalId: work.id,
        provider: "arxiv",
        title: work.title,
        authors: work.authors || null,
        year: work.year,
        abstract: work.abstract,
        score: assessment.score,
        keywordOverlap: Math.min(1, assessment.matchedTerms.length / 3),
        query: query.sourceQuery,
        lane: query.lane,
        querySource: query.querySource,
        url: work.url,
        accessStatus: "PDF",
      });
    }
  };

  for (const query of plan.filter((item) => item.selected)) {
    let executed = false;
    const fetchLimit = strengthFetchLimit(query.lane === "ORIGINAL" ? input.profile.original.strength : input.profile.counter.strength);
    for (const provider of query.providers) {
      if (provider === "openalex" && openAlexCapReached) continue;
      executed = true;
      if (provider === "openalex") {
        const result = await input.clients.openalex(query.providerQuery!, Math.min(fetchLimit || 1, 6));
        recordProviderResult(diagnostics, "openalex", result);
        if (result.status === "OK") addOpenAlexItems(result.items, query);
      } else {
        const result = await input.clients.arxiv(query.providerQuery!, Math.min(fetchLimit || 1, 6));
        recordProviderResult(diagnostics, "arxiv", result);
        if (result.status === "OK") addArxivItems(result.items, query);
      }
    }
    if (executed) diagnostics.executedQueries += 1;
  }

  for (const feedUrl of input.feeds) {
    const result = await input.clients.rss(feedUrl, 8);
    recordProviderResult(diagnostics, "rss", result);
    if (result.status !== "OK") continue;
    for (const item of result.items) {
      if (!item.url) {
        recordCandidateOutcome(diagnostics, "rss", { kind: "MISSING_ACCESS", reason: "ACCESS_UNKNOWN" });
        continue;
      }
      const accessStatus = classifyDiscoveryAccess("rss", item.url);
      const assessment = assessDiscoveryCandidate({ provider: "rss", title: item.title, summary: item.summary, year: item.year, accessStatus });
      if (!recordAssessment(diagnostics, "rss", assessment)) continue;
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

  const selected = selectDiscoveryCandidatesByLane(pending, input.profile.original.strength, input.profile.counter.strength, input.divergence, MAX_CANDIDATES_PER_RUN);
  const selectedIds = new Set(selected.map((candidate) => candidate.externalId));
  const selectedTitleKeys = new Set(selected.map((candidate) => normalizeDiscoveryTitle(candidate.title)).filter(Boolean));
  for (const candidate of pending) {
    if (selectedIds.has(candidate.externalId)) continue;
    const titleKey = normalizeDiscoveryTitle(candidate.title);
    if (titleKey && selectedTitleKeys.has(titleKey)) recordCandidateOutcome(diagnostics, candidate.provider as "openalex" | "arxiv" | "rss", { kind: "DUPLICATE" });
    else recordCandidateOutcome(diagnostics, candidate.provider as "openalex" | "arxiv" | "rss", { kind: "QUOTA_EXCLUDED" });
  }

  const selectedTitles = new Set(input.activeTitles);
  const insertable: PendingCandidate[] = [];
  for (const candidate of selected) {
    const titleKey = normalizeDiscoveryTitle(candidate.title);
    if (!titleKey || selectedTitles.has(titleKey)) {
      recordCandidateOutcome(diagnostics, candidate.provider as "openalex" | "arxiv" | "rss", { kind: "DUPLICATE" });
      continue;
    }
    selectedTitles.add(titleKey);
    recordCandidateOutcome(diagnostics, candidate.provider as "openalex" | "arxiv" | "rss", { kind: "SELECTED" });
    insertable.push(candidate);
  }

  return {
    pending: insertable,
    queries: plan.filter((item) => item.selected).map((item) => item.sourceQuery),
    diagnostics,
  };
}

export async function runDiscovery(env: Env, input: number | { divergence: number; profile?: DiscoveryProfile }): Promise<DiscoveryRunResult> {
  const divergence = typeof input === "number" ? input : input.divergence;
  const profile = typeof input === "number" ? await loadDiscoveryProfile(env.DB) : input.profile ?? await loadDiscoveryProfile(env.DB);
  const homepage = await homepageKeywords(env.DB, 2);
  const momentum = await momentumKeywords(env.DB, 4);
  const legacy = await customQueries(env.DB);
  const feeds = await customFeeds(env.DB);
  const plan = buildDiscoveryQueryPlan({ profile, homepageKeywords: homepage, momentumKeywords: momentum, legacyQueries: legacy });
  if (plan.length === 0 && feeds.length === 0) throw new Error("discovery_profile_empty");

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
  const maintenance: D1PreparedStatement[] = [];
  let existingReclassified = 0;
  for (const candidate of existingRows) {
    if (candidate.status !== "CANDIDATE") continue;
    const accessStatus = resolveDiscoveryAccessForExisting(candidate.access_status, candidate.provider, candidate.external_url);
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
    if (nextStatus !== candidate.status) existingReclassified += 1;
    if (nextStatus === "CANDIDATE" && titleKey) activeTitles.add(titleKey);
    maintenance.push(
      env.DB
        .prepare("UPDATE discovery_candidates SET status = ?, relevance_score = ?, access_status = ? WHERE id = ?")
        .bind(nextStatus, assessment.score, accessStatus, candidate.id),
    );
  }

  const collection = await collectDiscoveryCandidates({
    profile,
    homepageKeywords: homepage,
    momentumKeywords: momentum,
    legacyQueries: legacy,
    feeds,
    existingExternalIds: seenExternalIds,
    activeTitles,
    divergence,
    clients: { openalex: searchWorks, arxiv: searchArxiv, rss: fetchFeed },
  });
  collection.diagnostics.existingReclassified = existingReclassified;

  const ts = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const candidate of collection.pending) {
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
  }

  if (maintenance.length || stmts.length) await env.DB.batch([...maintenance, ...stmts]);
  return {
    collected: collection.pending.length,
    keptExisting: existingRows.filter((row) => row.status === "KEPT" || row.status === "WATCHED" || row.status === "CANDIDATE").length,
    queries: collection.queries,
    diagnostics: collection.diagnostics,
  };
}
