import { Hono } from "hono";
import type { UserAction } from "@radar/shared";
import { uuid } from "../ingestion/ids";

const VALID_ACTIONS = new Set<string>(["select", "keep", "watch", "develop", "ignore", "view"]);

const signals = new Hono<{ Bindings: Env }>();

signals.post("/", async (c) => {
  const body = await c.req.json<{ sourceId?: string; action?: string }>().catch(() => null);
  const sourceId = body?.sourceId;
  const action = body?.action as UserAction | undefined;

  if (!sourceId || !action || !VALID_ACTIONS.has(action)) {
    return c.json({ error: "sourceId_and_valid_action_required" }, 400);
  }

  const src = await c.env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first<{ id: string }>();
  if (!src) return c.json({ error: "not_found" }, 404);

  await c.env.DB
    .prepare(
      `INSERT INTO user_signals (id, source_id, action, weight, context, created_at)
       VALUES (?, ?, ?, 1.0, 'ui', ?)`
    )
    .bind(uuid(), sourceId, action, new Date().toISOString())
    .run();

  return c.json({ ok: true, sourceId, action });
});

signals.get("/summary", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT action, COUNT(*) AS n FROM user_signals GROUP BY action ORDER BY n DESC`
  ).all<{ action: string; n: number }>();
  return c.json({ summary: rows.results ?? [] });
});

export default signals;
