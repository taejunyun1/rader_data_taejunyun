import { loadModelRoles, openAiHeaders, pricingForModel } from "./modelSettings";
import { deterministicAiCallKey, markAiCallCalled, markAiCallFailed, markAiCallSettlementPending, reserveAiCall, settleAiCall } from "./aiCallLedger";

export interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCallOptions {
  purpose: string;
  messages: OpenAiMessage[];
  model?: "high" | "low" | "deep";
  modelId?: string;
  jsonMode?: boolean;
  maxOutputTokens?: number;
  researchJobId?: string;
  workflowStep?: string;
  promptVersion?: string;
  reservationUsd?: number;
}

export interface OpenAiCallResult {
  text: string;
  costUsd: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  pricingKnown: boolean;
}

interface ChatCompletionResponse {
  choices?: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
  id?: string;
}

export async function callOpenAi(env: Env, opts: OpenAiCallOptions): Promise<OpenAiCallResult> {
  const tier = opts.model ?? "high";
  const model = opts.modelId ?? await resolveModelId(env, tier);
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;

  const idempotencyKey = opts.researchJobId
    ? deterministicAiCallKey({
      researchJobId: opts.researchJobId,
      purpose: opts.purpose,
      workflowStep: opts.workflowStep ?? opts.purpose,
      promptVersion: opts.promptVersion ?? "v1",
    })
    : null;
  const ledger = idempotencyKey
    ? await reserveAiCall(env.DB, {
      researchJobId: opts.researchJobId!,
      idempotencyKey,
      purpose: opts.purpose,
      model,
      reservedUsd: opts.reservationUsd ?? 0.01,
      budgetUsd: parseFloat(env.MONTHLY_BUDGET_USD) || 10,
    })
    : null;
  if (idempotencyKey && (!ledger?.ok || !ledger.attempt)) throw new Error("monthly_budget_exhausted");
  if (ledger?.attempt?.status === "SETTLED" && ledger.attempt.responseText != null) {
    return {
      text: ledger.attempt.responseText,
      costUsd: ledger.attempt.actualUsd ?? 0,
      model: ledger.attempt.model,
      inputTokens: ledger.attempt.inputTokens,
      outputTokens: ledger.attempt.outputTokens,
      pricingKnown: pricingForModel(env, ledger.attempt.model).known,
    };
  }
  if (ledger?.attempt) await markAiCallCalled(env.DB, ledger.attempt.id);

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (opts.maxOutputTokens) body.max_completion_tokens = opts.maxOutputTokens;

  const headers = openAiHeaders(env);
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (ledger?.attempt) await markAiCallFailed(env.DB, ledger.attempt.id, `openai_error_${res.status}`);
    throw new Error(`openai_error_${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  const price = pricingForModel(env, model);
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  if (ledger?.attempt) {
    await markAiCallSettlementPending(env.DB, ledger.attempt.id, data.id ?? null);
    try {
      await settleAiCall(env.DB, {
        id: ledger.attempt.id,
        month: new Date().toISOString().slice(0, 7),
        model,
        purpose: opts.purpose,
        inputTokens,
        outputTokens,
        actualUsd: costUsd,
        providerRequestId: data.id ?? null,
        responseText: text,
      });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", scope: "ai-usage-settlement", idempotencyKey, message: error instanceof Error ? error.message : String(error) }));
      throw new Error("usage_settlement_required");
    }
  } else {
    await recordAiUsage(env, { purpose: opts.purpose, model, inputTokens, outputTokens, costUsd });
  }

  return { text, costUsd, model, inputTokens, outputTokens, pricingKnown: price.known };
}

async function resolveModelId(env: Env, tier: "high" | "low" | "deep"): Promise<string> {
  if (tier === "low") return env.MODEL_LOW;
  const roles = await loadModelRoles(env.DB, env);
  return tier === "deep" ? roles.reviewModel : roles.baseModel;
}

async function recordAiUsage(
  env: Env,
  u: { purpose: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }
): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO ai_usage (id, month, provider, model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, month, u.model, u.purpose, u.inputTokens, u.outputTokens, u.costUsd, new Date().toISOString())
    .run();
}

export async function monthSpendUsd(env: Env): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const row = await env.DB
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE month = ?")
    .bind(month)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
