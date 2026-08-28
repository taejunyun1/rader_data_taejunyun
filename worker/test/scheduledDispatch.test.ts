import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  HOMEPAGE_READING_CRON,
  VISUAL_TEMP_CLEANUP_CRON,
  WEEKLY_SNAPSHOT_DISCOVERY_CRON,
  runScheduledCron,
  scheduledKindForCron,
} from "../src/operations/scheduled";

describe("scheduled dispatch contract", () => {
  it("maps only the three owned cron schedules", () => {
    expect(scheduledKindForCron(VISUAL_TEMP_CLEANUP_CRON)).toBe("VISUAL_TEMP_CLEANUP");
    expect(scheduledKindForCron(HOMEPAGE_READING_CRON)).toBe("HOMEPAGE_READING");
    expect(scheduledKindForCron(WEEKLY_SNAPSHOT_DISCOVERY_CRON)).toBe("WEEKLY_SNAPSHOT_DISCOVERY");
    expect(scheduledKindForCron("0 3 * * *")).toBeNull();
  });

  it("treats unknown delivery as a no-op", async () => {
    await expect(runScheduledCron(env as Env, "unknown", new Date("2026-08-28T00:00:00.000Z"))).resolves.toEqual({ status: "SKIPPED" });
  });

  it("makes duplicate hourly deliveries idempotent", async () => {
    const now = new Date("2026-08-28T04:12:00.000Z");
    const first = await runScheduledCron(env as Env, VISUAL_TEMP_CLEANUP_CRON, now);
    const second = await runScheduledCron(env as Env, VISUAL_TEMP_CLEANUP_CRON, now);
    expect(first.status).toBe("SUCCEEDED");
    expect(second.status).toBe("SKIPPED");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM system_runs WHERE kind = 'VISUAL_TEMP_CLEANUP' AND window_key = '2026-08-28T04'").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
