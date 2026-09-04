import { loadModelRoles, pricingForModel } from "../lib/modelSettings";
import type { OpenAiCallOptions, OpenAiCallResult, OpenAiMessage } from "../lib/openai";
import { callOpenAi } from "../lib/openai";

export type BudgetedDistillOptions = OpenAiCallOptions & {
  maxOutputTokens: number;
  researchJobId: string;
};

export interface DistillPricing {
  input: number;
  output: number;
}

const INPUT_MESSAGE_OVERHEAD_TOKENS = 32;
const INPUT_REQUEST_OVERHEAD_TOKENS = 256;
const MAX_DISTILL_OUTPUT_TOKENS = 100_000;

export function estimateDistillCallUsd(messages: OpenAiMessage[], maxOutputTokens: number, pricing: DistillPricing): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > MAX_DISTILL_OUTPUT_TOKENS) {
    throw new Error("invalid_distill_output_limit");
  }
  if (!Number.isFinite(pricing.input) || pricing.input < 0 || !Number.isFinite(pricing.output) || pricing.output < 0) {
    throw new Error("invalid_distill_pricing");
  }
  const encoder = new TextEncoder();
  const inputEstimate = messages.reduce(
    (sum, message) => sum + encoder.encode(message.content).length + INPUT_MESSAGE_OVERHEAD_TOKENS,
    INPUT_REQUEST_OVERHEAD_TOKENS,
  );
  const estimatedUsd = ((inputEstimate * pricing.input) + (maxOutputTokens * pricing.output)) / 1e6;
  return Math.ceil(estimatedUsd * 1e6) / 1e6;
}

export async function callDistillWithBudget(env: Env, opts: BudgetedDistillOptions): Promise<OpenAiCallResult> {
  if (typeof opts.researchJobId !== "string" || !opts.researchJobId.trim()) throw new Error("distill_research_job_required");

  const model = opts.modelId ?? await resolveDistillModel(env, opts.model ?? "high");
  const pricing = pricingForModel(env, model);
  const calculatedReservation = estimateDistillCallUsd(opts.messages, opts.maxOutputTokens, pricing);
  const reservationUsd = Math.max(calculatedReservation, Number(opts.reservationUsd ?? 0));

  return callOpenAi(env, {
    ...opts,
    modelId: model,
    researchJobId: opts.researchJobId,
    reservationUsd,
  });
}

async function resolveDistillModel(env: Env, tier: "high" | "low" | "deep"): Promise<string> {
  if (tier === "low") return env.MODEL_LOW;
  const roles = await loadModelRoles(env.DB, env);
  return tier === "deep" ? roles.reviewModel : roles.baseModel;
}
