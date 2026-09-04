import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callDistillWithBudget, estimateDistillCallUsd } from "./callWithBudget";

function testEnv(): Env {
  return {
    DB: env.DB,
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://openai.test/v1",
    MODEL_HIGH: "gpt-5-mini",
    MODEL_LOW: "gpt-5-mini",
    MODEL_DEEP: "gpt-5.4-mini",
    MODEL_PRICING_JSON: JSON.stringify({ "gpt-5-mini": { input: 0.25, output: 2 } }),
    MODEL_UNKNOWN_INPUT_USD: "5",
    MODEL_UNKNOWN_OUTPUT_USD: "30",
    MONTHLY_BUDGET_USD: "10",
  } as unknown as Env;
}

async function insertRunningJob(id: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO research_jobs
     (id, kind, status, progress, input_json, requested_by, dedupe_key, created_at, started_at, updated_at)
     VALUES (?, 'DISTILL_RUN', 'RUNNING', 20, '{}', 'test', ?, ?, ?, ?)`,
  ).bind(id, `budget-wrapper:${id}`, now, now, now).run();
}

describe("Distill AI budget wrapper", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("estimates UTF-8 input and output reservation monotonically", () => {
    const pricing = { input: 0.25, output: 2 };
    const english = [{ role: "user" as const, content: "hello" }];
    const korean = [{ role: "user" as const, content: "안녕하세요 👋" }];

    expect(estimateDistillCallUsd(english, 6500, pricing)).toBeGreaterThan(0);
    expect(estimateDistillCallUsd(korean, 6500, pricing)).toBeGreaterThan(estimateDistillCallUsd(english, 6500, pricing));
    expect(estimateDistillCallUsd(english, 6500, pricing)).toBeGreaterThan(estimateDistillCallUsd(english, 4000, pricing));
    expect(estimateDistillCallUsd([{ role: "user", content: "hello world" }], 4000, pricing)).toBeGreaterThan(estimateDistillCallUsd(english, 4000, pricing));
  });

  it("rejects invalid output limits and prices before provider access", () => {
    const messages = [{ role: "user" as const, content: "hello" }];

    expect(() => estimateDistillCallUsd(messages, 0, { input: 0.25, output: 2 })).toThrow("invalid_distill_output_limit");
    expect(() => estimateDistillCallUsd(messages, 4000, { input: Number.NaN, output: 2 })).toThrow("invalid_distill_pricing");
    expect(() => estimateDistillCallUsd(messages, 4000, { input: 0.25, output: Number.POSITIVE_INFINITY })).toThrow("invalid_distill_pricing");
  });

  it("reserves the calculated amount and requires a research job before fetch", async () => {
    const envForTest = testEnv();
    const jobId = `budget-wrapper-${crypto.randomUUID()}`;
    await insertRunningJob(jobId);
    const messages = [{ role: "user" as const, content: "안녕하세요 👋" }];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "provider-budget-wrapper",
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })));

    await callDistillWithBudget(envForTest, {
      purpose: "distill",
      researchJobId: jobId,
      workflowStep: "distill-primary",
      promptVersion: "distill-v1",
      modelId: "gpt-5-mini",
      maxOutputTokens: 6500,
      messages,
    });

    const attempt = await env.DB.prepare("SELECT reserved_usd AS reservedUsd FROM ai_call_attempts WHERE research_job_id = ?")
      .bind(jobId).first<{ reservedUsd: number }>();
    expect(Number(attempt?.reservedUsd)).toBe(estimateDistillCallUsd(messages, 6500, { input: 0.25, output: 2 }));

    const fetchMock = vi.mocked(fetch);
    await expect(callDistillWithBudget(envForTest, {
      purpose: "distill",
      maxOutputTokens: 6500,
      messages,
    } as never)).rejects.toThrow("distill_research_job_required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent Distill call when the remaining budget fits one reservation", async () => {
    const envForTest = testEnv();
    const month = new Date().toISOString().slice(0, 7);
    const firstJob = `budget-race-a-${crypto.randomUUID()}`;
    const secondJob = `budget-race-b-${crypto.randomUUID()}`;
    await Promise.all([insertRunningJob(firstJob), insertRunningJob(secondJob)]);
    await env.DB.prepare(
      `INSERT INTO ai_usage (id, month, provider, model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, 'openai', 'gpt-5-mini', 'existing', 0, 0, 9.98, ?)`,
    ).bind(`budget-race-used-${crypto.randomUUID()}`, month, new Date().toISOString()).run();

    let releaseFirstFetch!: () => void;
    let markFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => { markFirstFetch = resolve; });
    const firstFetchReleased = new Promise<void>((resolve) => { releaseFirstFetch = resolve; });
    let providerBoundaryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerBoundaryCalls += 1;
      markFirstFetch();
      await firstFetchReleased;
      return Response.json({ id: `provider-budget-race-${providerBoundaryCalls}`, choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }));

    const invoke = (researchJobId: string) => callDistillWithBudget(envForTest, {
      purpose: "distill",
      researchJobId,
      workflowStep: "distill-primary",
      promptVersion: "distill-v1",
      modelId: "gpt-5-mini",
      maxOutputTokens: 6500,
      messages: [{ role: "user", content: "Return an empty JSON object." }],
    });
    const first = invoke(firstJob);
    await firstFetchStarted;
    const second = invoke(secondJob).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstFetch();
    await Promise.allSettled([first, second]);

    expect(providerBoundaryCalls).toBe(1);
  });
});
