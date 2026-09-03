import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashHomepageProjection } from "./projection";
import { createD1PublicationLeaseBackend, acquirePublicationLeaseController } from "./lease";
import { beginPublishing, beginWithdrawal, finalizePublished, finalizeWithdrawn, publicationStateForSessions } from "./ledger";
import type { ExploringCurrentResearchPayload } from "@radar/shared";

const content = { displayTitle: "현재 연구", keywords: ["빛"], thoughts: ["생각"], questions: [], researchDirections: [], artworkDirections: [], researchMaterials: [] };

async function makePayload(id: string, distilledAt: string): Promise<ExploringCurrentResearchPayload> {
  return { schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING", publicationId: id, distilledAt, publishedAt: distilledAt, updatedAt: distilledAt, contentHash: await hashHomepageProjection(distilledAt, content), content };
}

async function withLease<T>(fn: (lease: Awaited<ReturnType<ReturnType<typeof createD1PublicationLeaseBackend>["acquire"]>>) => Promise<T>): Promise<T> {
  const controller = await acquirePublicationLeaseController(createD1PublicationLeaseBackend(env.DB));
  try { return await fn(controller.currentLease()); } finally { await controller.stop(); await createD1PublicationLeaseBackend(env.DB).release(controller.currentLease()); }
}

describe("publication ledger transitions", () => {
  it("reserves a stable identity and finalizes publish with one event", async () => {
    const sessionId = crypto.randomUUID();
    const createdAt = "2026-09-03T00:00:00.000Z";
    await env.DB.prepare("INSERT INTO distill_sessions (id, output_json, sources_used_json, created_at) VALUES (?, '{}', '[]', ?)").bind(sessionId, createdAt).run();
    await withLease(async (lease) => {
      const hash = await hashHomepageProjection(createdAt, content);
      const edition = await beginPublishing(env.DB, lease, { sessionId, contentHash: hash, actorSub: "user:test", approvedAt: createdAt });
      const payload = await makePayload(edition.publicationId, edition.eventAt);
      await finalizePublished(env.DB, lease, { previousPublicationId: null, publication: payload });
      const row = await env.DB.prepare("SELECT status, pending_action FROM homepage_publications WHERE id=?").bind(edition.publicationId).first<{ status: string; pending_action: string | null }>();
      expect(row).toEqual({ status: "PUBLISHED", pending_action: null });
      expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM homepage_publication_events WHERE publication_id=?").bind(edition.publicationId).first<{ count: number }>())?.count).toBe(1);
    });
  });

  it("allocates withdrawal intent and consumes it into a tombstone state", async () => {
    const row = await env.DB.prepare("SELECT id FROM homepage_publications WHERE status='PUBLISHED' ORDER BY created_at DESC LIMIT 1").first<{ id: string }>();
    expect(row).toBeTruthy();
    await withLease(async (lease) => {
      const intent = await beginWithdrawal(env.DB, lease, { publicationId: row!.id, actorSub: "user:test", requestedAt: "2026-09-03T00:00:00.000Z" });
      await finalizeWithdrawn(env.DB, lease, { publicationId: intent.publicationId });
      const state = await env.DB.prepare("SELECT status, withdrawn_at FROM homepage_publications WHERE id=?").bind(row!.id).first<{ status: string; withdrawn_at: string | null }>();
      expect(state?.status).toBe("WITHDRAWN");
      expect(state?.withdrawn_at).toBe(intent.eventAt);
    });
  });

  it("never infers CURRENT from D1 alone", async () => {
    const sessionId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO distill_sessions (id, output_json, sources_used_json, created_at) VALUES (?, '{}', '[]', ?)").bind(sessionId, "2026-09-03T00:00:01.000Z").run();
    await env.DB.prepare("INSERT INTO homepage_publications (id,distill_session_id,status,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), sessionId, "PUBLISHED", "b".repeat(64), "2026-09-03T00:00:01.000Z", "2026-09-03T00:00:01.000Z").run();
    expect((await publicationStateForSessions(env.DB, [sessionId], null)).get(sessionId)).not.toBe("CURRENT");
  });
});
