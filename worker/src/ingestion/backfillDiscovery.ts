import type { TextScope } from "@radar/shared/ingestion";
import { enqueueResearchJob } from "../jobs/enqueue";
import { normalizeUrl } from "./normalize";

const MAX_DISCOVERY_BACKFILL = 10;

export interface DiscoveryBackfillSource {
  id: string;
  origin: string | null;
  textScope: TextScope;
  charCount: number;
}

interface DiscoveryBackfillRow extends DiscoveryBackfillSource {
  canonicalUrl: string | null;
}

export interface DiscoveryBackfillResult {
  selected: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export function selectDiscoveryBackfillSources(rows: DiscoveryBackfillSource[]): string[] {
  return rows
    .filter((row) => isRemoteBackfillOrigin(row.origin) && (row.textScope !== "FULLTEXT" || row.charCount < 1_000))
    .map((row) => row.id);
}

function isRemoteBackfillOrigin(origin: string | null): boolean {
  return origin?.startsWith("discovery:") === true || origin === "homepage-reading";
}

export async function backfillDiscoverySources(
  env: Env,
  requestedBy: string,
  limit = MAX_DISCOVERY_BACKFILL,
  enqueue: typeof enqueueResearchJob = enqueueResearchJob,
): Promise<DiscoveryBackfillResult> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || MAX_DISCOVERY_BACKFILL, 1), MAX_DISCOVERY_BACKFILL);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.origin, s.canonical_url AS canonicalUrl,
            COALESCE(v.text_scope, 'UNKNOWN') AS textScope,
            COALESCE(v.char_count, 0) AS charCount
     FROM sources s
     LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE (s.origin LIKE 'discovery:%' OR s.origin = 'homepage-reading')
       AND (COALESCE(v.text_scope, 'UNKNOWN') <> 'FULLTEXT' OR COALESCE(v.char_count, 0) < 1000)
     ORDER BY s.updated_at ASC, s.id ASC
     LIMIT ?`,
  ).bind(boundedLimit).all<DiscoveryBackfillRow>();

  const candidates = rows.results ?? [];
  const selectedIds = new Set(selectDiscoveryBackfillSources(candidates).slice(0, boundedLimit));
  const selectedRows = candidates.filter((row) => selectedIds.has(row.id)).slice(0, boundedLimit);
  const result: DiscoveryBackfillResult = { selected: selectedRows.length, enqueued: 0, skipped: 0, errors: 0 };

  for (const source of selectedRows) {
    const canonicalUrl = source.canonicalUrl ? normalizeUrl(source.canonicalUrl) : null;
    if (!canonicalUrl) {
      result.skipped++;
      continue;
    }

    try {
      const queued = await enqueue(env, {
        kind: "SOURCE_ACQUISITION",
        input: { sourceId: source.id, url: canonicalUrl },
      }, requestedBy);
      if (queued.reused) result.skipped++;
      else result.enqueued++;
    } catch (error) {
      result.errors++;
      console.warn(JSON.stringify({
        level: "warn",
        scope: "settings:backfill-discovery",
        sourceId: source.id,
        reason: error instanceof Error ? error.message : "enqueue_failed",
      }));
    }
  }

  return result;
}
