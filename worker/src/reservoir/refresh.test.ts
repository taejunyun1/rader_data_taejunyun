import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveDuplicateCandidate, runReservoirRefresh } from "./refresh";

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

  it("applies one 101-member connected duplicate component", async () => {
    const prefix = "!!!!!!!!!!!!!!!!large-component-";
    const sharedDoi = "10.1000/large-connected-component";
    const now = new Date().toISOString();

    for (let index = 0; index < 101; index += 1) {
      const id = `${prefix}${String(index).padStart(3, "0")}`;
      await env.DB.prepare(
        `INSERT INTO sources (id, kind, title, doi, reliability, status, quality_status, created_at, updated_at)
         VALUES (?, 'WEB', ?, ?, 'PRIMARY', 'stored', 'READY', ?, ?)`,
      ).bind(id, `Large connected component ${index}`, sharedDoi, now, now).run();
      if (index >= 50) {
        await env.DB.prepare(
          `INSERT INTO source_fingerprints (source_id, kind, value, created_at) VALUES (?, 'DOI', ?, ?)`,
        ).bind(id, sharedDoi, now).run();
      }
    }

    let preparedStatementCount = 0;
    let candidateStatusUpdateCount = 0;
    const countedDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            preparedStatementCount += 1;
            if (query.includes("UPDATE source_duplicate_candidates") && query.includes("status = 'MERGED'")) {
              candidateStatusUpdateCount += 1;
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const run = await runReservoirRefresh(countedDb, "APPLY");

    expect(run.status).toBe("COMPLETED");
    expect(run.scannedCount).toBe(50);
    const scannedIds = await env.DB.prepare("SELECT id FROM sources ORDER BY id ASC LIMIT 50").all<{ id: string }>();
    expect(scannedIds.results.every(({ id }) => id.startsWith(prefix))).toBe(true);
    const groups = await env.DB.prepare(
      `SELECT g.id, COUNT(*) AS memberCount
       FROM source_merge_groups g
       JOIN source_merge_members m ON m.group_id = g.id
       WHERE g.reversed_at IS NULL AND m.source_id LIKE ?
       GROUP BY g.id
       ORDER BY g.id`,
    ).bind(`${prefix}%`).all<{ id: string; memberCount: number }>();
    expect(groups.results).toHaveLength(1);
    expect(Number(groups.results[0]?.memberCount)).toBe(101);
    expect(preparedStatementCount).toBeLessThan(1_000);
    expect(candidateStatusUpdateCount).toBeLessThanOrEqual(20);
  });

  it("rolls back an interrupted automatic merge and succeeds on retry", async () => {
    const prefix = "!!!!!!!!atomic-retry-";
    const sharedDoi = "10.1000/atomic-retry";
    for (let index = 0; index < 3; index += 1) {
      await insertSource(`${prefix}${index}`, `Atomic retry ${index}`, sharedDoi);
    }

    const queryByStatement = new WeakMap<object, string>();
    let failedMergeBatch = false;
    const interruptedDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => {
                    const bound = statementTarget.bind(...values);
                    queryByStatement.set(bound, query);
                    return bound;
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const resolvesCandidates = statements.some((statement) => {
              const query = queryByStatement.get(statement);
              return query?.includes("UPDATE source_duplicate_candidates") && query.includes("status = 'MERGED'");
            });
            if (resolvesCandidates && !failedMergeBatch) {
              failedMergeBatch = true;
              return target.batch([
                ...statements,
                target.prepare("INSERT INTO source_merge_groups (id) VALUES ('forced-merge-failure')"),
              ]);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(runReservoirRefresh(interruptedDb, "APPLY")).rejects.toThrow();

    const afterFailure = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*)
          FROM source_merge_groups g
          JOIN source_merge_members m ON m.group_id = g.id
          WHERE g.reversed_at IS NULL AND m.source_id LIKE ?) AS activeGroupMemberCount,
         (SELECT COUNT(*)
          FROM source_duplicate_candidates
          WHERE left_source_id LIKE ? AND status = 'PENDING') AS pendingCandidateCount`,
    ).bind(`${prefix}%`, `${prefix}%`).first<{
      activeGroupMemberCount: number;
      pendingCandidateCount: number;
    }>();
    expect(afterFailure).toEqual({ activeGroupMemberCount: 0, pendingCandidateCount: 3 });

    const retry = await runReservoirRefresh(env.DB, "APPLY");
    expect(retry.status).toBe("COMPLETED");
    const afterRetry = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*)
          FROM source_merge_groups g
          JOIN source_merge_members m ON m.group_id = g.id
          WHERE g.reversed_at IS NULL AND m.source_id LIKE ?) AS activeGroupMemberCount,
         (SELECT COUNT(*)
          FROM source_duplicate_candidates
          WHERE left_source_id LIKE ? AND status = 'PENDING') AS pendingCandidateCount,
         (SELECT COUNT(*)
          FROM source_duplicate_candidates
          WHERE left_source_id LIKE ? AND status = 'MERGED') AS mergedCandidateCount`,
    ).bind(`${prefix}%`, `${prefix}%`, `${prefix}%`).first<{
      activeGroupMemberCount: number;
      pendingCandidateCount: number;
      mergedCandidateCount: number;
    }>();
    expect(afterRetry).toEqual({
      activeGroupMemberCount: 3,
      pendingCandidateCount: 0,
      mergedCandidateCount: 3,
    });
  });

  it("rolls back an interrupted manual MERGE and succeeds on retry", async () => {
    const prefix = "!!!!!!!!manual-atomic-retry-";
    await insertSource(`${prefix}left`, "Manual atomic retry");
    await insertSource(`${prefix}right`, "Manual atomic retry");
    const candidateId = `${prefix}candidate`;
    await env.DB.prepare(
      `INSERT INTO source_duplicate_candidates
       (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at)
       VALUES (?, ?, ?, 'REVIEW', 1, '["TITLE_EXACT_WITHOUT_SUPPORT"]', 'PENDING', ?)`,
    ).bind(candidateId, `${prefix}left`, `${prefix}right`, new Date().toISOString()).run();

    const queryByStatement = new WeakMap<object, string>();
    let failedMergeBatch = false;
    const interruptedDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty === "bind") {
                  return (...values: unknown[]) => {
                    const bound = statementTarget.bind(...values);
                    queryByStatement.set(bound, query);
                    return bound;
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const resolvesCandidate = statements.some((statement) => {
              const query = queryByStatement.get(statement);
              return query?.includes("UPDATE source_duplicate_candidates") && query.includes("status = 'MERGED'");
            });
            if (resolvesCandidate && !failedMergeBatch) {
              failedMergeBatch = true;
              return target.batch([
                ...statements,
                target.prepare("INSERT INTO source_merge_groups (id) VALUES ('forced-manual-merge-failure')"),
              ]);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(resolveDuplicateCandidate(interruptedDb, candidateId, "MERGE")).rejects.toThrow();

    const afterFailure = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT g.id)
          FROM source_merge_groups g
          JOIN source_merge_members m ON m.group_id = g.id
          WHERE g.reversed_at IS NULL AND m.source_id LIKE ?) AS activeGroupCount,
         (SELECT COUNT(*)
          FROM source_duplicate_candidates
          WHERE id = ? AND status = 'PENDING') AS pendingCandidateCount,
         (SELECT COUNT(*) FROM sources WHERE id LIKE ?) AS sourceCount`,
    ).bind(`${prefix}%`, candidateId, `${prefix}%`).first<{
      activeGroupCount: number;
      pendingCandidateCount: number;
      sourceCount: number;
    }>();
    expect(afterFailure).toEqual({ activeGroupCount: 0, pendingCandidateCount: 1, sourceCount: 2 });

    await expect(resolveDuplicateCandidate(env.DB, candidateId, "MERGE"))
      .resolves.toMatchObject({ id: candidateId, status: "MERGED" });
    const afterRetry = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT g.id)
          FROM source_merge_groups g
          JOIN source_merge_members m ON m.group_id = g.id
          WHERE g.reversed_at IS NULL AND m.source_id LIKE ?) AS activeGroupCount,
         (SELECT COUNT(*)
          FROM source_duplicate_candidates
          WHERE id = ? AND status = 'PENDING') AS pendingCandidateCount,
         (SELECT COUNT(*) FROM sources WHERE id LIKE ?) AS sourceCount`,
    ).bind(`${prefix}%`, candidateId, `${prefix}%`).first<{
      activeGroupCount: number;
      pendingCandidateCount: number;
      sourceCount: number;
    }>();
    expect(afterRetry).toEqual({ activeGroupCount: 1, pendingCandidateCount: 0, sourceCount: 2 });
  });

  it("rejects a stale manual MERGE without creating an orphan group", async () => {
    const prefix = "!!!!!!!!manual-stale-";
    const candidateId = `${prefix}candidate`;
    await insertSource(`${prefix}left`, "Manual stale merge");
    await insertSource(`${prefix}right`, "Manual stale merge");
    await env.DB.prepare(
      `INSERT INTO source_duplicate_candidates
       (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at)
       VALUES (?, ?, ?, 'REVIEW', 1, '["TITLE_EXACT_WITHOUT_SUPPORT"]', 'PENDING', ?)`,
    ).bind(candidateId, `${prefix}left`, `${prefix}right`, new Date().toISOString()).run();

    let resolvedBeforeBatch = false;
    const staleDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!resolvedBeforeBatch) {
              resolvedBeforeBatch = true;
              await target.prepare(
                "UPDATE source_duplicate_candidates SET status = 'SEPARATE', resolved_at = ? WHERE id = ?",
              ).bind(new Date().toISOString(), candidateId).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(resolveDuplicateCandidate(staleDb, candidateId, "MERGE"))
      .rejects.toThrow("duplicate_candidate_already_resolved");
    const state = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT g.id)
          FROM source_merge_groups g
          JOIN source_merge_members m ON m.group_id = g.id
          WHERE g.reversed_at IS NULL AND m.source_id LIKE ?) AS activeGroupCount,
         status, merge_group_id AS mergeGroupId
       FROM source_duplicate_candidates WHERE id = ?`,
    ).bind(`${prefix}%`, candidateId).first<{
      activeGroupCount: number;
      status: string;
      mergeGroupId: string | null;
    }>();
    expect(state).toEqual({ activeGroupCount: 0, status: "SEPARATE", mergeGroupId: null });
  });
});
