import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReservoirRefresh } from "./refresh";

async function insertSource(id: string, title: string, doi?: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, title, doi, reliability, status, quality_status, created_at, updated_at)
     VALUES (?, 'WEB', ?, ?, 'PRIMARY', 'stored', 'READY', ?, ?)`,
  ).bind(id, title, doi ?? null, now, now).run();
}

describe("reservoir refresh service", () => {
  it("persists a continuation cursor and advances past the first 50 sources", async () => {
    for (let index = 0; index < 51; index += 1) {
      await insertSource(
        `zz-task4-bounded-${String(index).padStart(2, "0")}`,
        `Bounded source ${index}`,
        index === 0 || index === 50 ? "10.1000/cross-batch" : undefined,
      );
    }

    const firstRun = await runReservoirRefresh(env.DB, "PREVIEW");
    const secondRun = await runReservoirRefresh(env.DB, "PREVIEW");

    expect(firstRun.status).toBe("COMPLETED");
    expect(firstRun.scannedCount).toBe(50);
    expect(firstRun.cursorSourceId).toBe("zz-task4-bounded-49");
    expect(firstRun.hasMore).toBe(true);
    expect(secondRun.scannedCount).toBe(1);
    expect(secondRun.cursorSourceId).toBeNull();
    expect(secondRun.hasMore).toBe(false);
    const persistedCursor = await env.DB.prepare(
      "SELECT cursor_source_id FROM reservoir_refresh_runs WHERE id = ?",
    ).bind(firstRun.id).first<{ cursor_source_id: string | null }>();
    expect(persistedCursor?.cursor_source_id).toBe("zz-task4-bounded-49");
    const crossBatchCandidate = await env.DB.prepare(
      `SELECT decision, status FROM source_duplicate_candidates
       WHERE left_source_id = ? AND right_source_id = ?`,
    ).bind("zz-task4-bounded-00", "zz-task4-bounded-50").first<{ decision: string; status: string }>();
    expect(crossBatchCandidate).toEqual({ decision: "AUTO_MERGE", status: "PENDING" });
    const qualities = await env.DB.prepare(
      "SELECT DISTINCT quality_status FROM sources WHERE id LIKE 'zz-task4-bounded-%'",
    ).all<{ quality_status: string }>();
    expect(qualities.results.map((row) => row.quality_status)).toEqual(["READY"]);
  });

  it("batches candidate persistence while retaining a real duplicate candidate", async () => {
    for (let index = 0; index < 50; index += 1) {
      await insertSource(
        `zz-task4-batched-${String(index).padStart(2, "0")}`,
        index < 2 ? "A retained duplicate candidate" : String.fromCodePoint(0x400 + index),
      );
    }
    let candidateWritePreparations = 0;
    const countedDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("INSERT INTO source_duplicate_candidates")) candidateWritePreparations += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await runReservoirRefresh(countedDb, "PREVIEW");

    expect(candidateWritePreparations).toBeLessThanOrEqual(10);
    const candidate = await env.DB.prepare(
      `SELECT decision, status FROM source_duplicate_candidates
       WHERE left_source_id = ? AND right_source_id = ?`,
    ).bind("zz-task4-batched-00", "zz-task4-batched-01").first<{ decision: string; status: string }>();
    expect(candidate).toEqual({ decision: "REVIEW", status: "PENDING" });
  });
});
