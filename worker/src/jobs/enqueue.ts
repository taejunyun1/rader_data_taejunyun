import type { DiscoveryProfile, ResearchJob, ResearchJobKind } from "@radar/shared/discovery";
import { createResearchJob, findActiveJobByDedupeKey, markDispatchPending, setWorkflowInstanceId } from "./store";
import {
  assertSourceDeletionNotClaimedForResearchJobInput,
  isSourceDeletionClaimError,
  SourceDeletionClaimError,
} from "../reservoir/deletionClaim";

export type ResearchJobRequest =
  | { kind: "DISCOVERY_RUN"; input: { divergence: number; profile: DiscoveryProfile } }
  | { kind: "DISTILL_RUN"; input: { includeCounter: boolean; redistillOf?: string; keepElements?: string[]; promptVariant?: string } }
  | { kind: "RADAR_SYNTHESIS"; input: { period: "WEEKLY" | "MONTHLY" | "YEARLY" } }
  | { kind: "DEEP_ANALYSIS"; input: { sourceId: string; profile: "precision" | "maximum" } }
  | { kind: "SOURCE_ACQUISITION"; input: { sourceId: string; url: string } }
  | { kind: "VISUAL_TRANSFORM"; input: { visualAssetId: string } }
  | { kind: "VISUAL_ANALYSIS"; input: { visualAssetId: string; versionId?: string } }
  | { kind: "VISUAL_EXTRACTION"; input: { sourceId: string; sourceVersionId: string; extractionRunId?: string } };

function stable(value: unknown): string {
  return JSON.stringify(value, Object.keys((value && typeof value === "object" ? value : {}) as object).sort());
}

export function dedupeKeyFor(request: ResearchJobRequest): string {
  return `${request.kind}:${stable(request.input)}`;
}

export async function enqueueResearchJob(env: Env, request: ResearchJobRequest, requestedBy: string, retryOf?: string | null): Promise<{ job: ResearchJob; reused: boolean }> {
  // Resolve source ownership before dedupe. A claimed source must not be able
  // to reuse an already-queued job as a way to sneak a new workflow into the
  // delete window; the migration trigger remains the race-safe final guard for
  // the insert itself.
  await assertSourceDeletionNotClaimedForResearchJobInput(env.DB, request.input);
  const dedupeKey = dedupeKeyFor(request);
  const active = await findActiveJobByDedupeKey(env.DB, dedupeKey);
  if (active) return { job: active, reused: true };

  let job: ResearchJob;
  try {
    job = await createResearchJob(env.DB, {
      kind: request.kind as ResearchJobKind,
      input: request.input,
      dedupeKey,
      requestedBy,
      retryOf,
    });
  } catch (error) {
    if (isSourceDeletionClaimError(error)) {
      throw new SourceDeletionClaimError("source_delete_in_progress", error);
    }
    const winner = await findActiveJobByDedupeKey(env.DB, dedupeKey);
    if (winner) return { job: winner, reused: true };
    throw error;
  }
  try {
    const instance = await env.RESEARCH_JOBS_WORKFLOW.create({ id: job.id, params: { jobId: job.id } });
    await setWorkflowInstanceId(env.DB, job.id, instance.id);
    return { job: (await findActiveJobByDedupeKey(env.DB, dedupeKey)) ?? job, reused: false };
  } catch (error) {
    await markDispatchPending(env.DB, job.id, error instanceof Error ? error.message : "workflow_create_failed");
    return { job: (await findActiveJobByDedupeKey(env.DB, dedupeKey)) ?? job, reused: false };
  }
}
