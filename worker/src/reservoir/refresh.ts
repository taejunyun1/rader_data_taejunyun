import { evaluateDuplicate, type DuplicateAssessment, type SourceMatchInput } from "../ingestion/matching";
import { normalizeDoi, normalizeOriginIdentity, normalizeUrl } from "../ingestion/normalize";
import { createLogicalMerge } from "./mergeGroups";

export type ReservoirRefreshMode = "PREVIEW" | "APPLY";
export type DuplicateCandidateStatus = "PENDING" | "MERGED" | "SEPARATE";
export type DuplicateReviewAction = "MERGE" | "SEPARATE";

const REFRESH_BATCH_SIZE = 50;

interface RefreshSource extends SourceMatchInput {
  id: string;
  qualityStatus: string;
  textScope: string | null;
  normalizedText: string | null;
  createdAt: string;
}

export interface ReservoirRefreshRun {
  id: string;
  mode: ReservoirRefreshMode;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  cursorSourceId: string | null;
  scannedCount: number;
  autoMergeCount: number;
  reviewCount: number;
  separateCount: number;
  qualityIssueCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DuplicateCandidate {
  id: string;
  leftSourceId: string;
  rightSourceId: string;
  leftTitle: string;
  rightTitle: string;
  decision: DuplicateAssessment["decision"];
  score: number;
  reasons: string[];
  status: DuplicateCandidateStatus;
  mergeGroupId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface StoredCandidate {
  id: string;
  status: DuplicateCandidateStatus;
}

interface AssessedPair {
  left: RefreshSource;
  right: RefreshSource;
  assessment: DuplicateAssessment;
  candidate: StoredCandidate;
}

function refreshRun(row: Record<string, unknown>): ReservoirRefreshRun {
  return {
    id: String(row.id),
    mode: row.mode as ReservoirRefreshMode,
    status: row.status as ReservoirRefreshRun["status"],
    cursorSourceId: typeof row.cursor_source_id === "string" ? row.cursor_source_id : null,
    scannedCount: Number(row.scanned_count ?? 0),
    autoMergeCount: Number(row.auto_merge_count ?? 0),
    reviewCount: Number(row.review_count ?? 0),
    separateCount: Number(row.separate_count ?? 0),
    qualityIssueCount: Number(row.quality_issue_count ?? 0),
    error: typeof row.error === "string" ? row.error : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

export async function getReservoirRefreshRun(db: D1Database, runId: string): Promise<ReservoirRefreshRun | null> {
  const row = await db.prepare("SELECT * FROM reservoir_refresh_runs WHERE id = ?").bind(runId).first<Record<string, unknown>>();
  return row ? refreshRun(row) : null;
}

async function scanSources(db: D1Database): Promise<RefreshSource[]> {
  const rows = await db.prepare(
    `SELECT s.id, s.title, s.authors, s.year, s.canonical_url AS canonicalUrl, s.doi, s.origin,
            s.quality_status AS qualityStatus, s.created_at AS createdAt,
            v.raw_content_hash AS rawContentHash,
            v.normalized_content_hash AS normalizedTextHash,
            v.normalized_text AS normalizedText, v.text_scope AS textScope
     FROM sources s
     LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE NOT EXISTS (
       SELECT 1 FROM source_merge_members m
       JOIN source_merge_groups g ON g.id = m.group_id
       WHERE m.source_id = s.id AND g.reversed_at IS NULL
     )
     ORDER BY s.id ASC
     LIMIT ?`,
  ).bind(REFRESH_BATCH_SIZE).all<RefreshSource>();
  return rows.results ?? [];
}

function fingerprintValues(source: RefreshSource): Array<{ kind: string; value: string }> {
  const values: Array<{ kind: string; value: string | null | undefined }> = [
    { kind: "DOI", value: source.doi ? normalizeDoi(source.doi) : null },
    { kind: "CANONICAL_URL", value: source.canonicalUrl ? normalizeUrl(source.canonicalUrl) : null },
    { kind: "RAW_HASH", value: source.rawContentHash },
    { kind: "NORMALIZED_TEXT_HASH", value: source.normalizedTextHash },
    { kind: "OBSIDIAN_ORIGIN", value: source.origin ? normalizeOriginIdentity(source.origin) : null },
  ];
  return values.flatMap(({ kind, value }) => value?.trim() ? [{ kind, value: value.trim() }] : []);
}

async function storeFingerprints(db: D1Database, sources: RefreshSource[], now: string): Promise<void> {
  const statements = sources.flatMap((source) => fingerprintValues(source).map(({ kind, value }) => db.prepare(
    `INSERT OR IGNORE INTO source_fingerprints (source_id, kind, value, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(source.id, kind, value, now)));
  if (statements.length) await db.batch(statements);
}

async function storeCandidate(
  db: D1Database,
  left: RefreshSource,
  right: RefreshSource,
  assessment: DuplicateAssessment,
  now: string,
): Promise<StoredCandidate> {
  const initialStatus: DuplicateCandidateStatus = assessment.decision === "SEPARATE" ? "SEPARATE" : "PENDING";
  const initialResolvedAt = initialStatus === "SEPARATE" ? now : null;
  const row = await db.prepare(
    `INSERT INTO source_duplicate_candidates
     (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(left_source_id, right_source_id) DO UPDATE SET
       decision = excluded.decision,
       score = excluded.score,
       reasons_json = excluded.reasons_json,
       status = CASE
         WHEN source_duplicate_candidates.status IN ('MERGED', 'SEPARATE') THEN source_duplicate_candidates.status
         ELSE excluded.status
       END,
       resolved_at = CASE
         WHEN source_duplicate_candidates.status IN ('MERGED', 'SEPARATE') THEN source_duplicate_candidates.resolved_at
         ELSE excluded.resolved_at
       END
     RETURNING id, status`,
  ).bind(
    crypto.randomUUID(),
    left.id,
    right.id,
    assessment.decision,
    assessment.confidence,
    JSON.stringify(assessment.reasons),
    initialStatus,
    now,
    initialResolvedAt,
  ).first<StoredCandidate>();
  if (!row) throw new Error("duplicate_candidate_not_stored");
  return row;
}

class SourceComponents {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent) throw new Error("unknown_component_source");
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }

  groups(): string[][] {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      groups.set(root, [...(groups.get(root) ?? []), id]);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }
}

async function selectCanonicalSourceId(db: D1Database, sourceIds: string[]): Promise<string> {
  const placeholders = sourceIds.map(() => "?").join(", ");
  const row = await db.prepare(
    `SELECT s.id
     FROM sources s
     LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id IN (${placeholders})
     ORDER BY
       ((SELECT COUNT(*) FROM user_signals us WHERE us.source_id = s.id) +
        (SELECT COUNT(*) FROM thread_links tl WHERE tl.source_id = s.id)) DESC,
       CASE WHEN s.quality_status = 'READY' AND v.text_scope = 'FULLTEXT' THEN 1 ELSE 0 END DESC,
       LENGTH(COALESCE(v.normalized_text, '')) DESC,
       s.created_at ASC,
       s.id ASC
     LIMIT 1`,
  ).bind(...sourceIds).first<{ id: string }>();
  if (!row) throw new Error("canonical_source_not_found");
  return row.id;
}

async function applyAutomaticMerges(db: D1Database, pairs: AssessedPair[], now: string): Promise<void> {
  const eligible = pairs.filter((pair) => pair.assessment.decision === "AUTO_MERGE" && pair.candidate.status === "PENDING");
  const components = new SourceComponents();
  for (const pair of eligible) components.union(pair.left.id, pair.right.id);

  for (const sourceIds of components.groups()) {
    const canonicalSourceId = await selectCanonicalSourceId(db, sourceIds);
    const componentPairs = eligible.filter((pair) => sourceIds.includes(pair.left.id) && sourceIds.includes(pair.right.id));
    const groupId = await createLogicalMerge(db, {
      canonicalSourceId,
      memberSourceIds: sourceIds.filter((id) => id !== canonicalSourceId),
      mode: "AUTO",
      confidence: Math.min(...componentPairs.map((pair) => pair.assessment.confidence)),
      reasons: [...new Set(componentPairs.flatMap((pair) => pair.assessment.reasons))],
    });
    await db.batch(componentPairs.map((pair) => db.prepare(
      `UPDATE source_duplicate_candidates
       SET status = 'MERGED', merge_group_id = ?, resolved_at = ?
       WHERE id = ? AND status = 'PENDING'`,
    ).bind(groupId, now, pair.candidate.id)));
  }
}

export async function runReservoirRefresh(db: D1Database, mode: ReservoirRefreshMode): Promise<ReservoirRefreshRun> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await db.prepare(
    `INSERT INTO reservoir_refresh_runs
     (id, mode, status, created_at, updated_at, started_at)
     VALUES (?, ?, 'RUNNING', ?, ?, ?)`,
  ).bind(runId, mode, startedAt, startedAt, startedAt).run();

  try {
    const sources = await scanSources(db);
    await storeFingerprints(db, sources, startedAt);
    const pairs: AssessedPair[] = [];
    const counts = { AUTO_MERGE: 0, REVIEW: 0, SEPARATE: 0 };
    for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
        const left = sources[leftIndex]!;
        const right = sources[rightIndex]!;
        const assessment = evaluateDuplicate(left, right);
        counts[assessment.decision] += 1;
        const candidate = await storeCandidate(db, left, right, assessment, startedAt);
        pairs.push({ left, right, assessment, candidate });
      }
    }
    const completedAt = new Date().toISOString();
    if (mode === "APPLY") await applyAutomaticMerges(db, pairs, completedAt);
    await db.prepare(
      `UPDATE reservoir_refresh_runs
       SET status = 'COMPLETED', cursor_source_id = ?, scanned_count = ?, auto_merge_count = ?,
           review_count = ?, separate_count = ?, quality_issue_count = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    ).bind(
      sources.at(-1)?.id ?? null,
      sources.length,
      counts.AUTO_MERGE,
      counts.REVIEW,
      counts.SEPARATE,
      sources.filter((source) => source.qualityStatus !== "READY").length,
      completedAt,
      completedAt,
      runId,
    ).run();
  } catch (error) {
    const failedAt = new Date().toISOString();
    await db.prepare(
      `UPDATE reservoir_refresh_runs
       SET status = 'FAILED', error = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
    ).bind((error as Error).message.slice(0, 500), failedAt, failedAt, runId).run();
    throw error;
  }

  return (await getReservoirRefreshRun(db, runId))!;
}

export async function listDuplicateCandidates(
  db: D1Database,
  status: DuplicateCandidateStatus = "PENDING",
): Promise<DuplicateCandidate[]> {
  const rows = await db.prepare(
    `SELECT c.id, c.left_source_id AS leftSourceId, c.right_source_id AS rightSourceId,
            left_source.title AS leftTitle, right_source.title AS rightTitle,
            c.decision, c.score, c.reasons_json AS reasonsJson, c.status,
            c.merge_group_id AS mergeGroupId, c.created_at AS createdAt, c.resolved_at AS resolvedAt
     FROM source_duplicate_candidates c
     JOIN sources left_source ON left_source.id = c.left_source_id
     JOIN sources right_source ON right_source.id = c.right_source_id
     WHERE c.status = ?
     ORDER BY c.created_at DESC, c.id ASC
     LIMIT 200`,
  ).bind(status).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    leftSourceId: String(row.leftSourceId),
    rightSourceId: String(row.rightSourceId),
    leftTitle: String(row.leftTitle),
    rightTitle: String(row.rightTitle),
    decision: row.decision as DuplicateCandidate["decision"],
    score: Number(row.score),
    reasons: JSON.parse(String(row.reasonsJson)) as string[],
    status: row.status as DuplicateCandidateStatus,
    mergeGroupId: typeof row.mergeGroupId === "string" ? row.mergeGroupId : null,
    createdAt: String(row.createdAt),
    resolvedAt: typeof row.resolvedAt === "string" ? row.resolvedAt : null,
  }));
}

export async function resolveDuplicateCandidate(
  db: D1Database,
  candidateId: string,
  action: DuplicateReviewAction,
): Promise<DuplicateCandidate | null> {
  const row = await db.prepare(
    `SELECT id, left_source_id, right_source_id, decision, score, reasons_json, status
     FROM source_duplicate_candidates WHERE id = ?`,
  ).bind(candidateId).first<{
    id: string;
    left_source_id: string;
    right_source_id: string;
    decision: DuplicateAssessment["decision"];
    score: number;
    reasons_json: string;
    status: DuplicateCandidateStatus;
  }>();
  if (!row) return null;
  if (row.status !== "PENDING") throw new Error("duplicate_candidate_already_resolved");
  const now = new Date().toISOString();
  if (action === "SEPARATE") {
    await db.prepare(
      `UPDATE source_duplicate_candidates SET status = 'SEPARATE', resolved_at = ? WHERE id = ? AND status = 'PENDING'`,
    ).bind(now, candidateId).run();
  } else {
    const sourceIds = [row.left_source_id, row.right_source_id];
    const canonicalSourceId = await selectCanonicalSourceId(db, sourceIds);
    const groupId = await createLogicalMerge(db, {
      canonicalSourceId,
      memberSourceIds: sourceIds.filter((id) => id !== canonicalSourceId),
      mode: "MANUAL",
      confidence: Number(row.score),
      reasons: JSON.parse(row.reasons_json) as string[],
    });
    await db.prepare(
      `UPDATE source_duplicate_candidates
       SET status = 'MERGED', merge_group_id = ?, resolved_at = ? WHERE id = ? AND status = 'PENDING'`,
    ).bind(groupId, now, candidateId).run();
  }
  return (await listDuplicateCandidates(db, action === "MERGE" ? "MERGED" : "SEPARATE"))
    .find((candidate) => candidate.id === candidateId) ?? null;
}
