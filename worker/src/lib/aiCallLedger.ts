import { uuid } from "../ingestion/ids";

export type AiCallAttemptStatus = "RESERVED" | "CALLED" | "SETTLED" | "FAILED" | "SETTLEMENT_PENDING";

export interface AiCallAttempt {
  id: string;
  researchJobId: string;
  idempotencyKey: string;
  purpose: string;
  model: string;
  status: AiCallAttemptStatus;
  reservedUsd: number;
  actualUsd: number | null;
  providerRequestId: string | null;
  responseText: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface ReserveAiCallInput {
  researchJobId: string;
  idempotencyKey: string;
  purpose: string;
  model: string;
  reservedUsd: number;
  budgetUsd: number;
}

function mapRow(row: Record<string, unknown>): AiCallAttempt {
  return {
    id: String(row.id),
    researchJobId: String(row.researchJobId),
    idempotencyKey: String(row.idempotencyKey),
    purpose: String(row.purpose),
    model: String(row.model),
    status: String(row.status) as AiCallAttemptStatus,
    reservedUsd: Number(row.reservedUsd ?? 0),
    actualUsd: row.actualUsd == null ? null : Number(row.actualUsd),
    providerRequestId: row.providerRequestId == null ? null : String(row.providerRequestId),
    responseText: row.responseText == null ? null : String(row.responseText),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
  };
}

const SELECT = `SELECT id, research_job_id AS researchJobId, idempotency_key AS idempotencyKey,
  purpose, model, status, reserved_usd AS reservedUsd, actual_usd AS actualUsd,
  provider_request_id AS providerRequestId, response_text AS responseText,
  input_tokens AS inputTokens, output_tokens AS outputTokens
  FROM ai_call_attempts`;

export function deterministicAiCallKey(input: {
  researchJobId: string;
  purpose: string;
  workflowStep: string;
  promptVersion: string;
}): string {
  return [input.researchJobId, input.purpose, input.workflowStep, input.promptVersion].join(":");
}

export async function reserveAiCall(db: D1Database, input: ReserveAiCallInput): Promise<{ ok: boolean; attempt: AiCallAttempt | null }> {
  const existing = await db.prepare(`${SELECT} WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<Record<string, unknown>>();
  if (existing) return { ok: existing.status === "SETTLED" || existing.status === "RESERVED" || existing.status === "CALLED" || existing.status === "SETTLEMENT_PENDING", attempt: mapRow(existing) };

  const reservedUsd = Math.max(0, Number(input.reservedUsd) || 0);
  const now = new Date().toISOString();
  const month = now.slice(0, 7);
  const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString();
  const result = await db.prepare(
    `INSERT INTO ai_call_attempts
      (id, research_job_id, idempotency_key, purpose, model, status, reserved_usd, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?
     WHERE COALESCE((SELECT SUM(cost_usd) FROM ai_usage WHERE month = ?), 0)
       + COALESCE((SELECT SUM(amount_usd) FROM ai_budget_reservations WHERE month = ? AND status = 'RESERVED'), 0)
       + COALESCE((SELECT SUM(reserved_usd) FROM ai_call_attempts
                  WHERE status IN ('RESERVED', 'CALLED', 'SETTLEMENT_PENDING')
                    AND created_at >= ? AND created_at < ?), 0)
       + ? <= ?`
  ).bind(uuid(), input.researchJobId, input.idempotencyKey, input.purpose, input.model, reservedUsd, now, now, month, month, new Date(`${month}-01T00:00:00.000Z`).toISOString(), nextMonth, reservedUsd, input.budgetUsd).run();

  const attempt = await db.prepare(`${SELECT} WHERE idempotency_key = ?`).bind(input.idempotencyKey).first<Record<string, unknown>>();
  return { ok: Boolean(result.meta.changes) || Boolean(attempt), attempt: attempt ? mapRow(attempt) : null };
}

export async function markAiCallCalled(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE ai_call_attempts SET status = 'CALLED', updated_at = ? WHERE id = ? AND status = 'RESERVED'")
    .bind(new Date().toISOString(), id).run();
}

export async function markAiCallSettlementPending(db: D1Database, id: string, providerRequestId: string | null): Promise<void> {
  await db.prepare("UPDATE ai_call_attempts SET status = 'SETTLEMENT_PENDING', provider_request_id = ?, updated_at = ? WHERE id = ? AND status IN ('RESERVED', 'CALLED')")
    .bind(providerRequestId, new Date().toISOString(), id).run();
}

export async function settleAiCall(db: D1Database, input: {
  id: string;
  month: string;
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  actualUsd: number;
  providerRequestId: string | null;
  responseText: string;
  provider?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO ai_usage
       (id, month, provider, model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(`ai-call:${input.id}`, input.month, input.provider ?? "openai", input.model, input.purpose, input.inputTokens, input.outputTokens, Math.max(0, input.actualUsd), now),
    db.prepare(
      `UPDATE ai_call_attempts
       SET status = 'SETTLED', actual_usd = ?, provider_request_id = ?, response_text = ?,
           input_tokens = ?, output_tokens = ?, settled_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('CALLED', 'SETTLEMENT_PENDING', 'RESERVED')`
    ).bind(Math.max(0, input.actualUsd), input.providerRequestId, input.responseText, input.inputTokens, input.outputTokens, now, now, input.id),
  ]);
}

export async function withAiCallLedger<T>(db: D1Database, input: ReserveAiCallInput, execute: () => Promise<T>, responseText: (result: T) => string): Promise<T> {
  const reservation = await reserveAiCall(db, input);
  if (!reservation.ok || !reservation.attempt) throw new Error("monthly_budget_exhausted");
  if (reservation.attempt.status === "SETTLED") throw new Error("ai_call_already_settled");
  await markAiCallCalled(db, reservation.attempt.id);
  try {
    const result = await execute();
    await markAiCallSettlementPending(db, reservation.attempt.id, null);
    try {
      await settleAiCall(db, {
        id: reservation.attempt.id,
        month: new Date().toISOString().slice(0, 7),
        model: input.model,
        purpose: input.purpose,
        inputTokens: 0,
        outputTokens: 0,
        actualUsd: 0,
        providerRequestId: null,
        responseText: responseText(result),
        provider: "cloudflare",
      });
    } catch {
      throw new Error("usage_settlement_required");
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "usage_settlement_required") throw error;
    await markAiCallFailed(db, reservation.attempt.id, error instanceof Error ? error.message : "ai_provider_failed");
    throw error;
  }
}

export async function markAiCallFailed(db: D1Database, id: string, errorCode: string): Promise<void> {
  await db.prepare("UPDATE ai_call_attempts SET status = 'FAILED', error_code = ?, updated_at = ? WHERE id = ? AND status NOT IN ('SETTLED', 'FAILED')")
    .bind(errorCode.slice(0, 100), new Date().toISOString(), id).run();
}

export async function releaseStaleAiCallReservations(db: D1Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const result = await db.prepare(
    `UPDATE ai_call_attempts
     SET status = 'FAILED', error_code = 'reservation_expired', updated_at = ?
     WHERE status = 'RESERVED' AND updated_at < ?
       AND research_job_id IN (SELECT id FROM research_jobs WHERE status IN ('SUCCEEDED', 'FAILED', 'BLOCKED'))`
  ).bind(now.toISOString(), cutoff).run();
  return result.meta.changes ?? 0;
}
