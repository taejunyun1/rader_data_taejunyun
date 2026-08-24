import { loadModelRoles, pricingForModel } from "../lib/modelSettings";
import { chunkText } from "./deepPrompt";
import { profileFor, type DeepProfile } from "./deepProfiles";

const DEEP_CHUNK_CHARS = 24_000;
const DEEP_MAX_CHUNKS = 4;
const DEEP_CHUNK_OUTPUT_TOKENS = 2_600;
const DEEP_SYNTHESIS_OUTPUT_TOKENS = 4_200;
const PROMPT_OVERHEAD_TOKENS = 2_000;

type ReservationResult =
  | { ok: true; reservationId: string; amountUsd: number }
  | { ok: false };

export async function deepAnalysisReservationUsd(env: Env, profile: DeepProfile): Promise<number> {
  const definition = profileFor(profile);
  const roles = await loadModelRoles(env.DB, env);
  const basePrice = pricingForModel(env, roles.baseModel);
  const reviewPrice = pricingForModel(env, roles.reviewModel);
  const placeholder = "x".repeat(definition.maxChars);
  const chunks = chunkText(placeholder, DEEP_CHUNK_CHARS, Math.ceil(definition.maxChars / DEEP_CHUNK_CHARS)).slice(0, DEEP_MAX_CHUNKS);
  const chunkInputTokens = chunks.reduce((sum, chunk) => sum + chunk.length + PROMPT_OVERHEAD_TOKENS, 0);
  const synthesisInputTokens = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + PROMPT_OVERHEAD_TOKENS + (chunks.length * DEEP_CHUNK_OUTPUT_TOKENS);
  const chunkOutputTokens = chunks.length * DEEP_CHUNK_OUTPUT_TOKENS;
  const costUsd =
    (chunkInputTokens / 1e6) * basePrice.input +
    (chunkOutputTokens / 1e6) * basePrice.output +
    (synthesisInputTokens / 1e6) * reviewPrice.input +
    (DEEP_SYNTHESIS_OUTPUT_TOKENS / 1e6) * reviewPrice.output;
  return Math.ceil(costUsd * 100) / 100;
}

export async function reserveDeepAnalysisBudget(
  env: Env,
  input: { researchJobId: string; profile: DeepProfile },
): Promise<ReservationResult> {
  const amountUsd = await deepAnalysisReservationUsd(env, input.profile);
  const budgetUsd = parseFloat(env.MONTHLY_BUDGET_USD) || 10;
  const month = new Date().toISOString().slice(0, 7);
  const createdAt = new Date().toISOString();
  const reservationId = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO ai_budget_reservations (id, month, research_job_id, amount_usd, status, created_at)
     SELECT ?, ?, ?, ?, 'RESERVED', ?
     WHERE NOT EXISTS (
       SELECT 1 FROM ai_budget_reservations WHERE research_job_id = ?
     )
       AND COALESCE((SELECT SUM(cost_usd) FROM ai_usage WHERE month = ?), 0)
         + COALESCE((SELECT SUM(amount_usd) FROM ai_budget_reservations
                     WHERE month = ? AND status = 'RESERVED'), 0)
         + ? <= ?`
  )
    .bind(reservationId, month, input.researchJobId, amountUsd, createdAt, input.researchJobId, month, month, amountUsd, budgetUsd)
    .run();

  if (result.meta.changes) return { ok: true, reservationId, amountUsd };

  const existing = await env.DB.prepare(
    `SELECT id, amount_usd
     FROM ai_budget_reservations
     WHERE research_job_id = ? AND status = 'RESERVED'
     LIMIT 1`
  )
    .bind(input.researchJobId)
    .first<{ id: string; amount_usd: number }>();

  return existing ? { ok: true, reservationId: existing.id, amountUsd: Number(existing.amount_usd) } : { ok: false };
}

export async function releaseDeepAnalysisBudgetReservation(
  db: D1Database,
  researchJobId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE ai_budget_reservations
     SET status = 'RELEASED', released_at = ?
     WHERE research_job_id = ? AND status = 'RESERVED'`
  )
    .bind(new Date().toISOString(), researchJobId)
    .run();
}
