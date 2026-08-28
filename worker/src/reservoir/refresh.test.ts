import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReservoirRefresh } from "./refresh";

async function insertSource(id: string, title: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, title, reliability, status, quality_status, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', 'READY', ?, ?)`,
  ).bind(id, title, now, now).run();
}

describe("reservoir refresh service", () => {
  it("scans at most 50 sources in one run without changing source quality", async () => {
    for (let index = 0; index < 51; index += 1) {
      await insertSource(`zz-task4-bounded-${String(index).padStart(2, "0")}`, `Bounded source ${index}`);
    }

    const run = await runReservoirRefresh(env.DB, "PREVIEW");

    expect(run.status).toBe("COMPLETED");
    expect(run.scannedCount).toBe(50);
    expect(run.cursorSourceId).toBeTruthy();
    const qualities = await env.DB.prepare(
      "SELECT DISTINCT quality_status FROM sources WHERE id LIKE 'zz-task4-bounded-%'",
    ).all<{ quality_status: string }>();
    expect(qualities.results.map((row) => row.quality_status)).toEqual(["READY"]);
  });
});
