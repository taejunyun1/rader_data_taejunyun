import { Hono } from "hono";
import type { RadarPeriod } from "@radar/shared";
import { computeStats, saveSnapshot, saveSnapshotSynthesis, windowFor } from "../radar/snapshot";
import { synthesizeRadar } from "../radar/synthesize";
import { enqueueResearchJob } from "../jobs/enqueue";
import { verifiedRequester } from "../lib/httpErrors";
import { readJson } from "../lib/requestBody";

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
    `SELECT id, period, window_start AS windowStart, window_end AS windowEnd, stats_json AS statsJson,
            synthesis_json AS synthesisJson, synthesis_cost AS synthesisCost, created_at AS createdAt,
            invalidated_at AS invalidatedAt
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
    synthesis: (() => {
      try {
        return r.synthesisJson ? JSON.parse(String(r.synthesisJson)) : null;
      } catch {
        return null;
      }
    })(),
    statsJson: undefined,
    synthesisJson: undefined,
  }));
  return c.json({ snapshots });
});

radar.post("/synthesize", async (c) => {
  const body = (await readJson<{ period?: string }>(c)) ?? {};
  const period = (PERIODS.has(body.period ?? "") ? body.period : "WEEKLY") as RadarPeriod;
  try {
    const requestedBy = verifiedRequester(c);
    const result = await enqueueResearchJob(c.env, { kind: "RADAR_SYNTHESIS", input: { period } }, requestedBy);
    return c.json(result, 202);
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    console.error(JSON.stringify({ level: "error", scope: "radar:synthesize", message }));
    return c.json({ error: message }, 500);
  }
});

export default radar;
