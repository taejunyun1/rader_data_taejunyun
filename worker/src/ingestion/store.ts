import type { Reliability, SourceKind } from "@radar/shared";
import {
  deriveIngestMeta,
  normalizeIngestText,
  type ExtractionMethod,
  type IngestChannel,
  type InputFormat,
  type QualityStatus,
  type TextScope,
  type VersionOrigin,
} from "@radar/shared/ingestion";
import { findDuplicate } from "./dedup";
import { uuid, sha256Hex } from "./ids";
import { titleNorm } from "./normalize";

export interface CreateSourceInput {
  kind: SourceKind;
  title: string;
  authors?: string;
  year?: number;
  canonicalUrl?: string;
  doi?: string;
  origin: string;
  original: string | ArrayBuffer;
  storedOriginal?: string | ArrayBuffer | null;
  preview?: { data: ArrayBuffer; contentType: string };
  extractedText?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  ingestChannel?: IngestChannel;
  inputFormat?: InputFormat;
  versionOrigin?: VersionOrigin;
  textScope?: TextScope;
  extractionMethod?: ExtractionMethod;
  extractionError?: string | null;
  contentType?: string | null;
  finalUrl?: string | null;
  acquiredAt?: string | null;
}

export interface CreateSourceResult {
  sourceId: string;
  duplicateOf: string | null;
  title: string;
  qualityStatus?: QualityStatus;
  activeVersionId?: string;
}

export type IngestProcessingStatus = "received" | "stored" | "extracted" | "analyzed" | "indexed" | "failed";

export const RELIABILITY_BY_KIND: Record<SourceKind, Reliability> = {
  PERSONAL_WORK: "PRIMARY",
  PERSONAL_TEXT: "PRIMARY",
  NOTE: "PRIMARY",
  PAPER_ACADEMIC: "PRIMARY",
  BOOK_ARTICLE: "SECONDARY",
  ARTIST_ARTWORK: "SECONDARY",
  TECHNICAL: "PRIMARY",
  WEB: "DISCOVERY",
  DISCOVERY: "DISCOVERY",
};

const nowIso = () => new Date().toISOString();

function qualityStatusForTextScope(scope: TextScope, normalizedStatus: QualityStatus, meaningfulChars: number): QualityStatus {
  if (scope === "EMPTY") return "EMPTY";
  if (scope === "PARTIAL" || scope === "METADATA_ONLY") return meaningfulChars > 0 ? "REVIEW" : "EMPTY";
  return normalizedStatus;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function asciiOnly(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/^[\x20-\x7E]*$/.test(v)) out[k] = v.slice(0, 500);
  }
  return out;
}

export async function createSource(env: Env, input: CreateSourceInput): Promise<CreateSourceResult> {
  const fileHash = await sha256Hex(input.original);

  const dup = await findDuplicate(env.DB, {
    doi: input.doi ?? null,
    canonicalUrl: input.canonicalUrl ?? null,
    title: input.title,
    authors: input.authors ?? null,
    fileHash,
  });

  if (dup) {
    await recordReimport(env, dup.sourceId, dup.field, input.origin);
    const row = await env.DB.prepare("SELECT title, quality_status, active_version_id FROM sources WHERE id = ?")
      .bind(dup.sourceId)
      .first<{ title: string; quality_status: QualityStatus | null; active_version_id: string | null }>();
    return {
      sourceId: dup.sourceId,
      duplicateOf: dup.sourceId,
      title: row?.title ?? input.title,
      qualityStatus: row?.quality_status ?? undefined,
      activeVersionId: row?.active_version_id ?? undefined,
    };
  }

  const id = uuid();
  const versionId = uuid();
  const clean = input.filename ? sanitizeFilename(input.filename) : null;
  const r2Key = input.storedOriginal === null ? null : `originals/${id}/v1${clean ? `-${clean}` : ""}`;
  if (r2Key) await env.ORIGINALS.put(r2Key, input.storedOriginal ?? input.original, {
    customMetadata: asciiOnly({ sourceId: id, origin: input.origin }),
  });
  const previewKey = input.preview ? `previews/${id}/v1.jpg` : null;
  if (previewKey && input.preview) await env.ORIGINALS.put(previewKey, input.preview.data, { httpMetadata: { contentType: input.preview.contentType } });

  const text = (input.extractedText ?? "").slice(0, 500_000);
  const derivedMeta = deriveIngestMeta(input.origin, input.filename, input.metadata);
  const ingestChannel = input.ingestChannel ?? derivedMeta.channel;
  const inputFormat = input.inputFormat ?? derivedMeta.format;
  const normalized = normalizeIngestText(text, inputFormat);
  const textScope = input.textScope ?? (text ? "FULLTEXT" : "METADATA_ONLY");
  const extractionMethod = input.extractionMethod ?? (text ? "MANUAL_TEXT" : "DISCOVERY_METADATA");
  const qualityStatus = qualityStatusForTextScope(textScope, normalized.qualityStatus, normalized.report.meaningfulChars);
  const versionContentHash = await sha256Hex(text || input.original);
  const status = text ? "extracted" : "stored";
  const ts = nowIso();

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO sources
         (id, kind, title, title_norm, authors, year, canonical_url, doi, file_hash,
          reliability, provenance_class, status, origin, origins_json, r2_key, metadata_json,
          ingest_channel, input_format, active_version_id, quality_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SOURCE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.kind,
        input.title,
        titleNorm(input.title),
        input.authors ?? null,
        input.year ?? null,
        input.canonicalUrl ?? null,
        input.doi ?? null,
        fileHash,
        RELIABILITY_BY_KIND[input.kind] ?? "DISCOVERY",
        status,
        input.origin,
        JSON.stringify([input.origin]),
        r2Key,
        JSON.stringify({ ...(input.metadata ?? {}), ...(previewKey ? { previewKey } : {}), ...(input.storedOriginal === null ? { originalDiscarded: true } : {}) }),
        ingestChannel,
        inputFormat,
        versionId,
        qualityStatus,
        ts,
        ts
      ),
    env.DB
      .prepare(
        `INSERT INTO source_versions
         (id, source_id, version, r2_key, extracted_text, char_count, content_hash, normalized_text,
          normalization_status, normalization_report_json, version_origin, review_status, created_at,
          text_scope, extraction_method, extraction_error, content_type, final_url, acquired_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'READY', ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        versionId,
        id,
        r2Key,
        text,
        text.length,
        versionContentHash,
        normalized.normalizedText,
        JSON.stringify(normalized.report),
        input.versionOrigin ?? "INITIAL_INGEST",
        ts,
        textScope,
        extractionMethod,
        input.extractionError ?? null,
        input.contentType ?? null,
        input.finalUrl ?? null,
        input.acquiredAt ?? ts,
      ),
    env.DB
      .prepare(
        `INSERT INTO processing_jobs (id, source_id, stage, status, error, retry_count, created_at, updated_at)
         VALUES (?, ?, 'ingest', ?, NULL, 0, ?, ?)`
      )
      .bind(uuid(), id, status, ts, ts),
    env.DB
      .prepare(
        `INSERT INTO user_signals (id, source_id, action, weight, context, created_at)
         VALUES (?, ?, 'import', 1.0, ?, ?)`
      )
      .bind(uuid(), id, JSON.stringify({ origin: input.origin }), ts),
  ]);

  return { sourceId: id, duplicateOf: null, title: input.title, qualityStatus, activeVersionId: versionId };
}

async function recordReimport(env: Env, sourceId: string, field: string, origin: string): Promise<void> {
  const ts = nowIso();
  const row = await env.DB.prepare("SELECT origins_json FROM sources WHERE id = ?")
    .bind(sourceId)
    .first<{ origins_json: string | null }>();
  let origins: string[] = [];
  try {
    origins = row?.origins_json ? (JSON.parse(row.origins_json) as string[]) : [];
  } catch {
    origins = [];
  }
  if (!origins.includes(origin)) origins.push(origin);

  await env.DB.batch([
    env.DB.prepare("UPDATE sources SET origins_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(origins), ts, sourceId),
    env.DB
      .prepare(
        `INSERT INTO user_signals (id, source_id, action, weight, context, created_at)
         VALUES (?, ?, 'import', 1.0, ?, ?)`
      )
      .bind(uuid(), sourceId, JSON.stringify({ origin, dedup: field }), ts),
  ]);
}

export async function updateIngestJob(
  db: D1Database,
  sourceId: string,
  status: IngestProcessingStatus,
  error: string | null,
): Promise<void> {
  const now = nowIso();
  const existing = await db.prepare(
    "SELECT id FROM processing_jobs WHERE source_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  ).bind(sourceId).first<{ id: string }>();

  if (existing?.id) {
    await db.prepare(
      "UPDATE processing_jobs SET stage = 'acquisition', status = ?, error = ?, updated_at = ? WHERE id = ?",
    ).bind(status, error, now, existing.id).run();
    return;
  }

  await db.prepare(
    `INSERT INTO processing_jobs (id, source_id, stage, status, error, retry_count, created_at, updated_at)
     VALUES (?, ?, 'acquisition', ?, ?, 0, ?, ?)`,
  ).bind(uuid(), sourceId, status, error, now, now).run();
}
