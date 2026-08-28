import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSource } from "../src/ingestion/store";

const input = (original: string) => ({
  kind: "WEB" as const,
  title: "Photography and Automation",
  authors: "Ada Example",
  canonicalUrl: "https://example.com/paper",
  doi: "10.1234/example",
  origin: "manual:test",
  original,
  extractedText: original,
  inputFormat: "PLAIN_TEXT" as const,
  textScope: "FULLTEXT" as const,
  extractionMethod: "MANUAL_TEXT" as const,
});

describe("source version raw-byte integrity", () => {
  it("keeps changed bytes as a new version while exact reimport stays idempotent", async () => {
    const first = await createSource(env as unknown as Env, input("first source body"));
    const changed = await createSource(env as unknown as Env, input("changed source body"));
    const exact = await createSource(env as unknown as Env, input("changed source body"));

    expect(first.sourceId).toBe(changed.sourceId);
    expect(exact.sourceId).toBe(first.sourceId);
    expect(exact.activeVersionId).toBe(changed.activeVersionId);

    const versions = await env.DB.prepare(
      "SELECT version, r2_key, raw_content_hash, normalized_content_hash FROM source_versions WHERE source_id = ? ORDER BY version",
    ).bind(first.sourceId).all<{ version: number; r2_key: string | null; raw_content_hash: string | null; normalized_content_hash: string | null }>();
    expect(versions.results).toHaveLength(2);
    expect(versions.results[0]?.version).toBe(1);
    expect(versions.results[1]?.version).toBe(2);
    expect(versions.results[0]?.r2_key).not.toBe(versions.results[1]?.r2_key);
    expect(versions.results[0]?.raw_content_hash).not.toBe(versions.results[1]?.raw_content_hash);
    expect(versions.results[0]?.normalized_content_hash).toBeTruthy();
    expect(versions.results[1]?.normalized_content_hash).toBeTruthy();
    expect((await env.ORIGINALS.get(versions.results[0]!.r2_key!))?.body).toBeTruthy();
    expect((await env.ORIGINALS.get(versions.results[1]!.r2_key!))?.body).toBeTruthy();
  });

  it("enforces version_id referential integrity for analysis rows", async () => {
    const source = await createSource(env as unknown as Env, input("analysis body"));
    await expect(env.DB.prepare(
      `INSERT INTO source_analysis
       (id, source_id, version_id, analysis_type, provenance, payload_json, created_at)
       VALUES (?, ?, ?, 'basic', 'INTERPRETATION', '{}', ?)`
    ).bind("orphan-analysis", source.sourceId, "missing-version", new Date().toISOString()).run()).rejects.toThrow();
  });

  it("converges concurrent identity claims to one logical source", async () => {
    const shared = {
      ...input("concurrent source A"),
      title: "Concurrent identity claim",
      canonicalUrl: "https://example.com/concurrent-identity",
      doi: "10.1234/concurrent-identity",
    };
    const [first, second] = await Promise.all([
      createSource(env as unknown as Env, shared),
      createSource(env as unknown as Env, { ...shared, original: "concurrent source B", extractedText: "concurrent source B" }),
    ]);

    expect(first.sourceId).toBe(second.sourceId);
    const sources = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sources WHERE canonical_url = ?",
    ).bind(shared.canonicalUrl).first<{ n: number }>();
    const versions = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM source_versions WHERE source_id = ?",
    ).bind(first.sourceId).first<{ n: number }>();
    expect(sources?.n).toBe(1);
    expect(versions?.n).toBe(2);
  });
});
