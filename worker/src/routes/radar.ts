import { Hono } from "hono";
import type { RadarPeriod } from "@radar/shared";
import { computeStats, windowFor } from "../radar/snapshot";
import { synthesizeRadar } from "../radar/synthesize";

const radar = new Hono<{ Bindings: Env }>();

const PERIODS = new Set<string>(["WEEKLY", "MONTHLY", "YEARLY"]);

radar.get("/stats", async (c) => {
  const period = (c.req.query("period") ?? "WEEKLY") as RadarPeriod;
  const { start, end } = windowFor(PERIODS.has(period) ? period : "WEEKLY");
  const stats = await computeStats(c.env.DB, start.toISOString(), end.toISOString());
  return c.json({ period, window: { start: start.toISOString(), end: end.toISOString() }, stats });
});

radar.get("/snapshots", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, period, window_start AS windowStart, window_end AS windowEnd, stats_json AS statsJson, created_at AS createdAt
     FROM radar_snapshots ORDER BY created_at DESC LIMIT 26`
  ).all<Record<string, unknown>>();
  const snapshots = (rows.results ?? []).map((r) => ({
    ...r,
    stats: (() => {
      try {
        return JSON.parse(String(r.statsJson ?? "{}"));
      } catch {
        return null;
      }
    })(),
    statsJson: undefined,
  }));
  return c.json({ snapshots });
});

radar.post("/synthesize", async (c) => {
  const body = (await c.req.json<{ period?: string }>().catch(() => ({}))) as { period?: string };
  const period = (PERIODS.has(body.period ?? "") ? body.period : "WEEKLY") as RadarPeriod;
  try {
    const result = await synthesizeRadar(c.env, period);
    return c.json(result);
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    console.error(JSON.stringify({ level: "error", scope: "radar:synthesize", message }));
    return c.json({ error: message }, 500);
  }
});

export default radar;
