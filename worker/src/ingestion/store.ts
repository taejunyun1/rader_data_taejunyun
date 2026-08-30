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
import { normalizeDoi, normalizeUrl, titleNorm } from "./normalize";
import { activateVersion, getActiveVersion } from "./versioning";
import {
  assertSourceDeletionNotClaimed,
  isSourceDeletionClaimError,
} from "../reservoir/deletionClaim";

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

function isPdfFormat(value: InputFormat): boolean {
  return value === "PDF_TEXT" || value === "PDF_SCAN";
}

function pdfSignatureBytes(value: string | ArrayBuffer): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value.slice(0, 1024));
  return new Uint8Array(value.slice(0, 1024));
}

function assertPdfOriginal(input: CreateSourceInput): void {
  const format = input.inputFormat ?? deriveIngestMeta(input.origin, input.filename, input.metadata).format;
  if (!isPdfFormat(format)) return;
  const signature = new TextDecoder().decode(pdfSignatureBytes(input.original));
  if (!signature.startsWith("%PDF-")) throw new Error("PDF_SIGNATURE_INVALID");
}

function originalMetadata(input: CreateSourceInput, sourceId: string, rawContentHash: string): Record<string, string> {
  const format = input.inputFormat ?? deriveIngestMeta(input.origin, input.filename, input.metadata).format;
  const filename = input.filename ? sanitizeFilename(input.filename) : "original";
  return asciiOnly({
    sourceId,
    origin: input.origin,
    sha256: rawContentHash,
    mimeType: input.contentType ?? (isPdfFormat(format) ? "application/pdf" : "application/octet-stream"),
    filename,
  });
}

export async function createSource(env: Env, input: CreateSourceInput): Promise<CreateSourceResult> {
  assertPdfOriginal(input);
  const fileHash = await sha256Hex(input.original);
  // Stage the bytes before identity lookup. This keeps the reservoir's original-first
  // invariant even when the lookup resolves to an existing logical source.
  const stagedOriginalKey = await stageIncomingOriginal(env, input, fileHash);
  let completed = false;

  try {
    const dup = await findDuplicate(env.DB, {
      doi: input.doi ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      title: input.title,
      authors: input.authors ?? null,
      fileHash,
      origin: input.origin,
    });

    if (dup) {
      const existingVersion = await env.DB.prepare(
        "SELECT id, version FROM source_versions WHERE source_id = ? AND raw_content_hash = ? LIMIT 1",
      ).bind(dup.sourceId, fileHash).first<{ id: string; version: number }>();
      if (!existingVersion) {
        const result = await appendReimportedVersion(env, dup.sourceId, input, fileHash, stagedOriginalKey);
        completed = true;
        return result;
      }
      await recordReimport(env, dup.sourceId, dup.field, input.origin);
      const row = await env.DB.prepare("SELECT title, quality_status, active_version_id FROM sources WHERE id = ?")
        .bind(dup.sourceId)
        .first<{ title: string; quality_status: QualityStatus | null; active_version_id: string | null }>();
      const result = {
        sourceId: dup.sourceId,
        duplicateOf: dup.sourceId,
        title: row?.title ?? input.title,
        qualityStatus: row?.quality_status ?? undefined,
        activeVersionId: row?.active_version_id ?? undefined,
      };
      completed = true;
      return result;
    }

  const id = uuid();
  const versionId = uuid();
  const clean = input.filename ? sanitizeFilename(input.filename) : null;
  const r2Key = input.storedOriginal === null ? null : `originals/${id}/v1${clean ? `-${clean}` : ""}`;
  if (r2Key) await copyStagedOriginal(
    env,
    stagedOriginalKey,
    r2Key,
    input.storedOriginal ?? input.original,
    originalMetadata(input, id, fileHash),
  );
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
  const normalizedContentHash = await sha256Hex(normalized.normalizedText);
  const status = text ? "extracted" : "stored";
  const ts = nowIso();

  try {
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
           (id, source_id, version, r2_key, extracted_text, char_count, content_hash, raw_content_hash, normalized_content_hash, normalized_text,
            normalization_status, normalization_report_json, version_origin, review_status, created_at,
            text_scope, extraction_method, extraction_error, content_type, final_url, acquired_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          versionId,
          id,
          r2Key,
          text,
          text.length,
          versionContentHash,
          fileHash,
          normalizedContentHash,
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
      ...identityStatements(env.DB, id, input, fileHash, ts),
    ]);
  } catch (error) {
    if (!isIdentityClaimConflict(error)) throw error;
    const winner = await findDuplicate(env.DB, {
      doi: input.doi ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      title: input.title,
      authors: input.authors ?? null,
      fileHash,
      origin: input.origin,
    });
    if (!winner || winner.sourceId === id) throw error;
    await deleteCreatedOriginals(env, r2Key, previewKey);
    const result = await appendReimportedVersion(env, winner.sourceId, input, fileHash, stagedOriginalKey);
    completed = true;
    return result;
  }

    completed = true;
    return { sourceId: id, duplicateOf: null, title: input.title, qualityStatus, activeVersionId: versionId };
  } finally {
    if (completed) await deleteStagedOriginal(env, stagedOriginalKey);
  }
}

async function appendReimportedVersion(
  env: Env,
  sourceId: string,
  input: CreateSourceInput,
  rawContentHash: string,
  stagedOriginalKey: string | null,
): Promise<CreateSourceResult> {
  assertPdfOriginal(input);
  // This is the source-owned branch of createSource. The initial intake object
  // is intentionally staged before identity lookup, but no source-scoped R2
  // object or D1 version may be created while its owner is being deleted.
  await assertSourceDeletionNotClaimed(env.DB, sourceId);
  const source = await env.DB.prepare("SELECT title FROM sources WHERE id = ?").bind(sourceId).first<{ title: string }>();
  if (!source) throw new Error("source_not_found");
  const row = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM source_versions WHERE source_id = ?")
    .bind(sourceId).first<{ version: number }>();
  const version = (row?.version ?? 0) + 1;
  const versionId = uuid();
  const clean = input.filename ? sanitizeFilename(input.filename) : null;
  const r2Key = input.storedOriginal === null ? null : `originals/${sourceId}/v${version}${clean ? `-${clean}` : ""}`;
  if (r2Key) await copyStagedOriginal(
    env,
    stagedOriginalKey,
    r2Key,
    input.storedOriginal ?? input.original,
    originalMetadata(input, sourceId, rawContentHash),
  );

  const text = (input.extractedText ?? "").slice(0, 500_000);
  const derivedMeta = deriveIngestMeta(input.origin, input.filename, input.metadata);
  const inputFormat = input.inputFormat ?? derivedMeta.format;
  const normalized = normalizeIngestText(text, inputFormat);
  const textScope = input.textScope ?? (text ? "FULLTEXT" : "METADATA_ONLY");
  const extractionMethod = input.extractionMethod ?? (text ? "MANUAL_TEXT" : "DISCOVERY_METADATA");
  const qualityStatus = qualityStatusForTextScope(textScope, normalized.qualityStatus, normalized.report.meaningfulChars);
  const ts = nowIso();
  const normalizedContentHash = await sha256Hex(normalized.normalizedText);
  const versionContentHash = await sha256Hex(text || input.original);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_versions
         (id, source_id, version, r2_key, extracted_text, char_count, content_hash, raw_content_hash, normalized_content_hash, normalized_text,
          normalization_status, normalization_report_json, version_origin, parent_version_id, review_status, created_at,
          text_scope, extraction_method, extraction_error, content_type, final_url, acquired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?,
          (SELECT active_version_id FROM sources WHERE id = ?), 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        versionId, sourceId, version, r2Key, text, text.length, versionContentHash, rawContentHash, normalizedContentHash,
        normalized.normalizedText, JSON.stringify(normalized.report), input.versionOrigin ?? "INITIAL_INGEST", sourceId, ts,
        textScope, extractionMethod, input.extractionError ?? null, input.contentType ?? null, input.finalUrl ?? null, input.acquiredAt ?? ts,
      ),
      env.DB.prepare("UPDATE sources SET origins_json = ?, updated_at = ? WHERE id = ?")
        .bind(await appendOrigin(env.DB, sourceId, input.origin), ts, sourceId),
      env.DB.prepare(
        `INSERT INTO processing_jobs (id, source_id, stage, status, error, retry_count, created_at, updated_at)
         VALUES (?, ?, 'ingest', ?, NULL, 0, ?, ?)`
      ).bind(uuid(), sourceId, text ? "extracted" : "stored", ts, ts),
      env.DB.prepare(
        `INSERT INTO user_signals (id, source_id, action, weight, context, created_at)
         VALUES (?, ?, 'import', 1.0, ?, ?)`
      ).bind(uuid(), sourceId, JSON.stringify({ origin: input.origin, version: versionId }), ts),
      ...identityStatements(env.DB, sourceId, input, rawContentHash, ts, "refresh"),
    ]);
  } catch (error) {
    // A claim can be acquired after the pre-put check but before the batch.
    // The trigger rejects the D1 insert; remove the just-created object so the
    // rejected version cannot leave an orphaned source-scoped R2 key.
    if (isSourceDeletionClaimError(error) && r2Key) {
      try { await env.ORIGINALS.delete(r2Key); } catch { /* best-effort compensation */ }
    }
    throw error;
  }
  await activateVersion(env.DB, sourceId, versionId, qualityStatus, ts);
  return { sourceId, duplicateOf: sourceId, title: source.title, qualityStatus, activeVersionId: versionId };
}

async function stageIncomingOriginal(env: Env, input: CreateSourceInput, rawContentHash: string): Promise<string | null> {
  if (input.storedOriginal === null) return null;
  const key = `originals/_intake/${rawContentHash}`;
  await env.ORIGINALS.put(key, input.storedOriginal ?? input.original, {
    customMetadata: asciiOnly({ origin: input.origin, staged: "true" }),
  });
  return key;
}

async function copyStagedOriginal(
  env: Env,
  stagedKey: string | null,
  targetKey: string,
  value: string | ArrayBuffer,
  metadata: Record<string, string>,
): Promise<void> {
  if (!stagedKey) return;
  await env.ORIGINALS.put(targetKey, value, { customMetadata: metadata });
}

async function deleteStagedOriginal(env: Env, stagedKey: string | null): Promise<void> {
  if (!stagedKey) return;
  try { await env.ORIGINALS.delete(stagedKey); } catch { /* cleanup is best effort */ }
}

async function appendOrigin(db: D1Database, sourceId: string, origin: string): Promise<string> {
  const row = await db.prepare("SELECT origins_json FROM sources WHERE id = ?").bind(sourceId).first<{ origins_json: string | null }>();
  let origins: string[] = [];
  try { origins = row?.origins_json ? JSON.parse(row.origins_json) as string[] : []; } catch { origins = []; }
  if (!origins.includes(origin)) origins.push(origin);
  return JSON.stringify(origins);
}

function identityStatements(
  db: D1Database,
  sourceId: string,
  input: CreateSourceInput,
  rawHash: string,
  createdAt: string,
  mode: "claim" | "refresh" = "claim",
): D1PreparedStatement[] {
  const entries = [
    input.doi ? ["DOI", normalizeDoi(input.doi)] : null,
    input.canonicalUrl ? ["CANONICAL_URL", normalizeUrl(input.canonicalUrl) ?? input.canonicalUrl] : null,
    input.title && input.authors ? ["TITLE_AUTHOR", `${titleNorm(input.title)}::${input.authors.split(/[,;]/)[0]!.trim().toLowerCase()}`] : null,
    ["RAW_HASH", rawHash],
  ].filter((entry): entry is [string, string] => Boolean(entry?.[1]));
  return entries.map(([kind, value]) => db.prepare(
    `${mode === "refresh" ? "INSERT OR IGNORE" : "INSERT"} INTO source_identity_keys (identity_kind, identity_value, source_id, created_at) VALUES (?, ?, ?, ?)`,
  ).bind(kind, value, sourceId, createdAt));
}

function isIdentityClaimConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("source_identity_keys") && message.toLowerCase().includes("unique");
}

async function deleteCreatedOriginals(env: Env, r2Key: string | null, previewKey: string | null): Promise<void> {
  for (const key of [r2Key, previewKey]) {
    if (!key) continue;
    try { await env.ORIGINALS.delete(key); } catch { /* best effort compensation after claim conflict */ }
  }
}

async function recordReimport(env: Env, sourceId: string, field: string, origin: string): Promise<void> {
  await assertSourceDeletionNotClaimed(env.DB, sourceId);
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
  await assertSourceDeletionNotClaimed(db, sourceId);
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
