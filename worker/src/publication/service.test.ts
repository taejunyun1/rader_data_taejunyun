import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { compareAndSwapCurrent, readCurrentPublication } from "./storage";
import { hashHomepageProjection } from "./projection";
import { getHomepagePublicationStatus, previewHomepagePublication, withdrawHomepagePublication } from "./service";
import type { ExploringCurrentResearchPayload, WithdrawnCurrentResearchPayload } from "@radar/shared";

const content = { displayTitle: "현재 연구", keywords: ["빛"], thoughts: ["생각"], questions: [], researchDirections: [], artworkDirections: [], researchMaterials: [] };

async function seedLedgerRow(input: { publicationId: string; sessionId: string; contentHash: string; status?: string }) {
  const at = "2026-09-03T00:00:00.000Z";
  await env.DB.prepare("INSERT INTO distill_sessions (id,output_json,sources_used_json,created_at) VALUES (?, '{}', '[]', ?)").bind(input.sessionId, at).run();
  await env.DB.prepare("INSERT INTO homepage_publications (id,distill_session_id,status,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .bind(input.publicationId, input.sessionId, input.status ?? "PUBLISHED", input.contentHash, at, at).run();
}

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

  it("fails closed when an exploring current has no matching private ledger identity", async () => {
    await env.PUBLICATIONS.delete("homepage/current-research.json");
    const distilledAt = "2026-09-03T00:00:00.000Z";
    const publicationId = crypto.randomUUID();
    const payload: ExploringCurrentResearchPayload = {
      schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING",
      publicationId, distilledAt, publishedAt: distilledAt, updatedAt: distilledAt,
      contentHash: await hashHomepageProjection(distilledAt, content), content,
    };
    await compareAndSwapCurrent(env.PUBLICATIONS, await readCurrentPublication(env.PUBLICATIONS), payload);
    await expect(getHomepagePublicationStatus(env, () => undefined)).rejects.toMatchObject({ code: "publication_ledger_unavailable", status: 503 });
  });

  it("returns idempotent withdrawal success for a matching tombstone before revision comparison", async () => {
    await env.PUBLICATIONS.delete("homepage/current-research.json");
    const distilledAt = "2026-09-03T00:00:00.000Z";
    const publicationId = crypto.randomUUID();
    const contentHash = await hashHomepageProjection(distilledAt, content);
    await seedLedgerRow({ publicationId, sessionId: crypto.randomUUID(), contentHash });
    const tombstone: WithdrawnCurrentResearchPayload = {
      schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "WITHDRAWN",
      withdrawnPublicationId: publicationId, withdrawnContentHash: contentHash, withdrawnAt: "2026-09-03T00:01:00.000Z",
    };
    const current = await compareAndSwapCurrent(env.PUBLICATIONS, await readCurrentPublication(env.PUBLICATIONS), tombstone);
    const deferred: Promise<unknown>[] = [];
    await expect(withdrawHomepagePublication(env, {
      expectedPublicationId: publicationId,
      expectedContentHash: contentHash,
      expectedCurrentRevision: "old-revision",
      actorSub: "user:test",
      defer: (work) => deferred.push(work),
    })).resolves.toMatchObject({
      ok: true, state: "WITHDRAWN", withdrawnPublicationId: publicationId,
      withdrawnAt: tombstone.withdrawnAt, currentRevision: current.currentRevision,
      idempotent: true, ledgerReconcilePending: false,
    });
    await Promise.all(deferred);
  });
});
