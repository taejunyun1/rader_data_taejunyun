import { Hono } from "hono";
import { monthSpendUsd } from "../lib/openai";

const usage = new Hono<{ Bindings: Env }>();

usage.get("/summary", async (c) => {
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const budgetUsd = parseFloat(c.env.MONTHLY_BUDGET_USD) || 10;

  const byPurpose = await c.env.DB
    .prepare(
      `SELECT purpose, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              SUM(cost_usd) AS costUsd
       FROM ai_usage WHERE month = ? GROUP BY purpose ORDER BY costUsd DESC`
    )
    .bind(month)
    .all<Record<string, number | string>>();

  const byModel = await c.env.DB
    .prepare(
      `SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS costUsd
       FROM ai_usage WHERE month = ? GROUP BY model ORDER BY costUsd DESC`
    )
    .bind(month)
    .all<Record<string, number | string>>();

  const daily = await c.env.DB
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, SUM(cost_usd) AS costUsd, COUNT(*) AS calls
       FROM ai_usage WHERE month = ? GROUP BY day ORDER BY day`
    )
    .bind(month)
    .all<Record<string, number | string>>();

  const totals = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens, SUM(cost_usd) AS costUsd
       FROM ai_usage WHERE month = ?`
    )
    .bind(month)
    .first<Record<string, number | null>>();

  const months = await c.env.DB
    .prepare(`SELECT month, SUM(cost_usd) AS costUsd, COUNT(*) AS calls FROM ai_usage GROUP BY month ORDER BY month DESC LIMIT 12`)
    .all<{ month: string; costUsd: number; calls: number }>();

  const distillCount = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n, COALESCE(AVG(cost_usd), 0) AS avgCost FROM distill_sessions WHERE substr(created_at, 1, 7) = ?`)
    .bind(month)
    .first<{ n: number; avgCost: number }>();

  const totalCost = totals?.costUsd ?? 0;
  return c.json({
    month,
    budgetUsd,
    usedUsd: Math.round(totalCost * 10000) / 10000,
    usedPct: Math.round((totalCost / budgetUsd) * 1000) / 10,
    calls: totals?.calls ?? 0,
    inputTokens: totals?.inputTokens ?? 0,
    outputTokens: totals?.outputTokens ?? 0,
    distillSessions: distillCount?.n ?? 0,
    distillAvgCost: distillCount?.avgCost ?? 0,
    byPurpose: byPurpose.results ?? [],
    byModel: byModel.results ?? [],
    daily: daily.results ?? [],
    months: months.results ?? [],
  });
});

export default usage;
