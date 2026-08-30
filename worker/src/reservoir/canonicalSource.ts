const MAX_SOURCE_IDS_PER_QUERY = 90;

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function selectCanonicalSourceId(
  db: D1Database,
  sourceIds: string[],
): Promise<string> {
  const uniqueIds = [...new Set(sourceIds)];
  const candidates: Array<{
    id: string;
    signalCount: number;
    fullText: number;
    textLength: number;
    createdAt: string;
  }> = [];

  for (const group of chunks(uniqueIds, MAX_SOURCE_IDS_PER_QUERY)) {
    if (group.length === 0) continue;
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
      signalCount: number;
      fullText: number;
      textLength: number;
      createdAt: string;
    }>();
    candidates.push(...(rows.results ?? []));
  }

  candidates.sort((left, right) =>
    Number(right.signalCount) - Number(left.signalCount) ||
    Number(right.fullText) - Number(left.fullText) ||
    Number(right.textLength) - Number(left.textLength) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id));

  const canonical = candidates[0];
  if (!canonical) throw new Error("canonical_source_not_found");
  return canonical.id;
}
