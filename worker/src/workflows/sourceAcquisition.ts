import type { ResearchJobResultRef } from "@radar/shared/discovery";
import type { QualityStatus, TextScope } from "@radar/shared/ingestion";
import { acquireRemoteSource, RemoteAcquisitionError } from "../ingestion/acquireRemoteSource";
import { updateIngestJob } from "../ingestion/store";
import { activateVersion, appendAcquisitionVersion, getActiveVersion } from "../ingestion/versioning";
import { enqueueResearchJob } from "../jobs/enqueue";
import {
  isSourceDeletionClaimError,
  isSourceVersionCommittedClaimError,
} from "../reservoir/deletionClaim";

export interface SourceAcquisitionJobLike {
  id: string;
  input: { sourceId: string; url: string };
}

export interface SourceAcquisitionStepResult {
  result: {
    sourceId: string;
    textScope: TextScope;
    versionId: string;
    charCount: number;
    warnings?: string[];
  };
  resultRef: ResearchJobResultRef;
}

interface ExecuteSourceAcquisitionJobInput {
  env: Env;
  job: SourceAcquisitionJobLike;
  updateProgress: (db: D1Database, jobId: string, progress: number, message: string) => Promise<void>;
}

interface ReusableAcquisitionVersion {
  versionId: string;
  charCount: number;
  textScope: TextScope;
  qualityStatus: QualityStatus;
}

export function buildSourceAcquisitionVersionId(jobId: string): string {
  return `acq-${jobId}`;
}

export async function executeSourceAcquisitionJob(input: ExecuteSourceAcquisitionJobInput): Promise<SourceAcquisitionStepResult> {
  const { env, job, updateProgress } = input;
  const versionId = buildSourceAcquisitionVersionId(job.id);
  const sourceId = job.input.sourceId;
  const existing = await findReusableAcquisitionVersion(env.DB, sourceId, versionId);
  const warnings: string[] = [];

  if (existing) {
    await updateProgress(env.DB, job.id, 75, "이미 저장된 원문 버전을 확인하는 중");
    if (existing.qualityStatus === "READY") {
      const activeVersion = await getActiveVersion(env.DB, sourceId);
      if (activeVersion?.id !== existing.versionId) {
        await activateVersion(env.DB, sourceId, existing.versionId, "READY");
      }
    }
    await updateIngestJob(env.DB, sourceId, existing.qualityStatus === "READY" ? "extracted" : "failed", existing.qualityStatus === "READY" ? null : "text_not_ready");
    if (existing.qualityStatus === "READY") await enqueueVisualExtractionIfReusableAndMissingRun(env, sourceId, existing.versionId, warnings);
    return {
      result: {
        sourceId,
        textScope: existing.textScope,
        versionId: existing.versionId,
        charCount: existing.charCount,
        ...(warnings.length ? { warnings } : {}),
      },
      resultRef: { view: "RESERVOIR", sourceId, acquisition: true },
    };
  }

  await updateProgress(env.DB, job.id, 20, "원문 링크를 확인하는 중");
  const current = await getActiveVersion(env.DB, sourceId);
  const nextVersion = (current?.version ?? 0) + 1;
  await updateIngestJob(env.DB, sourceId, "received", null);

  let acquired: Awaited<ReturnType<typeof acquireRemoteSource>>;
  try {
    acquired = await acquireRemoteSource(env, {
      sourceId,
      url: job.input.url,
      version: nextVersion,
      versionId,
    });
  } catch (error) {
    await tryUpdateIngestJobFailed(env.DB, sourceId, acquisitionFailureCode(error));
    throw error;
  }

  await updateProgress(env.DB, job.id, 75, "원문을 정규화하는 중");

  let stored: Awaited<ReturnType<typeof appendAcquisitionVersion>>;
  try {
    stored = await appendAcquisitionVersion(env.DB, {
      versionId,
      sourceId,
      r2Key: acquired.r2Key,
      extractedText: acquired.extractedText,
      inputFormat: acquired.kind === "PDF" ? "PDF_TEXT" : "URL_HTML",
      textScope: acquired.textScope,
      extractionMethod: acquired.extractionMethod,
      contentType: acquired.contentType,
      finalUrl: acquired.finalUrl,
      acquiredAt: new Date().toISOString(),
      parentVersionId: current?.id ?? null,
      versionOrigin: "REEXTRACT",
      rawContentHash: acquired.rawContentHash,
    });
  } catch (error) {
    // If a claim was acquired after the source-scoped put, the DB trigger can
    // reject the version insert. Compensate the object here so that a rejected
    // in-flight acquisition cannot become an orphan outside the deletion plan.
    if (isSourceDeletionClaimError(error) && !isSourceVersionCommittedClaimError(error)) {
      try { await env.ORIGINALS.delete(acquired.r2Key); } catch { /* best effort */ }
    }
    await tryUpdateIngestJobFailed(env.DB, sourceId, "source_version_store_failed");
    throw error;
  }

  await updateIngestJob(env.DB, sourceId, stored.qualityStatus === "READY" ? "extracted" : "failed", stored.qualityStatus === "READY" ? null : "text_not_ready");
  if (stored.qualityStatus === "READY") await enqueueVisualExtractionIfActive(env, sourceId, stored.versionId, warnings);
  return {
    result: {
      sourceId,
      textScope: acquired.textScope,
      versionId: stored.versionId,
      charCount: acquired.extractedText.length,
      ...(warnings.length ? { warnings } : {}),
    },
    resultRef: { view: "RESERVOIR", sourceId, acquisition: true },
  };
}

async function findReusableAcquisitionVersion(
  db: D1Database,
  sourceId: string,
  versionId: string,
): Promise<ReusableAcquisitionVersion | null> {
  return db.prepare(
    `SELECT v.id AS versionId, v.char_count AS charCount, v.text_scope AS textScope,
            CASE
              WHEN v.text_scope = 'EMPTY' THEN 'EMPTY'
              WHEN v.text_scope IN ('PARTIAL', 'METADATA_ONLY') THEN 'REVIEW'
              WHEN s.active_version_id = v.id THEN COALESCE(s.quality_status, 'READY')
              ELSE 'READY'
            END AS qualityStatus
     FROM source_versions v
     LEFT JOIN sources s ON s.id = v.source_id
     WHERE v.source_id = ?
       AND v.id = ?
       AND v.version_origin = 'REEXTRACT'
       AND v.review_status IN ('ACTIVE', 'PENDING_REVIEW')
       AND v.extraction_method IN ('HTML_STATIC', 'PDF_REMOTE_TO_MARKDOWN')
     LIMIT 1`,
  ).bind(sourceId, versionId).first<ReusableAcquisitionVersion>();
}

function acquisitionFailureCode(error: unknown): string {
  if (error instanceof RemoteAcquisitionError) return error.code;
  if (error instanceof Error && error.message) return error.message.slice(0, 100);
  return "source_acquisition_failed";
}

async function tryUpdateIngestJobFailed(db: D1Database, sourceId: string, error: string): Promise<void> {
  try {
    await updateIngestJob(db, sourceId, "failed", error);
  } catch {
    // The acquisition or version-store error remains the workflow's primary failure.
  }
}

async function enqueueVisualExtractionIfActive(
  env: Env,
  sourceId: string,
  sourceVersionId: string,
  warnings: string[],
): Promise<void> {
  const activeVersion = await getActiveVersion(env.DB, sourceId);
  if (!activeVersion || activeVersion.id !== sourceVersionId) return;
  try {
    await enqueueResearchJob(
      env,
      { kind: "VISUAL_EXTRACTION", input: { sourceId, sourceVersionId } },
      "system:source-acquisition",
    );
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "visual_extraction_enqueue_failed";
    warnings.push(`visual_extraction_enqueue_failed:${message}`);
  }
}

async function enqueueVisualExtractionIfReusableAndMissingRun(
  env: Env,
  sourceId: string,
  sourceVersionId: string,
  warnings: string[],
): Promise<void> {
  const activeVersion = await getActiveVersion(env.DB, sourceId);
  if (!activeVersion || activeVersion.id !== sourceVersionId) return;
  if (await hasVisualExtractionRunForVersion(env.DB, sourceVersionId)) return;
  try {
    await enqueueResearchJob(
      env,
      { kind: "VISUAL_EXTRACTION", input: { sourceId, sourceVersionId } },
      "system:source-acquisition",
    );
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "visual_extraction_enqueue_failed";
    warnings.push(`visual_extraction_enqueue_failed:${message}`);
  }
}

async function hasVisualExtractionRunForVersion(db: D1Database, sourceVersionId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id
     FROM visual_extraction_runs
     WHERE parent_version_id = ?
     LIMIT 1`,
  ).bind(sourceVersionId).first<{ id: string }>();
  return Boolean(row?.id);
}
