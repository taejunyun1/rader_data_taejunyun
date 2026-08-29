import { selectCanonicalSourceId } from "./canonicalSource";

export type SourceDeletionMergeRole = "NONE" | "CANONICAL" | "MEMBER";
export type SourceDeletionErrorCode =
  | "source_not_found"
  | "source_delete_confirmation_mismatch"
  | "source_delete_active_work"
  | "source_delete_state_changed"
  | "source_delete_r2_failed"
  | "source_delete_d1_failed";

export interface SourceDeletionPreview {
  sourceId: string;
  title: string;
  mergeRole: SourceDeletionMergeRole;
  mergeMemberCount: number;
}

export interface DeleteSourceInput {
  sourceId: string;
  confirmTitle: string;
}

export interface DeleteSourceMergeResult {
  groupId: string;
  action: "MEMBER_REMOVED" | "CANONICAL_REASSIGNED" | "GROUP_REMOVED";
  canonicalSourceId: string | null;
}

export interface DeleteSourceResult {
  deletedSourceId: string;
  merge: DeleteSourceMergeResult | null;
}

export class SourceDeletionError extends Error {
  readonly code: SourceDeletionErrorCode;

  constructor(code: SourceDeletionErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "SourceDeletionError";
    this.code = code;
  }
}

interface ActiveMergeSnapshot {
  groupId: string;
  canonicalSourceId: string;
  role: "CANONICAL" | "MEMBER";
  memberSourceIds: string[];
}

interface SourceDeletionPlan {
  sourceId: string;
  title: string;
  r2Keys: string[];
  merge: ActiveMergeSnapshot | null;
}

async function loadActiveMergeSnapshot(
  db: D1Database,
  sourceId: string,
): Promise<ActiveMergeSnapshot | null> {
  const membership = await db.prepare(
    `SELECT g.id AS groupId, g.canonical_source_id AS canonicalSourceId, m.role
     FROM source_merge_members m
     JOIN source_merge_groups g ON g.id = m.group_id
     WHERE m.source_id = ? AND g.reversed_at IS NULL
     ORDER BY g.created_at DESC LIMIT 1`,
  ).bind(sourceId).first<{
    groupId: string;
    canonicalSourceId: string;
    role: "CANONICAL" | "MEMBER";
  }>();
  if (!membership) return null;
  const members = await db.prepare(
    "SELECT source_id AS sourceId FROM source_merge_members WHERE group_id = ? ORDER BY source_id",
  ).bind(membership.groupId).all<{ sourceId: string }>();
  return {
    ...membership,
    memberSourceIds: (members.results ?? []).map((row) => row.sourceId),
  };
}

export async function getSourceDeletionPreview(
  db: D1Database,
  sourceId: string,
): Promise<SourceDeletionPreview | null> {
  const source = await db.prepare("SELECT id, title FROM sources WHERE id = ?")
    .bind(sourceId).first<{ id: string; title: string }>();
  if (!source) return null;
  const merge = await loadActiveMergeSnapshot(db, sourceId);
  return {
    sourceId: source.id,
    title: source.title,
    mergeRole: merge?.role ?? "NONE",
    mergeMemberCount: merge?.memberSourceIds.length ?? 1,
  };
}

async function hasActiveWork(db: D1Database, sourceId: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS active
     FROM research_jobs
     WHERE status IN ('QUEUED', 'RUNNING')
       AND json_extract(input_json, '$.sourceId') = ?
     UNION ALL
     SELECT 1 AS active
     FROM visual_extraction_runs
     WHERE parent_source_id = ? AND status IN ('UPLOADING', 'QUEUED', 'RUNNING')
     UNION ALL
     SELECT 1 AS active
     FROM visual_asset_operations operation
     JOIN visual_assets asset ON asset.id = operation.visual_asset_id
     WHERE (asset.parent_source_id = ?
            OR asset.parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?))
       AND operation.status = 'PENDING'
     LIMIT 1`,
  ).bind(sourceId, sourceId, sourceId, sourceId).first<{ active: number }>();
  return Boolean(row);
}

async function loadR2Keys(db: D1Database, sourceId: string): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT r2_key AS r2Key FROM sources WHERE id = ? AND r2_key IS NOT NULL
     UNION
     SELECT r2_key AS r2Key FROM source_versions WHERE source_id = ? AND r2_key IS NOT NULL
     UNION
     SELECT version.r2_key AS r2Key
     FROM visual_asset_versions version
     JOIN visual_assets asset ON asset.id = version.visual_asset_id
     WHERE (asset.parent_source_id = ?
            OR asset.parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?))
       AND version.r2_key IS NOT NULL
     UNION
     SELECT unit.temp_r2_key AS r2Key
     FROM visual_extraction_units unit
     JOIN visual_extraction_runs run ON run.id = unit.run_id
     WHERE run.parent_source_id = ? AND unit.temp_r2_key IS NOT NULL`,
  ).bind(sourceId, sourceId, sourceId, sourceId, sourceId).all<{ r2Key: string }>();
  return [...new Set((rows.results ?? []).map((row) => row.r2Key).filter(Boolean))].sort();
}

async function loadDeletionPlan(db: D1Database, input: DeleteSourceInput): Promise<SourceDeletionPlan> {
  const source = await db.prepare("SELECT id, title FROM sources WHERE id = ?")
    .bind(input.sourceId).first<{ id: string; title: string }>();
  if (!source) throw new SourceDeletionError("source_not_found");
  if (source.title !== input.confirmTitle) {
    throw new SourceDeletionError("source_delete_confirmation_mismatch");
  }
  if (await hasActiveWork(db, input.sourceId)) {
    throw new SourceDeletionError("source_delete_active_work");
  }
  return {
    sourceId: source.id,
    title: source.title,
    r2Keys: await loadR2Keys(db, source.id),
    merge: await loadActiveMergeSnapshot(db, source.id),
  };
}

async function deleteR2Keys(bucket: R2Bucket, keys: string[]): Promise<void> {
  const batchSize = 1_000;
  try {
    for (let index = 0; index < keys.length; index += batchSize) {
      await bucket.delete(keys.slice(index, index + batchSize));
    }
  } catch (error) {
    throw new SourceDeletionError("source_delete_r2_failed", error);
  }
}

function mergeFingerprint(merge: ActiveMergeSnapshot | null): string {
  if (!merge) return "NONE";
  return JSON.stringify({
    groupId: merge.groupId,
    canonicalSourceId: merge.canonicalSourceId,
    role: merge.role,
    memberSourceIds: [...merge.memberSourceIds].sort(),
  });
}

async function assertPlanStillCurrent(db: D1Database, plan: SourceDeletionPlan): Promise<void> {
  const source = await db.prepare("SELECT title FROM sources WHERE id = ?")
    .bind(plan.sourceId).first<{ title: string }>();
  const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
  if (!source || source.title !== plan.title || mergeFingerprint(currentMerge) !== mergeFingerprint(plan.merge)) {
    throw new SourceDeletionError("source_delete_state_changed");
  }
  if (await hasActiveWork(db, plan.sourceId)) {
    throw new SourceDeletionError("source_delete_active_work");
  }
}

function deletionGuard(
  db: D1Database,
  plan: SourceDeletionPlan,
): D1PreparedStatement {
  if (!plan.merge) {
    return db.prepare(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
         AND NOT EXISTS (
           SELECT 1 FROM source_merge_members member
           JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
           WHERE member.source_id = ? AND merge_group.reversed_at IS NULL
         )
       THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
    ).bind(plan.sourceId, plan.title, plan.sourceId);
  }
  return db.prepare(
    `SELECT CASE WHEN
       EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
       AND EXISTS (
         SELECT 1 FROM source_merge_members member
         JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
         WHERE member.source_id = ?
           AND member.group_id = ?
           AND member.role = ?
           AND merge_group.canonical_source_id = ?
           AND merge_group.reversed_at IS NULL
           AND (SELECT COUNT(*) FROM source_merge_members WHERE group_id = ?) = ?
       )
     THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
  ).bind(
    plan.sourceId,
    plan.title,
    plan.sourceId,
    plan.merge.groupId,
    plan.merge.role,
    plan.merge.canonicalSourceId,
    plan.merge.groupId,
    plan.merge.memberSourceIds.length,
  );
}

async function mergeMutation(
  db: D1Database,
  plan: SourceDeletionPlan,
): Promise<{ statements: D1PreparedStatement[]; result: DeleteSourceMergeResult | null }> {
  if (!plan.merge) return { statements: [], result: null };
  const remainingIds = plan.merge.memberSourceIds.filter((id) => id !== plan.sourceId);
  if (remainingIds.length === 0) {
    return {
      statements: [
        db.prepare("DELETE FROM source_duplicate_candidates WHERE merge_group_id = ?").bind(plan.merge.groupId),
        db.prepare("DELETE FROM source_merge_members WHERE group_id = ?").bind(plan.merge.groupId),
        db.prepare("DELETE FROM source_merge_groups WHERE id = ?").bind(plan.merge.groupId),
      ],
      result: { groupId: plan.merge.groupId, action: "GROUP_REMOVED", canonicalSourceId: null },
    };
  }
  if (plan.merge.role === "MEMBER") {
    return {
      statements: [
        db.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
          .bind(plan.merge.groupId, plan.sourceId),
      ],
      result: {
        groupId: plan.merge.groupId,
        action: "MEMBER_REMOVED",
        canonicalSourceId: plan.merge.canonicalSourceId,
      },
    };
  }
  const canonicalSourceId = await selectCanonicalSourceId(db, remainingIds);
  return {
    statements: [
      db.prepare("UPDATE source_merge_groups SET canonical_source_id = ? WHERE id = ? AND canonical_source_id = ?")
        .bind(canonicalSourceId, plan.merge.groupId, plan.sourceId),
      db.prepare("UPDATE source_merge_members SET role = 'MEMBER' WHERE group_id = ?")
        .bind(plan.merge.groupId),
      db.prepare("UPDATE source_merge_members SET role = 'CANONICAL' WHERE group_id = ? AND source_id = ?")
        .bind(plan.merge.groupId, canonicalSourceId),
      db.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
        .bind(plan.merge.groupId, plan.sourceId),
    ],
    result: { groupId: plan.merge.groupId, action: "CANONICAL_REASSIGNED", canonicalSourceId },
  };
}

async function deleteD1Records(
  db: D1Database,
  plan: SourceDeletionPlan,
): Promise<DeleteSourceMergeResult | null> {
  await assertPlanStillCurrent(db, plan);
  const merge = await mergeMutation(db, plan);
  const sourceId = plan.sourceId;
  const ownedAssets = `SELECT id FROM visual_assets
    WHERE parent_source_id = ?
       OR parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?)`;
  const historicalCanonicalGroups = `SELECT id FROM source_merge_groups
    WHERE canonical_source_id = ? AND reversed_at IS NOT NULL`;
  const statements: D1PreparedStatement[] = [
    deletionGuard(db, plan),
    db.prepare("UPDATE discovery_candidates SET source_id = NULL WHERE source_id = ?").bind(sourceId),
    db.prepare(
      `DELETE FROM visual_relations
       WHERE related_source_id = ?
          OR from_visual_asset_id IN (${ownedAssets})
          OR to_visual_asset_id IN (${ownedAssets})`,
    ).bind(sourceId, sourceId, sourceId, sourceId, sourceId),
    db.prepare(`DELETE FROM visual_embeddings WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_analyses WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_asset_operations WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_asset_versions WHERE visual_asset_id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(`DELETE FROM visual_assets WHERE id IN (${ownedAssets})`)
      .bind(sourceId, sourceId),
    db.prepare(
      `DELETE FROM visual_extraction_units
       WHERE run_id IN (SELECT id FROM visual_extraction_runs WHERE parent_source_id = ?)`,
    ).bind(sourceId),
    db.prepare("DELETE FROM visual_extraction_runs WHERE parent_source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_analysis WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM keywords WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM questions WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM fragments WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM thread_links WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM user_signals WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM processing_jobs WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_embeddings WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_identity_keys WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM source_fingerprints WHERE source_id = ?").bind(sourceId),
    db.prepare(
      "DELETE FROM source_duplicate_candidates WHERE left_source_id = ? OR right_source_id = ?",
    ).bind(sourceId, sourceId),
    db.prepare(
      `DELETE FROM source_duplicate_candidates WHERE merge_group_id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      `DELETE FROM source_merge_members WHERE group_id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      `DELETE FROM source_merge_groups WHERE id IN (${historicalCanonicalGroups})`,
    ).bind(sourceId),
    db.prepare(
      "DELETE FROM source_merge_members WHERE source_id = ? AND group_id IN (SELECT id FROM source_merge_groups WHERE reversed_at IS NOT NULL)",
    ).bind(sourceId),
    ...merge.statements,
    db.prepare("DELETE FROM source_versions WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId),
  ];
  try {
    await db.batch(statements);
    return merge.result;
  } catch (error) {
    if (error instanceof SourceDeletionError) throw error;
    try {
      const current = await db.prepare("SELECT title FROM sources WHERE id = ?")
        .bind(plan.sourceId).first<{ title: string }>();
      const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
      if (!current || current.title !== plan.title || mergeFingerprint(currentMerge) !== mergeFingerprint(plan.merge)) {
        throw new SourceDeletionError("source_delete_state_changed", error);
      }
    } catch (inspectionError) {
      if (inspectionError instanceof SourceDeletionError) throw inspectionError;
    }
    throw new SourceDeletionError("source_delete_d1_failed", error);
  }
}

export async function deleteSourcePermanently(
  env: Pick<Env, "DB" | "ORIGINALS">,
  input: DeleteSourceInput,
): Promise<DeleteSourceResult> {
  const plan = await loadDeletionPlan(env.DB, input);
  await deleteR2Keys(env.ORIGINALS, plan.r2Keys);
  const merge = await deleteD1Records(env.DB, plan);
  return { deletedSourceId: plan.sourceId, merge };
}
