import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { previewHomepagePublication } from "./service";

describe("homepage publication service", () => {
  it("builds a preview from one exact publishable session", async () => {
    const sessionId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const at = "2026-09-03T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO sources (id,kind,title,canonical_url,reliability,status,created_at,updated_at) VALUES (?, 'WEB', '자료', 'https://example.com/material', 'DISCOVERY', 'indexed', ?, ?)").bind(sourceId, at, at).run();
    const output = { keywords: ["빛"], thoughts_fragments: ["생각"], questions: ["질문"], read_next: [], research_gaps: [], research_directions: ["방향"], artwork_directions: [] };
    await env.DB.prepare("INSERT INTO distill_sessions (id,sources_used_json,output_json,critic_output_json,created_at) VALUES (?,?,?,?,?)").bind(sessionId, JSON.stringify([{ id: sourceId, title: "자료" }]), JSON.stringify(output), JSON.stringify({ malformed: true }), at).run();
    const preview = await previewHomepagePublication(env, sessionId);
    expect(preview.sessionId).toBe(sessionId);
    expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.privateReview).toEqual({ warnings: [], overall: null });
    expect(preview.content.researchMaterials[0]?.url).toBe("https://example.com/material");
  });
});
