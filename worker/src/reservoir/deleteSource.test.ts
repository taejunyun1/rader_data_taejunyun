import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createLogicalMerge } from "./mergeGroups";
import {
  deleteSourcePermanently,
  getSourceDeletionPreview,
  SourceDeletionError,
} from "./deleteSource";

async function insertSource(id: string, title: string, r2Key: string | null = null): Promise<string> {
  const now = new Date().toISOString();
  const versionId = `${id}-v1`;
  await env.DB.prepare(
    `INSERT INTO sources
     (id, kind, title, reliability, status, quality_status, active_version_id, r2_key, created_at, updated_at)
     VALUES (?, 'WEB', ?, 'PRIMARY', 'stored', 'READY', ?, ?, ?, ?)`,
  ).bind(id, title, versionId, r2Key, now, now).run();
  await env.DB.prepare(
    `INSERT INTO source_versions
     (id, source_id, version, r2_key, normalized_text, char_count, normalization_status,
      version_origin, review_status, text_scope, extraction_method, created_at)
     VALUES (?, ?, 1, ?, 'full text', 9, 'READY', 'INITIAL_INGEST', 'ACTIVE', 'FULLTEXT', 'MANUAL_TEXT', ?)`,
  ).bind(versionId, id, r2Key, now).run();
  if (r2Key) await env.ORIGINALS.put(r2Key, `original:${id}`);
  return versionId;
}

async function insertVisualDeletionFixture(sourceId: string, versionId: string): Promise<{
  assetId: string;
  visualKey: string;
  tempKey: string;
}> {
  const now = new Date().toISOString();
  const assetId = `${sourceId}-asset`;
  const visualKey = `tests/delete/${sourceId}/visual`;
  const tempKey = `tests/delete/${sourceId}/temp`;
  const runId = `${sourceId}-run`;
  await env.DB.prepare(
    `INSERT INTO visual_assets
     (id, parent_source_id, parent_version_id, origin_kind, source_url, asset_role, visual_kind,
      selection_status, rights_status, is_personal_work, assignment_status, storage_state,
      processing_status, created_at, updated_at)
     VALUES (?, ?, ?, 'WEB_EMBED', 'https://example.com/a.jpg', 'REFERENCE', 'PHOTO',
             'SELECTED', 'PERMITTED', 0, 'ASSIGNED', 'ARCHIVAL', 'READY', ?, ?)`,
  ).bind(assetId, sourceId, versionId, now, now).run();
  await env.DB.prepare(
    `INSERT INTO visual_asset_versions
     (id, visual_asset_id, version, variant, r2_key, mime_type, byte_size, content_hash, created_at)
     VALUES (?, ?, 1, 'ORIGINAL', ?, 'image/jpeg', 3, ?, ?)`,
  ).bind(`${assetId}-v1`, assetId, visualKey, `${assetId}-hash`, now).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visual_analyses
       (id, visual_asset_id, visual_version_id, analysis_type, provenance_class,
        payload_json, cost_usd, review_status, created_at)
       VALUES (?, ?, ?, 'AUTO_SUGGESTION', 'INTERPRETATION', '{}', 0, 'PENDING', ?)`,
    ).bind(`${assetId}-analysis`, assetId, `${assetId}-v1`, now),
    env.DB.prepare(
      `INSERT INTO visual_embeddings
       (id, visual_asset_id, visual_version_id, basis, model_id, dimensions, vector_id, created_at)
       VALUES (?, ?, ?, 'ANALYSIS_TEXT', 'test-model', 3, ?, ?)`,
    ).bind(`${assetId}-embedding`, assetId, `${assetId}-v1`, `${assetId}-vector`, now),
    env.DB.prepare(
      `INSERT INTO visual_relations
       (id, from_visual_asset_id, related_source_id, relation_kind, created_by, created_at)
       VALUES (?, ?, ?, 'SOURCE_CONTEXT', 'USER', ?)`,
    ).bind(`${assetId}-relation`, assetId, sourceId, now),
    env.DB.prepare(
      `INSERT INTO visual_asset_operations
       (id, visual_asset_id, operation_kind, from_state, to_state, status, created_at, finished_at)
       VALUES (?, ?, 'DELETE_CAPSULE', 'ARCHIVAL', 'TEXT_ONLY', 'SUCCEEDED', ?, ?)`,
    ).bind(`${assetId}-operation`, assetId, now, now),
  ]);
  await env.DB.prepare(
    `INSERT INTO visual_extraction_runs
     (id, parent_source_id, parent_version_id, origin_kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'WEB_EMBED', 'FAILED', ?, ?)`,
  ).bind(runId, sourceId, versionId, now, now).run();
  await env.DB.prepare(
    `INSERT INTO visual_extraction_units
     (id, run_id, unit_number, candidate_key, status, temp_r2_key, created_at)
     VALUES (?, ?, 1, 'candidate-1', 'FAILED', ?, ?)`,
  ).bind(`${sourceId}-unit`, runId, tempKey, now).run();
  await env.ORIGINALS.put(visualKey, "visual");
  await env.ORIGINALS.put(tempKey, "temp");
  return { assetId, visualKey, tempKey };
}

async function expectDeletionError(
  promise: Promise<unknown>,
  code: SourceDeletionError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "SourceDeletionError", code });
}

describe("source deletion preflight", () => {
  it("describes standalone, member, and canonical merge impact", async () => {
    const prefix = crypto.randomUUID();
    const canonicalId = `${prefix}-canonical`;
    const memberId = `${prefix}-member`;
    const standaloneId = `${prefix}-standalone`;
    await insertSource(canonicalId, "대표 자료");
    await insertSource(memberId, "병합 구성원");
    await insertSource(standaloneId, "단독 자료");
    await createLogicalMerge(env.DB, {
      canonicalSourceId: canonicalId,
      memberSourceIds: [memberId],
      mode: "MANUAL",
      confidence: 1,
      reasons: ["manual_review"],
    });

    await expect(getSourceDeletionPreview(env.DB, standaloneId)).resolves.toMatchObject({
      sourceId: standaloneId,
      title: "단독 자료",
      mergeRole: "NONE",
      mergeMemberCount: 1,
    });
    await expect(getSourceDeletionPreview(env.DB, canonicalId)).resolves.toMatchObject({
      mergeRole: "CANONICAL",
      mergeMemberCount: 2,
    });
    await expect(getSourceDeletionPreview(env.DB, memberId)).resolves.toMatchObject({
      mergeRole: "MEMBER",
      mergeMemberCount: 2,
    });
  });

  it("rejects missing source and exact-title mismatch before touching R2", async () => {
    const sourceId = `${crypto.randomUUID()}-confirm`;
    await insertSource(sourceId, "정확한 제목", `tests/delete/${sourceId}/v1`);
    const deleteObject = vi.fn();
    const testEnv = { DB: env.DB, ORIGINALS: { delete: deleteObject } } as unknown as Pick<Env, "DB" | "ORIGINALS">;

    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId: `${sourceId}-missing`, confirmTitle: "정확한 제목" }),
      "source_not_found",
    );
    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId, confirmTitle: "정확한 제목 " }),
      "source_delete_confirmation_mismatch",
    );
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("blocks queued research work and active visual extraction", async () => {
    const sourceId = `${crypto.randomUUID()}-busy`;
    const versionId = await insertSource(sourceId, "작업 중 자료");
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO research_jobs
       (id, kind, status, progress, input_json, dedupe_key, created_at, updated_at)
       VALUES (?, 'DEEP_ANALYSIS', 'QUEUED', 0, ?, ?, ?, ?)`,
    ).bind(`${sourceId}-job`, JSON.stringify({ sourceId }), `${sourceId}-job`, now, now).run();

    await expectDeletionError(
      deleteSourcePermanently(env, { sourceId, confirmTitle: "작업 중 자료" }),
      "source_delete_active_work",
    );

    await env.DB.prepare("UPDATE research_jobs SET status = 'FAILED' WHERE id = ?").bind(`${sourceId}-job`).run();
    await env.DB.prepare(
      `INSERT INTO visual_extraction_runs
       (id, parent_source_id, parent_version_id, origin_kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PDF_PAGE_CROP', 'RUNNING', ?, ?)`,
    ).bind(`${sourceId}-run`, sourceId, versionId, now, now).run();
    await expectDeletionError(
      deleteSourcePermanently(env, { sourceId, confirmTitle: "작업 중 자료" }),
      "source_delete_active_work",
    );
  });

  it("collects deduplicated source/version/visual/temp keys and leaves D1 unchanged when R2 fails", async () => {
    const sourceId = `${crypto.randomUUID()}-r2-fail`;
    const sourceKey = `tests/delete/${sourceId}/source`;
    const versionId = await insertSource(sourceId, "R2 실패 자료", sourceKey);
    await insertVisualDeletionFixture(sourceId, versionId);
    const deleteObject = vi.fn(async () => { throw new Error("r2 unavailable"); });
    const testEnv = { DB: env.DB, ORIGINALS: { delete: deleteObject } } as unknown as Pick<Env, "DB" | "ORIGINALS">;

    await expectDeletionError(
      deleteSourcePermanently(testEnv, { sourceId, confirmTitle: "R2 실패 자료" }),
      "source_delete_r2_failed",
    );
    expect(deleteObject).toHaveBeenCalledWith(expect.arrayContaining([sourceKey, `tests/delete/${sourceId}/visual`, `tests/delete/${sourceId}/temp`]));
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM visual_assets WHERE parent_source_id = ?").bind(sourceId).first()).not.toBeNull();
  });
});

describe("source deletion D1 purge", () => {
  it("removes source-owned D1 rows and clears the discovery candidate link", async () => {
    const sourceId = `${crypto.randomUUID()}-purge`;
    const title = "완전 삭제 자료";
    await insertSource(sourceId, title, `tests/delete/${sourceId}/v1`);
    const now = new Date().toISOString();
    const threadId = `${sourceId}-thread`;
    const otherSourceId = `${sourceId}-other`;
    await insertSource(otherSourceId, "보존할 다른 자료");
    await env.DB.prepare("INSERT INTO threads (id, title, status, created_at) VALUES (?, ?, 'SEED', ?)")
      .bind(threadId, threadId, now).run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_analysis
         (id, source_id, version_id, analysis_type, payload_json, created_at)
         VALUES (?, ?, ?, 'basic', '{}', ?)`,
      ).bind(`${sourceId}-analysis`, sourceId, `${sourceId}-v1`, now),
      env.DB.prepare("INSERT INTO keywords (id, source_id, keyword, created_at) VALUES (?, ?, 'photo', ?)")
        .bind(`${sourceId}-keyword`, sourceId, now),
      env.DB.prepare("INSERT INTO questions (id, source_id, question, created_at) VALUES (?, ?, 'why?', ?)")
        .bind(`${sourceId}-question`, sourceId, now),
      env.DB.prepare("INSERT INTO fragments (id, source_id, text, created_at) VALUES (?, ?, 'fragment', ?)")
        .bind(`${sourceId}-fragment`, sourceId, now),
      env.DB.prepare("INSERT INTO thread_links (thread_id, source_id, created_at) VALUES (?, ?, ?)")
        .bind(threadId, sourceId, now),
      env.DB.prepare("INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)")
        .bind(`${sourceId}-signal`, sourceId, now),
      env.DB.prepare("INSERT INTO processing_jobs (id, source_id, status, created_at, updated_at) VALUES (?, ?, 'analyzed', ?, ?)")
        .bind(`${sourceId}-processing`, sourceId, now, now),
      env.DB.prepare("INSERT INTO source_embeddings (source_id, model, created_at) VALUES (?, 'test-model', ?)")
        .bind(sourceId, now),
      env.DB.prepare("INSERT INTO source_identity_keys (identity_kind, identity_value, source_id, created_at) VALUES ('DOI', ?, ?, ?)")
        .bind(`10.1000/${sourceId}`, sourceId, now),
      env.DB.prepare("INSERT INTO source_fingerprints (source_id, kind, value, created_at) VALUES (?, 'DOI', ?, ?)")
        .bind(sourceId, `10.1000/${sourceId}`, now),
      env.DB.prepare(
        `INSERT INTO discovery_candidates
         (id, title, relevance_score, status, query_used, created_at, provider, source_id)
         VALUES (?, '발견 후보', 0.9, 'KEPT', 'photo', ?, 'openalex', ?)`,
      ).bind(`${sourceId}-candidate`, now, sourceId),
      env.DB.prepare(
        `INSERT INTO source_duplicate_candidates
         (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at)
         VALUES (?, ?, ?, 'REVIEW', 0.9, '[]', 'PENDING', ?)`,
      ).bind(`${sourceId}-duplicate`, sourceId, otherSourceId, now),
    ]);

    const result = await deleteSourcePermanently(env, { sourceId, confirmTitle: title });

    expect(result).toEqual({ deletedSourceId: sourceId, merge: null });
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).toBeNull();
    for (const table of [
      "source_versions", "source_analysis", "keywords", "questions", "fragments", "thread_links",
      "user_signals", "processing_jobs", "source_embeddings", "source_identity_keys", "source_fingerprints",
    ]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_id = ?`)
        .bind(sourceId).first<{ count: number }>();
      expect(Number(row?.count ?? 0), table).toBe(0);
    }
    await expect(env.DB.prepare("SELECT source_id FROM discovery_candidates WHERE id = ?")
      .bind(`${sourceId}-candidate`).first<{ source_id: string | null }>())
      .resolves.toEqual({ source_id: null });
    expect(await env.DB.prepare("SELECT id FROM source_duplicate_candidates WHERE id = ?")
      .bind(`${sourceId}-duplicate`).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(otherSourceId).first()).not.toBeNull();
  });

  it("deletes one noncanonical member and preserves the remaining group", async () => {
    const prefix = crypto.randomUUID();
    const canonicalId = `${prefix}-canonical`;
    const memberId = `${prefix}-member`;
    await insertSource(canonicalId, "유지 대표");
    await insertSource(memberId, "삭제 구성원");
    const groupId = await createLogicalMerge(env.DB, {
      canonicalSourceId: canonicalId,
      memberSourceIds: [memberId],
      mode: "MANUAL",
      confidence: 1,
      reasons: ["manual_review"],
    });

    await expect(deleteSourcePermanently(env, { sourceId: memberId, confirmTitle: "삭제 구성원" }))
      .resolves.toEqual({
        deletedSourceId: memberId,
        merge: { groupId, action: "MEMBER_REMOVED", canonicalSourceId: canonicalId },
      });
    expect(await env.DB.prepare("SELECT canonical_source_id FROM source_merge_groups WHERE id = ?")
      .bind(groupId).first()).toEqual({ canonical_source_id: canonicalId });
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(canonicalId).first()).not.toBeNull();
  });

  it("reassigns a deleted canonical source using the shared ordering", async () => {
    const prefix = crypto.randomUUID();
    const canonicalId = `${prefix}-old-canonical`;
    const weakId = `${prefix}-weak`;
    const strongId = `${prefix}-strong`;
    await insertSource(canonicalId, "기존 대표");
    await insertSource(weakId, "약한 후보");
    await insertSource(strongId, "새 대표");
    const now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO user_signals (id, source_id, action, created_at) VALUES (?, ?, 'keep', ?)")
      .bind(`${strongId}-signal`, strongId, now).run();
    const groupId = await createLogicalMerge(env.DB, {
      canonicalSourceId: canonicalId,
      memberSourceIds: [weakId, strongId],
      mode: "MANUAL",
      confidence: 1,
      reasons: ["manual_review"],
    });

    await expect(deleteSourcePermanently(env, { sourceId: canonicalId, confirmTitle: "기존 대표" }))
      .resolves.toEqual({
        deletedSourceId: canonicalId,
        merge: { groupId, action: "CANONICAL_REASSIGNED", canonicalSourceId: strongId },
      });
    expect(await env.DB.prepare("SELECT canonical_source_id FROM source_merge_groups WHERE id = ?")
      .bind(groupId).first()).toEqual({ canonical_source_id: strongId });
    expect(await env.DB.prepare("SELECT role FROM source_merge_members WHERE group_id = ? AND source_id = ?")
      .bind(groupId, strongId).first()).toEqual({ role: "CANONICAL" });
  });

  it("removes an active group when the selected source is its only remaining member", async () => {
    const prefix = crypto.randomUUID();
    const sourceId = `${prefix}-last`;
    const deletedMemberId = `${prefix}-already-removed`;
    await insertSource(sourceId, "마지막 구성원");
    await insertSource(deletedMemberId, "선행 구성원");
    const groupId = await createLogicalMerge(env.DB, {
      canonicalSourceId: sourceId,
      memberSourceIds: [deletedMemberId],
      mode: "MANUAL",
      confidence: 1,
      reasons: ["manual_review"],
    });
    await env.DB.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
      .bind(groupId, deletedMemberId).run();
    await env.DB.prepare("DELETE FROM source_versions WHERE source_id = ?").bind(deletedMemberId).run();
    await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(deletedMemberId).run();

    await expect(deleteSourcePermanently(env, { sourceId, confirmTitle: "마지막 구성원" }))
      .resolves.toEqual({
        deletedSourceId: sourceId,
        merge: { groupId, action: "GROUP_REMOVED", canonicalSourceId: null },
      });
    expect(await env.DB.prepare("SELECT id FROM source_merge_groups WHERE id = ?").bind(groupId).first()).toBeNull();
  });

  it("leaves D1 intact and returns a stable error when the deletion batch fails", async () => {
    const sourceId = `${crypto.randomUUID()}-d1-fail`;
    await insertSource(sourceId, "D1 실패 자료");
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async () => { throw new Error("forced D1 failure"); }),
    } as unknown as D1Database;
    await expectDeletionError(
      deleteSourcePermanently(
        { DB: failingDb, ORIGINALS: env.ORIGINALS },
        { sourceId, confirmTitle: "D1 실패 자료" },
      ),
      "source_delete_d1_failed",
    );
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).not.toBeNull();
  });

  it("detects a title change inside the guarded D1 batch without deleting children", async () => {
    const sourceId = `${crypto.randomUUID()}-state-change`;
    await insertSource(sourceId, "변경 전 제목");
    const staleDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: vi.fn(async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE sources SET title = '변경 후 제목' WHERE id = ?").bind(sourceId).run();
        return env.DB.batch(statements);
      }),
    } as unknown as D1Database;
    await expectDeletionError(
      deleteSourcePermanently(
        { DB: staleDb, ORIGINALS: env.ORIGINALS },
        { sourceId, confirmTitle: "변경 전 제목" },
      ),
      "source_delete_state_changed",
    );
    expect(await env.DB.prepare("SELECT id FROM source_versions WHERE source_id = ?")
      .bind(sourceId).first()).not.toBeNull();
  });

  it("deletes visual descendants and all existing R2 objects", async () => {
    const sourceId = `${crypto.randomUUID()}-visual-success`;
    const sourceKey = `tests/delete/${sourceId}/source`;
    const versionId = await insertSource(sourceId, "시각 포함 자료", sourceKey);
    const fixture = await insertVisualDeletionFixture(sourceId, versionId);
    await deleteSourcePermanently(env, { sourceId, confirmTitle: "시각 포함 자료" });
    expect(await env.ORIGINALS.get(sourceKey)).toBeNull();
    expect(await env.ORIGINALS.get(fixture.visualKey)).toBeNull();
    expect(await env.ORIGINALS.get(fixture.tempKey)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id = ?").bind(sourceId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM visual_assets WHERE id = ?").bind(fixture.assetId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM visual_extraction_runs WHERE parent_source_id = ?")
      .bind(sourceId).first()).toBeNull();
    for (const [table, id] of [
      ["visual_asset_versions", `${fixture.assetId}-v1`],
      ["visual_analyses", `${fixture.assetId}-analysis`],
      ["visual_embeddings", `${fixture.assetId}-embedding`],
      ["visual_relations", `${fixture.assetId}-relation`],
      ["visual_asset_operations", `${fixture.assetId}-operation`],
      ["visual_extraction_units", `${sourceId}-unit`],
    ]) {
      expect(await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(), table).toBeNull();
    }
  });
});
