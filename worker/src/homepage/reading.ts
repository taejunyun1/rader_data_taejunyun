import { analyzeSource } from "../analysis/analyze";
import { findDuplicate } from "../ingestion/dedup";
import { sha256Hex, uuid } from "../ingestion/ids";
import { normalizeUrl } from "../ingestion/normalize";
import { createSource } from "../ingestion/store";

const INPUT_KEY = "homepage-reading/latest.json";
const FINGERPRINT_KEY = "homepage_reading_fingerprint_v1";
const SOURCE_ORIGIN = "homepage-reading";
const MAX_ARTICLES = 36;

interface HomepageReadingArticle {
  id?: unknown;
  title?: unknown;
  source?: unknown;
  author?: unknown;
  url?: unknown;
  publishedAt?: unknown;
  publishedAtSource?: unknown;
  releaseAt?: unknown;
  crawledAt?: unknown;
  summary?: unknown;
  tags?: unknown;
  countries?: unknown;
  languages?: unknown;
  curationLane?: unknown;
  curationScore?: unknown;
  displayRank?: unknown;
  summaryLanguage?: unknown;
  summaryTranslated?: unknown;
}

interface HomepageReadingPayload {
  schemaVersion?: unknown;
  source?: unknown;
  generatedAt?: unknown;
  sourceCommit?: unknown;
  articles?: unknown;
}

interface NormalizedArticle {
  id: string;
  title: string;
  source: string;
  author: string;
  url: string;
  publishedAt: string;
  publishedAtSource: string;
  releaseAt: string;
  crawledAt: string;
  summary: string;
  tags: string[];
  countries: string[];
  languages: string[];
  curationLane: string;
  curationScore: number;
  displayRank: number | null;
  summaryLanguage: string;
  summaryTranslated: boolean;
}

export interface HomepageReadingSyncResult {
  status: "missing" | "unchanged" | "imported" | "failed";
  fingerprint?: string;
  archivedKey?: string;
  received?: number;
  valid?: number;
  created?: number;
  duplicates?: number;
  analyzed?: number;
  failed?: number;
  error?: string;
}

export async function syncHomepageReading(env: Env): Promise<HomepageReadingSyncResult> {
  const object = await env.ORIGINALS.get(INPUT_KEY);
  if (!object) return { status: "missing", error: INPUT_KEY };

  const raw = await object.text();
  let payload: HomepageReadingPayload;
  try {
    payload = JSON.parse(raw) as HomepageReadingPayload;
  } catch {
    return { status: "failed", error: "invalid_json" };
  }

  if (payload.schemaVersion !== 1 || payload.source !== "homepage_artist" || !Array.isArray(payload.articles)) {
    return { status: "failed", error: "invalid_payload" };
  }

  const articles = payload.articles
    .slice(0, MAX_ARTICLES)
    .map((article) => normalizeArticle(article as HomepageReadingArticle))
    .filter((article): article is NormalizedArticle => article !== null);
  if (!articles.length) return { status: "failed", received: payload.articles.length, error: "no_valid_articles" };

  const fingerprint = await sha256Hex(
    JSON.stringify(
      articles
        .map(({ id, title, source, author, url, publishedAt, publishedAtSource, summary, tags }) => ({
          id,
          title,
          source,
          author,
          url,
          publishedAt,
          publishedAtSource,
          summary,
          tags,
        }))
        .sort((a, b) => a.url.localeCompare(b.url))
    )
  );
  const previous = await env.DB.prepare("SELECT value FROM kv WHERE key = ?")
    .bind(FINGERPRINT_KEY)
    .first<{ value: string }>();
  if (previous?.value === fingerprint) {
    return { status: "unchanged", fingerprint, received: payload.articles.length, valid: articles.length };
  }

  const archivedKey = `homepage-reading/imports/${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${fingerprint.slice(0, 16)}.json`;
  await env.ORIGINALS.put(archivedKey, raw, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: "homepage_artist",
      fingerprint,
      generatedAt: String(payload.generatedAt ?? ""),
      sourceCommit: String(payload.sourceCommit ?? ""),
    },
  });

  let created = 0;
  let duplicates = 0;
  let analyzed = 0;
  let failed = 0;

  for (const article of articles) {
    try {
      const existing = await findDuplicate(env.DB, {
        canonicalUrl: article.url,
        title: article.title,
        authors: article.author || null,
      });
      if (existing) {
        duplicates++;
        if (await analyzeIfNeeded(env, existing.sourceId)) analyzed++;
        continue;
      }

      const result = await createSource(env, {
        kind: "WEB",
        title: article.title,
        authors: article.author || undefined,
        year: article.publishedAt ? Number(article.publishedAt.slice(0, 4)) || undefined : undefined,
        canonicalUrl: article.url,
        origin: SOURCE_ORIGIN,
        original: JSON.stringify(article),
        extractedText: articleText(article),
        metadata: {
          provider: "homepage_artist",
          source: article.source,
          publishedAt: article.publishedAt,
          publishedAtSource: article.publishedAtSource,
          releaseAt: article.releaseAt,
          crawledAt: article.crawledAt,
          tags: article.tags,
          countries: article.countries,
          languages: article.languages,
          curationLane: article.curationLane,
          curationScore: article.curationScore,
          displayRank: article.displayRank,
          summaryLanguage: article.summaryLanguage,
          summaryTranslated: article.summaryTranslated,
          snapshotKey: archivedKey,
        },
      });

      if (result.duplicateOf) {
        duplicates++;
        if (await analyzeIfNeeded(env, result.sourceId)) analyzed++;
        continue;
      }

      created++;
      if (await analyzeIfNeeded(env, result.sourceId)) analyzed++;
      else failed++;
    } catch (err) {
      failed++;
      console.error(
        JSON.stringify({
          level: "error",
          scope: "cron:homepage-reading:item",
          url: article.url,
          message: (err as Error).message,
        })
      );
    }
  }

  if (failed > 0) {
    return { status: "failed", fingerprint, archivedKey, received: payload.articles.length, valid: articles.length, created, duplicates, analyzed, failed, error: "partial_import" };
  }

  const ts = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(FINGERPRINT_KEY, fingerprint, ts)
    .run();

  return { status: "imported", fingerprint, archivedKey, received: payload.articles.length, valid: articles.length, created, duplicates, analyzed, failed };
}

async function analyzeIfNeeded(env: Env, sourceId: string): Promise<boolean> {
  const job = await env.DB.prepare("SELECT status FROM processing_jobs WHERE source_id = ?")
    .bind(sourceId)
    .first<{ status: string }>();
  if (job?.status === "indexed") return false;
  const analysis = await analyzeSource(env, sourceId);
  return analysis.status === "analyzed";
}

function normalizeArticle(raw: HomepageReadingArticle): NormalizedArticle | null {
  const title = stringValue(raw.title, 300);
  const url = typeof raw.url === "string" ? normalizeUrl(raw.url) : null;
  if (!title || !url) return null;

  return {
    id: stringValue(raw.id, 180) || `homepage-reading-${url}`,
    title,
    source: stringValue(raw.source, 120),
    author: stringValue(raw.author, 180),
    url,
    publishedAt: stringValue(raw.publishedAt, 40),
    publishedAtSource: stringValue(raw.publishedAtSource, 40) || "unknown",
    releaseAt: stringValue(raw.releaseAt, 40),
    crawledAt: stringValue(raw.crawledAt, 60),
    summary: stringValue(raw.summary, 1000),
    tags: stringArray(raw.tags, 24, 64),
    countries: stringArray(raw.countries, 8, 16),
    languages: stringArray(raw.languages, 8, 16),
    curationLane: stringValue(raw.curationLane, 40),
    curationScore: numberValue(raw.curationScore),
    displayRank: raw.displayRank == null ? null : numberValue(raw.displayRank),
    summaryLanguage: stringValue(raw.summaryLanguage, 20),
    summaryTranslated: raw.summaryTranslated === true,
  };
}

function articleText(article: NormalizedArticle): string {
  return [
    article.title,
    article.source ? `Source: ${article.source}` : "",
    article.author ? `Author: ${article.author}` : "",
    article.summary,
    article.tags.length ? `Tags: ${article.tags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function stringValue(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
