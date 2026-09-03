import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CurrentResearchContent } from "@radar/shared";
import { buildHomepageProjection, canonicalJson, deriveDisplayTitle, hashHomepageProjection, loadLatestPublishableDistill } from "./projection";

const output = (overrides: Record<string, unknown> = {}) => ({
  keywords: ["빛", "기억"],
  thoughts_fragments: ["  첫 생각\u0000"],
  questions: ["첫 질문"],
  read_next: [],
  research_gaps: [],
  research_directions: ["방향"],
  artwork_directions: ["작업"],
  ...overrides,
});

const content: CurrentResearchContent = {
  displayTitle: "현재 연구",
  keywords: ["빛"],
  thoughts: ["생각"],
  questions: ["질문"],
  researchDirections: ["방향"],
  artworkDirections: [],
  researchMaterials: [],
};

describe("public projection primitives", () => {
  it("derives and bounds the display title without changing source arrays", () => {
    expect(deriveDisplayTitle({ questions: ["첫 질문"], researchDirections: ["방향"] })).toBe("첫 질문");
    expect(deriveDisplayTitle({ questions: [], researchDirections: ["방향"] })).toBe("방향");
    expect(deriveDisplayTitle({ questions: [], researchDirections: [] })).toBe("현재 연구");
    expect([...deriveDisplayTitle({ questions: ["가".repeat(201)], researchDirections: [] })]).toHaveLength(200);
  });

  it("canonicalizes recursive records while preserving array order and null", () => {
    expect(canonicalJson({ z: null, a: ["두", "하나"], nested: { b: 2, a: 1 } })).toBe('{"a":["두","하나"],"nested":{"a":1,"b":2},"z":null}');
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });

  it("hashes the distilled timestamp and content as lowercase sha256", async () => {
    await expect(hashHomepageProjection("2026-09-03T00:00:00.000Z", content)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(hashHomepageProjection("2026-09-03T00:00:00.000Z", content)).resolves.toBe(await hashHomepageProjection("2026-09-03T00:00:00.000Z", content));
  });
});

describe("public Distill selection and material join", () => {
  it("skips invalid newest rows and preserves the first valid row", async () => {
    const now = new Date().toISOString();
    const sourceId = `projection-source-${crypto.randomUUID()}`;
    const invalidId = `projection-invalid-${crypto.randomUUID()}`;
    const validId = `projection-valid-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '자료', 'https://example.com/source', 'DISCOVERY', 'indexed', ?, ?)`).bind(sourceId, now, now),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, critic_output_json, created_at) VALUES (?, ?, ?, ?, ?)`).bind(invalidId, JSON.stringify([{ id: sourceId, title: "자료" }]), JSON.stringify({ nope: true }), null, now),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, critic_output_json, created_at) VALUES (?, ?, ?, ?, ?)`).bind(validId, JSON.stringify([{ id: sourceId, title: "자료" }]), JSON.stringify(output()), JSON.stringify({ malformed: true }), now),
    ]);

    const selected = await loadLatestPublishableDistill(env.DB);
    expect(selected?.id).toBe(validId);
    expect(selected?.critic).toBeNull();
    const draft = await buildHomepageProjection(env.DB, selected!);
    expect(draft.content.researchMaterials).toEqual([{ title: "자료", author: null, year: null, url: "https://example.com/source" }]);
    expect(draft.privateReview).toEqual({ warnings: [], overall: null });
  });
});
