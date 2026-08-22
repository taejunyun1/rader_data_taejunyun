export interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCallOptions {
  purpose: string;
  messages: OpenAiMessage[];
  model?: "high" | "low" | "deep";
  jsonMode?: boolean;
  maxOutputTokens?: number;
}

export interface OpenAiCallResult {
  text: string;
  costUsd: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface ChatCompletionResponse {
  choices?: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
}

const PRICE_PER_M_HIGH = { input: 0.25, output: 2 };
const PRICE_PER_M_LOW = { input: 0.1, output: 0.4 };
const PRICE_PER_M_DEEP = { input: 0.75, output: 4.5 };

export async function callOpenAi(env: Env, opts: OpenAiCallOptions): Promise<OpenAiCallResult> {
  const tier = opts.model ?? "high";
  const model = tier === "high" ? env.MODEL_HIGH : tier === "deep" ? (env.MODEL_DEEP || env.MODEL_HIGH) : env.MODEL_LOW;
  const url = `${env.OPENAI_BASE_URL}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
  };
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (opts.maxOutputTokens) body.max_completion_tokens = opts.maxOutputTokens;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`openai_error_${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  const price = tier === "deep" ? PRICE_PER_M_DEEP : tier === "high" ? PRICE_PER_M_HIGH : PRICE_PER_M_LOW;
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  await recordAiUsage(env, {
    purpose: opts.purpose,
    model,
    inputTokens,
    outputTokens,
    costUsd,
  });

  return { text, costUsd, model, inputTokens, outputTokens };
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
    .run()
    .catch(() => undefined);
}

export async function monthSpendUsd(env: Env): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  const row = await env.DB
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE month = ?")
    .bind(month)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
