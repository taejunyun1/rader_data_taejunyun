import type { InputFormat } from "@radar/shared/ingestion";
import { extensionForVisualType } from "../contracts";
import { analyzeVisualVersionBytes } from "../analyzer";
import { cropVisualBytes } from "../transform";
import { imageDHash } from "../perceptualHash";
import { enqueueResearchJob } from "../../jobs/enqueue";
import { sha256Hex, uuid } from "../../ingestion/ids";
import { inspectHtmlVisualCandidates } from "./html";
import { fetchRemoteImage, RemoteImageFetchError } from "./fetchImage";
import { buildLinkOnlyVisualDraft, filterVisualCandidate, unavailableVisualDecision, type ExistingVisualFingerprint } from "./filter";
import { createVisualExtractionVisionPersistence, ExtractionStore } from "./store";
import { buildPdfVisionPrompt, parsePdfPageCandidates, type PdfPageCandidate } from "./pdf";
import { withAiCallLedger } from "../../lib/aiCallLedger";
import {
  createVisualExtractionVisionGate,
  isVisualExtractionVisionBlocked,
  type VisualExtractionVisionBlockReason,
  type VisualExtractionVisionDiagnostics,
  type VisualExtractionVisionGate,
} from "./visionBudget";

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
  vision: VisualExtractionVisionDiagnostics;
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
  outcomeCounts: {
    duplicateExact: number;
    duplicateNear: number;
    rightsGated: number;
    cleanupFailures: number;
  };
  diagnostics: VisualExtractionDiagnostics;
}

export interface RunVisualExtractionInput {
  sourceId: string;
  sourceVersionId: string;
  extractionRunId?: string;
  researchJobId?: string;
  onProgress?: (progress: number, message: string) => Promise<void>;
  visionGate?: VisualExtractionVisionGate;
  visionBudget?: {
    budgetReserved: boolean;
    reservationUsd: number;
    reservationId?: string | null;
    researchJobId?: string | null;
  };
}

async function reportExtractionProgress(input: RunVisualExtractionInput, progress: number, message: string): Promise<void> {
  if (!input.onProgress) return;
  try {
    await input.onProgress(progress, message);
  } catch (error) {
    console.warn(JSON.stringify({
      level: "warn",
      stage: "progress-update",
      sourceId: input.sourceId,
      versionId: input.sourceVersionId,
      errorCode: "visual_extraction_progress_update_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
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

export function shouldProcessPdfExtractionUnit(status: string): boolean {
  return status !== "SUCCEEDED" && status !== "DELETED";
}

export function shouldProcessHtmlExtractionUnit(status: string): boolean {
  return status !== "SUCCEEDED" && status !== "DELETED";
}

export function selectHtmlRetryCandidates<T extends { candidateKey: string }, U extends { candidateKey: string; status: string }>(
  candidates: T[],
  units: U[],
): T[] {
  const retryableKeys = new Set(units.filter((unit) => shouldProcessHtmlExtractionUnit(unit.status)).map((unit) => unit.candidateKey));
  return candidates.filter((candidate) => retryableKeys.has(candidate.candidateKey));
}

export function shouldDeletePdfPageTemp(status: "SUCCEEDED" | "FAILED"): boolean {
  return status === "SUCCEEDED";
}

export async function deletePdfExtractionUnitTemp(
  env: Env,
  input: {
    runId: string;
    unitNumber: number;
    candidateKey: string;
    tempR2Key: string;
    deletedAt?: string;
  },
): Promise<void> {
  await env.ORIGINALS.delete(input.tempR2Key);
  await ExtractionStore.markUnitProcessed(env.DB, {
    runId: input.runId,
    unitNumber: input.unitNumber,
    candidateKey: input.candidateKey,
    status: "DELETED",
    processedAt: input.deletedAt,
  });
}

export function shouldPersistPdfTransform(selectionStatus: string): boolean {
  return selectionStatus === "SELECTED" || selectionStatus === "REVIEW";
}

export function decidePdfVisualCandidate(input: {
  pageNumber: number;
  candidate: PdfPageCandidate;
  contentHash: string;
  perceptualHash: string;
  existingAssets: ExistingVisualFingerprint[];
}): ReturnType<typeof filterVisualCandidate> {
  return filterVisualCandidate({
    contentHash: input.contentHash,
    perceptualHash: input.perceptualHash,
    caption: input.candidate.caption,
    nearbyText: buildPdfNearbyText(input.pageNumber, input.candidate),
    signals: [],
    existingAssets: input.existingAssets,
  });
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
  const runInput = input.visionGate || input.visionBudget
    ? input
    : { ...input, visionGate: createVisualExtractionVisionGate({ budgetReserved: false, reservationUsd: 0 }) };
  const source = await deps.loadSource(env, runInput);
  if (isPdfFormat(source.inputFormat)) {
    return deps.runPdfExtraction(env, runInput, source);
  }
  return deps.runHtmlExtraction(env, runInput, source);
}

function emptyOutcomeCounts(): VisualExtractionRunResult["outcomeCounts"] {
  return {
    duplicateExact: 0,
    duplicateNear: 0,
    rightsGated: 0,
    cleanupFailures: 0,
  };
}

export function summarizePersistedExtraction(input: {
  assets: Array<{ selectionStatus: string; selectionReason: string; rightsStatus: string }>;
  units: Array<{ status: string }>;
}): {
  counts: VisualExtractionRunResult["counts"];
  outcomeCounts: Pick<VisualExtractionRunResult["outcomeCounts"], "duplicateExact" | "duplicateNear" | "rightsGated">;
} {
  const counts = { selected: 0, review: 0, filtered: 0, unavailable: 0 };
  let duplicateExact = 0;
  let duplicateNear = 0;
  let rightsGated = 0;
  for (const asset of input.assets) {
    if (asset.selectionStatus === "SELECTED") counts.selected += 1;
    else if (asset.selectionStatus === "REVIEW") counts.review += 1;
    else if (asset.selectionStatus === "UNAVAILABLE") counts.unavailable += 1;
    else counts.filtered += 1;
    if (asset.selectionReason.includes("duplicate_exact")) duplicateExact += 1;
    if (asset.selectionReason.includes("duplicate_near")) duplicateNear += 1;
    if (asset.rightsStatus !== "PERSONAL" && asset.rightsStatus !== "PERMITTED") rightsGated += 1;
  }
  counts.unavailable = Math.max(counts.unavailable, input.units.filter((unit) => unit.status === "FAILED").length);
  return { counts, outcomeCounts: { duplicateExact, duplicateNear, rightsGated } };
}

export function mergeVisualExtractionDiagnostics(
  previous: VisualExtractionDiagnostics | null,
  current: VisualExtractionDiagnostics,
): VisualExtractionDiagnostics {
  if (!previous || previous.sourceKind !== current.sourceKind) return current;
  return {
    sourceKind: current.sourceKind,
    limits: {
      htmlCandidates: Math.max(previous.limits.htmlCandidates, current.limits.htmlCandidates),
      htmlFetch: Math.max(previous.limits.htmlFetch, current.limits.htmlFetch),
      pdfPages: Math.max(previous.limits.pdfPages, current.limits.pdfPages),
    },
    blocked: {
      htmlCandidates: Math.max(previous.blocked.htmlCandidates, current.blocked.htmlCandidates),
      htmlFetch: Math.max(previous.blocked.htmlFetch, current.blocked.htmlFetch),
      pdfPages: Math.max(previous.blocked.pdfPages, current.blocked.pdfPages),
    },
    vision: {
      callLimit: Math.max(previous.vision.callLimit, current.vision.callLimit),
      reservationUsd: Math.max(previous.vision.reservationUsd, current.vision.reservationUsd),
      budgetReserved: previous.vision.budgetReserved || current.vision.budgetReserved,
      budgetBlocked: previous.vision.budgetBlocked || current.vision.budgetBlocked,
      attempted: previous.vision.attempted + current.vision.attempted,
      completed: previous.vision.completed + current.vision.completed,
      failed: previous.vision.failed + current.vision.failed,
      blocked: previous.vision.blocked + current.vision.blocked,
      capBlocked: previous.vision.capBlocked + current.vision.capBlocked,
    },
  };
}

function applyOutcomeCount(
  outcomeCounts: VisualExtractionRunResult["outcomeCounts"],
  decision: { selectionReason: string },
): void {
  if (decision.selectionReason.includes("duplicate_exact")) outcomeCounts.duplicateExact += 1;
  if (decision.selectionReason.includes("duplicate_near")) outcomeCounts.duplicateNear += 1;
}

function logVisualExtractionDiagnostic(input: {
  level: "warn" | "error" | "info";
  runId: string;
  sourceId: string;
  versionId: string;
  stage: string;
  unit?: number;
  errorCode?: string;
  counts: VisualExtractionRunResult["counts"];
  outcomeCounts: VisualExtractionRunResult["outcomeCounts"];
}): void {
  const logger = input.level === "error" ? console.error : input.level === "warn" ? console.warn : console.log;
  logger(JSON.stringify({
    level: input.level,
    scope: "visual-extraction",
    runId: input.runId,
    sourceId: input.sourceId,
    versionId: input.versionId,
    unit: input.unit,
    stage: input.stage,
    errorCode: input.errorCode ?? null,
    counts: input.counts,
    outcomeCounts: input.outcomeCounts,
  }));
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
  const run = input.extractionRunId
    ? await ensureExistingRun(env.DB, input.extractionRunId, {
      parentSourceId: source.sourceId,
      parentVersionId: source.sourceVersionId,
      originKind: "WEB_EMBED",
    })
    : await ExtractionStore.createOrResumeRun(env.DB, {
      parentSourceId: source.sourceId,
      parentVersionId: source.sourceVersionId,
      originKind: "WEB_EMBED",
    });
  await markRunRunning(env.DB, run.id);
  await initializeExtractionVisionGate(env, input, run.id);
  await reportExtractionProgress(input, 35, "시각 후보 판독 중");

  const diagnostics: VisualExtractionDiagnostics = {
    sourceKind: "HTML",
    limits: { htmlCandidates: HTML_CANDIDATE_LIMIT, htmlFetch: HTML_FETCH_LIMIT, pdfPages: PDF_PAGE_LIMIT },
    blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
    vision: extractionVisionGate(input).snapshot(),
  };
  const counts = { selected: 0, review: 0, filtered: 0, unavailable: 0 };
  const outcomeCounts = emptyOutcomeCounts();

  const existingUnits = input.extractionRunId
    ? (await listExtractionUnits(env.DB, run.id)).filter((unit) => shouldProcessHtmlExtractionUnit(unit.status))
    : [];

  if (!source.r2Key || (input.extractionRunId && existingUnits.length === 0)) {
    await extractionVisionGate(input).refresh();
    await reconcileCumulativeExtractionState(env.DB, run.id, source, counts, outcomeCounts, diagnostics);
    await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status: "SUCCEEDED" });
    return {
      sourceId: source.sourceId,
      sourceVersionId: source.sourceVersionId,
      extractionRunId: run.id,
      status: "SUCCEEDED",
      counts,
      outcomeCounts,
      diagnostics,
    };
  }

  const object = await env.ORIGINALS.get(source.r2Key);
  if (!object) throw new Error("visual_extraction_original_missing");
  const html = await object.text();
  const inspected = inspectHtmlVisualCandidates(html, source.finalUrl ?? source.canonicalUrl ?? "https://example.invalid");
  const candidates = inspected.candidates as HtmlExtractionCandidate[];
  const retryCandidates = input.extractionRunId
    ? selectHtmlRetryCandidates(candidates, existingUnits)
    : candidates.slice(0, HTML_CANDIDATE_LIMIT).slice(0, HTML_FETCH_LIMIT);
  if (!input.extractionRunId) {
    diagnostics.blocked.htmlCandidates = Math.max(candidates.length - HTML_CANDIDATE_LIMIT, 0);
    diagnostics.blocked.htmlFetch = Math.max(Math.min(candidates.length, HTML_CANDIDATE_LIMIT) - HTML_FETCH_LIMIT, 0);
  }
  const existingAssets = await loadExistingFingerprints(env.DB, source.sourceVersionId);
  let failedUnits = 0;
  let filterProgressReported = false;

  const retryCandidateByKey = new Map(retryCandidates.map((candidate) => [candidate.candidateKey, candidate]));
  const queued = input.extractionRunId
    ? existingUnits.map((unit) => ({ unitNumber: unit.unitNumber, candidateKey: unit.candidateKey, candidate: retryCandidateByKey.get(unit.candidateKey) ?? null }))
    : retryCandidates.map((candidate, index) => ({ unitNumber: index + 1, candidateKey: candidate.candidateKey, candidate }));

  for (const queuedUnit of queued) {
    const { unitNumber, candidate } = queuedUnit;
    if (!candidate) {
      failedUnits += 1;
      counts.unavailable += 1;
      if (input.extractionRunId) {
        await ExtractionStore.markUnitProcessed(env.DB, {
          runId: run.id,
          unitNumber,
          candidateKey: queuedUnit.candidateKey,
          status: "FAILED",
          errorCode: "visual_candidate_not_found_on_retry",
          error: "candidate_missing_from_immutable_source_version",
        });
      }
      continue;
    }

    if (!input.extractionRunId) {
      await ExtractionStore.recordUnit(env.DB, {
        runId: run.id,
        unitNumber,
        candidateKey: candidate.candidateKey,
      });
    }
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
      if (!filterProgressReported) {
        filterProgressReported = true;
        await reportExtractionProgress(input, 60, "중복·장식 필터 중");
      }
      applyDecisionCount(counts, decision.selectionStatus);
      applyOutcomeCount(outcomeCounts, decision);
      outcomeCounts.rightsGated += 1;
      const visionFallback = await persistHtmlLinkOnlyVisual(env, source, {
        candidate,
        fetched,
        decision,
        researchJobId: input.researchJobId,
      }, extractionVisionGate(input));
      if (visionFallback) adjustDecisionCountToReview(counts, decision.selectionStatus);
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
      logVisualExtractionDiagnostic({
        level: "warn",
        runId: run.id,
        sourceId: source.sourceId,
        versionId: source.sourceVersionId,
        unit: unitNumber,
        stage: "candidate-fetch",
        errorCode,
        counts,
        outcomeCounts,
      });
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
  await reportExtractionProgress(input, 80, "도판 Capsule 정리 중");
  diagnostics.vision = await extractionVisionGate(input).refresh();
  await reconcileCumulativeExtractionState(env.DB, run.id, source, counts, outcomeCounts, diagnostics);
  await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status });
  logVisualExtractionDiagnostic({
    level: "info",
    runId: run.id,
    sourceId: source.sourceId,
    versionId: source.sourceVersionId,
    stage: "complete",
    counts,
    outcomeCounts,
  });
  return { sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, extractionRunId: run.id, status, counts, outcomeCounts, diagnostics };
}

async function runPdfVisualExtraction(env: Env, input: RunVisualExtractionInput, source: LoadedSourceForExtraction): Promise<VisualExtractionRunResult> {
  const run = input.extractionRunId
    ? await ensureExistingRun(env.DB, input.extractionRunId, {
      parentSourceId: source.sourceId,
      parentVersionId: source.sourceVersionId,
      originKind: "PDF_PAGE_CROP",
    })
    : await ExtractionStore.createOrResumeRun(env.DB, {
      parentSourceId: source.sourceId,
      parentVersionId: source.sourceVersionId,
      originKind: "PDF_PAGE_CROP",
    });
  await markRunRunning(env.DB, run.id);
  await initializeExtractionVisionGate(env, input, run.id);
  await reportExtractionProgress(input, 35, "시각 후보 판독 중");

  const diagnostics: VisualExtractionDiagnostics = {
    sourceKind: "PDF",
    limits: { htmlCandidates: HTML_CANDIDATE_LIMIT, htmlFetch: HTML_FETCH_LIMIT, pdfPages: PDF_PAGE_LIMIT },
    blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
    vision: extractionVisionGate(input).snapshot(),
  };
  const counts = { selected: 0, review: 0, filtered: 0, unavailable: 0 };
  const outcomeCounts = emptyOutcomeCounts();
  const units = (await listExtractionUnits(env.DB, run.id)).filter((unit) => shouldProcessPdfExtractionUnit(unit.status));
  const queuedUnits = units.slice(0, PDF_PAGE_LIMIT);
  diagnostics.blocked.pdfPages = Math.max(units.length - queuedUnits.length, 0);
  const rights = pdfRightsForSource(source.origin);
  const rightsStatus = rights.rightsStatus;
  const rightsBasis = rights.rightsBasis;
  const existingAssets = await loadExistingFingerprints(env.DB, source.sourceVersionId);
  let failedUnits = 0;
  let filterProgressReported = false;

  for (const [unitIndex, unit] of queuedUnits.entries()) {
    if (unitIndex === 0 || unitIndex === queuedUnits.length - 1 || unitIndex % 5 === 0) {
      const progress = 35 + Math.round((unitIndex / Math.max(queuedUnits.length, 1)) * 20);
      await reportExtractionProgress(input, progress, `시각 후보 판독 중 · ${unit.unitNumber}/${units.length}쪽`);
    }
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
      const rawCandidates = await detectPdfPageCandidates(env, pageBytes, source, unit, extractionVisionGate(input), input.researchJobId);
      const parsed = parsePdfPageCandidates(rawCandidates);
      counts.filtered += parsed.rejected.length;
      if (!filterProgressReported) {
        filterProgressReported = true;
        await reportExtractionProgress(input, 60, "중복·장식 필터 중");
      }

      for (const [index, candidate] of parsed.accepted.entries()) {
        try {
          const crop = await cropVisualBytes(env, pageBytes, candidate.bbox);
          const contentHash = await sha256Hex(crop.bytes);
          const perceptualHash = await imageDHash(env, crop.bytes);
          const filteredDecision = decidePdfVisualCandidate({
            pageNumber: unit.unitNumber,
            candidate,
            contentHash,
            perceptualHash,
            existingAssets,
          });
          const decision = extractionFallbackDecision(candidate, filteredDecision);
          applyDecisionCount(counts, decision.selectionStatus);
          applyOutcomeCount(outcomeCounts, decision);
          let persisted: { assetId: string };
          if (isLinkOnlyPdfRights(rightsStatus)) {
            outcomeCounts.rightsGated += 1;
            const linkOnly = await persistPdfLinkOnlyVisual(
              env,
              source,
              unit,
              candidate,
              crop,
              rightsStatus,
              rightsBasis,
              decision,
              index,
              contentHash,
              perceptualHash,
              extractionVisionGate(input),
              input.researchJobId,
            );
            persisted = linkOnly;
            if (linkOnly.visionFallback) adjustDecisionCountToReview(counts, decision.selectionStatus);
          } else if (!rightsBasis) {
            throw new Error("pdf_archival_rights_basis_missing");
          } else if (shouldPersistPdfTransform(decision.selectionStatus)) {
            persisted = await persistPdfTransformCandidate(env, source, unit, candidate, crop, rightsStatus, rightsBasis, index, decision, contentHash, perceptualHash);
          } else {
            persisted = await persistPdfDuplicateMetadata(env, source, unit, candidate, rightsStatus, rightsBasis, index, decision, contentHash, perceptualHash);
          }
          existingAssets.push({ assetId: persisted.assetId, contentHash, perceptualHash });
        } catch {
          pageFailed = true;
          counts.unavailable += 1;
          logVisualExtractionDiagnostic({
            level: "warn",
            runId: run.id,
            sourceId: source.sourceId,
            versionId: source.sourceVersionId,
            unit: unit.unitNumber,
            stage: "candidate-transform",
            errorCode: "visual_candidate_failed",
            counts,
            outcomeCounts,
          });
        }
      }

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
      logVisualExtractionDiagnostic({
        level: "warn",
        runId: run.id,
        sourceId: source.sourceId,
        versionId: source.sourceVersionId,
        unit: unit.unitNumber,
        stage: "page-load",
        errorCode: error instanceof Error ? error.message.slice(0, 100) : "visual_page_failed",
        counts,
        outcomeCounts,
      });
      continue;
    }

    if (pageFailed) {
      failedUnits += 1;
      await ExtractionStore.markUnitProcessed(env.DB, {
        runId: run.id,
        unitNumber: unit.unitNumber,
        candidateKey: unit.candidateKey,
        status: "FAILED",
        width: unit.width,
        height: unit.height,
        contentHash: unit.contentHash,
        errorCode: "pdf_page_partial",
        error: "one_or_more_page_candidates_failed",
      });
      continue;
    }

    await ExtractionStore.markUnitProcessed(env.DB, {
      runId: run.id,
      unitNumber: unit.unitNumber,
      candidateKey: unit.candidateKey,
      status: "SUCCEEDED",
      width: unit.width,
      height: unit.height,
      contentHash: unit.contentHash,
    });
    if (unit.tempR2Key && shouldDeletePdfPageTemp("SUCCEEDED")) {
      await deletePdfExtractionUnitTemp(env, {
        runId: run.id,
        unitNumber: unit.unitNumber,
        candidateKey: unit.candidateKey,
        tempR2Key: unit.tempR2Key,
      }).catch((error) => {
        outcomeCounts.cleanupFailures += 1;
        logVisualExtractionDiagnostic({
          level: "warn",
          runId: run.id,
          sourceId: source.sourceId,
          versionId: source.sourceVersionId,
          unit: unit.unitNumber,
          stage: "temp-cleanup",
          errorCode: "visual_temp_cleanup_failed",
          counts,
          outcomeCounts,
        });
        return error;
      });
    }
  }

  const status = failedUnits > 0 ? "PARTIAL" : "SUCCEEDED";
  await reportExtractionProgress(input, 80, "도판 Capsule 정리 중");
  diagnostics.vision = await extractionVisionGate(input).refresh();
  await reconcileCumulativeExtractionState(env.DB, run.id, source, counts, outcomeCounts, diagnostics);
  await ExtractionStore.finishRun(env.DB, { runId: run.id, counts, status });
  logVisualExtractionDiagnostic({
    level: "info",
    runId: run.id,
    sourceId: source.sourceId,
    versionId: source.sourceVersionId,
    stage: "complete",
    counts,
    outcomeCounts,
  });
  return { sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, extractionRunId: run.id, status, counts, outcomeCounts, diagnostics };
}

function isPdfFormat(value: InputFormat): value is "PDF_TEXT" | "PDF_SCAN" {
  return value === "PDF_TEXT" || value === "PDF_SCAN";
}

async function markRunRunning(db: D1Database, runId: string): Promise<void> {
  await db.prepare("UPDATE visual_extraction_runs SET status = 'RUNNING', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), runId)
    .run();
}

async function initializeExtractionVisionGate(env: Env, input: RunVisualExtractionInput, runId: string): Promise<void> {
  if (input.visionGate) return;
  const persistence = createVisualExtractionVisionPersistence(env.DB, runId);
  await persistence.seed(input.visionBudget ?? { budgetReserved: false, reservationUsd: 0 });
  input.visionGate = createVisualExtractionVisionGate({
    persistence,
    initialState: await persistence.load(),
  });
}

async function ensureExistingRun(
  db: D1Database,
  runId: string,
  expected?: { parentSourceId: string; parentVersionId: string; originKind: "WEB_EMBED" | "PDF_PAGE_CROP" },
): Promise<{ id: string }> {
  const row = await db.prepare(
    `SELECT id, parent_source_id AS parentSourceId, parent_version_id AS parentVersionId, origin_kind AS originKind
     FROM visual_extraction_runs WHERE id = ?`
  ).bind(runId).first<{ id: string; parentSourceId: string; parentVersionId: string; originKind: string }>();
  if (!row) throw new Error("visual_extraction_run_not_found");
  if (expected && (row.parentSourceId !== expected.parentSourceId || row.parentVersionId !== expected.parentVersionId || row.originKind !== expected.originKind)) {
    throw new Error("visual_extraction_run_provenance_mismatch");
  }
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

async function reconcileCumulativeExtractionState(
  db: D1Database,
  runId: string,
  source: LoadedSourceForExtraction,
  counts: VisualExtractionRunResult["counts"],
  outcomeCounts: VisualExtractionRunResult["outcomeCounts"],
  diagnostics: VisualExtractionDiagnostics,
): Promise<void> {
  const originKind = isPdfFormat(source.inputFormat) ? "PDF_PAGE_CROP" : "WEB_EMBED";
  const [assetRows, unitRows, runRow, priorResult] = await Promise.all([
    db.prepare(
      `SELECT selection_status AS selectionStatus,
              selection_reason AS selectionReason,
              rights_status AS rightsStatus
       FROM visual_assets
       WHERE parent_version_id = ? AND origin_kind = ? AND deleted_at IS NULL`
    ).bind(source.sourceVersionId, originKind).all<{
      selectionStatus: string;
      selectionReason: string;
      rightsStatus: string;
    }>(),
    db.prepare("SELECT status FROM visual_extraction_units WHERE run_id = ?")
      .bind(runId)
      .all<{ status: string }>(),
    db.prepare(
      `SELECT selected_count AS selectedCount,
              review_count AS reviewCount,
              filtered_count AS filteredCount,
              unavailable_count AS unavailableCount,
              vision_call_limit AS visionCallLimit,
              vision_reservation_usd AS visionReservationUsd,
              vision_budget_reserved AS visionBudgetReserved,
              vision_budget_blocked AS visionBudgetBlocked,
              vision_attempted AS visionAttempted,
              vision_completed AS visionCompleted,
              vision_failed AS visionFailed,
              vision_blocked AS visionBlocked,
              vision_cap_blocked AS visionCapBlocked
       FROM visual_extraction_runs WHERE id = ?`
    ).bind(runId).first<{
      selectedCount: number;
      reviewCount: number;
      filteredCount: number;
      unavailableCount: number;
      visionCallLimit?: number;
      visionReservationUsd?: number;
      visionBudgetReserved?: number;
      visionBudgetBlocked?: number;
      visionAttempted?: number;
      visionCompleted?: number;
      visionFailed?: number;
      visionBlocked?: number;
      visionCapBlocked?: number;
    }>(),
    loadPriorExtractionResult(db, runId, diagnostics),
  ]);

  const persisted = summarizePersistedExtraction({
    assets: assetRows.results ?? [],
    units: unitRows.results ?? [],
  });
  counts.selected = Math.max(counts.selected, persisted.counts.selected, Number(runRow?.selectedCount ?? 0));
  counts.review = Math.max(counts.review, persisted.counts.review, Number(runRow?.reviewCount ?? 0));
  counts.filtered = Math.max(counts.filtered, persisted.counts.filtered, Number(runRow?.filteredCount ?? 0));
  counts.unavailable = Math.max(counts.unavailable, persisted.counts.unavailable, Number(runRow?.unavailableCount ?? 0));

  outcomeCounts.duplicateExact = persisted.outcomeCounts.duplicateExact;
  outcomeCounts.duplicateNear = persisted.outcomeCounts.duplicateNear;
  outcomeCounts.rightsGated = persisted.outcomeCounts.rightsGated;
  outcomeCounts.cleanupFailures += priorResult?.outcomeCounts.cleanupFailures ?? 0;
  Object.assign(diagnostics, mergeVisualExtractionDiagnostics(priorResult?.diagnostics ?? null, diagnostics));
  if (runRow && runRow.visionCallLimit != null) {
    diagnostics.vision = {
      callLimit: Number(runRow.visionCallLimit),
      reservationUsd: Number(runRow.visionReservationUsd ?? 0),
      budgetReserved: Number(runRow.visionBudgetReserved ?? 0) === 1,
      budgetBlocked: Number(runRow.visionBudgetBlocked ?? 0) > 0 || Number(runRow.visionBudgetReserved ?? 0) === 0,
      attempted: Number(runRow.visionAttempted ?? 0),
      completed: Number(runRow.visionCompleted ?? 0),
      failed: Number(runRow.visionFailed ?? 0),
      blocked: Number(runRow.visionBlocked ?? 0),
      capBlocked: Number(runRow.visionCapBlocked ?? 0),
    };
  }
}

async function loadPriorExtractionResult(
  db: D1Database,
  runId: string,
  current: VisualExtractionDiagnostics,
): Promise<{
  diagnostics: VisualExtractionDiagnostics;
  outcomeCounts: VisualExtractionRunResult["outcomeCounts"];
} | null> {
  const row = await db.prepare(
    `SELECT result_json AS resultJson
     FROM research_jobs
     WHERE kind = 'VISUAL_EXTRACTION'
       AND status = 'SUCCEEDED'
       AND result_json IS NOT NULL
       AND json_extract(result_json, '$.extractionRunId') = ?
     ORDER BY finished_at DESC
     LIMIT 1`
  ).bind(runId).first<{ resultJson: string }>();
  if (!row?.resultJson) return null;
  try {
    const parsed = JSON.parse(row.resultJson) as {
      diagnostics?: Partial<VisualExtractionDiagnostics>;
      outcomeCounts?: Partial<VisualExtractionRunResult["outcomeCounts"]>;
    };
    const previous = parsed.diagnostics;
    if (!previous?.limits || !previous.blocked || previous.sourceKind !== current.sourceKind) return null;
    return {
      diagnostics: {
        sourceKind: current.sourceKind,
        limits: {
          htmlCandidates: Number(previous.limits.htmlCandidates ?? current.limits.htmlCandidates),
          htmlFetch: Number(previous.limits.htmlFetch ?? current.limits.htmlFetch),
          pdfPages: Number(previous.limits.pdfPages ?? current.limits.pdfPages),
        },
        blocked: {
          htmlCandidates: Number(previous.blocked.htmlCandidates ?? 0),
          htmlFetch: Number(previous.blocked.htmlFetch ?? 0),
          pdfPages: Number(previous.blocked.pdfPages ?? 0),
        },
        vision: previous.vision ?? {
          ...current.vision,
          attempted: 0,
          completed: 0,
          failed: 0,
          blocked: 0,
          capBlocked: 0,
        },
      },
      outcomeCounts: {
        duplicateExact: Number(parsed.outcomeCounts?.duplicateExact ?? 0),
        duplicateNear: Number(parsed.outcomeCounts?.duplicateNear ?? 0),
        rightsGated: Number(parsed.outcomeCounts?.rightsGated ?? 0),
        cleanupFailures: Number(parsed.outcomeCounts?.cleanupFailures ?? 0),
      },
    };
  } catch {
    return null;
  }
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

function adjustDecisionCountToReview(
  counts: VisualExtractionRunResult["counts"],
  previous: "SELECTED" | "REVIEW" | "DECORATIVE" | "DUPLICATE" | "UNAVAILABLE",
): void {
  if (previous === "REVIEW") return;
  if (previous === "SELECTED") counts.selected = Math.max(0, counts.selected - 1);
  else if (previous === "UNAVAILABLE") counts.unavailable = Math.max(0, counts.unavailable - 1);
  else counts.filtered = Math.max(0, counts.filtered - 1);
  counts.review += 1;
}

function extractionVisionGate(input: RunVisualExtractionInput): VisualExtractionVisionGate {
  if (!input.visionGate) throw new Error("visual_extraction_vision_gate_missing");
  return input.visionGate;
}

async function persistHtmlLinkOnlyVisual(
  env: Env,
  source: LoadedSourceForExtraction,
  input: {
    candidate: HtmlExtractionCandidate;
    fetched: Awaited<ReturnType<typeof fetchRemoteImage>>;
    decision: ReturnType<typeof filterVisualCandidate>;
    researchJobId?: string;
  },
  visionGate: VisualExtractionVisionGate,
): Promise<VisualExtractionVisionBlockReason | null> {
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
    rightsBasis: null,
    decision: input.decision,
  });
  const persisted = existing?.versionId
    ? { assetId: existing.assetId, versionId: existing.versionId }
    : await persistLinkOnlyDraft(env.DB, draft);
  if (existing?.analysisId) return null;
  try {
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
      visionGate,
      researchJobId: input.researchJobId,
    });
    return null;
  } catch (error) {
    if (!isVisualExtractionVisionBlocked(error)) throw error;
    await markExtractionVisionFallback(env.DB, persisted.assetId, error.reason);
    return error.reason;
  }
}

async function persistPdfLinkOnlyVisual(
  env: Env,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  candidate: PdfPageCandidate,
  crop: Awaited<ReturnType<typeof cropVisualBytes>>,
  rightsStatus: "UNKNOWN" | "RESTRICTED" | "PUBLIC_LINK",
  rightsBasis: string | null,
  decision: ReturnType<typeof filterVisualCandidate>,
  index: number,
  contentHash: string,
  perceptualHash: string,
  visionGate: VisualExtractionVisionGate,
  researchJobId?: string,
): Promise<{ assetId: string; visionFallback: VisualExtractionVisionBlockReason | null }> {
  const candidateKey = buildPdfCandidateKey(unit.unitNumber, candidate, index);
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "PDF_PAGE_CROP", candidateKey);
  if (existing && !existing.versionId) return { assetId: existing.assetId, visionFallback: null };
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
    byteSize: crop.bytes.byteLength,
    contentHash,
    perceptualHash,
    rightsStatus,
    rightsBasis,
    decision,
  });
  const persisted = existing?.versionId
    ? { assetId: existing.assetId, versionId: existing.versionId }
    : await persistLinkOnlyDraft(env.DB, draft);
  if (existing?.analysisId) return { assetId: persisted.assetId, visionFallback: null };
  try {
    await analyzeVisualVersionBytes(env, {
      visualAssetId: persisted.assetId,
      visualVersionId: persisted.versionId,
      bytes: crop.bytes,
      filename: `page-${unit.unitNumber}.webp`,
      mimeType: "image/webp",
      width: crop.width,
      height: crop.height,
      caption: candidate.caption,
      storageState: "LINK_ONLY",
      visionGate,
      researchJobId,
    });
    return { assetId: persisted.assetId, visionFallback: null };
  } catch (error) {
    if (!isVisualExtractionVisionBlocked(error)) throw error;
    await markExtractionVisionFallback(env.DB, persisted.assetId, error.reason);
    return { assetId: persisted.assetId, visionFallback: error.reason };
  }
}

async function persistPdfDuplicateMetadata(
  env: Env,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  candidate: PdfPageCandidate,
  rightsStatus: "PERMITTED" | "PERSONAL",
  rightsBasis: string,
  index: number,
  decision: ReturnType<typeof filterVisualCandidate>,
  contentHash: string,
  perceptualHash: string,
): Promise<{ assetId: string }> {
  if (decision.selectionStatus !== "DUPLICATE" || !decision.duplicateOf) {
    throw new Error("pdf_duplicate_relation_missing");
  }
  const candidateKey = buildPdfCandidateKey(unit.unitNumber, candidate, index);
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "PDF_PAGE_CROP", candidateKey);
  if (existing) return { assetId: existing.assetId };

  const assetId = uuid();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visual_assets
       (id, parent_source_id, parent_version_id, origin_kind, source_url, page_number, figure_label, bbox_json,
        candidate_key, caption, nearby_text, asset_role, visual_kind, selection_status, selection_reason,
        rights_status, rights_basis, rights_reviewed_at, is_personal_work, assignment_status, storage_state,
        pending_storage_state, processing_status, last_error, content_hash, perceptual_hash, perceptual_hash_method,
        created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 'PDF_PAGE_CROP', ?, ?, ?, ?, ?, ?, ?, 'REFERENCE', 'OTHER', ?, ?, ?, ?, ?, ?, 'ASSIGNED', 'LINK_ONLY', NULL, 'READY', NULL, ?, ?, 'IMAGES_RGBA_DHASH_V1', ?, ?, NULL)`
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
      decision.selectionStatus,
      decision.selectionReason,
      rightsStatus,
      rightsBasis,
      now,
      rightsStatus === "PERSONAL" ? 1 : 0,
      contentHash,
      perceptualHash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO visual_relations
       (id, from_visual_asset_id, to_visual_asset_id, related_source_id, related_thread_id, relation_kind, created_by, description, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 'SYSTEM', ?, ?)`
    ).bind(uuid(), assetId, decision.duplicateOf?.toVisualAssetId, decision.duplicateOf?.relationKind ?? "DUPLICATE_OF", decision.duplicateOf?.description ?? "duplicate candidate provenance", now),
  ]);
  return { assetId };
}

async function persistPdfTransformCandidate(
  env: Env,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  candidate: PdfPageCandidate,
  crop: Awaited<ReturnType<typeof cropVisualBytes>>,
  rightsStatus: "PERMITTED" | "PERSONAL",
  rightsBasis: string,
  index: number,
  decision: ReturnType<typeof filterVisualCandidate>,
  contentHash: string,
  perceptualHash: string,
): Promise<{ assetId: string }> {
  const candidateKey = buildPdfCandidateKey(unit.unitNumber, candidate, index);
  const existing = await findExistingCandidate(env.DB, source.sourceVersionId, "PDF_PAGE_CROP", candidateKey);
  if (existing) {
    if (shouldPersistPdfTransform(decision.selectionStatus) && existing.processingStatus === "TRANSFORM_PENDING") {
      await enqueueResearchJob(env, { kind: "VISUAL_TRANSFORM", input: { visualAssetId: existing.assetId } }, "system:visual-extraction");
    }
    return { assetId: existing.assetId };
  }

  const assetId = uuid();
  const versionId = uuid();
  const now = new Date().toISOString();
  const extension = extensionForVisualType("image/webp", `page-${unit.unitNumber}.webp`);
  const r2Key = `visuals/${assetId}/original/1.${extension}`;
  await env.ORIGINALS.put(r2Key, crop.bytes, {
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
         VALUES (?, ?, ?, 'PDF_PAGE_CROP', ?, ?, ?, ?, ?, ?, ?, 'REFERENCE', 'OTHER', ?, ?, ?, ?, ?, ?, 'ASSIGNED', 'ARCHIVAL', 'CAPSULE', 'TRANSFORM_PENDING', NULL, ?, ?, 'IMAGES_RGBA_DHASH_V1', ?, ?, NULL)`
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
        decision.selectionStatus,
        decision.selectionReason,
        rightsStatus,
        rightsBasis,
        now,
        rightsStatus === "PERSONAL" ? 1 : 0,
        contentHash,
        perceptualHash,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO visual_asset_versions
         (id, visual_asset_id, version, variant, r2_key, mime_type, width, height, byte_size, content_hash, parent_asset_version_id, created_at)
         VALUES (?, ?, 1, 'ORIGINAL', ?, 'image/webp', ?, ?, ?, ?, NULL, ?)`
      ).bind(versionId, assetId, r2Key, crop.width, crop.height, crop.bytes.byteLength, contentHash, now),
      ...(decision.duplicateOf ? [
        env.DB.prepare(
          `INSERT INTO visual_relations
           (id, from_visual_asset_id, to_visual_asset_id, related_source_id, related_thread_id, relation_kind, created_by, description, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?, 'SYSTEM', ?, ?)`
        ).bind(uuid(), assetId, decision.duplicateOf.toVisualAssetId, decision.duplicateOf.relationKind, decision.duplicateOf.description, now),
      ] : []),
    ]);
  } catch (error) {
    await env.ORIGINALS.delete(r2Key).catch(() => undefined);
    throw error;
  }

  await enqueueResearchJob(env, { kind: "VISUAL_TRANSFORM", input: { visualAssetId: assetId } }, "system:visual-extraction");
  return { assetId };
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
): Promise<{
  assetId: string;
  versionId: string | null;
  analysisId: string | null;
  processingStatus: string | null;
  selectionStatus: string | null;
  storageState: string | null;
} | null> {
  const row = await db.prepare(
    `SELECT a.id AS assetId,
            v.id AS versionId,
            a.processing_status AS processingStatus,
            a.selection_status AS selectionStatus,
            a.storage_state AS storageState,
            (SELECT an.id
             FROM visual_analyses an
             WHERE an.visual_asset_id = a.id
               AND an.analysis_type = 'AUTO_SUGGESTION'
             ORDER BY an.created_at DESC LIMIT 1) AS analysisId
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
  ).bind(parentVersionId, originKind, candidateKey).first<{
    assetId: string;
    versionId: string | null;
    analysisId: string | null;
    processingStatus: string | null;
    selectionStatus: string | null;
    storageState: string | null;
  }>();
  if (!row?.assetId) return null;
  return row;
}

export function pdfRightsForSource(origin: string | null): {
  rightsStatus: "PERSONAL" | "UNKNOWN" | "RESTRICTED" | "PUBLIC_LINK";
  rightsBasis: string | null;
  storageState: "ARCHIVAL" | "LINK_ONLY";
} {
  if (origin?.startsWith("restricted:")) {
    return { rightsStatus: "RESTRICTED", rightsBasis: null, storageState: "LINK_ONLY" };
  }
  if (origin?.startsWith("public_link:")) {
    return { rightsStatus: "PUBLIC_LINK", rightsBasis: null, storageState: "LINK_ONLY" };
  }
  return { rightsStatus: "UNKNOWN", rightsBasis: null, storageState: "LINK_ONLY" };
}

function isLinkOnlyPdfRights(value: ReturnType<typeof pdfRightsForSource>["rightsStatus"]): value is "UNKNOWN" | "RESTRICTED" | "PUBLIC_LINK" {
  return value === "UNKNOWN" || value === "RESTRICTED" || value === "PUBLIC_LINK";
}

async function detectPdfPageCandidates(
  env: Env,
  pageBytes: ArrayBuffer,
  source: LoadedSourceForExtraction,
  unit: ExtractionUnitRow,
  visionGate: VisualExtractionVisionGate,
  researchJobId?: string,
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
    const modelCall = () => visionGate.execute(() => env.AI.run(env.MODEL_VISION, {
        messages: [
          { role: "system", content: "You are a careful PDF-page visual extraction assistant. Output only valid JSON." },
          { role: "user", content: prompt },
        ],
        image,
        max_tokens: 1800,
      } as unknown as Record<string, unknown>));
    const result = researchJobId
      ? await withAiCallLedger(
        env.DB,
        {
          researchJobId,
          idempotencyKey: `${researchJobId}:visual_extraction:pdf-page-${unit.unitNumber}:visual-v1`,
          purpose: "visual_extraction",
          model: env.MODEL_VISION,
          reservedUsd: 0.01,
          budgetUsd: Number(env.MONTHLY_BUDGET_USD ?? 10),
        },
        modelCall,
        (value) => responseText(value),
      )
      : await modelCall();
    const parsed = parsePdfCandidateResponse(responseText(result));
    return parsed.length ? parsed : [fallbackPdfCandidate(unit)];
  } catch (error) {
    if (error instanceof Error && error.message === "usage_settlement_required") throw error;
    if (isVisualExtractionVisionBlocked(error)) {
      return [fallbackPdfCandidate(unit, `vision_skipped_${error.reason}`)];
    }
    return [fallbackPdfCandidate(unit)];
  }
}

function fallbackPdfCandidate(unit: ExtractionUnitRow, reason = "full_page_fallback"): PdfPageCandidate {
  return {
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    visualKind: "DOCUMENT_SCAN",
    figureLabel: null,
    caption: `page ${unit.unitNumber}`,
    reason,
    confidence: 0.4,
  };
}

function extractionFallbackDecision(
  candidate: PdfPageCandidate,
  decision: ReturnType<typeof filterVisualCandidate>,
): ReturnType<typeof filterVisualCandidate> {
  if (!candidate.reason.startsWith("vision_skipped_")) return decision;
  return {
    ...decision,
    selectionStatus: "REVIEW",
    selectionReason: `${decision.ruleVersion}:${candidate.reason}`,
    duplicateOf: null,
  };
}

async function markExtractionVisionFallback(
  db: D1Database,
  visualAssetId: string,
  reason: VisualExtractionVisionBlockReason,
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE visual_assets
     SET selection_status = 'REVIEW',
         selection_reason = ?,
         processing_status = 'READY',
         last_error = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(`visual_extraction_skipped_${reason}`, reason, now, visualAssetId).run();
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
