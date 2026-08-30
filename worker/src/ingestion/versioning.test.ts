import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appendAcquisitionVersion } from "./versioning";
import { acquireSourceDeletionClaim, isSourceDeletionClaimError } from "../reservoir/deletionClaim";

async function insertSource(sourceId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, reliability, provenance_class, status, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'DISCOVERY', 'SOURCE', 'received', ?, ?)`,
  ).bind(sourceId, `versioning fixture ${sourceId}`, now, now).run();
}

describe("appendAcquisitionVersion deletion claim boundary", () => {
  it("rolls back the version row and source metadata when a claim wins at the D1 batch boundary", async () => {
    const sourceId = `versioning-claim-race-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const before = await env.DB.prepare("SELECT updated_at AS updatedAt FROM sources WHERE id = ?")
      .bind(sourceId)
      .first<{ updatedAt: string }>();
    const versionId = `${sourceId}-version-2`;
    let claimAcquired = false;
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "batch") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (statements: D1PreparedStatement[]) => {
          await acquireSourceDeletionClaim(env.DB, sourceId, new Date("2026-08-30T00:00:00.000Z"));
          claimAcquired = true;
          return env.DB.batch(statements);
        };
      },
    }) as unknown as D1Database;

    const error = await appendAcquisitionVersion(db, {
      sourceId,
      versionId,
      r2Key: `originals/${sourceId}/v2-race.html`,
      extractedText: "late source version",
      inputFormat: "URL_HTML",
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
      versionOrigin: "REEXTRACT",
    }).catch((caught: unknown) => caught);

    expect(claimAcquired).toBe(true);
    expect(isSourceDeletionClaimError(error)).toBe(true);
    const version = await env.DB.prepare("SELECT id FROM source_versions WHERE id = ?")
      .bind(versionId)
      .first();
    const after = await env.DB.prepare("SELECT updated_at AS updatedAt FROM sources WHERE id = ?")
      .bind(sourceId)
      .first<{ updatedAt: string }>();
    expect(version).toBeNull();
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });
});
