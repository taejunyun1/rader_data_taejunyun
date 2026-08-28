import { syncHomepageReading } from "../homepage/reading";
import { runDiscovery } from "../discovery/run";
import { loadParams } from "../lib/params";
import { cleanupExpiredVisualExtractionTemps } from "../visual/cleanup";
import { createWeeklySnapshotIfDue } from "../radar/snapshot";
import { reconcileDispatchPendingJobs } from "./reconcileJobs";
import { releaseStaleAiCallReservations } from "../lib/aiCallLedger";
import { beginSystemRun, finishSystemRun, type SystemRun } from "./systemRuns";

export const VISUAL_TEMP_CLEANUP_CRON = "0 * * * *";
export const HOMEPAGE_READING_CRON = "0 1 * * *";
export const WEEKLY_SNAPSHOT_DISCOVERY_CRON = "0 3 * * 1";

export interface ScheduledResult {
  status: "SUCCEEDED" | "FAILED" | "PARTIAL" | "SKIPPED";
  run?: SystemRun;
  tasks?: Record<string, unknown>;
}

function windowKey(cron: string, now: Date): string {
  if (cron === WEEKLY_SNAPSHOT_DISCOVERY_CRON) {
    const monday = new Date(now);
    const day = monday.getUTCDay() || 7;
    monday.setUTCDate(monday.getUTCDate() - day + 1);
    return monday.toISOString().slice(0, 10);
  }
  return cron === HOMEPAGE_READING_CRON ? now.toISOString().slice(0, 10) : now.toISOString().slice(0, 13);
}

export function scheduledKindForCron(cron: string): string | null {
  if (cron === VISUAL_TEMP_CLEANUP_CRON) return "VISUAL_TEMP_CLEANUP";
  if (cron === HOMEPAGE_READING_CRON) return "HOMEPAGE_READING";
  if (cron === WEEKLY_SNAPSHOT_DISCOVERY_CRON) return "WEEKLY_SNAPSHOT_DISCOVERY";
  return null;
}

async function runTask<T>(name: string, task: () => Promise<T>): Promise<{ name: string; ok: true; value: T } | { name: string; ok: false; error: string }> {
  try {
    return { name, ok: true, value: await task() };
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 100) : "scheduled_task_failed";
    console.error(JSON.stringify({ level: "error", scope: "cron-task", task: name, errorCode }));
    return { name, ok: false, error: errorCode };
  }
}

export async function runScheduledCron(env: Env, cron: string, now = new Date()): Promise<ScheduledResult> {
  const kind = scheduledKindForCron(cron);
  if (!kind) {
    console.warn(JSON.stringify({ level: "warn", scope: "cron", cron, errorCode: "unknown_cron_noop" }));
    return { status: "SKIPPED" };
  }

  const begun = await beginSystemRun(env.DB, kind, windowKey(cron, now));
  if (!begun.created) return { status: "SKIPPED", run: begun.run };

  const tasks = cron === VISUAL_TEMP_CLEANUP_CRON
    ? [
      await runTask("visual-temp-cleanup", () => cleanupExpiredVisualExtractionTemps(env)),
      await runTask("job-reconciliation", () => reconcileDispatchPendingJobs(env)),
      await runTask("ai-reservation-reconciliation", () => releaseStaleAiCallReservations(env.DB)),
    ]
    : cron === HOMEPAGE_READING_CRON
      ? [await runTask("homepage-reading", () => syncHomepageReading(env))]
      : [
        await runTask("weekly-snapshot", () => createWeeklySnapshotIfDue(env)),
        await runTask("discovery", async () => {
          const params = await loadParams(env.DB);
          return runDiscovery(env, params.divergence);
        }),
      ];
  const failed = tasks.filter((task) => !task.ok);
  const status = failed.length === 0 ? "SUCCEEDED" : failed.length === tasks.length ? "FAILED" : "PARTIAL";
  await finishSystemRun(env.DB, begun.run.id, {
    status,
    counts: { tasks: tasks.length, succeeded: tasks.length - failed.length, failed: failed.length },
    result: Object.fromEntries(tasks.map((task) => [task.name, task.ok ? task.value : { errorCode: task.error }])),
    errorCode: failed[0]?.ok === false ? failed[0].error : null,
  });
  return { status, run: { ...begun.run, status }, tasks: Object.fromEntries(tasks.map((task) => [task.name, task.ok ? task.value : { errorCode: task.error }])) };
}
