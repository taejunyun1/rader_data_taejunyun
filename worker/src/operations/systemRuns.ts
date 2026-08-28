import { uuid } from "../ingestion/ids";

export type SystemRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "PARTIAL";

export interface SystemRun {
  id: string;
  kind: string;
  windowKey: string;
  status: SystemRunStatus;
  counts: Record<string, number> | null;
  result: unknown;
  errorCode: string | null;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mapRun(row: Record<string, unknown>): SystemRun {
  return {
    id: String(row.id),
    kind: String(row.kind),
    windowKey: String(row.windowKey),
    status: String(row.status) as SystemRunStatus,
    counts: parse(row.countsJson) as Record<string, number> | null,
    result: parse(row.resultJson),
    errorCode: row.errorCode == null ? null : String(row.errorCode),
  };
}

const SELECT = `SELECT id, kind, window_key AS windowKey, status,
  counts_json AS countsJson, result_json AS resultJson, error_code AS errorCode
  FROM system_runs`;

export async function beginSystemRun(db: D1Database, kind: string, windowKey: string): Promise<{ run: SystemRun; created: boolean }> {
  const now = new Date().toISOString();
  const id = uuid();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO system_runs (id, kind, window_key, status, started_at)
     VALUES (?, ?, ?, 'RUNNING', ?)`
  ).bind(id, kind, windowKey, now).run();
  const row = await db.prepare(`${SELECT} WHERE kind = ? AND window_key = ?`).bind(kind, windowKey).first<Record<string, unknown>>();
  if (!row) throw new Error("system_run_create_failed");
  return { run: mapRun(row), created: String(row.id) === id && Boolean(result.meta.changes) };
}

export async function finishSystemRun(db: D1Database, id: string, input: {
  status: Exclude<SystemRunStatus, "RUNNING">;
  counts?: Record<string, number>;
  result?: unknown;
  errorCode?: string | null;
}): Promise<void> {
  await db.prepare(
    `UPDATE system_runs
     SET status = ?, counts_json = ?, result_json = ?, error_code = ?, finished_at = ?
     WHERE id = ? AND status = 'RUNNING'`
  ).bind(input.status, JSON.stringify(input.counts ?? {}), JSON.stringify(input.result ?? null), input.errorCode ?? null, new Date().toISOString(), id).run();
}
