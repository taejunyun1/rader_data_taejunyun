import type { ResearchJobResultRef } from "@radar/shared/discovery";
import type { QualityStatus, TextScope } from "@radar/shared/ingestion";
import { acquireRemoteSource, RemoteAcquisitionError } from "../ingestion/acquireRemoteSource";
import { updateIngestJob } from "../ingestion/store";
import { appendAcquisitionVersion, getActiveVersion } from "../ingestion/versioning";

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

  if (existing) {
    await updateProgress(env.DB, job.id, 75, "이미 저장된 원문 버전을 확인하는 중");
    await updateIngestJob(env.DB, sourceId, existing.qualityStatus === "READY" ? "extracted" : "failed", existing.qualityStatus === "READY" ? null : "text_not_ready");
    return {
      result: {
        sourceId,
        textScope: existing.textScope,
        versionId: existing.versionId,
        charCount: existing.charCount,
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
    await updateIngestJob(env.DB, sourceId, "failed", acquisitionFailureCode(error));
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
    });
  } catch (error) {
    await updateIngestJob(env.DB, sourceId, "failed", "source_version_store_failed");
    throw error;
  }

  await updateIngestJob(env.DB, sourceId, stored.qualityStatus === "READY" ? "extracted" : "failed", stored.qualityStatus === "READY" ? null : "text_not_ready");
  return {
    result: {
      sourceId,
      textScope: acquired.textScope,
      versionId: stored.versionId,
      charCount: acquired.extractedText.length,
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
