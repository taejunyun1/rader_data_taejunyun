-- Preserve raw and normalized hash meanings independently and make source identity claims explicit.
ALTER TABLE source_versions ADD COLUMN raw_content_hash TEXT;
ALTER TABLE source_versions ADD COLUMN normalized_content_hash TEXT;

CREATE UNIQUE INDEX idx_source_versions_raw_hash
  ON source_versions(source_id, raw_content_hash)
  WHERE raw_content_hash IS NOT NULL;

CREATE INDEX idx_source_analysis_version
  ON source_analysis(version_id);

CREATE TABLE source_identity_keys (
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('DOI', 'CANONICAL_URL', 'TITLE_AUTHOR', 'RAW_HASH')),
  identity_value TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (identity_kind, identity_value)
);

INSERT OR IGNORE INTO source_identity_keys (identity_kind, identity_value, source_id, created_at)
SELECT 'DOI', lower(doi), id, created_at
FROM sources
WHERE doi IS NOT NULL AND trim(doi) <> '';

INSERT OR IGNORE INTO source_identity_keys (identity_kind, identity_value, source_id, created_at)
SELECT 'CANONICAL_URL', canonical_url, id, created_at
FROM sources
WHERE canonical_url IS NOT NULL AND trim(canonical_url) <> '';

-- source.file_hash has historically represented the raw ingest bytes. Only copy it to the
-- version row when the source has a single legacy version; normalized content_hash is not reused.
UPDATE source_versions
SET raw_content_hash = (
  SELECT s.file_hash
  FROM sources s
  WHERE s.id = source_versions.source_id
    AND s.file_hash IS NOT NULL
    AND source_versions.version = 1
)
WHERE version = 1 AND raw_content_hash IS NULL;

INSERT OR IGNORE INTO source_identity_keys (identity_kind, identity_value, source_id, created_at)
SELECT 'RAW_HASH', raw_content_hash, source_id, created_at
FROM source_versions
WHERE raw_content_hash IS NOT NULL;

-- Rebuild the legacy nullable version reference with an actual FK. The INSERT fails before
-- the old table is dropped if existing data contains an orphan version_id.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE source_analysis_with_version_fk (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  version_id TEXT REFERENCES source_versions(id),
  analysis_type TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'INTERPRETATION',
  model TEXT,
  prompt_version TEXT,
  payload_json TEXT NOT NULL,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
INSERT INTO source_analysis_with_version_fk
  (id, source_id, version_id, analysis_type, provenance, model, prompt_version, payload_json, cost_usd, created_at)
SELECT id, source_id, version_id, analysis_type, provenance, model, prompt_version, payload_json, cost_usd, created_at
FROM source_analysis;
DROP TABLE source_analysis;
ALTER TABLE source_analysis_with_version_fk RENAME TO source_analysis;
CREATE INDEX idx_analysis_source ON source_analysis(source_id);
CREATE INDEX idx_source_analysis_version ON source_analysis(version_id);
