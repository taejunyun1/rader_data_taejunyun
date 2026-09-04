import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CurrentResearchContent } from "@radar/shared";
import { buildHomepageProjection, canonicalJson, deriveDisplayTitle, hashHomepageProjection, loadLatestPublishableDistill, type PublishableDistillSession } from "./projection";

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

function session(id: string, sourcesUsed: Array<{ id: string; title: string }> = [], overrides: Record<string, unknown> = {}): PublishableDistillSession {
  return { id, createdAt: "2026-09-03T00:00:00.000Z", sourcesUsed, output: output(overrides), critic: null };
}

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
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalJson(sparse)).toThrow(/sparse_array/);
    expect(() => canonicalJson(new Date())).toThrow(/non_plain_record/);
    expect(canonicalJson({ "\uE000": 1, "😀": 2 })).toBe('{"😀":2,"":1}');
  });

  it("hashes the distilled timestamp and content as lowercase sha256", async () => {
    await expect(hashHomepageProjection("2026-09-03T00:00:00.000Z", content)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(hashHomepageProjection("2026-09-03T00:00:00.000Z", content)).resolves.toBe(await hashHomepageProjection("2026-09-03T00:00:00.000Z", content));
  });

  it("keeps layered detail notes out of the homepage projection", async () => {
    const now = new Date().toISOString();
    const sourceId = `projection-layered-source-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '자료', 'https://example.com/layered', 'DISCOVERY', 'indexed', ?, ?)`).bind(sourceId, now, now).run();
    const base = session(`projection-layered-base-${crypto.randomUUID()}`, [{ id: sourceId, title: "자료" }]);
    const layered = {
      ...base,
      id: `projection-layered-detail-${crypto.randomUUID()}`,
      output: output({ details: {
        thoughts: [{ summaryIndex: 0, rationale: "내부 근거", sourceIds: [sourceId], uncertainty: "불확실성", nextCheck: "다음 확인" }],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      } }),
    };
    const [baseDraft, layeredDraft] = await Promise.all([
      buildHomepageProjection(env.DB, base),
      buildHomepageProjection(env.DB, layered),
    ]);
    expect(layeredDraft.content).toEqual(baseDraft.content);
    expect(layeredDraft.contentHash).toBe(baseDraft.contentHash);
    expect(layeredDraft.content).not.toHaveProperty("details");
  });

  it("keeps a valid public summary publishable when stored details are malformed", async () => {
    const now = new Date().toISOString();
    const sourceId = `projection-malformed-details-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '자료', 'https://example.com/malformed-details', 'PRIMARY', 'indexed', ?, ?)`).bind(sourceId, now, now).run();
    const malformed = session(`projection-malformed-session-${crypto.randomUUID()}`, [{ id: sourceId, title: "자료" }], {
      details: {
        thoughts: [{ summaryIndex: 0, rationale: 42, sourceIds: [sourceId], uncertainty: "불확실", nextCheck: "확인" }],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      },
    });

    const draft = await buildHomepageProjection(env.DB, malformed);

    expect(draft.content.thoughts).toEqual(["첫 생각"]);
    expect(draft.content).not.toHaveProperty("details");
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
    expect(draft.content.thoughts).toEqual(["첫 생각"]);
  });

  it("uses id DESC as the deterministic tie breaker and falls back past missing sources", async () => {
    const now = new Date().toISOString();
    const sourceId = `projection-tie-source-${crypto.randomUUID()}`;
    const tieAt = "2099-01-01T00:00:00.000Z";
    await env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '정렬 자료', 'https://example.com/tie', 'DISCOVERY', 'indexed', ?, ?)`).bind(sourceId, now, now).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES ('projection-tie-a', ?, ?, ?)`).bind(JSON.stringify([{ id: sourceId, title: "정렬 자료" }]), JSON.stringify(output({ questions: ["A"] })), tieAt),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES ('projection-tie-z', ?, ?, ?)`).bind(JSON.stringify([{ id: sourceId, title: "정렬 자료" }]), JSON.stringify(output({ questions: ["Z"] })), tieAt),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES ('projection-missing-new', ?, ?, '2099-02-01T00:00:00.000Z')`).bind(JSON.stringify([{ id: `projection-never-${crypto.randomUUID()}`, title: "삭제 자료" }]), JSON.stringify(output({ questions: ["missing"] }))),
    ]);
    const selected = await loadLatestPublishableDistill(env.DB);
    expect(selected?.id).toBe("projection-tie-z");
    expect(selected?.output.questions).toEqual(["Z"]);
  });

  it("skips sessions whose source was deleted but blocks a selected session with a deletion claim", async () => {
    const now = new Date().toISOString();
    const sourceId = `projection-claim-source-${crypto.randomUUID()}`;
    const deletedId = `projection-deleted-source-${crypto.randomUUID()}`;
    const olderId = `projection-older-${crypto.randomUUID()}`;
    const selectedId = `projection-claimed-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '활성 자료', 'https://example.com/active', 'DISCOVERY', 'indexed', ?, ?)`).bind(sourceId, now, now),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES (?, ?, ?, ?)`).bind(olderId, JSON.stringify([{ id: sourceId, title: "활성 자료" }]), JSON.stringify(output()), "2100-01-01T00:00:00.000Z"),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES (?, ?, ?, ?)`).bind(`projection-deleted-${crypto.randomUUID()}`, JSON.stringify([{ id: deletedId, title: "삭제 자료" }]), JSON.stringify(output()), "2100-02-01T00:00:00.000Z"),
      env.DB.prepare(`INSERT INTO distill_sessions (id, sources_used_json, output_json, created_at) VALUES (?, ?, ?, ?)`).bind(selectedId, JSON.stringify([{ id: sourceId, title: "활성 자료" }]), JSON.stringify(output()), "2100-03-01T00:00:00.000Z"),
      env.DB.prepare(`INSERT INTO source_deletion_claims (source_id, claim_token, state, lease_expires_at, created_at, updated_at) VALUES (?, ?, 'R2_PENDING', ?, ?, ?)`).bind(sourceId, crypto.randomUUID(), "2999-01-01T00:00:00.000Z", now, now),
    ]);
    await expect(loadLatestPublishableDistill(env.DB)).rejects.toThrow("source_delete_in_progress");
    await expect(buildHomepageProjection(env.DB, session(selectedId, [{ id: sourceId, title: "활성 자료" }]))).rejects.toThrow("source_delete_in_progress");
  });

  it("joins ordered materials, prefers canonical URLs, falls back to DOI, excludes private URLs, and counts overflow", async () => {
    const now = new Date().toISOString();
    const ids = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const id = `projection-material-${crypto.randomUUID()}`;
      const canonical = index === 1 ? null : index === 2 ? "http://127.0.0.1/private" : index === 3 ? "https://example.local/private" : `https://example.com/${index}`;
      const doi = index === 1 ? "10.1234/DOI.TEST" : null;
      await env.DB.prepare(`INSERT INTO sources (id, kind, title, authors, year, canonical_url, doi, reliability, status, created_at, updated_at) VALUES (?, 'WEB', ?, ?, 2024, ?, ?, 'DISCOVERY', 'indexed', ?, ?)`).bind(id, `자료 ${index}`, index === 0 ? "저자" : null, canonical, doi, now, now).run();
      return { id, title: `입력 ${index}` };
    }));
    const draft = await buildHomepageProjection(env.DB, session(`projection-material-session-${crypto.randomUUID()}`, ids));
    expect(draft.content.researchMaterials.map((material) => material.url)).toEqual(["https://example.com/0", "https://doi.org/10.1234/doi.test", "https://example.com/4", "https://example.com/5", "https://example.com/6"]);
    expect(draft.excludedResearchMaterialCount).toBe(4);
    const longUrlId = `projection-material-long-${crypto.randomUUID()}`;
    const invalidYearId = `projection-material-year-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sources (id, kind, title, year, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '긴 URL', 2024, ?, 'DISCOVERY', 'indexed', ?, ?)`).bind(longUrlId, `https://example.com/${"x".repeat(2048)}`, now, now),
      env.DB.prepare(`INSERT INTO sources (id, kind, title, year, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '잘못된 연도', -1, 'https://example.com/year', 'DISCOVERY', 'indexed', ?, ?)`).bind(invalidYearId, now, now),
    ]);
    const longDraft = await buildHomepageProjection(env.DB, session(`projection-material-long-session-${crypto.randomUUID()}`, [{ id: longUrlId, title: "긴 URL" }]));
    expect(longDraft.content.researchMaterials).toEqual([]);
    expect(longDraft.excludedResearchMaterialCount).toBe(1);
    await expect(buildHomepageProjection(env.DB, session(`projection-material-year-session-${crypto.randomUUID()}`, [{ id: invalidYearId, title: "잘못된 연도" }]))).rejects.toThrow(/Year_invalid/);
  });

  it("rejects copied array counts and HTML-like or over-limit values", async () => {
    const base = session(`projection-invalid-${crypto.randomUUID()}`);
    await expect(buildHomepageProjection(env.DB, { ...base, output: output({ keywords: Array.from({ length: 8 }, () => "키워드") }) })).rejects.toThrow(/count_too_large/);
    await expect(buildHomepageProjection(env.DB, { ...base, output: output({ thoughts_fragments: ["<b>위험</b>"] }) })).rejects.toThrow(/html_like/);
    await expect(buildHomepageProjection(env.DB, { ...base, output: output({ questions: ["질문".repeat(401)] }) })).rejects.toThrow(/too_long/);
    await expect(buildHomepageProjection(env.DB, { ...base, createdAt: "x".repeat(70_000) })).rejects.toThrow(/public_projection_too_large/);
  });

  it.each([
    ["comment", "<!-- private -->"],
    ["doctype", "<!doctype html>"],
    ["tag", "<em>private</em>"],
  ])("rejects %s markup in every copied text field", async (_label, value) => {
    const fields = ["keywords", "thoughts_fragments", "questions", "research_directions", "artwork_directions"] as const;
    for (const field of fields) {
      await expect(buildHomepageProjection(env.DB, session(`projection-sanitize-${field}-${crypto.randomUUID()}`, [], { [field]: [value] }))).rejects.toThrow(/html_like/);
    }
  });

  it("preserves mathematical symbols and accepts a maximal valid content envelope", async () => {
    const maximal = session(`projection-maximal-${crypto.randomUUID()}`, [], {
      keywords: Array.from({ length: 7 }, () => "키".repeat(80)),
      thoughts_fragments: Array.from({ length: 5 }, () => "생각 ∑ ≤ ".repeat(75).slice(0, 600)),
      questions: Array.from({ length: 3 }, () => "질문 ∑ ≤ ".repeat(50).slice(0, 400)),
      research_directions: Array.from({ length: 2 }, () => "방향 ∑ ≤ ".repeat(75).slice(0, 600)),
      artwork_directions: Array.from({ length: 2 }, () => "작업 ∑ ≤ ".repeat(75).slice(0, 600)),
    });
    const draft = await buildHomepageProjection(env.DB, maximal);
    expect(draft.content.thoughts[0]).toContain("∑");
  });

  it.each([
    "https://8.8.8.8/public",
    "https://[2001:db8::1]/public",
    "https://[::ffff:8.8.8.8]/public",
    "https://localhost./private",
    "https://research.local./private",
  ])("excludes IP literals and trailing-dot local host %s", async (url) => {
    const now = new Date().toISOString();
    const id = `projection-url-boundary-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO sources (id, kind, title, canonical_url, reliability, status, created_at, updated_at) VALUES (?, 'WEB', '경계 URL', ?, 'DISCOVERY', 'indexed', ?, ?)`).bind(id, url, now, now).run();
    const draft = await buildHomepageProjection(env.DB, session(`projection-url-session-${crypto.randomUUID()}`, [{ id, title: "경계 URL" }]));
    expect(draft.content.researchMaterials).toEqual([]);
    expect(draft.excludedResearchMaterialCount).toBe(1);
  });
});
