import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenAi } from "../src/lib/openai";

function openAiTestEnv(): Env {
  return {
    DB: env.DB,
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://openai.test/v1",
    MODEL_HIGH: "gpt-5-mini",
    MODEL_LOW: "gpt-5-mini",
    MODEL_DEEP: "gpt-5.4-mini",
    MODEL_PRICING_JSON: JSON.stringify({
      "gpt-5-mini": { input: 0.25, output: 2 },
    }),
    MODEL_UNKNOWN_INPUT_USD: "5",
    MODEL_UNKNOWN_OUTPUT_USD: "30",
    MONTHLY_BUDGET_USD: "10",
  } as Env;
}

async function insertRunningJob(id: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO research_jobs
     (id, kind, status, progress, input_json, requested_by, dedupe_key, created_at, started_at, updated_at)
     VALUES (?, 'DISTILL_RUN', 'RUNNING', 20, '{}', 'test', ?, ?, ?, ?)`,
  ).bind(id, `test:${id}`, now, now, now).run();
}

describe("AI call settlement ledger", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lets at most one provider call cross the boundary when $9.90 is used and two $0.20 reservations race", async () => {
    const month = new Date().toISOString().slice(0, 7);
    await Promise.all([insertRunningJob("ai-race-job-1"), insertRunningJob("ai-race-job-2")]);
    await env.DB.prepare(
      `INSERT INTO ai_usage
       (id, month, provider, model, purpose, input_tokens, output_tokens, cost_usd, created_at)
       VALUES ('ai-race-used', ?, 'openai', 'gpt-5-mini', 'existing', 0, 0, 9.90, ?)`,
    ).bind(month, new Date().toISOString()).run();

    let providerBoundaryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      providerBoundaryCalls += 1;
      return Response.json({
        id: `provider-${providerBoundaryCalls}`,
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }));

    const invoke = (researchJobId: string) => callOpenAi(openAiTestEnv(), {
      purpose: "distill",
      researchJobId,
      workflowStep: "distill-primary",
      promptVersion: "distill-v1",
      reservationUsd: 0.20,
      modelId: "gpt-5-mini",
      jsonMode: true,
      messages: [{ role: "user", content: "Return an empty JSON object." }],
    });

    await Promise.allSettled([
      invoke("ai-race-job-1"),
      invoke("ai-race-job-2"),
    ]);

    expect(providerBoundaryCalls).toBeLessThanOrEqual(1);
  });

  it("settles actual provider usage and makes a replay return the persisted response", async () => {
    await insertRunningJob("ai-settlement-job");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      id: "provider-settlement-1",
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    })));
    const options = {
      purpose: "distill",
      researchJobId: "ai-settlement-job",
      workflowStep: "distill-primary",
      promptVersion: "distill-v1",
      reservationUsd: 0.20,
      modelId: "gpt-5-mini" as const,
      jsonMode: true,
      messages: [{ role: "user" as const, content: "Return an empty JSON object." }],
    };

    const settlementEnv = { ...openAiTestEnv(), MONTHLY_BUDGET_USD: "20" } as Env;
    const first = await callOpenAi(settlementEnv, options);
    const replay = await callOpenAi(settlementEnv, options);
    const attempt = await env.DB.prepare("SELECT status, actual_usd AS actualUsd, response_text AS responseText FROM ai_call_attempts WHERE research_job_id = ?")
      .bind("ai-settlement-job").first<{ status: string; actualUsd: number; responseText: string }>();
    const usage = await env.DB.prepare("SELECT provider, cost_usd AS costUsd FROM ai_usage WHERE id = ?")
      .bind("ai-call:" + (await env.DB.prepare("SELECT id FROM ai_call_attempts WHERE research_job_id = ?").bind("ai-settlement-job").first<{ id: string }>())?.id).first<{ provider: string; costUsd: number }>();

    expect(first.text).toBe(replay.text);
    expect(attempt).toMatchObject({ status: "SETTLED", responseText: '{"ok":true}' });
    expect(Number(attempt?.actualUsd)).toBeGreaterThan(0);
    expect(usage).toMatchObject({ provider: "openai" });
    expect(Number(usage?.costUsd)).toBe(Number(first.costUsd));
  });
});
