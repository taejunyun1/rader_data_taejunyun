import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { normalizeDiscoveryTitle, type DiscoveryProfile } from "@radar/shared/discovery";
import {
  assessDiscoveryFieldSignal,
  emptyDiscoveryFieldSignalSourceStats,
  type DiscoveryFieldSignalRejectionReason,
  type DiscoveryFieldSignalRunDiagnostics,
  type DiscoveryFieldSignalRunResult,
  type DiscoveryFieldSignalSourceStats,
  type DiscoveryFieldSignalType,
} from "@radar/shared/fieldSignals";
import type { DiscoveryProviderResult } from "@radar/shared/discoveryRun";
import { uuid } from "../ingestion/ids";
import { fetchFeed, type FeedItem } from "../lib/rss";

const MAX_FIELD_SIGNALS_PER_RUN = 12;
const MAX_FIELD_SIGNALS_PER_SOURCE = 4;
const FIELD_SIGNAL_FEED_FETCH_LIMIT = 12;

export interface DiscoveryFieldSignalSourceInput {
  id: string;
  name: string;
  feedUrl: string;
  topicAnchors: string[];
}

export interface PendingDiscoveryFieldSignal {
  sourceId: string;
  sourceName: string;
  externalUrl: string;
  title: string;
  summary: string | null;
  signalType: DiscoveryFieldSignalType;
  publishedAt: string | null;
  eventAt: string | null;
  deadlineAt: string | null;
  matchedTerms: string[];
  relevanceScore: number;
}

export interface DiscoveryFieldSignalCollectionInput {
  profile: DiscoveryProfile;
  sources: DiscoveryFieldSignalSourceInput[];
  existingUrls: Set<string>;
  now?: Date;
  rss: (url: string, limit: number) => Promise<DiscoveryProviderResult<FeedItem>>;
}

export interface DiscoveryFieldSignalCollectionResult {
  pending: PendingDiscoveryFieldSignal[];
  diagnostics: DiscoveryFieldSignalRunDiagnostics;
}

function countReason(diagnostics: DiscoveryFieldSignalRunDiagnostics, reason: DiscoveryFieldSignalRejectionReason): void {
  diagnostics.rejectedByReason[reason] = (diagnostics.rejectedByReason[reason] ?? 0) + 1;
}

function compareSignals(a: PendingDiscoveryFieldSignal, b: PendingDiscoveryFieldSignal): number {
  if (a.relevanceScore !== b.relevanceScore) return b.relevanceScore - a.relevanceScore;

  const aActionDate = a.deadlineAt ?? a.eventAt;
  const bActionDate = b.deadlineAt ?? b.eventAt;
  if (aActionDate && bActionDate && aActionDate !== bActionDate) return aActionDate.localeCompare(bActionDate);
  if (aActionDate && !bActionDate) return -1;
  if (!aActionDate && bActionDate) return 1;

  const publishedOrder = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
  if (publishedOrder !== 0) return publishedOrder;
  return 0;
}

function normalizedTitleDateKey(item: FeedItem, eventAt: string | null, deadlineAt: string | null): string {
  return `${normalizeDiscoveryTitle(item.title)}|${deadlineAt ?? eventAt ?? item.publishedAt ?? ""}`;
}

export async function collectDiscoveryFieldSignals(
  input: DiscoveryFieldSignalCollectionInput,
): Promise<DiscoveryFieldSignalCollectionResult> {
  const diagnostics: DiscoveryFieldSignalRunDiagnostics = { sources: {}, rejectedByReason: {}, incomplete: false };
  const accepted: PendingDiscoveryFieldSignal[] = [];
  const seenUrls = new Set(input.existingUrls);
  const seenTitleDates = new Set<string>();

  for (const source of input.sources) {
    const stats: DiscoveryFieldSignalSourceStats = emptyDiscoveryFieldSignalSourceStats();
    diagnostics.sources[source.id] = stats;
    stats.requests += 1;

    const result = await input.rss(source.feedUrl, FIELD_SIGNAL_FEED_FETCH_LIMIT);
    if (result.status !== "OK") {
      stats.failedRequests += 1;
      if (result.errorCode && !stats.errorCodes.includes(result.errorCode) && stats.errorCodes.length < 5) {
        stats.errorCodes.push(result.errorCode);
      }
      diagnostics.incomplete = true;
      continue;
    }

    stats.succeededRequests += 1;
    stats.received += result.items.length;

    const sourceAccepted: PendingDiscoveryFieldSignal[] = [];
    for (const item of result.items) {
      if (!item.url) {
        stats.missingUrl += 1;
        countReason(diagnostics, "MISSING_URL");
        continue;
      }

      if (seenUrls.has(item.url)) {
        stats.duplicate += 1;
        countReason(diagnostics, "DUPLICATE");
        continue;
      }

      const assessment = assessDiscoveryFieldSignal({
        title: item.title,
        summary: item.summary,
        publishedAt: item.publishedAt,
        profile: input.profile,
        sourceAnchors: source.topicAnchors,
        now: input.now,
      });

      if (!assessment.accepted) {
        stats.rejected += 1;
        if (assessment.reason === "STALE") stats.stale += 1;
        if (assessment.reason === "EXPIRED") stats.expired += 1;
        if (assessment.reason !== "RELEVANT") countReason(diagnostics, assessment.reason);
        continue;
      }

      const titleDateKey = normalizedTitleDateKey(item, assessment.eventAt, assessment.deadlineAt);
      if (seenTitleDates.has(titleDateKey)) {
        stats.duplicate += 1;
        countReason(diagnostics, "DUPLICATE");
        continue;
      }

      seenUrls.add(item.url);
      seenTitleDates.add(titleDateKey);
      sourceAccepted.push({
        sourceId: source.id,
        sourceName: source.name,
        externalUrl: item.url,
        title: item.title.slice(0, 300),
        summary: item.summary?.slice(0, 1000) ?? null,
        signalType: assessment.signalType,
        publishedAt: item.publishedAt,
        eventAt: assessment.eventAt,
        deadlineAt: assessment.deadlineAt,
        matchedTerms: assessment.matchedTerms,
        relevanceScore: assessment.score,
      });
    }

    sourceAccepted.sort(compareSignals);
    const selectedForSource = sourceAccepted.slice(0, MAX_FIELD_SIGNALS_PER_SOURCE);
    const sourceExcluded = Math.max(0, sourceAccepted.length - selectedForSource.length);
    if (sourceExcluded > 0) {
      stats.quotaExcluded += sourceExcluded;
      for (let index = 0; index < sourceExcluded; index += 1) countReason(diagnostics, "SOURCE_QUOTA");
    }
    accepted.push(...selectedForSource);
  }

  const selected = accepted.slice(0, MAX_FIELD_SIGNALS_PER_RUN);
  const selectedUrls = new Set(selected.map((item) => item.externalUrl));
  for (const item of accepted) {
    const stats = diagnostics.sources[item.sourceId]!;
    if (selectedUrls.has(item.externalUrl)) {
      stats.selected += 1;
      continue;
    }
    stats.quotaExcluded += 1;
    countReason(diagnostics, "SOURCE_QUOTA");
  }

  return { pending: selected, diagnostics };
}

export async function runDiscoveryFieldSignals(
  env: Env,
  profile: DiscoveryProfile,
): Promise<DiscoveryFieldSignalRunResult> {
  const sources = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
    source.autoCollect && source.collection === "RSS" && source.target === "FIELD_SIGNAL" && source.feedUrl
      ? [{ id: source.id, name: source.name, feedUrl: source.feedUrl, topicAnchors: [...source.topicAnchors] }]
      : [],
  );

  const existing = await env.DB
    .prepare("SELECT external_url FROM discovery_field_signals")
    .all<{ external_url: string | null }>();

  const collection = await collectDiscoveryFieldSignals({
    profile,
    sources,
    existingUrls: new Set(
      (existing.results ?? [])
        .map((row) => row.external_url)
        .filter((value): value is string => Boolean(value)),
    ),
    rss: fetchFeed,
  });

  const now = new Date().toISOString();
  const statements = collection.pending.map((item) =>
    env.DB
      .prepare(
        `INSERT OR IGNORE INTO discovery_field_signals
          (id, source_id, external_url, title, summary, signal_type, published_at, event_at, deadline_at,
           matched_terms_json, relevance_score, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)`,
      )
      .bind(
        uuid(),
        item.sourceId,
        item.externalUrl,
        item.title,
        item.summary,
        item.signalType,
        item.publishedAt,
        item.eventAt,
        item.deadlineAt,
        JSON.stringify(item.matchedTerms),
        item.relevanceScore,
        now,
        now,
      ),
  );

  if (statements.length > 0) await env.DB.batch(statements);

  return { collected: collection.pending.length, diagnostics: collection.diagnostics };
}
