import { selectCanonicalSourceId } from "./canonicalSource";
import {
  acquireSourceDeletionClaim,
  assertSourceDeletionClaimOwned,
  isSourceDeletionClaimError,
  markSourceDeletionR2Complete,
  recordSourceDeletionError,
  releaseSourceDeletionClaim,
  renewSourceDeletionClaim,
  SourceDeletionClaimError,
  type SourceDeletionClaim,
} from "./deletionClaim";

export type SourceDeletionMergeRole = "NONE" | "CANONICAL" | "MEMBER";
export type SourceDeletionErrorCode =
  | "source_not_found"
  | "source_delete_confirmation_mismatch"
  | "source_delete_active_work"
  | "source_delete_state_changed"
  | "source_delete_in_progress"
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
  memberRoles: Array<{
    sourceId: string;
    role: "CANONICAL" | "MEMBER";
  }>;
}

interface HistoricalMergeSnapshot {
  groupId: string;
  canonicalSourceId: string;
  memberSourceIds: string[];
  memberRoles: Array<{
    sourceId: string;
    role: "CANONICAL" | "MEMBER";
  }>;
  replacementCanonicalSourceId: string | null;
}

interface SourceDeletionPlan {
  sourceId: string;
  title: string;
  r2Keys: string[];
  merge: ActiveMergeSnapshot | null;
  mergeFingerprint: string;
  historicalMerges: HistoricalMergeSnapshot[];
  historicalMergeFingerprint: string;
  dependencySnapshot: string;
}

const ACTIVE_WORK_QUERY = `
  SELECT 1 AS active
  FROM research_jobs
  WHERE status IN ('QUEUED', 'RUNNING')
    AND json_extract(input_json, '$.sourceId') = ?
  UNION ALL
  SELECT 1 AS active
  FROM research_jobs job
  JOIN visual_assets asset ON asset.id = json_extract(job.input_json, '$.visualAssetId')
  WHERE job.kind IN ('VISUAL_TRANSFORM', 'VISUAL_ANALYSIS')
    AND job.status IN ('QUEUED', 'RUNNING')
    AND (asset.parent_source_id = ?
         OR asset.parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?))
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
    AND operation.status = 'PENDING'`;

const SOURCE_DEPENDENCY_SNAPSHOT_QUERY = `
  WITH target(source_id) AS (SELECT ?),
  owned_versions AS (
    SELECT version.id
    FROM source_versions version
    JOIN target ON target.source_id = version.source_id
  ),
  owned_assets AS (
    SELECT asset.id
    FROM visual_assets asset
    CROSS JOIN target
    WHERE target.source_id = asset.parent_source_id
       OR asset.parent_version_id IN (SELECT id FROM owned_versions)
  ),
  owned_runs AS (
    SELECT run.id
    FROM visual_extraction_runs run
    JOIN target ON target.source_id = run.parent_source_id
  )
  SELECT json_object(
    'sources', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', source.id,
        'activeVersionId', source.active_version_id,
        'r2Key', source.r2_key,
        'state', source.status
      ))
      FROM (SELECT source.id, source.active_version_id, source.r2_key, source.status
            FROM sources source
            JOIN target ON target.source_id = source.id
            ORDER BY source.id) source
    ), '[]')),
    'versions', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', version.id,
        'sourceId', version.source_id,
        'parentVersionId', version.parent_version_id,
        'version', version.version,
        'r2Key', version.r2_key,
        'state', version.normalization_status
      ))
      FROM (SELECT version.id, version.source_id, version.parent_version_id, version.version,
                   version.r2_key, version.normalization_status
            FROM source_versions version
            WHERE version.id IN (SELECT id FROM owned_versions)
            ORDER BY version.id) version
    ), '[]')),
    'assets', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', asset.id,
        'parentSourceId', asset.parent_source_id,
        'parentVersionId', asset.parent_version_id,
        'state', asset.processing_status,
        'deletedAt', asset.deleted_at
      ))
      FROM (SELECT asset.id, asset.parent_source_id, asset.parent_version_id,
                   asset.processing_status, asset.deleted_at
            FROM visual_assets asset
            WHERE asset.id IN (SELECT id FROM owned_assets)
            ORDER BY asset.id) asset
    ), '[]')),
    'assetVersions', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', version.id,
        'assetId', version.visual_asset_id,
        'parentVersionId', version.parent_asset_version_id,
        'version', version.version,
        'variant', version.variant,
        'r2Key', version.r2_key,
        'contentHash', version.content_hash,
        'deletedAt', version.deleted_at
      ))
      FROM (SELECT version.id, version.visual_asset_id, version.parent_asset_version_id,
                   version.version, version.variant, version.r2_key, version.content_hash, version.deleted_at
            FROM visual_asset_versions version
            WHERE version.visual_asset_id IN (SELECT id FROM owned_assets)
            ORDER BY version.id) version
    ), '[]')),
    'extractionRuns', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', run.id,
        'sourceId', run.parent_source_id,
        'parentVersionId', run.parent_version_id,
        'state', run.status
      ))
      FROM (SELECT run.id, run.parent_source_id, run.parent_version_id, run.status
            FROM visual_extraction_runs run
            WHERE run.id IN (SELECT id FROM owned_runs)
            ORDER BY run.id) run
    ), '[]')),
    'extractionUnits', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', unit.id,
        'runId', unit.run_id,
        'unitNumber', unit.unit_number,
        'tempR2Key', unit.temp_r2_key,
        'state', unit.status,
        'deletedAt', unit.deleted_at
      ))
      FROM (SELECT unit.id, unit.run_id, unit.unit_number, unit.temp_r2_key,
                   unit.status, unit.deleted_at
            FROM visual_extraction_units unit
            WHERE unit.run_id IN (SELECT id FROM owned_runs)
            ORDER BY unit.id) unit
    ), '[]'))
  ) AS snapshot`;

const MERGE_MEMBERSHIP_FINGERPRINT_QUERY = `
  SELECT json_object(
    'groupId', merge_group.id,
    'canonicalSourceId', merge_group.canonical_source_id,
    'members', json(COALESCE((
      SELECT json_group_array(json_object(
        'sourceId', member.source_id,
        'role', member.role
      ))
      FROM (
        SELECT source_id, role
        FROM source_merge_members
        WHERE group_id = merge_group.id
        ORDER BY source_id, role
      ) member
    ), '[]'))
  )
  FROM source_merge_groups merge_group
  WHERE merge_group.id = ? AND merge_group.reversed_at IS NULL`;

const HISTORICAL_MERGE_FINGERPRINT_QUERY = `
  SELECT COALESCE(json_group_array(json_object(
    'groupId', historical_group.groupId,
    'canonicalSourceId', historical_group.canonicalSourceId,
    'members', json(COALESCE((
      SELECT json_group_array(json_object(
        'sourceId', member.source_id,
        'role', member.role
      ))
      FROM (
        SELECT source_id, role
        FROM source_merge_members
        WHERE group_id = historical_group.groupId
        ORDER BY source_id, role
      ) member
    ), '[]'))
  )), '[]') AS fingerprint
  FROM (
    SELECT merge_group.id AS groupId, merge_group.canonical_source_id AS canonicalSourceId
    FROM source_merge_members target_member
    JOIN source_merge_groups merge_group ON merge_group.id = target_member.group_id
    WHERE target_member.source_id = ? AND merge_group.reversed_at IS NOT NULL
    ORDER BY merge_group.created_at DESC, merge_group.id
  ) historical_group`;

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
    "SELECT source_id AS sourceId, role FROM source_merge_members WHERE group_id = ? ORDER BY source_id, role",
  ).bind(membership.groupId).all<{
    sourceId: string;
    role: "CANONICAL" | "MEMBER";
  }>();
  const memberRoles = members.results ?? [];
  return {
    ...membership,
    memberSourceIds: memberRoles.map((row) => row.sourceId),
    memberRoles,
  };
}

async function loadHistoricalMergeSnapshots(
  db: D1Database,
  sourceId: string,
): Promise<HistoricalMergeSnapshot[]> {
  const memberships = await db.prepare(
    `SELECT g.id AS groupId, g.canonical_source_id AS canonicalSourceId
     FROM source_merge_members m
     JOIN source_merge_groups g ON g.id = m.group_id
     WHERE m.source_id = ? AND g.reversed_at IS NOT NULL
     ORDER BY g.created_at DESC, g.id`,
  ).bind(sourceId).all<{
    groupId: string;
    canonicalSourceId: string;
  }>();
  const snapshots: HistoricalMergeSnapshot[] = [];
  for (const membership of memberships.results ?? []) {
    const members = await db.prepare(
      "SELECT source_id AS sourceId, role FROM source_merge_members WHERE group_id = ? ORDER BY source_id, role",
    ).bind(membership.groupId).all<{
      sourceId: string;
      role: "CANONICAL" | "MEMBER";
    }>();
    const memberRoles = members.results ?? [];
    snapshots.push({
      ...membership,
      memberSourceIds: memberRoles.map((row) => row.sourceId),
      memberRoles,
      replacementCanonicalSourceId: null,
    });
  }
  return snapshots;
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
  const row = await db.prepare(`${ACTIVE_WORK_QUERY} LIMIT 1`)
    .bind(sourceId, sourceId, sourceId, sourceId, sourceId, sourceId)
    .first<{ active: number }>();
  return Boolean(row);
}

async function loadDependencySnapshot(db: D1Database, sourceId: string): Promise<string> {
  const row = await db.prepare(SOURCE_DEPENDENCY_SNAPSHOT_QUERY)
    .bind(sourceId)
    .first<{ snapshot: string }>();
  return row?.snapshot ?? "[]";
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

function historicalMergeFingerprint(merges: HistoricalMergeSnapshot[]): string {
  return JSON.stringify(merges.map((merge) => ({
    groupId: merge.groupId,
    canonicalSourceId: merge.canonicalSourceId,
    members: [...merge.memberRoles].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.role.localeCompare(right.role)),
  })));
}

async function loadHistoricalMergeFingerprint(db: D1Database, sourceId: string): Promise<string> {
  const row = await db.prepare(HISTORICAL_MERGE_FINGERPRINT_QUERY)
    .bind(sourceId)
    .first<{ fingerprint: string }>();
  return row?.fingerprint ?? "[]";
}

/**
 * Validate the destructive confirmation before creating any lock metadata.
 * The claim is deliberately acquired only after this read so a typo cannot
 * leave an operational lock behind.
 */
async function validateSourceDeletionInput(
  db: D1Database,
  input: DeleteSourceInput,
): Promise<void> {
  const source = await db.prepare("SELECT id, title FROM sources WHERE id = ?")
    .bind(input.sourceId).first<{ id: string; title: string }>();
  if (!source) throw new SourceDeletionError("source_not_found");
  if (source.title !== input.confirmTitle) {
    throw new SourceDeletionError("source_delete_confirmation_mismatch");
  }
}

function mapClaimError(error: unknown, fallback: SourceDeletionErrorCode): SourceDeletionError {
  if (error instanceof SourceDeletionClaimError && error.code === "source_delete_in_progress") {
    return new SourceDeletionError("source_delete_in_progress", error);
  }
  return new SourceDeletionError(fallback, error);
}

async function recordDeletionFailure(
  db: D1Database,
  claim: SourceDeletionClaim,
  code: "source_delete_r2_failed" | "source_delete_d1_failed",
): Promise<void> {
  // The original R2/D1 error is more useful to the caller than a secondary
  // lease bookkeeping failure. The claim helper intentionally keeps this
  // best-effort: if the worker dies here the lease expiry remains recoverable.
  try {
    await recordSourceDeletionError(db, claim, code);
  } catch {
    // Preserve the original failure and never release a claim after R2 work.
  }
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
  const dependencySnapshot = await loadDependencySnapshot(db, source.id);
  const r2Keys = await loadR2Keys(db, source.id);
  const merge = await loadActiveMergeSnapshot(db, source.id);
  const historicalMerges = await loadHistoricalMergeSnapshots(db, source.id);
  for (const historicalMerge of historicalMerges) {
    const remainingIds = historicalMerge.memberSourceIds.filter((id) => id !== source.id);
    if (historicalMerge.canonicalSourceId === source.id && remainingIds.length > 0) {
      historicalMerge.replacementCanonicalSourceId = await selectCanonicalSourceId(db, remainingIds);
    }
  }
  return {
    sourceId: source.id,
    title: source.title,
    r2Keys,
    merge,
    mergeFingerprint: mergeFingerprint(merge),
    historicalMerges,
    historicalMergeFingerprint: historicalMergeFingerprint(historicalMerges),
    dependencySnapshot,
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
    members: [...merge.memberRoles].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.role.localeCompare(right.role)),
  });
}

async function assertPlanStillCurrent(
  db: D1Database,
  plan: SourceDeletionPlan,
  claim?: SourceDeletionClaim,
): Promise<void> {
  if (claim) {
    await assertSourceDeletionClaimOwned(db, claim);
  }
  const source = await db.prepare("SELECT title FROM sources WHERE id = ?")
    .bind(plan.sourceId).first<{ title: string }>();
  const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
  const currentDependencies = await loadDependencySnapshot(db, plan.sourceId);
  if (
    !source
    || source.title !== plan.title
    || mergeFingerprint(currentMerge) !== plan.mergeFingerprint
    || currentDependencies !== plan.dependencySnapshot
  ) {
    throw new SourceDeletionError("source_delete_state_changed");
  }
  if (await hasActiveWork(db, plan.sourceId)) {
    throw new SourceDeletionError("source_delete_active_work");
  }
}

function deletionGuard(
  db: D1Database,
  plan: SourceDeletionPlan,
  claim: SourceDeletionClaim,
): D1PreparedStatement {
  const claimGuard = `EXISTS (
    SELECT 1 FROM source_deletion_claims
    WHERE source_id = ?
      AND claim_token = ?
      AND state = 'R2_COMPLETE'
      AND lease_expires_at > ?
  )`;
  if (!plan.merge) {
    return db.prepare(
      `SELECT CASE WHEN
         ${claimGuard}
         AND
         EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
         AND (${SOURCE_DEPENDENCY_SNAPSHOT_QUERY}) = ?
         AND NOT EXISTS (${ACTIVE_WORK_QUERY})
         AND NOT EXISTS (
           SELECT 1 FROM source_merge_members member
           JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
           WHERE member.source_id = ? AND merge_group.reversed_at IS NULL
         )
         AND (${HISTORICAL_MERGE_FINGERPRINT_QUERY}) = ?
       THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
    ).bind(
      plan.sourceId,
      claim.claimToken,
      new Date().toISOString(),
      plan.sourceId,
      plan.title,
      plan.sourceId,
      plan.dependencySnapshot,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.sourceId,
      plan.historicalMergeFingerprint,
    );
  }
  return db.prepare(
    `SELECT CASE WHEN
       ${claimGuard}
       AND
       EXISTS (SELECT 1 FROM sources WHERE id = ? AND title = ?)
       AND (${SOURCE_DEPENDENCY_SNAPSHOT_QUERY}) = ?
       AND NOT EXISTS (${ACTIVE_WORK_QUERY})
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
       AND (${MERGE_MEMBERSHIP_FINGERPRINT_QUERY}) = ?
       AND (${HISTORICAL_MERGE_FINGERPRINT_QUERY}) = ?
     THEN 1 ELSE json('source_delete_guard_failed') END AS valid`,
  ).bind(
    plan.sourceId,
    claim.claimToken,
    new Date().toISOString(),
    plan.sourceId,
    plan.title,
    plan.sourceId,
    plan.dependencySnapshot,
    plan.sourceId,
    plan.sourceId,
    plan.sourceId,
    plan.sourceId,
    plan.sourceId,
    plan.sourceId,
    plan.sourceId,
    plan.merge.groupId,
    plan.merge.role,
    plan.merge.canonicalSourceId,
    plan.merge.groupId,
    plan.merge.memberSourceIds.length,
    plan.merge.groupId,
    plan.mergeFingerprint,
    plan.sourceId,
    plan.historicalMergeFingerprint,
  );
}

async function mergeMutation(
  db: D1Database,
  plan: SourceDeletionPlan,
): Promise<{ statements: D1PreparedStatement[]; result: DeleteSourceMergeResult | null }> {
  if (!plan.merge) return { statements: [], result: null };
  const remainingIds = plan.merge.memberSourceIds.filter((id) => id !== plan.sourceId).sort();
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

function historicalMergeMutation(
  db: D1Database,
  plan: SourceDeletionPlan,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const merge of plan.historicalMerges) {
    const remainingIds = merge.memberSourceIds.filter((id) => id !== plan.sourceId);
    if (remainingIds.length === 0) {
      statements.push(
        db.prepare("DELETE FROM source_duplicate_candidates WHERE merge_group_id = ?").bind(merge.groupId),
        db.prepare("DELETE FROM source_merge_members WHERE group_id = ?").bind(merge.groupId),
        db.prepare("DELETE FROM source_merge_groups WHERE id = ?").bind(merge.groupId),
      );
      continue;
    }
    if (merge.canonicalSourceId === plan.sourceId) {
      const canonicalSourceId = merge.replacementCanonicalSourceId;
      statements.push(
        db.prepare("UPDATE source_merge_groups SET canonical_source_id = ? WHERE id = ? AND canonical_source_id = ?")
          .bind(canonicalSourceId, merge.groupId, plan.sourceId),
        db.prepare("UPDATE source_merge_members SET role = 'MEMBER' WHERE group_id = ?")
          .bind(merge.groupId),
        db.prepare("UPDATE source_merge_members SET role = 'CANONICAL' WHERE group_id = ? AND source_id = ?")
          .bind(merge.groupId, canonicalSourceId),
      );
    }
    statements.push(
      db.prepare("DELETE FROM source_merge_members WHERE group_id = ? AND source_id = ?")
        .bind(merge.groupId, plan.sourceId),
    );
  }
  return statements;
}

async function deleteD1Records(
  db: D1Database,
  plan: SourceDeletionPlan,
  claim: SourceDeletionClaim,
): Promise<DeleteSourceMergeResult | null> {
  await assertPlanStillCurrent(db, plan, claim);
  const merge = await mergeMutation(db, plan);
  const historicalMerge = historicalMergeMutation(db, plan);
  const sourceId = plan.sourceId;
  const ownedAssets = `SELECT id FROM visual_assets
    WHERE parent_source_id = ?
       OR parent_version_id IN (SELECT id FROM source_versions WHERE source_id = ?)`;
  const statements: D1PreparedStatement[] = [
    // Keep this as the first statement in the transaction. It proves that
    // this exact attempt still owns the R2-complete claim immediately before
    // any source-owned row is removed.
    deletionGuard(db, plan, claim),
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
    ...historicalMerge,
    ...merge.statements,
    db.prepare("DELETE FROM source_versions WHERE source_id = ?").bind(sourceId),
    db.prepare("DELETE FROM sources WHERE id = ?").bind(sourceId),
  ];
  try {
    await db.batch(statements);
    return merge.result;
  } catch (error) {
    if (error instanceof SourceDeletionError) throw error;
    // A non-route writer that raced this batch is stopped by the migration
    // trigger. Treat that as a stale guarded batch; the claim remains held
    // and the caller can safely retry after the failed attempt is recorded.
    if (isSourceDeletionClaimError(error)) {
      throw new SourceDeletionError("source_delete_state_changed", error);
    }
    try {
      if (await hasActiveWork(db, plan.sourceId)) {
        throw new SourceDeletionError("source_delete_active_work", error);
      }
      const current = await db.prepare("SELECT title FROM sources WHERE id = ?")
        .bind(plan.sourceId).first<{ title: string }>();
      const currentMerge = await loadActiveMergeSnapshot(db, plan.sourceId);
      const currentDependencies = await loadDependencySnapshot(db, plan.sourceId);
      const currentHistoricalMergeFingerprint = await loadHistoricalMergeFingerprint(db, plan.sourceId);
      if (
        !current
        || current.title !== plan.title
        || mergeFingerprint(currentMerge) !== plan.mergeFingerprint
        || currentHistoricalMergeFingerprint !== plan.historicalMergeFingerprint
        || currentDependencies !== plan.dependencySnapshot
      ) {
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
  // Confirm the exact title before creating a lock. If this request is a
  // typo, it must have no operational side effects.
  await validateSourceDeletionInput(env.DB, input);

  let claim: SourceDeletionClaim;
  try {
    claim = await acquireSourceDeletionClaim(env.DB, input.sourceId);
  } catch (error) {
    throw mapClaimError(error, "source_delete_d1_failed");
  }

  let r2MutationStarted = false;
  let r2Complete = false;
  try {
    // All mutable dependency snapshots are collected only after the claim is
    // held. New versions, visual descendants, and jobs are then blocked by
    // both the route guard and migration triggers.
    const plan = await loadDeletionPlan(env.DB, input);
    await assertPlanStillCurrent(env.DB, plan, claim);

    // Renew immediately before crossing the D1/R2 boundary. A claim that
    // cannot be renewed is never allowed to start storage mutation.
    claim = await renewSourceDeletionClaim(env.DB, claim);
    r2MutationStarted = true;
    await deleteR2Keys(env.ORIGINALS, plan.r2Keys);

    claim = await markSourceDeletionR2Complete(env.DB, claim);
    r2Complete = true;
    // Extend the lease for the bounded final batch and prove that the same
    // token is still active before constructing any merge mutation.
    claim = await renewSourceDeletionClaim(env.DB, claim);
    const merge = await deleteD1Records(env.DB, plan, claim);
    return { deletedSourceId: plan.sourceId, merge };
  } catch (error) {
    if (!r2MutationStarted) {
      // Only read-only preflight failures release the claim. If release fails,
      // the lease remains recoverable and no writer can repopulate the source.
      try {
        await releaseSourceDeletionClaim(env.DB, claim);
      } catch {
        // Preserve the original preflight error.
      }
      if (error instanceof SourceDeletionClaimError) {
        throw mapClaimError(error, "source_delete_d1_failed");
      }
      throw error;
    }

    const failureCode = !r2Complete || (
      error instanceof SourceDeletionError && error.code === "source_delete_r2_failed"
    )
      ? "source_delete_r2_failed"
      : "source_delete_d1_failed";
    await recordDeletionFailure(env.DB, claim, failureCode);
    if (error instanceof SourceDeletionClaimError) {
      throw mapClaimError(error, failureCode);
    }
    throw error;
  }
}
