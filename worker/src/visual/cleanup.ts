const DAY_MS = 24 * 60 * 60 * 1000;

interface CleanupRow {
  unitId: string;
  runId: string;
  sourceId: string;
  versionId: string;
  unitNumber: number;
  tempR2Key: string;
  runStatus: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface VisualCleanupResult {
  scanned: number;
  deleted: number;
  cleanupFailures: number;
  skippedActiveOrRecent: number;
}

export async function cleanupExpiredVisualExtractionTemps(
  env: Env,
  input: { now?: string } = {},
): Promise<VisualCleanupResult> {
  const now = input.now ?? new Date().toISOString();
  const cutoff = new Date(new Date(now).getTime() - DAY_MS).toISOString();
  const rows = await env.DB.prepare(
    `SELECT u.id AS unitId,
            u.run_id AS runId,
            r.parent_source_id AS sourceId,
            r.parent_version_id AS versionId,
            u.unit_number AS unitNumber,
            u.temp_r2_key AS tempR2Key,
            r.status AS runStatus,
            r.finished_at AS finishedAt,
            r.updated_at AS updatedAt
     FROM visual_extraction_units u
     JOIN visual_extraction_runs r ON r.id = u.run_id
     WHERE r.origin_kind = 'PDF_PAGE_CROP'
       AND u.temp_r2_key IS NOT NULL
       AND u.deleted_at IS NULL`
  ).all<CleanupRow>();

  const result: VisualCleanupResult = {
    scanned: rows.results?.length ?? 0,
    deleted: 0,
    cleanupFailures: 0,
    skippedActiveOrRecent: 0,
  };

  for (const row of rows.results ?? []) {
    const terminal = row.runStatus === "SUCCEEDED" || row.runStatus === "PARTIAL" || row.runStatus === "FAILED" || row.runStatus === "CANCELLED";
    const stale = Boolean(row.finishedAt && row.finishedAt <= cutoff);
    if (!terminal || !stale) {
      result.skippedActiveOrRecent += 1;
      continue;
    }

    try {
      await env.ORIGINALS.delete(row.tempR2Key);
      await env.DB.prepare(
        `UPDATE visual_extraction_units
         SET deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`
      ).bind(now, row.unitId).run();
      result.deleted += 1;
    } catch (error) {
      result.cleanupFailures += 1;
      console.error(JSON.stringify({
        level: "error",
        scope: "visual-cleanup",
        runId: row.runId,
        sourceId: row.sourceId,
        versionId: row.versionId,
        unit: row.unitNumber,
        stage: "temp-delete",
        errorCode: "visual_temp_cleanup_failed",
        counts: result,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return result;
}
