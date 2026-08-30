import type { RadarPeriod } from "@radar/shared";
import { uuid } from "../ingestion/ids";
import type { RadarSynthesis } from "./types";

export interface SnapshotStats {
  newSources: number;
  newKeywords: { keyword: string; count: number }[];
  newQuestions: string[];
  signalCounts: Record<string, number>;
  topKeptSources: { title: string; kind: string }[];
  distillRuns: number;
  gapsRaised: number;
  readingQueueSize: number;
  kindBreakdown: Record<string, number>;
}

export function liveDistillSessionFilter(alias: string): string {
  return `(
    ${alias}.sources_used_json IS NULL
    OR (
      json_valid(${alias}.sources_used_json)
      AND json_array_length(CASE WHEN json_valid(${alias}.sources_used_json) THEN ${alias}.sources_used_json ELSE '[]' END) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(${alias}.sources_used_json) THEN ${alias}.sources_used_json ELSE '[]' END) used
        LEFT JOIN sources active_source ON active_source.id = json_extract(used.value, '$.id')
        WHERE active_source.id IS NULL
      )
    )
  )`;
}

export function windowFor(period: RadarPeriod, now = new Date()): { start: Date; end: Date } {
  const end = now;
  const start = new Date(now);
  if (period === "WEEKLY") start.setDate(start.getDate() - 7);
  else if (period === "MONTHLY") start.setMonth(start.getMonth() - 1);
  else start.setFullYear(start.getFullYear() - 1);
  return { start, end };
}

export async function computeStats(db: D1Database, startIso: string, endIso: string): Promise<SnapshotStats> {
  const newSources = await db
    .prepare("SELECT COUNT(*) AS n FROM sources WHERE created_at >= ? AND created_at <= ?")
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const kw = await db
    .prepare(
      `SELECT k.keyword, COUNT(*) AS n FROM keywords k
       JOIN sources s ON s.id = k.source_id
       WHERE k.created_at >= ? AND k.created_at <= ?
       GROUP BY k.keyword ORDER BY n DESC LIMIT 10`
    )
    .bind(startIso, endIso)
    .all<{ keyword: string; n: number }>();

  const qs = await db
    .prepare(
      `SELECT q.question FROM questions q
       JOIN sources s ON s.id = q.source_id
       WHERE q.created_at >= ? AND q.created_at <= ?
       ORDER BY q.created_at DESC LIMIT 8`
    )
    .bind(startIso, endIso)
    .all<{ question: string }>();

  const sigs = await db
    .prepare(
      `SELECT us.action, COUNT(*) AS n FROM user_signals us
       JOIN sources s ON s.id = us.source_id
       WHERE us.created_at >= ? AND us.created_at <= ?
       GROUP BY us.action`
    )
    .bind(startIso, endIso)
    .all<{ action: string; n: number }>();

  const kept = await db
    .prepare(
      `SELECT s.title, s.kind, COUNT(*) AS n FROM user_signals us JOIN sources s ON s.id = us.source_id
       WHERE us.action IN ('keep','develop') AND us.created_at >= ? AND us.created_at <= ?
       GROUP BY s.id ORDER BY n DESC LIMIT 5`
    )
    .bind(startIso, endIso)
    .all<{ title: string; kind: string }>();

  const distills = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM distill_sessions session
       WHERE session.created_at >= ? AND session.created_at <= ?
         AND ${liveDistillSessionFilter("session")}`
    )
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const gaps = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM research_gaps gap
       JOIN distill_sessions session ON session.id = gap.distill_session_id
       WHERE gap.created_at >= ? AND gap.created_at <= ?
         AND ${liveDistillSessionFilter("session")}`
    )
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const queue = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM reading_queue item
       JOIN distill_sessions session ON session.id = item.distill_session_id
       WHERE item.created_at >= ? AND item.created_at <= ?
         AND ${liveDistillSessionFilter("session")}`
    )
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const kinds = await db
    .prepare("SELECT kind, COUNT(*) AS n FROM sources WHERE created_at <= ? GROUP BY kind")
    .bind(endIso)
    .all<{ kind: string; n: number }>();

  const signalCounts: Record<string, number> = {};
  for (const s of sigs.results ?? []) signalCounts[s.action] = s.n;
  const kindBreakdown: Record<string, number> = {};
  for (const k of kinds.results ?? []) kindBreakdown[k.kind] = k.n;

  return {
    newSources: newSources?.n ?? 0,
    newKeywords: (kw.results ?? []).map((r) => ({ keyword: r.keyword, count: r.n })),
    newQuestions: (qs.results ?? []).map((r) => r.question),
    signalCounts,
    topKeptSources: (kept.results ?? []).map((r) => ({ title: r.title, kind: r.kind })),
    distillRuns: distills?.n ?? 0,
    gapsRaised: gaps?.n ?? 0,
    readingQueueSize: queue?.n ?? 0,
    kindBreakdown,
  };
}

export async function saveSnapshot(db: D1Database, period: RadarPeriod, stats: SnapshotStats, startIso: string, endIso: string): Promise<string> {
  const id = uuid();
  await db
    .prepare(
      `INSERT INTO radar_snapshots (id, period, window_start, window_end, stats_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, period, startIso, endIso, JSON.stringify(stats), endIso)
    .run();
  return id;
}

export async function saveSnapshotSynthesis(db: D1Database, snapshotId: string, synthesis: RadarSynthesis): Promise<void> {
  await db
    .prepare("UPDATE radar_snapshots SET synthesis_json = ?, synthesis_cost = ? WHERE id = ?")
    .bind(JSON.stringify(synthesis), synthesis.costUsd, snapshotId)
    .run();
}

export async function createWeeklySnapshotIfDue(env: Env): Promise<string | null> {
  const last = await env.DB.prepare(
    `SELECT created_at FROM radar_snapshots WHERE period = 'WEEKLY' ORDER BY created_at DESC LIMIT 1`
  ).first<{ created_at: string }>();
  if (last && Date.now() - new Date(last.created_at).getTime() < 6 * 24 * 3600 * 1000) return null;

  const { start, end } = windowFor("WEEKLY");
  const stats = await computeStats(env.DB, start.toISOString(), end.toISOString());
  return saveSnapshot(env.DB, "WEEKLY", stats, start.toISOString(), end.toISOString());
}

export async function createWeeklySnapshotWithSynthesis(env: Env): Promise<string | null> {
  return createWeeklySnapshotIfDue(env);
}
