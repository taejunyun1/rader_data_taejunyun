import { evaluateDuplicate, type DuplicateAssessment, type SourceMatchInput } from "../ingestion/matching";
import { normalizeDoi, normalizeOriginIdentity, normalizeUrl } from "../ingestion/normalize";
import { createLogicalMerge } from "./mergeGroups";

export type ReservoirRefreshMode = "PREVIEW" | "APPLY";
export type DuplicateCandidateStatus = "PENDING" | "MERGED" | "SEPARATE";
export type DuplicateReviewAction = "MERGE" | "SEPARATE";

const REFRESH_BATCH_SIZE = 50;
const MAX_FINGERPRINTS_PER_STATEMENT = 20;
const MAX_CANDIDATES_PER_STATEMENT = 8;
const MAX_STATEMENTS_PER_BATCH = 50;
const MAX_CANDIDATE_LOOKUP_PAIRS = 40;
const MAX_PERSISTED_FINGERPRINT_PAIRS = 200;
const MAX_CANONICAL_SOURCE_IDS_PER_QUERY = 90;
const MAX_MERGE_MEMBERS_PER_STATEMENT = 25;
const MAX_CANDIDATE_STATUS_IDS_PER_STATEMENT = 98;

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
  hasMore: boolean;
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
}

interface StoredAssessedPair extends AssessedPair {
  candidate: StoredCandidate;
}

interface SourceBatch {
  sources: RefreshSource[];
  continuationCursor: string | null;
}

function refreshRun(row: Record<string, unknown>): ReservoirRefreshRun {
  return {
    id: String(row.id),
    mode: row.mode as ReservoirRefreshMode,
    status: row.status as ReservoirRefreshRun["status"],
    cursorSourceId: typeof row.cursor_source_id === "string" ? row.cursor_source_id : null,
    hasMore: typeof row.cursor_source_id === "string",
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

async function latestContinuationCursor(db: D1Database, mode: ReservoirRefreshMode): Promise<string | null> {
  const row = await db.prepare(
    `SELECT cursor_source_id
     FROM reservoir_refresh_runs
     WHERE mode = ? AND status = 'COMPLETED'
     ORDER BY rowid DESC
     LIMIT 1`,
  ).bind(mode).first<{ cursor_source_id: string | null }>();
  return row?.cursor_source_id ?? null;
}

async function scanSources(db: D1Database, afterSourceId: string | null): Promise<SourceBatch> {
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
       AND (? IS NULL OR s.id > ?)
     ORDER BY s.id ASC
     LIMIT ?`,
  ).bind(afterSourceId, afterSourceId, REFRESH_BATCH_SIZE + 1).all<RefreshSource>();
  const available = rows.results ?? [];
  const sources = available.slice(0, REFRESH_BATCH_SIZE);
  return {
    sources,
    continuationCursor: available.length > REFRESH_BATCH_SIZE ? sources.at(-1)?.id ?? null : null,
  };
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

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function executeBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const group of chunks(statements, MAX_STATEMENTS_PER_BATCH)) await db.batch(group);
}

async function storeFingerprints(db: D1Database, sources: RefreshSource[], now: string): Promise<void> {
  const fingerprints = sources.flatMap((source) => fingerprintValues(source).map(({ kind, value }) => ({
    sourceId: source.id,
    kind,
    value,
  })));
  const statements = chunks(fingerprints, MAX_FINGERPRINTS_PER_STATEMENT).map((group) => db.prepare(
    `INSERT OR IGNORE INTO source_fingerprints (source_id, kind, value, created_at)
     VALUES ${group.map(() => "(?, ?, ?, ?)").join(", ")}`,
  ).bind(...group.flatMap((fingerprint) => [fingerprint.sourceId, fingerprint.kind, fingerprint.value, now])));
  if (statements.length) await executeBatched(db, statements);
}

function normalizedTitle(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || null;
}

function titleBigrams(value: string): string[] {
  if (value.length < 2) return [value];
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) result.add(value.slice(index, index + 2));
  return [...result];
}

function blockedSourcePairs(sources: RefreshSource[]): Array<[RefreshSource, RefreshSource]> {
  const blocks = new Map<string, RefreshSource[]>();
  const addBlock = (key: string, source: RefreshSource) => blocks.set(key, [...(blocks.get(key) ?? []), source]);
  for (const source of sources) {
    for (const fingerprint of fingerprintValues(source)) {
      addBlock(`fingerprint:${fingerprint.kind}:${fingerprint.value}`, source);
    }
    const title = normalizedTitle(source.title);
    if (title) {
      for (const bigram of titleBigrams(title)) addBlock(`title:${bigram}`, source);
    }
  }

  const pairKeys = new Set<string>();
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  for (const members of blocks.values()) {
    for (let leftIndex = 0; leftIndex < members.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < members.length; rightIndex += 1) {
        const ids = [members[leftIndex]!.id, members[rightIndex]!.id].sort();
        if (ids[0] !== ids[1]) pairKeys.add(`${ids[0]}\u0000${ids[1]}`);
      }
    }
  }
  return [...pairKeys].sort().map((key) => {
    const [leftId, rightId] = key.split("\u0000");
    return [sourcesById.get(leftId!)!, sourcesById.get(rightId!)!];
  });
}

async function persistedFingerprintPairs(
  db: D1Database,
  sources: RefreshSource[],
): Promise<Array<[RefreshSource, RefreshSource]>> {
  if (!sources.length) return [];
  const placeholders = sources.map(() => "?").join(", ");
  const rows = await db.prepare(
    `SELECT DISTINCT current_fp.source_id AS currentSourceId,
            matched_source.id, matched_source.title, matched_source.authors, matched_source.year,
            matched_source.canonical_url AS canonicalUrl, matched_source.doi, matched_source.origin,
            matched_source.quality_status AS qualityStatus, matched_source.created_at AS createdAt,
            matched_version.raw_content_hash AS rawContentHash,
            matched_version.normalized_content_hash AS normalizedTextHash,
            matched_version.normalized_text AS normalizedText, matched_version.text_scope AS textScope
     FROM source_fingerprints current_fp
     JOIN source_fingerprints matched_fp
       ON matched_fp.kind = current_fp.kind AND matched_fp.value = current_fp.value
      AND matched_fp.source_id <> current_fp.source_id
     JOIN sources matched_source ON matched_source.id = matched_fp.source_id
     LEFT JOIN source_versions matched_version ON matched_version.id = matched_source.active_version_id
     WHERE current_fp.source_id IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM source_merge_members member
         JOIN source_merge_groups merge_group ON merge_group.id = member.group_id
         WHERE member.source_id = matched_source.id AND merge_group.reversed_at IS NULL
       )
     ORDER BY current_fp.source_id ASC, matched_source.id ASC
     LIMIT ?`,
  ).bind(...sources.map((source) => source.id), MAX_PERSISTED_FINGERPRINT_PAIRS).all<RefreshSource & {
    currentSourceId: string;
  }>();
  const currentById = new Map(sources.map((source) => [source.id, source]));
  return (rows.results ?? []).flatMap((row) => {
    const current = currentById.get(row.currentSourceId);
    if (!current) return [];
    const { currentSourceId: _currentSourceId, ...matched } = row;
    return current.id < matched.id ? [[current, matched]] : [[matched, current]];
  });
}

function uniqueSourcePairs(
  ...groups: Array<Array<[RefreshSource, RefreshSource]>>
): Array<[RefreshSource, RefreshSource]> {
  const result = new Map<string, [RefreshSource, RefreshSource]>();
  for (const [left, right] of groups.flat()) result.set(`${left.id}\u0000${right.id}`, [left, right]);
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, pair]) => pair);
}

async function loadStoredCandidates(db: D1Database, pairs: AssessedPair[]): Promise<Map<string, StoredCandidate>> {
  const result = new Map<string, StoredCandidate>();
  for (const group of chunks(pairs, MAX_CANDIDATE_LOOKUP_PAIRS)) {
    const rows = await db.prepare(
      `SELECT id, left_source_id, right_source_id, status
       FROM source_duplicate_candidates
       WHERE ${group.map(() => "(left_source_id = ? AND right_source_id = ?)").join(" OR ")}`,
    ).bind(...group.flatMap((pair) => [pair.left.id, pair.right.id])).all<{
      id: string;
      left_source_id: string;
      right_source_id: string;
      status: DuplicateCandidateStatus;
    }>();
    for (const row of rows.results ?? []) {
      result.set(`${row.left_source_id}\u0000${row.right_source_id}`, { id: row.id, status: row.status });
    }
  }
  return result;
}

async function storeCandidates(db: D1Database, pairs: AssessedPair[], now: string): Promise<StoredAssessedPair[]> {
  const candidates = pairs.filter((pair) => pair.assessment.decision !== "SEPARATE");
  const statements = chunks(candidates, MAX_CANDIDATES_PER_STATEMENT).map((group) => db.prepare(
    `INSERT INTO source_duplicate_candidates
     (id, left_source_id, right_source_id, decision, score, reasons_json, status, created_at, resolved_at)
     VALUES ${group.map(() => "(?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)").join(", ")}
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
       END`,
  ).bind(...group.flatMap((pair) => [
    crypto.randomUUID(),
    pair.left.id,
    pair.right.id,
    pair.assessment.decision,
    pair.assessment.confidence,
    JSON.stringify(pair.assessment.reasons),
    now,
  ])));
  if (statements.length) await executeBatched(db, statements);
  const stored = await loadStoredCandidates(db, candidates);
  return candidates.map((pair) => {
    const candidate = stored.get(`${pair.left.id}\u0000${pair.right.id}`);
    if (!candidate) throw new Error("duplicate_candidate_not_stored");
    return { ...pair, candidate };
  });
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
  const candidates: Array<{
    id: string;
    signalCount: number;
    fullText: number;
    textLength: number;
    createdAt: string;
  }> = [];
  for (const group of chunks(sourceIds, MAX_CANONICAL_SOURCE_IDS_PER_QUERY)) {
    const placeholders = group.map(() => "?").join(", ");
    const rows = await db.prepare(
      `SELECT s.id, s.created_at AS createdAt,
              ((SELECT COUNT(*) FROM user_signals us WHERE us.source_id = s.id) +
               (SELECT COUNT(*) FROM thread_links tl WHERE tl.source_id = s.id)) AS signalCount,
              CASE WHEN s.quality_status = 'READY' AND v.text_scope = 'FULLTEXT' THEN 1 ELSE 0 END AS fullText,
              LENGTH(COALESCE(v.normalized_text, '')) AS textLength
       FROM sources s
       LEFT JOIN source_versions v ON v.id = s.active_version_id
       WHERE s.id IN (${placeholders})`,
    ).bind(...group).all<{
      id: string;
      createdAt: string;
      signalCount: number;
      fullText: number;
      textLength: number;
    }>();
    candidates.push(...(rows.results ?? []));
  }
  candidates.sort((left, right) =>
    right.signalCount - left.signalCount ||
    right.fullText - left.fullText ||
    right.textLength - left.textLength ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id));
  const canonical = candidates[0];
  if (!canonical) throw new Error("canonical_source_not_found");
  return canonical.id;
}

async function createAutomaticLogicalMerge(
  db: D1Database,
  input: {
    canonicalSourceId: string;
    memberSourceIds: string[];
    confidence: number;
    reasons: string[];
    candidateIds: string[];
  },
  now: string,
): Promise<void> {
  const sourceIds = [...new Set([input.canonicalSourceId, ...input.memberSourceIds])];
  if (sourceIds.length < 2) throw new Error("A logical merge requires at least two distinct sources");

  let existingSourceCount = 0;
  for (const group of chunks(sourceIds, MAX_CANONICAL_SOURCE_IDS_PER_QUERY)) {
    const placeholders = group.map(() => "?").join(", ");
    const existingSources = await db.prepare(
      `SELECT COUNT(*) AS count FROM sources WHERE id IN (${placeholders})`,
    ).bind(...group).first<{ count: number }>();
    existingSourceCount += Number(existingSources?.count ?? 0);
  }
  if (existingSourceCount !== sourceIds.length) {
    throw new Error("Every logical merge member must reference an existing source");
  }

  for (const group of chunks(sourceIds, MAX_CANONICAL_SOURCE_IDS_PER_QUERY)) {
    const placeholders = group.map(() => "?").join(", ");
    const activeMembership = await db.prepare(
      `SELECT m.source_id
       FROM source_merge_members m
       JOIN source_merge_groups g ON g.id = m.group_id
       WHERE g.reversed_at IS NULL AND m.source_id IN (${placeholders})
       LIMIT 1`,
    ).bind(...group).first<{ source_id: string }>();
    if (activeMembership) {
      throw new Error(`Source ${activeMembership.source_id} already belongs to an active merge group`);
    }
  }

  const groupId = crypto.randomUUID();
  const statements = [
    db.prepare(
      `INSERT INTO source_merge_groups
       (id, canonical_source_id, mode, confidence, reasons_json, created_at)
       VALUES (?, ?, 'AUTO', ?, ?, ?)`,
    ).bind(groupId, input.canonicalSourceId, input.confidence, JSON.stringify(input.reasons), now),
    ...chunks(sourceIds, MAX_MERGE_MEMBERS_PER_STATEMENT).map((group) => db.prepare(
      `INSERT INTO source_merge_members (group_id, source_id, role, created_at)
       VALUES ${group.map(() => "(?, ?, ?, ?)").join(", ")}`,
    ).bind(...group.flatMap((sourceId) => [
      groupId,
      sourceId,
      sourceId === input.canonicalSourceId ? "CANONICAL" : "MEMBER",
      now,
    ]))),
    ...chunks(input.candidateIds, MAX_CANDIDATE_STATUS_IDS_PER_STATEMENT).map((group) => db.prepare(
      `UPDATE source_duplicate_candidates
       SET status = 'MERGED', merge_group_id = ?, resolved_at = ?
       WHERE id IN (${group.map(() => "?").join(", ")}) AND status = 'PENDING'`,
    ).bind(groupId, now, ...group)),
  ];
  await db.batch(statements);
}

async function applyAutomaticMerges(db: D1Database, pairs: StoredAssessedPair[], now: string): Promise<void> {
  const eligible = pairs.filter((pair) => pair.assessment.decision === "AUTO_MERGE" && pair.candidate.status === "PENDING");
  const components = new SourceComponents();
  for (const pair of eligible) components.union(pair.left.id, pair.right.id);

  for (const sourceIds of components.groups()) {
    const canonicalSourceId = await selectCanonicalSourceId(db, sourceIds);
    const componentPairs = eligible.filter((pair) => sourceIds.includes(pair.left.id) && sourceIds.includes(pair.right.id));
    await createAutomaticLogicalMerge(db, {
      canonicalSourceId,
      memberSourceIds: sourceIds.filter((id) => id !== canonicalSourceId),
      confidence: Math.min(...componentPairs.map((pair) => pair.assessment.confidence)),
      reasons: [...new Set(componentPairs.flatMap((pair) => pair.assessment.reasons))],
      candidateIds: componentPairs.map((pair) => pair.candidate.id),
    }, now);
  }
}

export async function runReservoirRefresh(db: D1Database, mode: ReservoirRefreshMode): Promise<ReservoirRefreshRun> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const priorCursor = await latestContinuationCursor(db, mode);
  await db.prepare(
    `INSERT INTO reservoir_refresh_runs
     (id, mode, status, created_at, updated_at, started_at)
     VALUES (?, ?, 'RUNNING', ?, ?, ?)`,
  ).bind(runId, mode, startedAt, startedAt, startedAt).run();

  try {
    const { sources, continuationCursor } = await scanSources(db, priorCursor);
    await storeFingerprints(db, sources, startedAt);
    const counts = { AUTO_MERGE: 0, REVIEW: 0, SEPARATE: 0 };
    const candidatePairs = uniqueSourcePairs(
      blockedSourcePairs(sources),
      await persistedFingerprintPairs(db, sources),
    );
    const assessedPairs = candidatePairs.map(([left, right]) => {
      const assessment = evaluateDuplicate(left, right);
      counts[assessment.decision] += 1;
      return { left, right, assessment };
    });
    const storedPairs = await storeCandidates(db, assessedPairs, startedAt);
    const completedAt = new Date().toISOString();
    if (mode === "APPLY") await applyAutomaticMerges(db, storedPairs, completedAt);
    await db.prepare(
      `UPDATE reservoir_refresh_runs
       SET status = 'COMPLETED', cursor_source_id = ?, scanned_count = ?, auto_merge_count = ?,
           review_count = ?, separate_count = ?, quality_issue_count = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    ).bind(
      continuationCursor,
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
    try {
      await createLogicalMerge(db, {
        canonicalSourceId,
        memberSourceIds: sourceIds.filter((id) => id !== canonicalSourceId),
        mode: "MANUAL",
        confidence: Number(row.score),
        reasons: JSON.parse(row.reasons_json) as string[],
      }, {
        candidateId,
        resolvedAt: now,
      });
    } catch (error) {
      const current = await db.prepare(
        "SELECT status FROM source_duplicate_candidates WHERE id = ?",
      ).bind(candidateId).first<{ status: DuplicateCandidateStatus }>();
      if (current && current.status !== "PENDING") {
        throw new Error("duplicate_candidate_already_resolved");
      }
      throw error;
    }
  }
  return (await listDuplicateCandidates(db, action === "MERGE" ? "MERGED" : "SEPARATE"))
    .find((candidate) => candidate.id === candidateId) ?? null;
}
