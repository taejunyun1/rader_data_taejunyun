export interface OpenAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenAiCallOptions {
  purpose: string;
  messages: OpenAiMessage[];
  model?: "high" | "low";
  jsonMode?: boolean;
  maxOutputTokens?: number;
}

interface ChatCompletionResponse {
  choices?: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { message: string };
}

const PRICE_PER_M_HIGH = { input: 0.4, output: 1.6 };
const PRICE_PER_M_LOW = { input: 0.1, output: 0.4 };

export async function callOpenAi(env: Env, opts: OpenAiCallOptions): Promise<{ text: string; costUsd: number; model: string }> {
  const tier = opts.model ?? "high";
  const model = tier === "high" ? env.MODEL_HIGH : env.MODEL_LOW;
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
  const price = tier === "high" ? PRICE_PER_M_HIGH : PRICE_PER_M_LOW;
  const inputTokens = data.usage?.prompt_tokens ?? 0;
  const outputTokens = data.usage?.completion_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  return { text, costUsd, model };
}
