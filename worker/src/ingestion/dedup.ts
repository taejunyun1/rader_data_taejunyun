import { firstAuthor, titleNorm } from "./normalize";

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

export async function findDuplicate(db: D1Database, input: DedupInput): Promise<DedupMatch | null> {
  if (input.doi) {
    const row = await db
      .prepare("SELECT id FROM sources WHERE doi = ? LIMIT 1")
      .bind(input.doi)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "doi" };
  }
  if (input.canonicalUrl) {
    const row = await db
      .prepare("SELECT id FROM sources WHERE canonical_url = ? LIMIT 1")
      .bind(input.canonicalUrl)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "canonical_url" };
  }
  const author = firstAuthor(input.authors);
  if (input.title && author) {
    const row = await db
      .prepare("SELECT id FROM sources WHERE title_norm = ? AND lower(authors) LIKE ? LIMIT 1")
      .bind(titleNorm(input.title), `%${author}%`)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "title_author" };
  }
  if (input.fileHash) {
    const row = await db
      .prepare("SELECT id FROM sources WHERE file_hash = ? LIMIT 1")
      .bind(input.fileHash)
      .first<{ id: string }>();
    if (row) return { sourceId: row.id, field: "file_hash" };
  }
  return null;
}
