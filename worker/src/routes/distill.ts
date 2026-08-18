import { Hono } from "hono";
import { loadParams } from "../lib/params";
import { budgetPct, runDistill } from "../distill/run";

const distill = new Hono<{ Bindings: Env }>();

distill.get("/budget", async (c) => {
  const pct = await budgetPct(c.env);
  return c.json({
    usedPct: Math.round(pct * 10) / 10,
    budgetUsd: parseFloat(c.env.MONTHLY_BUDGET_USD) || 10,
    blocked: pct >= 100,
    warn: pct >= 80,
  });
});

distill.post("/run", async (c) => {
  const body = (await c.req.json<{ redistillOf?: string; keepElements?: string[] }>().catch(() => ({}))) as {
    redistillOf?: string;
    keepElements?: string[];
  };
  const params = await loadParams(c.env.DB);
  try {
    const result = await runDistill(c.env, params, {
      redistillOf: body.redistillOf,
      keepElements: body.keepElements,
    });
    if (!result.ok) return c.json(result, 429);
    return c.json(result);
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    console.error(JSON.stringify({ level: "error", scope: "distill:run", message }));
    return c.json({ ok: false, error: message }, 500);
  }
});

distill.get("/sessions", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, redistill_of AS redistillOf, cost_usd AS costUsd, model_version AS modelVersion,
            prompt_version AS promptVersion, created_at AS createdAt
     FROM distill_sessions ORDER BY created_at DESC LIMIT 30`
  ).all<Record<string, unknown>>();
  return c.json({ sessions: rows.results ?? [] });
});

distill.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare(
      `SELECT id, input_context_json, sources_used_json, output_json, critic_output_json, counter_output_json,
              user_selection_json, redistill_of AS redistillOf, model_version AS modelVersion,
              prompt_version AS promptVersion, cost_usd AS costUsd, created_at AS createdAt
       FROM distill_sessions WHERE id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };

  const [queue, gaps] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, title, author, priority, why_read AS whyRead, related_question AS relatedQuestion, source_url AS sourceUrl
         FROM reading_queue WHERE distill_session_id = ?`
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    c.env.DB
      .prepare(`SELECT id, gap_text AS gap, kind FROM research_gaps WHERE distill_session_id = ?`)
      .bind(id)
      .all<Record<string, unknown>>(),
  ]);

  return c.json({
    session: {
      id: row.id,
      redistillOf: row.redistillOf,
      modelVersion: row.modelVersion,
      promptVersion: row.promptVersion,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
      sourcesUsed: parse(row.sources_used_json),
      output: parse(row.output_json),
      critic: parse(row.critic_output_json),
      counter: parse(row.counter_output_json),
      userSelection: parse(row.user_selection_json),
    },
    readingQueue: queue.results ?? [],
    researchGaps: gaps.results ?? [],
  });
});

distill.post("/sessions/:id/select", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ kept?: string[]; note?: string }>().catch(() => null);
  if (!body?.kept) return c.json({ error: "kept_required" }, 400);
  const ts = new Date().toISOString();
  await c.env.DB
    .prepare("UPDATE distill_sessions SET user_selection_json = ?, created_at = created_at WHERE id = ?")
    .bind(JSON.stringify({ kept: body.kept, note: body.note ?? null, at: ts }), id)
    .run();
  return c.json({ ok: true });
});

export default distill;
