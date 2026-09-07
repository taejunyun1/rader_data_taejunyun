// Fixed research-data allowlist: runtime leases, credentials and pending jobs
// are not restoration inputs. Keep all columns, including provenance fields.
const TABLES = {
  sources: "sources", sourceVersions: "source_versions", sourceAnalysis: "source_analysis",
  keywords: "keywords", questions: "questions", fragments: "fragments", threads: "threads",
  threadLinks: "thread_links", directions: "directions", userSignals: "user_signals",
  radarSnapshots: "radar_snapshots", distillSessions: "distill_sessions",
  researchGaps: "research_gaps", readingQueue: "reading_queue",
  discoveryCandidates: "discovery_candidates", discoveryFieldSignals: "discovery_field_signals",
  sourceIdentityKeys: "source_identity_keys", sourceMergeGroups: "source_merge_groups",
  sourceMergeMembers: "source_merge_members", sourceDuplicateCandidates: "source_duplicate_candidates",
  sourceFingerprints: "source_fingerprints", sourceEmbeddings: "source_embeddings",
  visualAssets: "visual_assets", visualAssetVersions: "visual_asset_versions",
  visualAnalyses: "visual_analyses", visualRelations: "visual_relations", visualEmbeddings: "visual_embeddings",
} as const;

type ExportRow = Record<string, unknown>;
export type ResearchExport = {
  format: "research-radar-export"; version: 2; exportedAt: string;
} & Record<keyof typeof TABLES, ExportRow[]>;

export async function loadResearchExport(db: D1Database): Promise<ResearchExport> {
  // One D1 batch keeps relational metadata in one transaction.
  const entries = Object.entries(TABLES);
  const results = await db.batch(entries.map(([, table]) => db.prepare(`SELECT * FROM ${table}`)));
  return {
    format: "research-radar-export", version: 2, exportedAt: new Date().toISOString(),
    ...Object.fromEntries(entries.map(([key], index) => {
      const result = results[index];
      if (!result?.success) throw new Error(`export_query_failed:${key}`);
      return [key, result.results ?? []];
    })),
  } as ResearchExport;
}

interface BackupObject {
  sourceId?: string; visualAssetId?: string; versionId?: string;
  reference?: "preview";
  originalKey: string; backupKey: string; status: "pending" | "copied" | "missing";
  size?: number; etag?: string;
}

export async function backupResearchOriginals(env: Pick<Env, "DB" | "ORIGINALS" | "EXPORTS">) {
  const snapshot = await loadResearchExport(env.DB);
  const prefix = `exports/originals-${crypto.randomUUID()}/`;
  const objects: BackupObject[] = [];
  const seen = new Set<string>();
  const add = (row: ExportRow, owner: string, versionId?: string, visual = false, reference?: "preview") => {
    const key = row.r2_key;
    if (typeof key !== "string" || !key || seen.has(key)) return;
    seen.add(key);
    objects.push({
      ...(visual ? { visualAssetId: owner } : { sourceId: owner }), versionId, reference,
      originalKey: key, backupKey: `${prefix}${visual ? "visual/" : ""}${encodeURIComponent(owner)}/${encodeURIComponent(versionId ?? reference ?? "legacy")}`,
      status: "pending",
    });
  };
  for (const row of snapshot.sourceVersions) add(row, String(row.source_id), String(row.id));
  for (const row of snapshot.sources) {
    add(row, String(row.id));
    if (typeof row.metadata_json === "string") {
      let metadata: { previewKey?: unknown } | null = null;
      try { metadata = JSON.parse(row.metadata_json); } catch { /* Retain invalid metadata unchanged in the snapshot. */ }
      if (typeof metadata?.previewKey === "string") {
        add({ r2_key: metadata.previewKey }, String(row.id), undefined, false, "preview");
      }
    }
  }
  for (const row of snapshot.visualAssetVersions) {
    if (!row.deleted_at) add(row, String(row.visual_asset_id), String(row.id), true);
  }
  let copied = 0;
  let missing = 0;
  for (const entry of objects) {
    const object = await env.ORIGINALS.get(entry.originalKey);
    if (!object) { entry.status = "missing"; missing++; continue; }
    // Stream each object instead of buffering a complete PDF in Worker memory.
    await env.EXPORTS.put(entry.backupKey, object.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: { ...object.customMetadata, originalKey: entry.originalKey },
    });
    entry.status = "copied"; entry.size = object.size; entry.etag = object.etag;
    copied++;
  }
  const snapshotKey = `${prefix}research.json`;
  const manifestKey = `${prefix}manifest.json`;
  await env.EXPORTS.put(snapshotKey, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });
  await env.EXPORTS.put(manifestKey, JSON.stringify({
    format: "research-radar-originals", version: 2, exportedAt: snapshot.exportedAt,
    complete: missing === 0, snapshotKey, objects,
  }), { httpMetadata: { contentType: "application/json" } });
  return { ok: missing === 0, ...(missing ? { error: "backup_incomplete" } : {}), copied, total: objects.length, missing, prefix, manifestKey, snapshotKey };
}
