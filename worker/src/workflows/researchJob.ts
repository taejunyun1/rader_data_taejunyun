import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RadarPeriod } from "@radar/shared";
import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import { runDiscovery } from "../discovery/run";
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
    keptExisting?: number;
    queries?: string[];
    sessionId?: string;
    costUsd?: number;
    snapshotId?: string;
    analysisId?: string;
    model?: string;
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
      return { result: { collected: result.collected, keptExisting: result.keptExisting, queries: result.queries }, resultRef: { view: "DISCOVER" } };
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

    await updateJobProgress(this.env.DB, job.id, 20, "자료 본문을 읽는 중");
    const input = job.input as { sourceId: string; profile: "precision" | "maximum" };
    const budget = parseFloat(this.env.MONTHLY_BUDGET_USD) || 10;
    if (await monthSpendUsd(this.env) >= budget) throw new JobBlockedError("monthly_budget_exhausted", "monthly_budget_exhausted");
    const result = await analyzeDeepSource(this.env, input.sourceId, input.profile);
    return { result: { analysisId: result.analysisId, model: result.model, costUsd: result.costUsd }, resultRef: { view: "RESERVOIR", sourceId: input.sourceId, analysisId: result.analysisId } };
  }
}
