-- semantic embeddings tracking + discovery provider columns
CREATE TABLE IF NOT EXISTS source_embeddings (
  source_id TEXT PRIMARY KEY REFERENCES sources(id),
  model TEXT NOT NULL,
  chunk_chars INTEGER,
  created_at TEXT NOT NULL
);
ALTER TABLE discovery_candidates ADD COLUMN provider TEXT NOT NULL DEFAULT 'openalex';
ALTER TABLE discovery_candidates ADD COLUMN external_url TEXT;
