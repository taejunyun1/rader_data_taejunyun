import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS,
  SourceDeletionClaimError,
  acquireSourceDeletionClaim,
  assertSourceDeletionNotClaimed,
  getSourceDeletionClaim,
  markSourceDeletionR2Complete,
  recordSourceDeletionError,
  renewSourceDeletionClaim,
} from "./deletionClaim";

async function insertSource(sourceId: string): Promise<string> {
  const now = new Date().toISOString();
  const versionId = `${sourceId}-version`;
  await env.DB.prepare(
    `INSERT INTO sources (id, kind, title, reliability, provenance_class, status, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'DISCOVERY', 'SOURCE', 'received', ?, ?)`,
  ).bind(sourceId, `claim fixture ${sourceId}`, now, now).run();
  await env.DB.prepare(
    `INSERT INTO source_versions (id, source_id, version, created_at)
     VALUES (?, ?, 1, ?)`,
  ).bind(versionId, sourceId, now).run();
  return versionId;
}

function laterThanLease(now: Date): Date {
  return new Date(now.getTime() + DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS + 1_000);
}

describe("source deletion claim", () => {
  it("atomically allows one live owner and rejects a second owner", async () => {
    const sourceId = `claim-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const now = new Date("2026-08-30T00:00:00.000Z");

    const first = await acquireSourceDeletionClaim(env.DB, sourceId, now);
    expect(first.sourceId).toBe(sourceId);
    expect(first.state).toBe("R2_PENDING");
    expect(first.claimToken).toMatch(/^[0-9a-f-]{36}$/);

    await expect(acquireSourceDeletionClaim(env.DB, sourceId, now)).rejects.toMatchObject({
      name: "SourceDeletionClaimError",
      code: "source_delete_in_progress",
    } satisfies Partial<SourceDeletionClaimError>);
  });

  it("resumes an expired claim without allowing a live lease to be stolen", async () => {
    const sourceId = `claim-expired-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const now = new Date("2026-08-30T00:00:00.000Z");
    const first = await acquireSourceDeletionClaim(env.DB, sourceId, now);

    await expect(acquireSourceDeletionClaim(env.DB, sourceId, new Date(now.getTime() + 1_000))).rejects.toMatchObject({
      code: "source_delete_in_progress",
    });

    const resumed = await acquireSourceDeletionClaim(env.DB, sourceId, laterThanLease(now));
    expect(resumed.claimToken).not.toBe(first.claimToken);
    expect(resumed.state).toBe("R2_PENDING");
  });

  it("renews, completes the R2 phase, and records a retryable error", async () => {
    const sourceId = `claim-state-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const now = new Date("2026-08-30T00:00:00.000Z");
    const claim = await acquireSourceDeletionClaim(env.DB, sourceId, now);
    const renewed = await renewSourceDeletionClaim(env.DB, claim, new Date(now.getTime() + 10_000));
    expect(new Date(renewed.leaseExpiresAt).getTime()).toBeGreaterThan(new Date(claim.leaseExpiresAt).getTime());

    const complete = await markSourceDeletionR2Complete(env.DB, renewed, new Date(now.getTime() + 20_000));
    expect(complete.state).toBe("R2_COMPLETE");
    expect(complete.lastErrorCode).toBeNull();

    const recorded = await recordSourceDeletionError(env.DB, complete, "source_delete_d1_failed", new Date(now.getTime() + 30_000));
    expect(recorded.state).toBe("R2_COMPLETE");
    expect(recorded.lastErrorCode).toBe("source_delete_d1_failed");
    expect(new Date(recorded.leaseExpiresAt).getTime()).toBe(new Date(now.getTime() + 30_000).getTime());
  });

  it("keeps a live R2-complete claim during D1 finalization but retries an explicit D1 failure immediately", async () => {
    const sourceId = `claim-d1-retry-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    const now = new Date("2026-08-30T00:00:00.000Z");
    const complete = await markSourceDeletionR2Complete(
      env.DB,
      await acquireSourceDeletionClaim(env.DB, sourceId, now),
      new Date(now.getTime() + 1_000),
    );

    await expect(
      acquireSourceDeletionClaim(env.DB, sourceId, new Date(now.getTime() + 2_000)),
    ).rejects.toMatchObject({ code: "source_delete_in_progress" });

    // Model a D1 failure while its lease is still live. The error marker, not
    // lease expiry, is what makes the abandoned R2-complete purge resumable.
    await env.DB.prepare(
      `UPDATE source_deletion_claims
       SET last_error_code = 'source_delete_d1_failed', lease_expires_at = ?, updated_at = ?
       WHERE source_id = ? AND claim_token = ?`,
    ).bind(
      new Date(now.getTime() + 60_000).toISOString(),
      new Date(now.getTime() + 3_000).toISOString(),
      sourceId,
      complete.claimToken,
    ).run();

    const retry = await acquireSourceDeletionClaim(env.DB, sourceId, new Date(now.getTime() + 4_000));
    expect(retry.claimToken).not.toBe(complete.claimToken);
    expect(retry.state).toBe("R2_PENDING");
    expect(retry.lastErrorCode).toBeNull();
  });

  it("asserts a claim for source-owned writes while unrelated sources remain writable", async () => {
    const sourceId = `claim-guard-${crypto.randomUUID()}`;
    const unrelatedId = `claim-unrelated-${crypto.randomUUID()}`;
    await insertSource(sourceId);
    await insertSource(unrelatedId);
    await acquireSourceDeletionClaim(env.DB, sourceId, new Date("2026-08-30T00:00:00.000Z"));

    await expect(assertSourceDeletionNotClaimed(env.DB, sourceId)).rejects.toMatchObject({
      code: "source_delete_in_progress",
    });
    await expect(assertSourceDeletionNotClaimed(env.DB, unrelatedId)).resolves.toBeUndefined();
  });

  it("blocks source-owned version, visual, and research-job inserts through DB triggers", async () => {
    const sourceId = `claim-trigger-${crypto.randomUUID()}`;
    const versionId = await insertSource(sourceId);
    await acquireSourceDeletionClaim(env.DB, sourceId, new Date("2026-08-30T00:00:00.000Z"));
    const now = new Date().toISOString();

    await expect(
      env.DB.prepare(
        `INSERT INTO source_versions (id, source_id, version, created_at) VALUES (?, ?, 2, ?)`,
      ).bind(`${sourceId}-version-2`, sourceId, now).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);

    await expect(
      env.DB.prepare(
        `INSERT INTO visual_assets
         (id, parent_source_id, parent_version_id, origin_kind, asset_role, visual_kind,
          selection_status, rights_status, is_personal_work, assignment_status, storage_state,
          processing_status, created_at, updated_at)
         VALUES (?, ?, ?, 'WEB_EMBED', 'REFERENCE', 'PHOTO', 'SELECTED', 'PERMITTED', 0,
                 'ASSIGNED', 'ARCHIVAL', 'UPLOADED', ?, ?)`,
      ).bind(`${sourceId}-asset`, sourceId, versionId, now, now).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);

    await expect(
      env.DB.prepare(
        `INSERT INTO research_jobs
         (id, kind, status, progress, input_json, dedupe_key, created_at, updated_at)
         VALUES (?, 'DEEP_ANALYSIS', 'QUEUED', 0, ?, ?, ?, ?)`,
      ).bind(`${sourceId}-job`, JSON.stringify({ sourceId }), `${sourceId}-job`, now, now).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);

    await expect(
      env.DB.prepare(
        `INSERT INTO research_jobs
         (id, kind, status, progress, input_json, dedupe_key, created_at, updated_at)
         VALUES (?, 'DISCOVERY_RUN', 'QUEUED', 0, ?, ?, ?, ?)`,
      ).bind(`${sourceId}-unrelated-job`, "not-json", `${sourceId}-unrelated-job`, now, now).run(),
    ).resolves.toBeDefined();
  });

  it("blocks updates that could mutate a claimed source-owned record", async () => {
    const sourceId = `claim-update-${crypto.randomUUID()}`;
    const versionId = await insertSource(sourceId);
    await env.DB.prepare(
      `INSERT INTO visual_assets
       (id, parent_source_id, parent_version_id, origin_kind, asset_role, visual_kind,
        selection_status, rights_status, is_personal_work, assignment_status, storage_state,
        processing_status, created_at, updated_at)
       VALUES (?, ?, ?, 'WEB_EMBED', 'REFERENCE', 'PHOTO', 'SELECTED', 'PERMITTED', 0,
               'ASSIGNED', 'ARCHIVAL', 'UPLOADED', ?, ?)`,
    ).bind(`${sourceId}-asset`, sourceId, versionId, new Date().toISOString(), new Date().toISOString()).run();
    await acquireSourceDeletionClaim(env.DB, sourceId, new Date("2026-08-30T00:00:00.000Z"));

    await expect(
      env.DB.prepare("UPDATE sources SET title = ? WHERE id = ?").bind("mutated", sourceId).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);
    await expect(
      env.DB.prepare("UPDATE source_versions SET extracted_text = ? WHERE id = ?").bind("mutated", versionId).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);
    await expect(
      env.DB.prepare("UPDATE visual_assets SET caption = ? WHERE id = ?").bind("mutated", `${sourceId}-asset`).run(),
    ).rejects.toThrow(/source_deletion_in_progress/);
  });
});
