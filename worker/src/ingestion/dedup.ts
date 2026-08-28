import { firstAuthor, normalizeDoi, normalizeUrl, titleNorm } from "./normalize";

export interface DedupInput {
  doi?: string | null;
  canonicalUrl?: string | null;
  title?: string | null;
  authors?: string | null;
  fileHash?: string | null;
}

export interface DedupMatch {
  sourceId: string;
  field: "doi" | "canonical_url" | "title_author" | "file_hash";
}

async function findIdentity(db: D1Database, kind: string, value: string): Promise<DedupMatch | null> {
  const row = await db
    .prepare("SELECT source_id FROM source_identity_keys WHERE identity_kind = ? AND identity_value = ? LIMIT 1")
    .bind(kind, value)
    .first<{ source_id: string }>();
  if (!row?.source_id) return null;
  const field = kind === "DOI" ? "doi" : kind === "CANONICAL_URL" ? "canonical_url" : kind === "TITLE_AUTHOR" ? "title_author" : "file_hash";
  return { sourceId: row.source_id, field };
}

export async function findDuplicate(db: D1Database, input: DedupInput): Promise<DedupMatch | null> {
  if (input.doi) {
    const identity = await findIdentity(db, "DOI", normalizeDoi(input.doi));
    if (identity) return identity;
    const row = await db
      .prepare("SELECT id FROM sources WHERE doi = ? LIMIT 1")
      .bind(input.doi)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "doi" };
  }
  if (input.canonicalUrl) {
    const identity = await findIdentity(db, "CANONICAL_URL", normalizeUrl(input.canonicalUrl) ?? input.canonicalUrl);
    if (identity) return identity;
    const row = await db
      .prepare("SELECT id FROM sources WHERE canonical_url = ? LIMIT 1")
      .bind(input.canonicalUrl)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "canonical_url" };
  }
  const author = firstAuthor(input.authors);
  if (input.title && author) {
    const identity = await findIdentity(db, "TITLE_AUTHOR", `${titleNorm(input.title)}::${author}`);
    if (identity) return identity;
    const row = await db
      .prepare("SELECT id FROM sources WHERE title_norm = ? AND lower(authors) LIKE ? LIMIT 1")
      .bind(titleNorm(input.title), `%${author}%`)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "title_author" };
  }
  if (input.fileHash) {
    const identity = await findIdentity(db, "RAW_HASH", input.fileHash);
    if (identity) return identity;
    const version = await db
      .prepare("SELECT source_id FROM source_versions WHERE raw_content_hash = ? LIMIT 1")
      .bind(input.fileHash)
      .first<{ source_id: string }>();
    if (version?.source_id) return { sourceId: version.source_id, field: "file_hash" };
    const row = await db
      .prepare("SELECT id FROM sources WHERE file_hash = ? LIMIT 1")
      .bind(input.fileHash)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "file_hash" };
  }
  return null;
}
