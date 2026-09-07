import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createSource } from "../ingestion/store";
import { analyzeSource } from "./analyze";
import { embedText, ensureEmbedding } from "../lib/embed";

const sourceInput = (title: string, original: string) => ({
  kind: "NOTE" as const, title, canonicalUrl: `https://example.com/basic/${title}`, origin: "manual", original, extractedText: original,
});

describe("basic analysis provenance", () => {
  it("uses configured models and stores only source-matching fragments with version identity", async () => {
    const original = "A photograph records the light that touched its surface. The image carries a trace of time.";
    const source = await createSource(env as unknown as Env, sourceInput("verified", original));
    const run = vi.fn(async (_model: string, input: { messages?: unknown }) => input.messages
      ? { response: JSON.stringify({ summary: "A trace of time", important_fragments: ["A photograph records the light", "A fabricated quotation", "A photograph records the light"] }) }
      : { data: [[1, 2, 3]] });
    const testEnv = { ...env, MODEL_ANALYSIS: "configured-analysis", MODEL_EMBEDDING: "configured-embedding", AI: { run }, VECTOR_INDEX: { upsert: vi.fn(async () => ({})) } } as unknown as Env;
    expect(await analyzeSource(testEnv, source.sourceId)).toMatchObject({ hasAnalysis: true });
    expect(run.mock.calls.map(call => call[0])).toEqual(["configured-analysis", "configured-embedding"]);
    const fragments = await env.DB.prepare("SELECT text, context_json FROM fragments WHERE source_id = ?").bind(source.sourceId).all<{ text: string; context_json: string }>();
    expect(fragments.results).toHaveLength(1);
    expect(fragments.results[0]?.text).toBe("A photograph records the light");
    expect(JSON.parse(fragments.results[0]!.context_json)).toMatchObject({ provenance: "SOURCE", sourceVersionId: source.activeVersionId });
    const analysis = await env.DB.prepare("SELECT payload_json FROM source_analysis WHERE source_id = ?").bind(source.sourceId).first<{ payload_json: string }>();
    expect(JSON.parse(analysis!.payload_json).important_fragments).toEqual(["A photograph records the light"]);
  });

  it("keeps late basic output on its original version without indexing the new active version", async () => {
    const original = "This original photograph records the light that touched its surface.";
    const source = await createSource(env as unknown as Env, sourceInput("basic-race", original));
    const run = vi.fn(async () => {
      await createSource(env as unknown as Env, sourceInput("basic-race", "A replacement photograph records an entirely different moment."));
      return { response: JSON.stringify({ summary: "Old summary", keywords: ["old-keyword"], important_fragments: ["original photograph"] }) };
    });
    expect(await analyzeSource({ ...env, AI: { run } } as unknown as Env, source.sourceId)).toMatchObject({ hasAnalysis: true });
    const analysis = await env.DB.prepare("SELECT version_id FROM source_analysis WHERE source_id = ?").bind(source.sourceId).first<{ version_id: string }>();
    expect(analysis?.version_id).toBe(source.activeVersionId);
    expect((await env.DB.prepare("SELECT id FROM fragments WHERE source_id = ?").bind(source.sourceId).all()).results).toHaveLength(0);
    expect((await env.DB.prepare("SELECT id FROM keywords WHERE source_id = ?").bind(source.sourceId).all()).results).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not mix an older basic summary into the active version embedding", async () => {
    const source = await createSource(env as unknown as Env, sourceInput("summary-version", "First original text with sufficient embedding material."));
    await env.DB.prepare("INSERT INTO source_analysis (id, source_id, version_id, analysis_type, provenance, model, prompt_version, payload_json, cost_usd, created_at) VALUES (?, ?, ?, 'basic', 'INTERPRETATION', 'test', 'v1', ?, 0, ?)")
      .bind(crypto.randomUUID(), source.sourceId, source.activeVersionId, JSON.stringify({ summary: "OLD_SUMMARY_SENTINEL" }), new Date().toISOString()).run();
    await createSource(env as unknown as Env, sourceInput("summary-version", "New original text with sufficient embedding material."));
    const run = vi.fn(async (_model: string, _input: unknown) => ({ data: [[1, 2]] }));
    await ensureEmbedding({ ...env, AI: { run }, VECTOR_INDEX: { upsert: async () => ({}) } } as unknown as Env, source.sourceId);
    expect(JSON.stringify(run.mock.calls)).not.toContain("OLD_SUMMARY_SENTINEL");
  });

  it("does not publish an embedding when active input changes during the model call", async () => {
    const source = await createSource(env as unknown as Env, sourceInput("embedding-race", "Original text of sufficient length for embedding."));
    const upsert = vi.fn(async () => ({}));
    const testEnv = { ...env, MODEL_EMBEDDING: "configured-embedding", VECTOR_INDEX: { upsert }, AI: { run: async () => {
      await createSource(env as unknown as Env, sourceInput("embedding-race", "Changed text of sufficient length for embedding."));
      return { data: [[1, 2, 3]] };
    } } } as unknown as Env;
    expect(await ensureEmbedding(testEnv, source.sourceId)).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("uses the configured embedding model for a query", async () => {
    const run = vi.fn(async () => ({ data: [[1, 2]] }));
    expect(await embedText({ MODEL_EMBEDDING: "configured-embedding", AI: { run } } as unknown as Env, "query")).toEqual([1, 2]);
    expect(run).toHaveBeenCalledWith("configured-embedding", { text: ["query"] });
  });
});
