export const DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS = 5 * 60 * 1_000;
export const SOURCE_DELETION_CLAIM_ERROR = "source_deletion_in_progress" as const;

export type SourceDeletionClaimState = "R2_PENDING" | "R2_COMPLETE";
export type SourceDeletionClaimErrorCode =
  | "source_delete_in_progress"
  | "source_delete_claim_lost"
  | "source_delete_claim_invalid_state";
export type SourceDeletionClaimFailureCode = "source_delete_r2_failed" | "source_delete_d1_failed";

export interface SourceDeletionClaim {
  sourceId: string;
  claimToken: string;
  state: SourceDeletionClaimState;
  leaseExpiresAt: string;
  lastErrorCode: SourceDeletionClaimFailureCode | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceDeletionClaimRef {
  sourceId: string;
  claimToken: string;
}

export class SourceDeletionClaimError extends Error {
  readonly code: SourceDeletionClaimErrorCode;

  constructor(code: SourceDeletionClaimErrorCode, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "SourceDeletionClaimError";
    this.code = code;
  }
}

type ClaimRow = {
  source_id: string;
  claim_token: string;
  state: SourceDeletionClaimState;
  lease_expires_at: string;
  last_error_code: SourceDeletionClaimFailureCode | null;
  created_at: string;
  updated_at: string;
};

function mapClaim(row: ClaimRow): SourceDeletionClaim {
  return {
    sourceId: row.source_id,
    claimToken: row.claim_token,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asIso(value: Date): string {
  return value.toISOString();
}

function leaseExpiry(now: Date, leaseMs: number): string {
  return asIso(new Date(now.getTime() + leaseMs));
}

export async function getSourceDeletionClaim(db: D1Database, sourceId: string): Promise<SourceDeletionClaim | null> {
  const row = await db.prepare(
    `SELECT source_id, claim_token, state, lease_expires_at, last_error_code, created_at, updated_at
     FROM source_deletion_claims
     WHERE source_id = ?`,
  ).bind(sourceId).first<ClaimRow>();
  return row ? mapClaim(row) : null;
}

/**
 * Atomically inserts a claim or rotates a recoverable claim. A live claim is
 * never replaced, except for a completed R2 phase that explicitly recorded a
 * D1-finalization failure; that state has no owner left and is safe to resume
 * immediately. A live `R2_COMPLETE` claim with no error remains locked while
 * its owner is performing the D1 batch.
 */
export async function acquireSourceDeletionClaim(
  db: D1Database,
  sourceId: string,
  now = new Date(),
  leaseMs = DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS,
): Promise<SourceDeletionClaim> {
  const nowIso = asIso(now);
  const token = crypto.randomUUID();
  const expiresIso = leaseExpiry(now, leaseMs);
  const result = await db.prepare(
    `INSERT INTO source_deletion_claims
       (source_id, claim_token, state, lease_expires_at, last_error_code, created_at, updated_at)
     VALUES (?, ?, 'R2_PENDING', ?, NULL, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       claim_token = excluded.claim_token,
       state = 'R2_PENDING',
       lease_expires_at = excluded.lease_expires_at,
       last_error_code = NULL,
       updated_at = excluded.updated_at
     WHERE source_deletion_claims.lease_expires_at <= excluded.updated_at
        OR (source_deletion_claims.state = 'R2_COMPLETE'
            AND source_deletion_claims.last_error_code = 'source_delete_d1_failed')`,
  ).bind(sourceId, token, expiresIso, nowIso, nowIso).run();

  if (!result.meta.changes) {
    throw new SourceDeletionClaimError("source_delete_in_progress");
  }
  const claim = await getSourceDeletionClaim(db, sourceId);
  if (!claim || claim.claimToken !== token) {
    throw new SourceDeletionClaimError("source_delete_claim_lost");
  }
  return claim;
}

async function updateClaim(
  db: D1Database,
  statement: D1PreparedStatement,
  sourceId: string,
  claimToken: string,
): Promise<SourceDeletionClaim> {
  const result = await statement.run();
  if (!result.meta.changes) {
    throw new SourceDeletionClaimError("source_delete_claim_lost");
  }
  const claim = await getSourceDeletionClaim(db, sourceId);
  if (!claim || claim.claimToken !== claimToken) {
    throw new SourceDeletionClaimError("source_delete_claim_lost");
  }
  return claim;
}

export async function renewSourceDeletionClaim(
  db: D1Database,
  claim: SourceDeletionClaimRef,
  now = new Date(),
  leaseMs = DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS,
): Promise<SourceDeletionClaim> {
  const nowIso = asIso(now);
  return updateClaim(
    db,
    db.prepare(
      `UPDATE source_deletion_claims
       SET lease_expires_at = ?, updated_at = ?
       WHERE source_id = ?
         AND claim_token = ?
         AND lease_expires_at > ?`,
    ).bind(leaseExpiry(now, leaseMs), nowIso, claim.sourceId, claim.claimToken, nowIso),
    claim.sourceId,
    claim.claimToken,
  );
}

export async function markSourceDeletionR2Complete(
  db: D1Database,
  claim: SourceDeletionClaimRef,
  now = new Date(),
  leaseMs = DEFAULT_SOURCE_DELETION_CLAIM_LEASE_MS,
): Promise<SourceDeletionClaim> {
  const nowIso = asIso(now);
  return updateClaim(
    db,
    db.prepare(
      `UPDATE source_deletion_claims
       SET state = 'R2_COMPLETE', last_error_code = NULL, lease_expires_at = ?, updated_at = ?
       WHERE source_id = ?
         AND claim_token = ?
         AND state = 'R2_PENDING'
         AND lease_expires_at > ?`,
    ).bind(leaseExpiry(now, leaseMs), nowIso, claim.sourceId, claim.claimToken, nowIso),
    claim.sourceId,
    claim.claimToken,
  );
}

/**
 * Records a bounded retry state and immediately makes the failed attempt
 * resumable. The row remains present so no writer can repopulate a partially
 * cleaned source before the next delete attempt.
 */
export async function recordSourceDeletionError(
  db: D1Database,
  claim: SourceDeletionClaimRef,
  code: SourceDeletionClaimFailureCode,
  now = new Date(),
): Promise<SourceDeletionClaim> {
  const nowIso = asIso(now);
  return updateClaim(
    db,
    db.prepare(
      `UPDATE source_deletion_claims
       SET last_error_code = ?, lease_expires_at = ?, updated_at = ?
       WHERE source_id = ? AND claim_token = ?`,
    ).bind(code, nowIso, nowIso, claim.sourceId, claim.claimToken),
    claim.sourceId,
    claim.claimToken,
  );
}

/** Only a preflight failure, before any R2 mutation, may release the lock. */
export async function releaseSourceDeletionClaim(db: D1Database, claim: SourceDeletionClaimRef): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM source_deletion_claims WHERE source_id = ? AND claim_token = ?",
  ).bind(claim.sourceId, claim.claimToken).run();
  return Boolean(result.meta.changes);
}

export async function assertSourceDeletionClaimOwned(
  db: D1Database,
  claim: SourceDeletionClaimRef,
  state?: SourceDeletionClaimState,
  now = new Date(),
): Promise<SourceDeletionClaim> {
  const row = await db.prepare(
    `SELECT source_id, claim_token, state, lease_expires_at, last_error_code, created_at, updated_at
     FROM source_deletion_claims
     WHERE source_id = ?
       AND claim_token = ?
       AND lease_expires_at > ?
       AND (? IS NULL OR state = ?)`,
  ).bind(claim.sourceId, claim.claimToken, asIso(now), state ?? null, state ?? null).first<ClaimRow>();
  if (!row) throw new SourceDeletionClaimError("source_delete_claim_lost");
  return mapClaim(row);
}

/**
 * DB-level triggers are the final race-safe boundary. This helper gives route
 * and worker callers the same stable error before they attempt a write.
 */
export async function assertSourceDeletionNotClaimed(db: D1Database, sourceId: string): Promise<void> {
  const row = await db.prepare(
    "SELECT 1 AS claimed FROM source_deletion_claims WHERE source_id = ? LIMIT 1",
  ).bind(sourceId).first<{ claimed: number }>();
  if (row) throw new SourceDeletionClaimError("source_delete_in_progress");
}

export async function assertSourceDeletionNotClaimedForVersion(db: D1Database, versionId: string): Promise<void> {
  const row = await db.prepare("SELECT source_id FROM source_versions WHERE id = ?").bind(versionId).first<{ source_id: string }>();
  if (row) await assertSourceDeletionNotClaimed(db, row.source_id);
}

export async function assertSourceDeletionNotClaimedForVisualAsset(db: D1Database, visualAssetId: string): Promise<void> {
  const row = await db.prepare(
    `SELECT asset.parent_source_id, version.source_id AS version_source_id
     FROM visual_assets asset
     LEFT JOIN source_versions version ON version.id = asset.parent_version_id
     WHERE asset.id = ?`,
  ).bind(visualAssetId).first<{ parent_source_id: string | null; version_source_id: string | null }>();
  if (row?.parent_source_id) await assertSourceDeletionNotClaimed(db, row.parent_source_id);
  if (row?.version_source_id && row.version_source_id !== row.parent_source_id) {
    await assertSourceDeletionNotClaimed(db, row.version_source_id);
  }
}

export async function assertSourceDeletionNotClaimedForExtractionRun(db: D1Database, runId: string): Promise<void> {
  const row = await db.prepare("SELECT parent_source_id FROM visual_extraction_runs WHERE id = ?").bind(runId).first<{ parent_source_id: string }>();
  if (row) await assertSourceDeletionNotClaimed(db, row.parent_source_id);
}

type JobInput = {
  sourceId?: unknown;
  sourceVersionId?: unknown;
  versionId?: unknown;
  visualAssetId?: unknown;
  extractionRunId?: unknown;
};

function textId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Resolve all source owners represented by a research-job input. */
export async function sourceIdsForResearchJobInput(db: D1Database, input: unknown): Promise<string[]> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const candidate = input as JobInput;
  const sourceIds = new Set<string>();
  const directSourceId = textId(candidate.sourceId);
  if (directSourceId) sourceIds.add(directSourceId);

  for (const versionId of [textId(candidate.sourceVersionId), textId(candidate.versionId)]) {
    if (!versionId) continue;
    const row = await db.prepare("SELECT source_id FROM source_versions WHERE id = ?").bind(versionId).first<{ source_id: string }>();
    if (row) sourceIds.add(row.source_id);
  }

  const visualAssetId = textId(candidate.visualAssetId);
  if (visualAssetId) {
    const row = await db.prepare(
      `SELECT asset.parent_source_id, version.source_id AS version_source_id
       FROM visual_assets asset
       LEFT JOIN source_versions version ON version.id = asset.parent_version_id
       WHERE asset.id = ?`,
    ).bind(visualAssetId).first<{ parent_source_id: string | null; version_source_id: string | null }>();
    if (row?.parent_source_id) sourceIds.add(row.parent_source_id);
    if (row?.version_source_id) sourceIds.add(row.version_source_id);
  }

  const extractionRunId = textId(candidate.extractionRunId);
  if (extractionRunId) {
    const row = await db.prepare("SELECT parent_source_id FROM visual_extraction_runs WHERE id = ?").bind(extractionRunId).first<{ parent_source_id: string }>();
    if (row) sourceIds.add(row.parent_source_id);
  }
  return [...sourceIds];
}

export async function assertSourceDeletionNotClaimedForResearchJobInput(db: D1Database, input: unknown): Promise<void> {
  for (const sourceId of await sourceIdsForResearchJobInput(db, input)) {
    await assertSourceDeletionNotClaimed(db, sourceId);
  }
}

/** Translate a D1 trigger abort into the public claim error contract. */
export function isSourceDeletionClaimError(error: unknown): boolean {
  if (error instanceof SourceDeletionClaimError && error.code === "source_delete_in_progress") return true;
  return error instanceof Error && error.message.includes(SOURCE_DELETION_CLAIM_ERROR);
}
