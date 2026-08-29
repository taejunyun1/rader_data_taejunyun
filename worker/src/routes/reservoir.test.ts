import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import reservoir from "./reservoir";

const app = new Hono<{
  Bindings: Env;
  Variables: { identity: { sub: string; email: string; name: string } };
}>();
app.use("*", async (c, next) => {
  c.set("identity", { sub: "test", email: "test@local", name: "Test" });
  await next();
});
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

async function deleteRequest(path: string, body: unknown, bindings: Env = env as unknown as Env): Promise<Response> {
  return app.request(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, bindings);
}

describe("reservoir refresh routes", () => {
  it("reports REVIEW for a legacy PARTIAL version whose source quality is still UNREVIEWED", async () => {
    const sourceId = "0000e-legacy-partial";
    const versionId = "0000e-legacy-partial-v1";
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources
       (id, kind, title, reliability, status, origin, input_format, quality_status, created_at, updated_at)
       VALUES (?, 'NOTE', '레거시 부분 본문', 'PRIVATE', 'stored', 'obsidian:legacy', 'OBSIDIAN_MARKDOWN', 'UNREVIEWED', ?, ?)`,
    ).bind(sourceId, now, now).run();
    await env.DB.prepare(
      `INSERT INTO source_versions
       (id, source_id, version, extracted_text, char_count, normalized_text, normalization_status,
        version_origin, review_status, text_scope, extraction_method, created_at)
       VALUES (?, ?, 1, ?, 283, ?, 'PENDING', 'INITIAL_INGEST', 'ACTIVE', 'PARTIAL', 'LEGACY', ?)`,
    ).bind(versionId, sourceId, "부분 본문".repeat(36), "부분 본문".repeat(36), now).run();
    await env.DB.prepare("UPDATE sources SET active_version_id = ? WHERE id = ?").bind(versionId, sourceId).run();

    const response = await app.request(`/api/reservoir/${sourceId}`, undefined, env as unknown as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      acquisition: {
        textScope: "PARTIAL",
        qualityStatus: "REVIEW",
        charCount: 283,
        canDeepAnalyze: false,
      },
    });

    const blocked = await post(`/api/reservoir/${sourceId}/deep-analysis`, {});
    expect(blocked.status).toBe(422);
    await expect(blocked.json()).resolves.toMatchObject({
      error: "deep_analysis_text_not_ready",
      textScope: "PARTIAL",
      qualityStatus: "REVIEW",
      charCount: 283,
    });
  });

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

  it("manually merges a pending review candidate without deleting either source", async () => {
    await insertSource({ id: "0000d-merge-left", title: "Manual review title" });
    await insertSource({ id: "0000d-merge-right", title: "Manual review title" });
    await post("/api/reservoir/refresh", { mode: "PREVIEW" });
    const candidate = await env.DB.prepare(
      `SELECT id FROM source_duplicate_candidates
       WHERE left_source_id = ? AND right_source_id = ?`,
    ).bind("0000d-merge-left", "0000d-merge-right").first<{ id: string }>();

    const response = await post(`/api/reservoir/duplicates/${candidate!.id}`, { action: "MERGE" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: candidate!.id, status: "MERGED" });
    expect(await activeMergeCount("0000d-merge-left", "0000d-merge-right")).toBe(1);
    const group = await env.DB.prepare(
      `SELECT mode FROM source_merge_groups g
       JOIN source_merge_members m ON m.group_id = g.id
       WHERE m.source_id = ? AND g.reversed_at IS NULL`,
    ).bind("0000d-merge-left").first<{ mode: string }>();
    expect(group?.mode).toBe("MANUAL");
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sources WHERE id IN (?, ?)",
    ).bind("0000d-merge-left", "0000d-merge-right").first<{ count: number }>();
    expect(Number(retained?.count ?? 0)).toBe(2);
  });
});

describe("reservoir permanent deletion route", () => {
  it("exposes merge deletion impact in source detail", async () => {
    const sourceId = `${crypto.randomUUID()}-detail-delete`;
    await insertSource({ id: sourceId, title: "삭제 preview" });
    const response = await app.request(`/api/reservoir/${sourceId}`, undefined, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deletion: { sourceId, title: "삭제 preview", mergeRole: "NONE", mergeMemberCount: 1 },
    });
  });

  it("rejects an invalid body and an exact-title mismatch", async () => {
    const sourceId = `${crypto.randomUUID()}-route-confirm`;
    await insertSource({ id: sourceId, title: "정확한 제목" });
    const invalid = await deleteRequest(`/api/reservoir/${sourceId}`, {});
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_source_delete_confirmation" });
    const mismatch = await deleteRequest(`/api/reservoir/${sourceId}`, { confirmTitle: "다른 제목" });
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ error: "source_delete_confirmation_mismatch" });
  });

  it("returns only deletion identifiers on success", async () => {
    const sourceId = `${crypto.randomUUID()}-route-success`;
    await insertSource({ id: sourceId, title: "API 삭제" });
    const response = await deleteRequest(`/api/reservoir/${sourceId}`, { confirmTitle: "API 삭제" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deletedSourceId: sourceId, merge: null });
  });

  it("maps R2 failure to 502 without exposing keys or raw errors", async () => {
    const sourceId = `${crypto.randomUUID()}-route-r2`;
    await insertSource({ id: sourceId, title: "R2 route 실패" });
    await env.DB.prepare("UPDATE sources SET r2_key = ? WHERE id = ?")
      .bind(`tests/delete/${sourceId}/secret`, sourceId).run();
    const failingEnv = {
      DB: env.DB,
      ORIGINALS: { delete: async () => { throw new Error("secret/key/path"); } },
    } as unknown as Env;
    const response = await deleteRequest(
      `/api/reservoir/${sourceId}`,
      { confirmTitle: "R2 route 실패" },
      failingEnv,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "source_delete_r2_failed" });
  });
});
