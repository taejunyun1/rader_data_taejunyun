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
      `SELECT keyword, COUNT(*) AS n FROM keywords WHERE created_at >= ? AND created_at <= ?
       GROUP BY keyword ORDER BY n DESC LIMIT 10`
    )
    .bind(startIso, endIso)
    .all<{ keyword: string; n: number }>();

  const qs = await db
    .prepare(
      `SELECT question FROM questions WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT 8`
    )
    .bind(startIso, endIso)
    .all<{ question: string }>();

  const sigs = await db
    .prepare(
      `SELECT action, COUNT(*) AS n FROM user_signals WHERE created_at >= ? AND created_at <= ? GROUP BY action`
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
    .prepare("SELECT COUNT(*) AS n FROM distill_sessions WHERE created_at >= ? AND created_at <= ?")
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const gaps = await db
    .prepare("SELECT COUNT(*) AS n FROM research_gaps WHERE created_at >= ? AND created_at <= ?")
    .bind(startIso, endIso)
    .first<{ n: number }>();

  const queue = await db
    .prepare("SELECT COUNT(*) AS n FROM reading_queue WHERE created_at >= ? AND created_at <= ?")
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
  const snapshotId = await createWeeklySnapshotIfDue(env);
  if (!snapshotId) return null;

  try {
    const { synthesizeRadar } = await import("./synthesize");
    const synthesis = await synthesizeRadar(env, "WEEKLY");
    await saveSnapshotSynthesis(env.DB, snapshotId, synthesis);
  } catch (err) {
    console.error(JSON.stringify({ level: "error", scope: "cron:synthesis", message: (err as Error).message }));
  }
  return snapshotId;
}
