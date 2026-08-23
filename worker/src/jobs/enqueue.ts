import type { DiscoveryProfile, ResearchJob, ResearchJobKind } from "@radar/shared/discovery";
import { createResearchJob, findActiveJobByDedupeKey, failResearchJob, setWorkflowInstanceId } from "./store";

export type ResearchJobRequest =
  | { kind: "DISCOVERY_RUN"; input: { divergence: number; profile: DiscoveryProfile } }
  | { kind: "DISTILL_RUN"; input: { includeCounter: boolean; redistillOf?: string; keepElements?: string[]; promptVariant?: string } }
  | { kind: "RADAR_SYNTHESIS"; input: { period: "WEEKLY" | "MONTHLY" | "YEARLY" } }
  | { kind: "DEEP_ANALYSIS"; input: { sourceId: string; profile: "precision" | "maximum" } }
  | { kind: "SOURCE_ACQUISITION"; input: { sourceId: string; url: string } };

function stable(value: unknown): string {
  return JSON.stringify(value, Object.keys((value && typeof value === "object" ? value : {}) as object).sort());
}

export function dedupeKeyFor(request: ResearchJobRequest): string {
  return `${request.kind}:${stable(request.input)}`;
}

export async function enqueueResearchJob(env: Env, request: ResearchJobRequest, requestedBy: string, retryOf?: string | null): Promise<{ job: ResearchJob; reused: boolean }> {
  const dedupeKey = dedupeKeyFor(request);
  const active = await findActiveJobByDedupeKey(env.DB, dedupeKey);
  if (active) return { job: active, reused: true };

  const job = await createResearchJob(env.DB, {
    kind: request.kind as ResearchJobKind,
    input: request.input,
    dedupeKey,
    requestedBy,
    retryOf,
  });
  try {
    const instance = await env.RESEARCH_JOBS_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
    await setWorkflowInstanceId(env.DB, job.id, instance.id);
    return { job: (await findActiveJobByDedupeKey(env.DB, dedupeKey)) ?? job, reused: false };
  } catch (error) {
    await failResearchJob(env.DB, job.id, "workflow_create_failed", error instanceof Error ? error.message : "workflow_create_failed");
    throw error;
  }
}
