import type { ResearchJob, ResearchJobKind, ResearchJobResultRef, ResearchJobStatus } from "@radar/shared/discovery";
import { uuid } from "../ingestion/ids";

export type JobRow = Record<string, unknown>;

function parse(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapJob(row: JobRow): ResearchJob {
  return {
    id: String(row.id),
    workflowInstanceId: row.workflowInstanceId == null ? null : String(row.workflowInstanceId),
    kind: String(row.kind) as ResearchJobKind,
    status: String(row.status) as ResearchJobStatus,
    progress: Number(row.progress ?? 0),
    message: row.message == null ? null : String(row.message),
    input: parse(row.inputJson),
    result: parse(row.resultJson),
    resultRef: parse(row.resultRefJson) as ResearchJobResultRef | null,
    errorCode: row.errorCode == null ? null : String(row.errorCode),
    error: row.error == null ? null : String(row.error),
    retryOf: row.retryOf == null ? null : String(row.retryOf),
    requestedBy: row.requestedBy == null ? null : String(row.requestedBy),
    dedupeKey: String(row.dedupeKey),
    dismissedAt: row.dismissedAt == null ? null : String(row.dismissedAt),
    createdAt: String(row.createdAt),
    startedAt: row.startedAt == null ? null : String(row.startedAt),
    finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    updatedAt: String(row.updatedAt),
  };
}

const SELECT = `SELECT id, workflow_instance_id AS workflowInstanceId, kind, status, progress, message,
  input_json AS inputJson, result_json AS resultJson, result_ref_json AS resultRefJson,
  error_code AS errorCode, error, retry_of AS retryOf, requested_by AS requestedBy,
  dedupe_key AS dedupeKey, dismissed_at AS dismissedAt, created_at AS createdAt,
  started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
  FROM research_jobs`;

export interface CreateJobInput {
  kind: ResearchJobKind;
  input: unknown;
  dedupeKey: string;
  requestedBy: string;
  retryOf?: string | null;
}

export async function createResearchJob(db: D1Database, input: CreateJobInput): Promise<ResearchJob> {
  const id = uuid();
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO research_jobs (id, kind, status, progress, input_json, retry_of, requested_by, dedupe_key, created_at, updated_at)
     VALUES (?, ?, 'QUEUED', 0, ?, ?, ?, ?, ?, ?)`
  ).bind(id, input.kind, JSON.stringify(input.input ?? null), input.retryOf ?? null, input.requestedBy, input.dedupeKey, now, now).run();
  const job = await getResearchJob(db, id);
  if (!job) throw new Error("research_job_create_failed");
  return job;
}

export async function findActiveJobByDedupeKey(db: D1Database, dedupeKey: string): Promise<ResearchJob | null> {
  const row = await db.prepare(`${SELECT} WHERE dedupe_key = ? AND status IN ('QUEUED', 'RUNNING') LIMIT 1`).bind(dedupeKey).first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function findVisualExtractionJobByRun(db: D1Database, extractionRunId: string): Promise<ResearchJob | null> {
  const row = await db.prepare(
    `${SELECT}
     WHERE kind = 'VISUAL_EXTRACTION'
       AND json_extract(input_json, '$.extractionRunId') = ?
       AND status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'BLOCKED')
       AND dismissed_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`
  ).bind(extractionRunId).first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function getResearchJob(db: D1Database, id: string): Promise<ResearchJob | null> {
  const row = await db.prepare(`${SELECT} WHERE id = ?`).bind(id).first<JobRow>();
  return row ? mapJob(row) : null;
}

export async function listResearchJobs(db: D1Database, requestedBy: string, limit = 20): Promise<ResearchJob[]> {
  const rows = await db.prepare(`${SELECT} WHERE (requested_by = ? OR requested_by IS NULL) AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT ?`).bind(requestedBy, Math.min(50, Math.max(1, limit))).all<JobRow>();
  return (rows.results ?? []).map(mapJob);
}

export async function setWorkflowInstanceId(db: D1Database, id: string, workflowInstanceId: string): Promise<void> {
  await db.prepare("UPDATE research_jobs SET workflow_instance_id = ?, error_code = NULL, updated_at = ? WHERE id = ? AND workflow_instance_id IS NULL AND status = 'QUEUED'").bind(workflowInstanceId, new Date().toISOString(), id).run();
}

export async function markDispatchPending(db: D1Database, id: string, error = "workflow_create_failed"): Promise<void> {
  await db.prepare("UPDATE research_jobs SET error_code = 'dispatch_pending', error = ?, updated_at = ? WHERE id = ? AND status = 'QUEUED'")
    .bind(error.slice(0, 300), new Date().toISOString(), id).run();
}

export async function markJobRunning(db: D1Database, id: string, message = "작업을 시작했습니다."): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE research_jobs SET status = 'RUNNING', progress = MAX(progress, 5), message = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('QUEUED', 'RUNNING')").bind(message, now, now, id).run();
}

export async function updateJobProgress(db: D1Database, id: string, progress: number, message: string): Promise<void> {
  await db.prepare("UPDATE research_jobs SET progress = ?, message = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'").bind(Math.max(0, Math.min(100, Math.round(progress))), message.slice(0, 200), new Date().toISOString(), id).run();
}

export async function completeResearchJob(db: D1Database, id: string, result: unknown, resultRef: ResearchJobResultRef | null): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE research_jobs SET status = 'SUCCEEDED', progress = 100, message = '완료', result_json = ?, result_ref_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'RUNNING'").bind(JSON.stringify(result ?? null), JSON.stringify(resultRef ?? null), now, now, id).run();
}

export async function failResearchJob(db: D1Database, id: string, errorCode: string, error: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE research_jobs SET status = 'FAILED', error_code = ?, error = ?, message = '작업에 실패했습니다.', finished_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'BLOCKED')").bind(errorCode.slice(0, 100), error.slice(0, 300), now, now, id).run();
}

export async function blockResearchJob(db: D1Database, id: string, errorCode: string, error: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare("UPDATE research_jobs SET status = 'BLOCKED', error_code = ?, error = ?, message = '설정 확인이 필요합니다.', finished_at = ?, updated_at = ? WHERE id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'BLOCKED')").bind(errorCode.slice(0, 100), error.slice(0, 300), now, now, id).run();
}

export async function dismissResearchJob(db: D1Database, id: string, requestedBy: string): Promise<boolean> {
  const result = await db.prepare("UPDATE research_jobs SET dismissed_at = ?, updated_at = ? WHERE id = ? AND (requested_by = ? OR requested_by IS NULL)").bind(new Date().toISOString(), new Date().toISOString(), id, requestedBy).run();
  return Boolean(result.meta.changes);
}
