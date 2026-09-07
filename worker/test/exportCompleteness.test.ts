import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import exportRoute from "../src/routes/export";
import { createSource } from "../src/ingestion/store";

async function source(title: string, original: string) {
  return createSource(env as unknown as Env, {
    kind: "NOTE", title, canonicalUrl: `https://example.com/${title}`, original,
    extractedText: original, origin: "manual", inputFormat: "PLAIN_TEXT",
    textScope: "FULLTEXT", extractionMethod: "MANUAL_TEXT",
  });
}

describe("research export completeness", () => {
  it("preserves source versions, analysis payload and session provenance", async () => {
    const created = await source("export-provenance", "original first version");
    await source("export-provenance", "original second version");
    const sessionId = crypto.randomUUID();
    const analysisId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO source_analysis (id,source_id,version_id,analysis_type,payload_json,created_at) VALUES (?,?,?,'basic',?,?)")
      .bind(analysisId, created.sourceId, created.activeVersionId, '{"summary":"version one analysis"}', new Date().toISOString()).run();
    const sourceRefs = JSON.stringify([{ id: created.sourceId, versionId: created.activeVersionId }]);
    await env.DB.prepare("INSERT INTO distill_sessions (id,sources_used_json,input_context_json,output_json,created_at) VALUES (?,?,?,?,?)")
      .bind(sessionId, sourceRefs, '{"input":"context"}', '{}', new Date().toISOString()).run();
    const response = await exportRoute.request("http://local/json", {}, env);
    const data = await response.json() as any;
    expect(data.sourceVersions.filter((row: any) => row.source_id === created.sourceId)).toHaveLength(2);
    expect(data.sources.find((row: any) => row.id === created.sourceId)).toHaveProperty("active_version_id");
    expect(data.sourceAnalysis.find((row: any) => row.id === analysisId)).toMatchObject({
      source_id: created.sourceId, version_id: created.activeVersionId, payload_json: '{"summary":"version one analysis"}',
    });
    expect(data.distillSessions.find((row: any) => row.id === sessionId)).toMatchObject({ sources_used_json: sourceRefs, input_context_json: '{"input":"context"}' });
  });

  it("backs up both originals with a restorable key mapping and matching snapshot", async () => {
    const created = await source("backup-versions", "first original");
    await source("backup-versions", "second original");
    const response = await exportRoute.request("http://local/originals-to-r2", { method: "POST" }, env);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    const manifest = await (await env.EXPORTS.get(result.manifestKey))!.json() as any;
    const objects = manifest.objects.filter((entry: any) => entry.sourceId === created.sourceId);
    expect(objects).toHaveLength(2);
    for (const entry of objects) {
      expect(entry.status).toBe("copied");
      expect(await (await env.EXPORTS.get(entry.backupKey))!.text()).toBe(await (await env.ORIGINALS.get(entry.originalKey))!.text());
    }
    const snapshot = await (await env.EXPORTS.get(manifest.snapshotKey))!.json() as any;
    expect(snapshot.sourceVersions.filter((row: any) => row.source_id === created.sourceId)).toHaveLength(2);
  });

  it("reports a missing referenced original instead of a successful backup", async () => {
    const created = await source("missing-original", "gone bytes");
    const row = await env.DB.prepare("SELECT r2_key FROM sources WHERE id=?").bind(created.sourceId).first<{ r2_key: string }>();
    await env.ORIGINALS.delete(row!.r2_key);
    const response = await exportRoute.request("http://local/originals-to-r2", { method: "POST" }, env);
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body).toMatchObject({ ok: false, error: "backup_incomplete" });
    expect(body.missing).toBeGreaterThan(0);
  });

  it("backs up retained previews referenced by source metadata", async () => {
    const created = await source("preview-original", "PDF original bytes");
    const previewKey = `previews/${created.sourceId}.jpg`;
    await env.ORIGINALS.put(previewKey, "preview bytes");
    await env.DB.prepare("UPDATE sources SET metadata_json=? WHERE id=?")
      .bind(JSON.stringify({ previewKey }), created.sourceId).run();
    const response = await exportRoute.request("http://local/originals-to-r2", { method: "POST" }, env);
    const result = await response.json() as any;
    const manifest = await (await env.EXPORTS.get(result.manifestKey))!.json() as any;
    const entry = manifest.objects.find((item: any) => item.originalKey === previewKey);
    expect(entry).toMatchObject({ sourceId: created.sourceId, status: "copied" });
    expect(await (await env.EXPORTS.get(entry.backupKey))!.text()).toBe("preview bytes");
  });
});
