import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RadarPeriod } from "@radar/shared";
import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import type { DiscoveryFieldSignalRunDiagnostics } from "@radar/shared/fieldSignals";
import type { DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";
import type { TextScope, QualityStatus } from "@radar/shared/ingestion";
import { runDiscovery } from "../discovery/run";
import { discoveryCombinedJobFailure, discoveryCombinedJobOutcome, discoveryJobOutcome } from "../discovery/diagnostics";
import { acquireRemoteSource } from "../ingestion/acquireRemoteSource";
import { updateIngestJob } from "../ingestion/store";
import { appendAcquisitionVersion, getActiveVersion } from "../ingestion/versioning";
import { loadParams } from "../lib/params";
import { monthSpendUsd } from "../lib/openai";
import { runDistill, verifyQueueItems } from "../distill/run";
import { runRadarSynthesis } from "../radar/run";
import { analyzeDeepSource } from "../analysis/deepAnalyze";
import { blockResearchJob, completeResearchJob, failResearchJob, getResearchJob, markJobRunning, updateJobProgress } from "../jobs/store";

class JobBlockedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

type WorkflowStepResult = {
  result: {
    collected?: number;
    fieldSignalsCollected?: number;
    keptExisting?: number;
    queries?: string[];
    diagnostics?: DiscoveryRunDiagnostics;
    fieldSignalDiagnostics?: DiscoveryFieldSignalRunDiagnostics;
    sessionId?: string;
    costUsd?: number;
    snapshotId?: string;
    analysisId?: string;
    model?: string;
    sourceId?: string;
    textScope?: TextScope;
    versionId?: string;
    charCount?: number;
  };
  resultRef: ResearchJobResultRef;
};

export class ResearchJobWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<void> {
    const job = await getResearchJob(this.env.DB, event.payload.jobId);
    if (!job) throw new Error("research_job_not_found");

    try {
      await step.do("mark-running", async () => {
        await markJobRunning(this.env.DB, job.id, "작업을 시작했습니다.");
        return true;
      });

      const result = await step.do<WorkflowStepResult>(
        `execute-${job.kind.toLowerCase()}`,
        { retries: { limit: 1, delay: "5 seconds", backoff: "exponential" }, timeout: "15 minutes" },
        async () => this.execute(job),
      );

      await step.do("mark-complete", async () => {
        await completeResearchJob(this.env.DB, job.id, result.result, result.resultRef);
        return true;
      });
    } catch (error) {
      if (error instanceof JobBlockedError) {
        await blockResearchJob(this.env.DB, job.id, error.code, error.message);
      } else {
        await failResearchJob(this.env.DB, job.id, "workflow_runtime_failed", error instanceof Error ? error.message : "workflow_runtime_failed");
      }
      throw error;
    }
  }

  private async execute(job: ResearchJob): Promise<WorkflowStepResult> {
    if (job.kind === "DISCOVERY_RUN") {
      await updateJobProgress(this.env.DB, job.id, 20, "발견 방향을 읽는 중");
      const input = job.input as { divergence: number; profile: Parameters<typeof runDiscovery>[1] extends number ? never : { original: { keywords: string[]; strength: number }; counter: { keywords: string[]; strength: number }; updatedAt: string } };
      const result = await runDiscovery(this.env, { divergence: input.divergence, profile: input.profile });
      const readingOutcome = discoveryJobOutcome(result.diagnostics, result.diagnostics.providers.rss.requests > 0);
      const outcome = discoveryCombinedJobOutcome(readingOutcome, result.fieldSignalDiagnostics);
      const failure = discoveryCombinedJobFailure(outcome);
      if (failure?.outcome === "FAILED") throw new Error(failure.errorMessage);
      if (failure?.outcome === "BLOCKED") throw new JobBlockedError(failure.errorCode, failure.errorMessage);
      return {
        result: {
          collected: result.collected,
          fieldSignalsCollected: result.fieldSignalsCollected,
          keptExisting: result.keptExisting,
          queries: result.queries,
          diagnostics: result.diagnostics,
          fieldSignalDiagnostics: result.fieldSignalDiagnostics,
        },
        resultRef: { view: "DISCOVER" },
      };
    }

    if (job.kind === "DISTILL_RUN") {
      await updateJobProgress(this.env.DB, job.id, 20, "읽기 맥락을 정리하는 중");
      const input = job.input as { includeCounter?: boolean; redistillOf?: string; keepElements?: string[] };
      const params = await loadParams(this.env.DB);
      const result = await runDistill(this.env, params, input);
      if (!result.ok) {
        if (result.error.includes("monthly_budget_exhausted")) throw new JobBlockedError("monthly_budget_exhausted", result.error);
        throw new Error(result.error);
      }
      await updateJobProgress(this.env.DB, job.id, 80, "읽기 큐를 검증하는 중");
      await verifyQueueItems(this.env, result.distillOutput, result.queueItemIds);
      return { result: { sessionId: result.sessionId, costUsd: result.costUsd }, resultRef: { view: "DISTILL", sessionId: result.sessionId } };
    }

    if (job.kind === "RADAR_SYNTHESIS") {
      await updateJobProgress(this.env.DB, job.id, 25, "레이더 서사를 만드는 중");
      const input = job.input as { period: RadarPeriod };
      const result = await runRadarSynthesis(this.env, input.period);
      return { result: { snapshotId: result.snapshotId }, resultRef: { view: "RADAR", period: input.period, snapshotId: result.snapshotId } };
    }

    if (job.kind === "SOURCE_ACQUISITION") {
      const input = job.input as { sourceId: string; url: string };
      const existing = await findReusableAcquisitionVersion(this.env.DB, input.sourceId, job.createdAt);
      if (existing) {
        await updateJobProgress(this.env.DB, job.id, 75, "이미 저장된 원문 버전을 확인하는 중");
        await updateIngestJob(this.env.DB, input.sourceId, existing.qualityStatus === "READY" ? "extracted" : "failed", existing.qualityStatus === "READY" ? null : "text_not_ready");
        return {
          result: {
            sourceId: input.sourceId,
            textScope: existing.textScope,
            versionId: existing.versionId,
            charCount: existing.charCount,
          },
          resultRef: { view: "RESERVOIR", sourceId: input.sourceId, acquisition: true },
        };
      }

      await updateJobProgress(this.env.DB, job.id, 20, "원문 링크를 확인하는 중");
      const current = await getActiveVersion(this.env.DB, input.sourceId);
      const nextVersion = (current?.version ?? 0) + 1;
      await updateIngestJob(this.env.DB, input.sourceId, "received", null);
      const acquired = await acquireRemoteSource(this.env, { sourceId: input.sourceId, url: input.url, version: nextVersion });
      await updateJobProgress(this.env.DB, job.id, 75, "원문을 정규화하는 중");
      const stored = await appendAcquisitionVersion(this.env.DB, {
        sourceId: input.sourceId,
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
      await updateIngestJob(this.env.DB, input.sourceId, stored.qualityStatus === "READY" ? "extracted" : "failed", stored.qualityStatus === "READY" ? null : "text_not_ready");
      return {
        result: {
          sourceId: input.sourceId,
          textScope: acquired.textScope,
          versionId: stored.versionId,
          charCount: acquired.extractedText.length,
        },
        resultRef: { view: "RESERVOIR", sourceId: input.sourceId, acquisition: true },
      };
    }

    await updateJobProgress(this.env.DB, job.id, 20, "자료 본문을 읽는 중");
    const input = job.input as { sourceId: string; profile: "precision" | "maximum" };
    const budget = parseFloat(this.env.MONTHLY_BUDGET_USD) || 10;
    if (await monthSpendUsd(this.env) >= budget) throw new JobBlockedError("monthly_budget_exhausted", "monthly_budget_exhausted");
    const result = await analyzeDeepSource(this.env, input.sourceId, input.profile);
    return { result: { analysisId: result.analysisId, model: result.model, costUsd: result.costUsd }, resultRef: { view: "RESERVOIR", sourceId: input.sourceId, analysisId: result.analysisId } };
  }
}

interface ReusableAcquisitionVersion {
  versionId: string;
  charCount: number;
  textScope: TextScope;
  qualityStatus: QualityStatus;
}

async function findReusableAcquisitionVersion(
  db: D1Database,
  sourceId: string,
  jobCreatedAt: string,
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
       AND v.version_origin = 'REEXTRACT'
       AND v.review_status IN ('ACTIVE', 'PENDING_REVIEW')
       AND v.created_at >= ?
       AND v.extraction_method IN ('HTML_STATIC', 'PDF_REMOTE_TO_MARKDOWN')
     ORDER BY v.created_at DESC, v.version DESC
     LIMIT 1`,
  ).bind(sourceId, jobCreatedAt).first<ReusableAcquisitionVersion>();
}
