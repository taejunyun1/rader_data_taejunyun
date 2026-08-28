import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import reservoir from "./reservoir";

const app = new Hono<{ Bindings: Env }>();
app.route("/api/reservoir", reservoir);

async function insertSource(input: {
  id: string;
  title: string;
  doi?: string;
  authors?: string;
  year?: number;
}): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, authors, year, doi, reliability, status, quality_status, created_at, updated_at)
     VALUES (?, 'WEB', ?, ?, ?, ?, 'PRIMARY', 'stored', 'READY', ?, ?)`,
  ).bind(input.id, input.title, input.authors ?? null, input.year ?? null, input.doi ?? null, now, now).run();
}

async function activeMergeCount(...sourceIds: string[]): Promise<number> {
  const placeholders = sourceIds.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT g.id) AS count
     FROM source_merge_groups g
     JOIN source_merge_members m ON m.group_id = g.id
     WHERE g.reversed_at IS NULL AND m.source_id IN (${placeholders})`,
  ).bind(...sourceIds).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env as unknown as Env);
}

describe("reservoir refresh routes", () => {
  it("accepts a preview and creates no active logical merge", async () => {
    await insertSource({ id: "0000b-preview-left", title: "Preview left", doi: "10.1000/preview" });
    await insertSource({ id: "0000b-preview-right", title: "Preview right", doi: "https://doi.org/10.1000/preview" });

    const response = await post("/api/reservoir/refresh", { mode: "PREVIEW" });

    expect(response.status).toBe(202);
    const accepted = await response.json<{ runId: string }>();
    expect(await activeMergeCount("0000b-preview-left", "0000b-preview-right")).toBe(0);
    const runResponse = await app.request(`/api/reservoir/refresh/${accepted.runId}`, undefined, env as unknown as Env);
    expect(runResponse.status).toBe(200);
    await expect(runResponse.json()).resolves.toMatchObject({ mode: "PREVIEW", status: "COMPLETED", autoMergeCount: 1 });
  });

  it("applies only AUTO_MERGE assessments", async () => {
    await insertSource({ id: "0000a-apply-auto-left", title: "Apply exact left", doi: "10.1000/apply" });
    await insertSource({ id: "0000a-apply-auto-right", title: "Apply exact right", doi: "10.1000/apply" });
    await insertSource({ id: "0000a-apply-review-left", title: "Review this exact title" });
    await insertSource({ id: "0000a-apply-review-right", title: "Review this exact title" });

    const response = await post("/api/reservoir/refresh", { mode: "APPLY" });

    expect(response.status).toBe(202);
    expect(await activeMergeCount("0000a-apply-auto-left", "0000a-apply-auto-right")).toBe(1);
    expect(await activeMergeCount("0000a-apply-review-left", "0000a-apply-review-right")).toBe(0);
    const candidate = await env.DB.prepare(
      `SELECT decision, status FROM source_duplicate_candidates
       WHERE left_source_id = ? AND right_source_id = ?`,
    ).bind("0000a-apply-review-left", "0000a-apply-review-right").first<{ decision: string; status: string }>();
    expect(candidate).toEqual({ decision: "REVIEW", status: "PENDING" });
  });

  it("keeps both reviewed sources visible when the user separates them", async () => {
    await insertSource({ id: "0000c-separate-left", title: "Human review title" });
    await insertSource({ id: "0000c-separate-right", title: "Human review title" });
    await post("/api/reservoir/refresh", { mode: "PREVIEW" });
    const candidate = await env.DB.prepare(
      `SELECT id FROM source_duplicate_candidates
       WHERE left_source_id = ? AND right_source_id = ?`,
    ).bind("0000c-separate-left", "0000c-separate-right").first<{ id: string }>();

    const response = await post(`/api/reservoir/duplicates/${candidate!.id}`, { action: "SEPARATE" });

    expect(response.status).toBe(200);
    expect(await activeMergeCount("0000c-separate-left", "0000c-separate-right")).toBe(0);
    const listResponse = await app.request("/api/reservoir?decision=all&limit=200", undefined, env as unknown as Env);
    const list = await listResponse.json<{ items: Array<{ id: string }> }>();
    expect(list.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      "0000c-separate-left",
      "0000c-separate-right",
    ]));
  });
});
