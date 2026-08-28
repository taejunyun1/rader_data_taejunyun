export type LogicalMergeMode = "AUTO" | "REVIEW" | "MANUAL";

export interface LogicalMergeInput {
  canonicalSourceId: string;
  memberSourceIds: string[];
  mode: LogicalMergeMode;
  confidence: number;
  reasons: string[];
}

const MAX_SOURCE_IDS_PER_QUERY = 90;

function uniqueSourceIds(input: LogicalMergeInput): string[] {
  return [...new Set([input.canonicalSourceId, ...input.memberSourceIds])];
}

function sourceIdChunks(sourceIds: string[]): string[][] {
  const result: string[][] = [];
  for (let index = 0; index < sourceIds.length; index += MAX_SOURCE_IDS_PER_QUERY) {
    result.push(sourceIds.slice(index, index + MAX_SOURCE_IDS_PER_QUERY));
  }
  return result;
}

export async function createLogicalMerge(db: D1Database, input: LogicalMergeInput): Promise<string> {
  const sourceIds = uniqueSourceIds(input);
  if (sourceIds.length < 2) throw new Error("A logical merge requires at least two distinct sources");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("Merge confidence must be between 0 and 1");
  }

  let existingSourceCount = 0;
  for (const group of sourceIdChunks(sourceIds)) {
    const placeholders = group.map(() => "?").join(", ");
    const existingSources = await db.prepare(
      `SELECT COUNT(*) AS count FROM sources WHERE id IN (${placeholders})`,
    ).bind(...group).first<{ count: number }>();
    existingSourceCount += Number(existingSources?.count ?? 0);
  }
  if (existingSourceCount !== sourceIds.length) {
    throw new Error("Every logical merge member must reference an existing source");
  }

  for (const group of sourceIdChunks(sourceIds)) {
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
  const createdAt = new Date().toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO source_merge_groups
       (id, canonical_source_id, mode, confidence, reasons_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      groupId,
      input.canonicalSourceId,
      input.mode,
      input.confidence,
      JSON.stringify(input.reasons),
      createdAt,
    ),
    ...sourceIds.map((sourceId) => db.prepare(
      `INSERT INTO source_merge_members (group_id, source_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(
      groupId,
      sourceId,
      sourceId === input.canonicalSourceId ? "CANONICAL" : "MEMBER",
      createdAt,
    )),
  ]);
  return groupId;
}

export async function resolveCanonicalSourceId(db: D1Database, sourceId: string): Promise<string> {
  const row = await db.prepare(
    `SELECT g.canonical_source_id
     FROM source_merge_members m
     JOIN source_merge_groups g ON g.id = m.group_id
     WHERE m.source_id = ? AND g.reversed_at IS NULL
     ORDER BY g.created_at DESC
     LIMIT 1`,
  ).bind(sourceId).first<{ canonical_source_id: string }>();
  return row?.canonical_source_id ?? sourceId;
}

export async function reverseLogicalMerge(db: D1Database, groupId: string): Promise<void> {
  await db.prepare(
    "UPDATE source_merge_groups SET reversed_at = ? WHERE id = ? AND reversed_at IS NULL",
  ).bind(new Date().toISOString(), groupId).run();
}
