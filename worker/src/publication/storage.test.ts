import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CurrentResearchContent, ExploringCurrentResearchPayload } from "@radar/shared";
import { hashHomepageProjection } from "./projection";
import {
  CURRENT_RESEARCH_KEY,
  compareAndSwapCurrent,
  hasPermanentPurgeMarker,
  historyKey,
  putHistoryEventIfAbsent,
  putPermanentPurgeMarker,
  readCurrentPublication,
  readPurgeMarker,
} from "./storage";

const content: CurrentResearchContent = {
  displayTitle: "현재 연구",
  keywords: ["빛"],
  thoughts: ["생각"],
  questions: [],
  researchDirections: [],
  artworkDirections: [],
  researchMaterials: [],
};

async function payload(id = crypto.randomUUID()): Promise<ExploringCurrentResearchPayload> {
  const distilledAt = "2026-09-03T00:00:00.000Z";
  const contentHash = await hashHomepageProjection(distilledAt, content);
  return { schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING", publicationId: id, distilledAt, publishedAt: distilledAt, updatedAt: distilledAt, contentHash, content };
}

describe("publication R2 storage", () => {
  it("reads missing current and uses an opaque revision", async () => {
    await env.PUBLICATIONS.delete(CURRENT_RESEARCH_KEY);
    const snapshot = await readCurrentPublication(env.PUBLICATIONS);
    expect(snapshot.exists).toBe(false);
    expect(snapshot.currentRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("performs conditional current CAS and rejects a stale expected snapshot", async () => {
    await env.PUBLICATIONS.delete(CURRENT_RESEARCH_KEY);
    const before = await readCurrentPublication(env.PUBLICATIONS);
    const first = await payload();
    const after = await compareAndSwapCurrent(env.PUBLICATIONS, before, first);
    expect(after.exists).toBe(true);
    await expect(compareAndSwapCurrent(env.PUBLICATIONS, before, await payload())).rejects.toThrow("publication_state_changed");
    const reread = await readCurrentPublication(env.PUBLICATIONS);
    expect(reread.exists && reread.wrapper.payload).toEqual(first);
  });

  it("writes immutable history idempotently and fences a purged session", async () => {
    const sessionId = crypto.randomUUID();
    const first = await payload();
    await env.PUBLICATIONS.delete(historyKey(first.publicationId, first.updatedAt));
    await putHistoryEventIfAbsent(env.PUBLICATIONS, { distillSessionId: sessionId, payload: first });
    await putHistoryEventIfAbsent(env.PUBLICATIONS, { distillSessionId: sessionId, payload: first });
    await putPermanentPurgeMarker(env.PUBLICATIONS, { distillSessionId: sessionId, requestedPublicationId: first.publicationId, createdAt: first.updatedAt });
    expect(await hasPermanentPurgeMarker(env.PUBLICATIONS, sessionId)).toBe(true);
    expect(await readPurgeMarker(env.PUBLICATIONS, sessionId)).toMatchObject({ distillSessionId: sessionId, requestedPublicationId: first.publicationId });
    await expect(putHistoryEventIfAbsent(env.PUBLICATIONS, { distillSessionId: sessionId, payload: await payload(crypto.randomUUID()) })).rejects.toThrow("publication_purged");
  });
});
