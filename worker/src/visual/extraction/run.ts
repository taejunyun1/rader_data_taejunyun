import type { InputFormat } from "@radar/shared/ingestion";
import { extensionForVisualType } from "../contracts";
import { analyzeVisualVersionBytes } from "../analyzer";
import { enqueueResearchJob } from "../../jobs/enqueue";
import { sha256Hex, uuid } from "../../ingestion/ids";
import { inspectHtmlVisualCandidates } from "./html";
import { fetchRemoteImage, RemoteImageFetchError } from "./fetchImage";
import { buildLinkOnlyVisualDraft, filterVisualCandidate, unavailableVisualDecision, type ExistingVisualFingerprint } from "./filter";
import { ExtractionStore } from "./store";
import { buildPdfVisionPrompt, parsePdfPageCandidates, type PdfPageCandidate } from "./pdf";

const HTML_CANDIDATE_LIMIT = 40;
const HTML_FETCH_LIMIT = 12;
const PDF_PAGE_LIMIT = 40;

type SourceKind = "HTML" | "PDF";

export interface VisualExtractionDiagnostics {
  sourceKind: SourceKind;
  limits: {
    htmlCandidates: number;
    htmlFetch: number;
    pdfPages: number;
  };
  blocked: {
    htmlCandidates: number;
    htmlFetch: number;
    pdfPages: number;
  };
}

export interface VisualExtractionRunResult {
  sourceId: string;
  sourceVersionId: string;
  extractionRunId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  counts: {
    selected: number;
    review: number;
    filtered: number;
    unavailable: number;
  };
  diagnostics: VisualExtractionDiagnostics;
}

export interface RunVisualExtractionInput {
  sourceId: string;
  sourceVersionId: string;
  extractionRunId?: string;
}

export interface LoadedSourceForExtraction {
  sourceId: string;
  sourceVersionId: string;
  inputFormat: InputFormat;
  extractionMethod: string | null;
  origin: string | null;
  title: string | null;
  canonicalUrl: string | null;
  finalUrl: string | null;
  r2Key: string | null;
  extractedText: string | null;
}

interface ExtractionUnitRow {
  unitNumber: number;
  candidateKey: string;
  status: string;
  tempR2Key: string | null;
  width: number | null;
  height: number | null;
  contentHash: string | null;
}

interface HtmlExtractionCandidate {
  candidateKey: string;
  sourceUrl: string;
  caption: string | null;
  figureLabel: string | null;
  nearbyText: string | null;
  signals: string[];
}

export interface RunnerDeps {
  loadSource: (env: Env, input: RunVisualExtractionInput) => Promise<LoadedSourceForExtraction>;
  runHtmlExtraction: (env: Env, input: RunVisualExtractionInput, source: LoadedSourceForExtraction) => Promise<VisualExtractionRunResult>;
  runPdfExtraction: (env: Env, input: RunVisualExtractionInput, source: LoadedSourceForExtraction) => Promise<VisualExtractionRunResult>;
}

export async function runVisualExtraction(
  env: Env,
  input: RunVisualExtractionInput,
  deps: RunnerDeps = {
    loadSource: loadSourceForExtraction,
    runHtmlExtraction: runHtmlVisualExtraction,
    runPdfExtraction: runPdfVisualExtraction,
  },
): Promise<VisualExtractionRunResult> {
  const source = await deps.loadSource(env, input);
  if (isPdfFormat(source.inputFormat)) {
    return deps.runPdfExtraction(env, input, source);
  }
  return deps.runHtmlExtraction(env, input, source);
}

async function loadSourceForExtraction(env: Env, input: RunVisualExtractionInput): Promise<LoadedSourceForExtraction> {
  const row = await env.DB.prepare(
    `SELECT s.id AS sourceId,
            s.active_version_id AS sourceVersionId,
            s.input_format AS inputFormat,
            s.origin,
            s.title,
            s.canonical_url AS canonicalUrl,
            v.extraction_method AS extractionMethod,
            v.final_url AS finalUrl,
            v.r2_key AS r2Key,
            v.extracted_text AS extractedText
     FROM sources s
     LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id = ? AND s.active_version_id = ?`
  ).bind(input.sourceId, input.sourceVersionId).first<LoadedSourceForExtraction>();
  if (!row) throw new Error("visual_extraction_source_not_found");
  if (row.inputFormat !== "URL_HTML" && !isPdfFormat(row.inputFormat)) {
    throw new Error("visual_extraction_source_unsupported");
  }
  return row;
}

async function runHtmlVisualExtraction(env: Env, input: RunVisualExtractionInput, source: LoadedSourceForExtraction): Promise<VisualExtractionRunResult> {
  const run = await ExtractionStore.createOrResumeRun(env.DB, {
    parentSourceId: source.sourceId,
    parentVersionId: source.sourceVersionId,
    originKind: "WEB_EMBED",
  });
  await markRunRunning(env.DB, run.id);

  const diagnostics: VisualExtractionDiagnostics = {
    sourceKind: "HTML",
    limits: { htmlCandidates: HTML_CANDIDATE_LIMIT, htmlFetch: HTML_FETCH_LIMIT, pdfPages: PDF_PAGE_LIMIT },
    blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
  };
  const counts = { selected: 0, review: 0, filtered: 0, unavailable: 0 };

  if (!source.r2Key) {
    await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status: "SUCCEEDED" });
    return { sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, extractionRunId: run.id, status: "SUCCEEDED", counts, diagnostics };
  }

  const object = await env.ORIGINALS.get(source.r2Key);
  if (!object) throw new Error("visual_extraction_original_missing");
  const html = await object.text();
  const inspected = inspectHtmlVisualCandidates(html, source.finalUrl ?? source.canonicalUrl ?? "https://example.invalid");
  const candidates = inspected.candidates.slice(0, HTML_CANDIDATE_LIMIT) as HtmlExtractionCandidate[];
  diagnostics.blocked.htmlCandidates = Math.max(inspected.candidates.length - candidates.length, 0);
  const queued = candidates.slice(0, HTML_FETCH_LIMIT);
  diagnostics.blocked.htmlFetch = Math.max(candidates.length - queued.length, 0);
  const existingAssets = await loadExistingFingerprints(env.DB, source.sourceVersionId);
  let failedUnits = 0;

  for (const [index, candidate] of queued.entries()) {
    const unitNumber = index + 1;
    await ExtractionStore.recordUnit(env.DB, {
      runId: run.id,
      unitNumber,
      candidateKey: candidate.candidateKey,
    });
    await ExtractionStore.markUnitProcessed(env.DB, {
      runId: run.id,
      unitNumber,
      candidateKey: candidate.candidateKey,
      status: "PROCESSING",
    });

    try {
      const fetched = await fetchRemoteImage(candidate.sourceUrl);
      const decision = filterVisualCandidate({
        contentHash: fetched.contentHash,
        perceptualHash: null,
        caption: candidate.caption,
        nearbyText: candidate.nearbyText,
        signals: candidate.signals,
        existingAssets,
      });
      applyDecisionCount(counts, decision.selectionStatus);
      await persistHtmlLinkOnlyVisual(env, source, {
        candidate,
        fetched,
        decision,
      });
      existingAssets.push({ assetId: `${candidate.candidateKey}:${fetched.contentHash}`, contentHash: fetched.contentHash, perceptualHash: null });
      await ExtractionStore.markUnitProcessed(env.DB, {
        runId: run.id,
        unitNumber,
        candidateKey: candidate.candidateKey,
        status: "SUCCEEDED",
        width: null,
        height: null,
        contentHash: fetched.contentHash,
      });
    } catch (error) {
      failedUnits += 1;
      counts.unavailable += 1;
      const errorCode = error instanceof RemoteImageFetchError ? error.code : "visual_candidate_failed";
      await ExtractionStore.markUnitProcessed(env.DB, {
        runId: run.id,
        unitNumber,
        candidateKey: candidate.candidateKey,
        status: "FAILED",
        errorCode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const status = failedUnits > 0 ? "PARTIAL" : "SUCCEEDED";
  await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status });
  return { sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, extractionRunId: run.id, status, counts, diagnostics };
}

async function runPdfVisualExtraction(env: Env, input: RunVisualExtractionInput, source: LoadedSourceForExtraction): Promise<VisualExtractionRunResult> {
  const run = input.extractionRunId
    ? await ensureExistingRun(env.DB, input.extractionRunId)
    : await ExtractionStore.createOrResumeRun(env.DB, {
      parentSourceId: source.sourceId,
      parentVersionId: source.sourceVersionId,
      originKind: "PDF_PAGE_CROP",
    });
  await markRunRunning(env.DB, run.id);

  const diagnostics: VisualExtractionDiagnostics = {
    sourceKind: "PDF",
    limits: { htmlCandidates: HTML_CANDIDATE_LIMIT, htmlFetch: HTML_FETCH_LIMIT, pdfPages: PDF_PAGE_LIMIT },
    blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
  };
  const counts = { selected: 0, review: 0, filtered: 0, unavailable: 0 };
  const units = (await listExtractionUnits(env.DB, run.id)).filter((unit) => unit.status !== "DELETED");
  const queuedUnits = units.slice(0, PDF_PAGE_LIMIT);
  diagnostics.blocked.pdfPages = Math.max(units.length - queuedUnits.length, 0);
  const rightsStatus = pdfRightsStatus(source.origin);
  const rightsBasis = rightsStatus === "UNKNOWN" ? "pdf_rights_unknown_requires_link_only" : "source_pdf_permitted_for_capsule";
  let failedUnits = 0;

  for (const unit of queuedUnits) {
    await ExtractionStore.markUnitProcessed(env.DB, {
      runId: run.id,
      unitNumber: unit.unitNumber,
      candidateKey: unit.candidateKey,
      status: "PROCESSING",
      width: unit.width,
      height: unit.height,
      contentHash: unit.contentHash,
    });

    let pageFailed = false;
    try {
      if (!unit.tempR2Key) throw new Error("visual_page_bytes_missing");
      const object = await env.ORIGINALS.get(unit.tempR2Key);
      if (!object) throw new Error("visual_page_bytes_missing");
      const pageBytes = await object.arrayBuffer();
      const rawCandidates = await detectPdfPageCandidates(env, pageBytes, source, unit);
      const parsed = parsePdfPageCandidates(rawCandidates);
      counts.filtered += parsed.rejected.length;

      for (const [index, candidate] of parsed.accepted.entries()) {
        try {
          if (rightsStatus === "UNKNOWN") {
            counts.review += 1;
            await persistPdfLinkOnlyVisual(env, source, unit, candidate, pageBytes, rightsStatus, rightsBasis);
          } else {
            const selectionStatus = candidate.caption?.trim() ? "SELECTED" : "REVIEW";
            if (selectionStatus === "SELECTED") counts.selected += 1;
            else counts.review += 1;
            await persistPdfTransformCandidate(env, source, unit, candidate, pageBytes, rightsStatus, rightsBasis, index);
          }
        } catch {
          pageFailed = true;
          counts.unavailable += 1;
        }
      }

      await env.ORIGINALS.delete(unit.tempR2Key).catch(() => undefined);
    } catch (error) {
      pageFailed = true;
      counts.unavailable += 1;
      failedUnits += 1;
      await ExtractionStore.markUnitProcessed(env.DB, {
        runId: run.id,
        unitNumber: unit.unitNumber,
        candidateKey: unit.candidateKey,
        status: "FAILED",
        errorCode: error instanceof Error ? error.message.slice(0, 100) : "visual_page_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (pageFailed) failedUnits += 1;
    await ExtractionStore.markUnitProcessed(env.DB, {
      runId: run.id,
      unitNumber: unit.unitNumber,
      candidateKey: unit.candidateKey,
      status: pageFailed ? "FAILED" : "SUCCEEDED",
      width: unit.width,
      height: unit.height,
      contentHash: unit.contentHash,
      ...(pageFailed ? { errorCode: "pdf_page_partial", error: "one_or_more_page_candidates_failed" } : {}),
    });
  }

  const status = failedUnits > 0 ? "PARTIAL" : "SUCCEEDED";
  await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status });
  return { sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, extractionRunId: run.id, status, counts, diagnostics };
}

function isPdfFormat(value: InputFormat): value is "PDF_TEXT" | "PDF_SCAN" {
  return value === "PDF_TEXT" || value === "PDF_SCAN";
}

async function markRunRunning(db: D1Database, runId: string): Promise<void> {
  await db.prepare("UPDATE visual_extraction_runs SET status = 'RUNNING', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), runId)
    .run();
}

async function ensureExistingRun(db: D1Database, runId: string): Promise<{ id: string }> {
  const row = await db.prepare("SELECT id FROM visual_extraction_runs WHERE id = ?").bind(runId).first<{ id: string }>();
  if (!row) throw new Error("visual_extraction_run_not_found");
  return row;
}

async function listExtractionUnits(db: D1Database, runId: string): Promise<ExtractionUnitRow[]> {
  const rows = await db.prepare(
    `SELECT unit_number AS unitNumber,
            candidate_key AS candidateKey,
            status,
            temp_r2_key AS tempR2Key,
            width,
            height,
            content_hash AS contentHash
     FROM visual_extraction_units
     WHERE run_id = ?
     ORDER BY unit_number ASC`
  ).bind(runId).all<ExtractionUnitRow>();
  return rows.results ?? [];
}

async function loadExistingFingerprints(db: D1Database, parentVersionId: string): Promise<ExistingVisualFingerprint[]> {
  const rows = await db.prepare(
    `SELECT id AS assetId, content_hash AS contentHash, perceptual_hash AS perceptualHash
     FROM visual_assets
     WHERE parent_version_id = ? AND deleted_at IS NULL`
  ).bind(parentVersionId).all<ExistingVisualFingerprint>();
  return rows.results ?? [];
}

function applyDecisionCount(
  counts: VisualExtractionRunResult["counts"],
  selectionStatus: "SELECTED" | "REVIEW" | "DECORATIVE" | "DUPLICATE" | "UNAVAILABLE",
): void {
  if (selectionStatus === "SELECTED") counts.selected += 1;
  else if (selectionStatus === "REVIEW") counts.review += 1;
  else if (selectionStatus === "UNAVAILABLE") counts.unavailable += 1;
  else counts.filtered += 1;
}

async function persistHtmlLinkOnlyVisual(
  env: Env,
  source: LoadedSourceForExtraction,
  input: {
    candidate: HtmlExtractionCandidate;
    fetched: Awaited<ReturnType<typeof fetchRemoteImage>>;
    decision: ReturnType<typeof filterVisualCandidate>;
  },
): Promise<void> {
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "WEB_EMBED", input.candidate.candidateKey);
  const draft = buildLinkOnlyVisualDraft({
    parentSourceId: source.sourceId,
    parentVersionId: source.sourceVersionId,
    originKind: "WEB_EMBED",
    candidateKey: input.candidate.candidateKey,
    sourceUrl: input.candidate.sourceUrl,
    finalUrl: input.fetched.finalUrl,
    figureLabel: input.candidate.figureLabel,
    caption: input.candidate.caption,
    nearbyText: input.candidate.nearbyText,
    contentType: input.fetched.contentType,
    byteSize: input.fetched.byteSize,
    contentHash: input.fetched.contentHash,
    rightsStatus: "UNKNOWN",
    rightsBasis: "external_image_requires_rights_review",
    decision: input.decision,
  });
  const persisted = existing ?? await persistLinkOnlyDraft(env.DB, draft);
  await analyzeVisualVersionBytes(env, {
    visualAssetId: persisted.assetId,
    visualVersionId: persisted.versionId,
    bytes: input.fetched.body,
    filename: `${persisted.assetId}.${extensionForVisualType(input.fetched.contentType, "asset")}`,
    mimeType: input.fetched.contentType,
    width: null,
    height: null,
    caption: input.candidate.caption,
    storageState: "LINK_ONLY",
  });
}

async function persistPdfLinkOnlyVisual(
  env: Env,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  candidate: PdfPageCandidate,
  pageBytes: ArrayBuffer,
  rightsStatus: "UNKNOWN" | "RESTRICTED" | "PUBLIC_LINK",
  rightsBasis: string,
): Promise<void> {
  const candidateKey = buildPdfCandidateKey(unit.unitNumber, candidate, 0);
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "PDF_PAGE_CROP", candidateKey);
  const contentHash = await sha256Hex(pageBytes);
  const draft = buildLinkOnlyVisualDraft({
    parentSourceId: source.sourceId,
    parentVersionId: source.sourceVersionId,
    originKind: "PDF_PAGE_CROP",
    candidateKey,
    sourceUrl: source.finalUrl ?? source.canonicalUrl ?? `source:${source.sourceId}`,
    finalUrl: source.finalUrl ?? source.canonicalUrl ?? `source:${source.sourceId}`,
    figureLabel: candidate.figureLabel,
    caption: candidate.caption,
    nearbyText: buildPdfNearbyText(unit.unitNumber, candidate),
    pageNumber: unit.unitNumber,
    bboxJson: JSON.stringify({ ...candidate.bbox, page: unit.unitNumber }),
    contentType: "image/webp",
    byteSize: pageBytes.byteLength,
    contentHash,
    rightsStatus,
    rightsBasis,
    decision: {
      selectionStatus: "REVIEW",
      selectionReason: "visual-filter-v1:pdf_link_only_rights_review",
      ruleVersion: "visual-filter-v1",
      duplicateOf: null,
    },
  });
  const persisted = existing ?? await persistLinkOnlyDraft(env.DB, draft);
  await analyzeVisualVersionBytes(env, {
    visualAssetId: persisted.assetId,
    visualVersionId: persisted.versionId,
    bytes: pageBytes,
    filename: `page-${unit.unitNumber}.webp`,
    mimeType: "image/webp",
    width: unit.width,
    height: unit.height,
    caption: candidate.caption,
    storageState: "LINK_ONLY",
  });
}

async function persistPdfTransformCandidate(
  env: Env,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  candidate: PdfPageCandidate,
  pageBytes: ArrayBuffer,
  rightsStatus: "PERMITTED" | "PERSONAL",
  rightsBasis: string,
  index: number,
): Promise<void> {
  const candidateKey = buildPdfCandidateKey(unit.unitNumber, candidate, index);
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "PDF_PAGE_CROP", candidateKey);
  if (existing) return;

  const assetId = uuid();
  const versionId = uuid();
  const now = new Date().toISOString();
  const contentHash = await sha256Hex(pageBytes);
  const extension = extensionForVisualType("image/webp", `page-${unit.unitNumber}.webp`);
  const r2Key = `visuals/${assetId}/original/1.${extension}`;
  await env.ORIGINALS.put(r2Key, pageBytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: { visualAssetId: assetId, variant: "ORIGINAL", source: "PDF_PAGE_CROP" },
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO visual_assets
         (id, parent_source_id, parent_version_id, origin_kind, source_url, page_number, figure_label, bbox_json,
          candidate_key, caption, nearby_text, asset_role, visual_kind, selection_status, selection_reason,
          rights_status, rights_basis, rights_reviewed_at, is_personal_work, assignment_status, storage_state,
          pending_storage_state, processing_status, last_error, content_hash, perceptual_hash, perceptual_hash_method,
          created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, 'PDF_PAGE_CROP', ?, ?, ?, ?, ?, ?, ?, 'REFERENCE', 'OTHER', ?, ?, ?, ?, ?, 0, 'ASSIGNED', 'ARCHIVAL', 'CAPSULE', 'TRANSFORM_PENDING', NULL, ?, NULL, NULL, ?, ?, NULL)`
      ).bind(
        assetId,
        source.sourceId,
        source.sourceVersionId,
        source.finalUrl ?? source.canonicalUrl,
        unit.unitNumber,
        candidate.figureLabel,
        JSON.stringify({ ...candidate.bbox, page: unit.unitNumber }),
        candidateKey,
        candidate.caption,
        buildPdfNearbyText(unit.unitNumber, candidate),
        candidate.caption?.trim() ? "SELECTED" : "REVIEW",
        candidate.caption?.trim() ? "visual-filter-v1:selected_contextual_match" : "visual-filter-v1:needs_context_review",
        rightsStatus,
        rightsBasis,
        now,
        contentHash,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO visual_asset_versions
         (id, visual_asset_id, version, variant, r2_key, mime_type, width, height, byte_size, content_hash, parent_asset_version_id, created_at)
         VALUES (?, ?, 1, 'ORIGINAL', ?, 'image/webp', ?, ?, ?, ?, NULL, ?)`
      ).bind(versionId, assetId, r2Key, unit.width, unit.height, pageBytes.byteLength, contentHash, now),
    ]);
  } catch (error) {
    await env.ORIGINALS.delete(r2Key).catch(() => undefined);
    throw error;
  }

  await enqueueResearchJob(env, { kind: "VISUAL_TRANSFORM", input: { visualAssetId: assetId } }, "system:visual-extraction");
}

async function persistLinkOnlyDraft(
  db: D1Database,
  draft: ReturnType<typeof buildLinkOnlyVisualDraft>,
): Promise<{ assetId: string; versionId: string }> {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO visual_assets
       (id, parent_source_id, parent_version_id, origin_kind, source_url, page_number, figure_label, bbox_json,
        candidate_key, caption, nearby_text, asset_role, visual_kind, selection_status, selection_reason,
        rights_status, rights_basis, rights_reviewed_at, is_personal_work, assignment_status, storage_state,
        pending_storage_state, processing_status, last_error, content_hash, perceptual_hash, perceptual_hash_method,
        created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      draft.asset.id,
      draft.asset.parentSourceId,
      draft.asset.parentVersionId,
      draft.asset.originKind,
      draft.asset.sourceUrl,
      draft.asset.pageNumber,
      draft.asset.figureLabel,
      draft.asset.bboxJson,
      draft.asset.candidateKey,
      draft.asset.caption,
      draft.asset.nearbyText,
      draft.asset.assetRole,
      draft.asset.visualKind,
      draft.asset.selectionStatus,
      draft.asset.selectionReason,
      draft.asset.rightsStatus,
      draft.asset.rightsBasis,
      draft.asset.rightsReviewedAt,
      draft.asset.assignmentStatus,
      draft.asset.storageState,
      draft.asset.pendingStorageState,
      draft.asset.processingStatus,
      draft.asset.lastError,
      draft.asset.contentHash,
      draft.asset.perceptualHash,
      draft.asset.perceptualHashMethod,
      draft.asset.createdAt,
      draft.asset.updatedAt,
      draft.asset.deletedAt,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO visual_asset_versions
       (id, visual_asset_id, version, variant, r2_key, mime_type, width, height, byte_size, content_hash, parent_asset_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      draft.originalVersion.id,
      draft.originalVersion.visualAssetId,
      draft.originalVersion.version,
      draft.originalVersion.variant,
      draft.originalVersion.r2Key,
      draft.originalVersion.mimeType,
      draft.originalVersion.width,
      draft.originalVersion.height,
      draft.originalVersion.byteSize,
      draft.originalVersion.contentHash,
      draft.originalVersion.parentAssetVersionId,
      draft.asset.createdAt,
    ),
    ...draft.relations.map((relation) => db.prepare(
      `INSERT OR IGNORE INTO visual_relations
       (id, from_visual_asset_id, to_visual_asset_id, related_source_id, related_thread_id, relation_kind, created_by, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      relation.id,
      draft.asset.id,
      relation.toVisualAssetId,
      relation.relatedSourceId,
      relation.relatedThreadId,
      relation.relationKind,
      relation.createdBy,
      relation.description,
      relation.createdAt,
    )),
  ]);
  return { assetId: draft.asset.id, versionId: draft.originalVersion.id };
}

async function findExistingCandidate(
  db: D1Database,
  parentVersionId: string,
  originKind: "WEB_EMBED" | "PDF_PAGE_CROP",
  candidateKey: string,
): Promise<{ assetId: string; versionId: string } | null> {
  const row = await db.prepare(
    `SELECT a.id AS assetId,
            v.id AS versionId
     FROM visual_assets a
     LEFT JOIN visual_asset_versions v
       ON v.visual_asset_id = a.id
      AND v.variant = 'ORIGINAL'
      AND v.deleted_at IS NULL
     WHERE a.parent_version_id = ?
       AND a.origin_kind = ?
       AND a.candidate_key = ?
       AND a.deleted_at IS NULL
     LIMIT 1`
  ).bind(parentVersionId, originKind, candidateKey).first<{ assetId: string; versionId: string | null }>();
  if (!row?.assetId || !row.versionId) return null;
  return { assetId: row.assetId, versionId: row.versionId };
}

function pdfRightsStatus(origin: string | null): "PERMITTED" | "PERSONAL" | "UNKNOWN" {
  if (origin?.startsWith("homepage")) return "PERSONAL";
  if (origin?.startsWith("discovery:")) return "UNKNOWN";
  return "PERMITTED";
}

async function detectPdfPageCandidates(
  env: Env,
  pageBytes: ArrayBuffer,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
): Promise<PdfPageCandidate[]> {
  if (!env.AI?.run || !env.MODEL_VISION) {
    return [fallbackPdfCandidate(unit)];
  }

  try {
    const prompt = buildPdfVisionPrompt({
      title: source.title,
      pageNumber: unit.unitNumber,
      figureContext: extractPdfFigureContext(source.extractedText, unit.unitNumber),
    });
    const image = `data:image/webp;base64,${base64(pageBytes)}`;
    const result = await env.AI.run(env.MODEL_VISION, {
      messages: [
        { role: "system", content: "You are a careful PDF-page visual extraction assistant. Output only valid JSON." },
        { role: "user", content: prompt },
      ],
      image,
      max_tokens: 1800,
    } as unknown as Record<string, unknown>);
    const parsed = parsePdfCandidateResponse(responseText(result));
    return parsed.length ? parsed : [fallbackPdfCandidate(unit)];
  } catch {
    return [fallbackPdfCandidate(unit)];
  }
}

function fallbackPdfCandidate(unit: ExtractionUnitRow): PdfPageCandidate {
  return {
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    visualKind: "DOCUMENT_SCAN",
    figureLabel: null,
    caption: `page ${unit.unitNumber}`,
    reason: "full_page_fallback",
    confidence: 0.4,
  };
}

function extractPdfFigureContext(text: string | null, pageNumber: number): Array<{ figureLabel: string | null; caption: string | null }> {
  if (!text?.trim()) return [];
  const pageText = extractPageText(text, pageNumber);
  const figureLines = pageText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(figure|fig\.?|plate)/i.test(line));
  return figureLines.slice(0, 6).map((line) => ({ figureLabel: line.match(/^(figure|fig\.?|plate)\s*\d+/i)?.[0] ?? null, caption: line }));
}

function extractPageText(text: string, pageNumber: number): string {
  const marker = new RegExp(`\\[page\\s+${pageNumber}\\]`, "i");
  const nextMarker = new RegExp(`\\[page\\s+${pageNumber + 1}\\]`, "i");
  const start = text.search(marker);
  if (start === -1) return "";
  const rest = text.slice(start);
  const end = rest.search(nextMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

function buildPdfCandidateKey(pageNumber: number, candidate: PdfPageCandidate, index: number): string {
  const label = [candidate.figureLabel, candidate.caption, candidate.visualKind].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `page-${pageNumber}-${label || "candidate"}-${index}`;
}

function buildPdfNearbyText(pageNumber: number, candidate: PdfPageCandidate): string {
  return [`page ${pageNumber}`, candidate.figureLabel, candidate.caption, candidate.reason].filter(Boolean).join(" | ");
}

function parsePdfCandidateResponse(text: string): PdfPageCandidate[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(extractJsonBlock(text)) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown[] }).candidates)
        ? (parsed as { candidates: unknown[] }).candidates
        : [];
    return list.map(toPdfCandidate).filter((candidate): candidate is PdfPageCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function toPdfCandidate(value: unknown): PdfPageCandidate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bbox = record.bbox as Record<string, unknown> | undefined;
  if (!bbox) return null;
  if (typeof bbox.x !== "number" || typeof bbox.y !== "number" || typeof bbox.width !== "number" || typeof bbox.height !== "number") return null;
  const visualKind = typeof record.visualKind === "string" ? record.visualKind : "DOCUMENT_SCAN";
  if (!["PHOTO", "ARTWORK", "INSTALLATION", "GRAPHIC", "DIAGRAM", "DOCUMENT_SCAN", "DECORATIVE"].includes(visualKind)) return null;
  return {
    bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
    visualKind: visualKind as PdfPageCandidate["visualKind"],
    figureLabel: typeof record.figureLabel === "string" ? record.figureLabel : null,
    caption: typeof record.caption === "string" ? record.caption : null,
    reason: typeof record.reason === "string" ? record.reason : "candidate",
    confidence: typeof record.confidence === "number" ? Math.min(Math.max(record.confidence, 0), 1) : 0.5,
  };
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return codeBlock?.trim() || trimmed;
}

function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["response", "result", "description", "text"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function base64(bytes: ArrayBuffer): string {
  const input = new Uint8Array(bytes);
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    output += String.fromCharCode(...input.subarray(offset, Math.min(offset + chunkSize, input.length)));
  }
  return btoa(output);
}
