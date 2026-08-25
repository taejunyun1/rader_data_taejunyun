import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RadarPeriod } from "@radar/shared";
import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import type { DiscoveryFieldSignalRunDiagnostics } from "@radar/shared/fieldSignals";
import type { DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";
import type { TextScope } from "@radar/shared/ingestion";
import { runDiscovery } from "../discovery/run";
import { discoveryCombinedJobFailure, discoveryCombinedJobOutcome, discoveryJobOutcome } from "../discovery/diagnostics";
import { loadParams } from "../lib/params";
import { runDistill, verifyQueueItems } from "../distill/run";
import { runRadarSynthesis } from "../radar/run";
import { analyzeDeepSource } from "../analysis/deepAnalyze";
import { releaseDeepAnalysisBudgetReservation, reserveDeepAnalysisBudget } from "../analysis/budgetReservation";
import { blockResearchJob, completeResearchJob, failResearchJob, getResearchJob, markJobRunning, updateJobProgress } from "../jobs/store";
import { executeSourceAcquisitionJob } from "./sourceAcquisition";
import { transformVisualAsset } from "../visual/transform";
import { analyzeVisualAsset } from "../visual/analyzer";
import { markVisualProcessingError } from "../visual/store";
import { enqueueResearchJob } from "../jobs/enqueue";
import { runVisualExtraction, type VisualExtractionDiagnostics } from "../visual/extraction/run";

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
    diagnostics?: DiscoveryRunDiagnostics | VisualExtractionDiagnostics;
    fieldSignalDiagnostics?: DiscoveryFieldSignalRunDiagnostics;
    sessionId?: string;
    costUsd?: number;
    snapshotId?: string;
    analysisId?: string;
    model?: string;
    sourceId?: string;
    visualAssetId?: string;
    extractionRunId?: string;
    textScope?: TextScope;
    versionId?: string;
    charCount?: number;
    counts?: {
      selected: number;
      review: number;
      filtered: number;
      unavailable: number;
    };
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

      if (job.kind === "VISUAL_TRANSFORM") {
        await step.do(
          "enqueue-visual-analysis",
          { retries: { limit: 1, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
          async () => {
            const visualAssetId = result.result.visualAssetId;
            if (!visualAssetId) return false;
            await enqueueResearchJob(this.env, { kind: "VISUAL_ANALYSIS", input: { visualAssetId } }, job.requestedBy ?? "local");
            return true;
          },
        );
      }

      if (job.kind === "DEEP_ANALYSIS") {
        await step.do(
          "release-deep-analysis-budget",
          { retries: { limit: 1, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
          async () => {
            await releaseDeepAnalysisBudgetReservation(this.env.DB, job.id);
            return true;
          },
        );
      }

      await step.do("mark-complete", async () => {
        await completeResearchJob(this.env.DB, job.id, result.result, result.resultRef);
        return true;
      });
    } catch (error) {
      if (job.kind === "DEEP_ANALYSIS") await this.releaseDeepAnalysisBudgetAfterFailure(job.id, error);
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
      return executeSourceAcquisitionJob({
        env: this.env,
        job: {
          id: job.id,
          input: job.input as { sourceId: string; url: string },
        },
        updateProgress: updateJobProgress,
      });
    }

    if (job.kind === "VISUAL_TRANSFORM" || job.kind === "VISUAL_ANALYSIS" || job.kind === "VISUAL_EXTRACTION") {
      if (job.kind === "VISUAL_TRANSFORM") {
        await updateJobProgress(this.env.DB, job.id, 25, "이미지 Capsule을 만드는 중");
        const input = job.input as { visualAssetId: string };
        let transformed: Awaited<ReturnType<typeof transformVisualAsset>>;
        try {
          transformed = await transformVisualAsset(this.env, input.visualAssetId);
        } catch (error) {
          await markVisualProcessingError(this.env.DB, input.visualAssetId, error instanceof Error ? error.message : "visual_transform_failed");
          throw error;
        }
        return {
          result: { visualAssetId: transformed.visualAssetId, sourceId: transformed.sourceId ?? undefined },
          resultRef: { view: "VISUAL", visualAssetId: transformed.visualAssetId, sourceId: transformed.sourceId ?? undefined },
        };
      }
      if (job.kind === "VISUAL_ANALYSIS") {
        await updateJobProgress(this.env.DB, job.id, 45, "이미지의 형태와 맥락을 읽는 중");
        const input = job.input as { visualAssetId: string; versionId?: string };
        const analyzed = await analyzeVisualAsset(this.env, input.visualAssetId, input.versionId);
        return {
          result: { visualAssetId: analyzed.visualAssetId, analysisId: analyzed.analysisId, model: analyzed.model },
          resultRef: { view: "VISUAL", visualAssetId: analyzed.visualAssetId },
        };
      }
      await updateJobProgress(this.env.DB, job.id, 30, "시각 후보를 정리하는 중");
      const input = job.input as { sourceId: string; sourceVersionId: string; extractionRunId?: string };
      const extracted = await runVisualExtraction(this.env, input);
      return {
        result: {
          sourceId: extracted.sourceId,
          extractionRunId: extracted.extractionRunId,
          counts: extracted.counts,
          diagnostics: extracted.diagnostics,
        },
        resultRef: { view: "VISUAL", sourceId: extracted.sourceId, extractionRunId: extracted.extractionRunId },
      };
    }

    if (job.kind !== "DEEP_ANALYSIS") {
      throw new Error(`unsupported_research_job_kind:${job.kind}`);
    }

    await updateJobProgress(this.env.DB, job.id, 20, "자료 본문을 읽는 중");
    const input = job.input as { sourceId: string; profile: "precision" | "maximum" };
    const reservation = await reserveDeepAnalysisBudget(this.env, { researchJobId: job.id, profile: input.profile });
    if (!reservation.ok) throw new JobBlockedError("monthly_budget_exhausted", "monthly_budget_exhausted");
    const result = await analyzeDeepSource(this.env, input.sourceId, input.profile);
    return { result: { analysisId: result.analysisId, model: result.model, costUsd: result.costUsd }, resultRef: { view: "RESERVOIR", sourceId: input.sourceId, analysisId: result.analysisId } };
  }

  private async releaseDeepAnalysisBudgetAfterFailure(researchJobId: string, originalError: unknown): Promise<void> {
    try {
      await releaseDeepAnalysisBudgetReservation(this.env.DB, researchJobId);
    } catch (releaseError) {
      console.error(JSON.stringify({
        level: "error",
        scope: "workflow:deep-analysis-budget-release",
        researchJobId,
        message: releaseError instanceof Error ? releaseError.message : "deep_analysis_budget_release_failed",
        originalError: originalError instanceof Error ? originalError.message : String(originalError),
      }));
    }
  }
}
