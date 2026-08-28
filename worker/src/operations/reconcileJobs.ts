import { setWorkflowInstanceId } from "../jobs/store";

export async function reconcileDispatchPendingJobs(env: Env, limit = 20): Promise<{ scanned: number; dispatched: number; failed: number }> {
  const rows = await env.DB.prepare(
    `SELECT id FROM research_jobs
     WHERE status = 'QUEUED' AND error_code = 'dispatch_pending' AND workflow_instance_id IS NULL
     ORDER BY created_at ASC LIMIT ?`
  ).bind(Math.min(50, Math.max(1, limit))).all<{ id: string }>();
  let dispatched = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      const instance = await env.RESEARCH_JOBS_WORKFLOW.create({ id: row.id, params: { jobId: row.id } });
      await setWorkflowInstanceId(env.DB, row.id, instance.id);
      dispatched += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ level: "error", scope: "job-reconciliation", jobId: row.id, errorCode: "workflow_create_failed", message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { scanned: rows.results?.length ?? 0, dispatched, failed };
}
