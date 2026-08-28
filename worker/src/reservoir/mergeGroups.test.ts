import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createLogicalMerge,
  resolveCanonicalSourceId,
  reverseLogicalMerge,
} from "./mergeGroups";

async function insertSource(id: string, title: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, title, reliability, status, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', ?, ?)`,
  ).bind(id, title, timestamp, timestamp).run();
}

describe("logical source merge groups", () => {
  it("resolves a member to its canonical source and reverses without deleting data", async () => {
    await insertSource("merge-canonical", "Canonical source");
    await insertSource("merge-member", "Duplicate source");

    const groupId = await createLogicalMerge(env.DB, {
      canonicalSourceId: "merge-canonical",
      memberSourceIds: ["merge-member"],
      mode: "AUTO",
      confidence: 1,
      reasons: ["DOI_EXACT"],
    });

    expect(await resolveCanonicalSourceId(env.DB, "merge-member")).toBe("merge-canonical");

    const stored = await env.DB.prepare(
      "SELECT reasons_json FROM source_merge_groups WHERE id = ?",
    ).bind(groupId).first<{ reasons_json: string }>();
    expect(JSON.parse(stored!.reasons_json)).toEqual(["DOI_EXACT"]);

    await reverseLogicalMerge(env.DB, groupId);

    expect(await resolveCanonicalSourceId(env.DB, "merge-member")).toBe("merge-member");
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE id IN (?, ?)",
    ).bind("merge-canonical", "merge-member").first<{ count: number }>())?.count).toBe(2);
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM source_merge_members WHERE group_id = ?",
    ).bind(groupId).first<{ count: number }>())?.count).toBe(2);
    expect((await env.DB.prepare(
      "SELECT reversed_at FROM source_merge_groups WHERE id = ?",
    ).bind(groupId).first<{ reversed_at: string | null }>())?.reversed_at).toBeTruthy();
  });

  it("rejects overlapping active merge memberships", async () => {
    await insertSource("merge-a", "Source A");
    await insertSource("merge-b", "Source B");
    await insertSource("merge-c", "Source C");

    await createLogicalMerge(env.DB, {
      canonicalSourceId: "merge-a",
      memberSourceIds: ["merge-b"],
      mode: "REVIEW",
      confidence: 0.9,
      reasons: ["TITLE_SIMILAR_HIGH", "YEAR_EXACT"],
    });

    await expect(createLogicalMerge(env.DB, {
      canonicalSourceId: "merge-c",
      memberSourceIds: ["merge-b"],
      mode: "REVIEW",
      confidence: 0.9,
      reasons: ["TITLE_SIMILAR_HIGH", "YEAR_EXACT"],
    })).rejects.toThrow("already belongs to an active merge group");
  });

  it("creates and reverses one logical merge with more than 100 members", async () => {
    const sourceIds = Array.from(
      { length: 102 },
      (_, index) => `merge-large-${String(index).padStart(3, "0")}`,
    );
    for (const sourceId of sourceIds) await insertSource(sourceId, `Large merge source ${sourceId}`);

    const groupId = await createLogicalMerge(env.DB, {
      canonicalSourceId: sourceIds[0]!,
      memberSourceIds: [...sourceIds.slice(1), sourceIds[0]!, sourceIds[1]!],
      mode: "AUTO",
      confidence: 1,
      reasons: ["DOI_EXACT"],
    });

    const members = await env.DB.prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN role = 'CANONICAL' THEN 1 ELSE 0 END) AS canonicalCount
       FROM source_merge_members WHERE group_id = ?`,
    ).bind(groupId).first<{ count: number; canonicalCount: number }>();
    expect(members).toEqual({ count: 102, canonicalCount: 1 });
    expect(await resolveCanonicalSourceId(env.DB, sourceIds.at(-1)!)).toBe(sourceIds[0]);

    await reverseLogicalMerge(env.DB, groupId);

    expect(await resolveCanonicalSourceId(env.DB, sourceIds.at(-1)!)).toBe(sourceIds.at(-1));
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE id LIKE 'merge-large-%'",
    ).first<{ count: number }>())?.count).toBe(102);
  });

  it("rejects a missing source beyond the first validation chunk", async () => {
    const sourceIds = Array.from(
      { length: 101 },
      (_, index) => `merge-missing-${String(index).padStart(3, "0")}`,
    );
    for (const sourceId of sourceIds.slice(0, -1)) await insertSource(sourceId, `Existing source ${sourceId}`);

    await expect(createLogicalMerge(env.DB, {
      canonicalSourceId: sourceIds[0]!,
      memberSourceIds: sourceIds.slice(1),
      mode: "REVIEW",
      confidence: 0.9,
      reasons: ["TITLE_SIMILAR_HIGH"],
    })).rejects.toThrow("Every logical merge member must reference an existing source");
    expect((await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM source_merge_groups WHERE canonical_source_id LIKE 'merge-missing-%'",
    ).first<{ count: number }>())?.count).toBe(0);
  });

  it("rejects an active membership beyond the first validation chunk", async () => {
    const sourceIds = Array.from(
      { length: 101 },
      (_, index) => `merge-overlap-${String(index).padStart(3, "0")}`,
    );
    for (const sourceId of sourceIds) await insertSource(sourceId, `Overlap source ${sourceId}`);
    await insertSource("merge-overlap-existing-canonical", "Existing canonical");
    await createLogicalMerge(env.DB, {
      canonicalSourceId: "merge-overlap-existing-canonical",
      memberSourceIds: [sourceIds.at(-1)!],
      mode: "REVIEW",
      confidence: 0.9,
      reasons: ["TITLE_SIMILAR_HIGH"],
    });

    await expect(createLogicalMerge(env.DB, {
      canonicalSourceId: sourceIds[0]!,
      memberSourceIds: sourceIds.slice(1),
      mode: "REVIEW",
      confidence: 0.9,
      reasons: ["TITLE_SIMILAR_HIGH"],
    })).rejects.toThrow(`Source ${sourceIds.at(-1)} already belongs to an active merge group`);
    expect((await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM source_merge_groups
       WHERE reversed_at IS NULL AND canonical_source_id LIKE 'merge-overlap-%'`,
    ).first<{ count: number }>())?.count).toBe(1);
  });
});
