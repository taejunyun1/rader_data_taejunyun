-- Received-material review, normalized text, and immutable active versions.
ALTER TABLE sources ADD COLUMN ingest_channel TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE sources ADD COLUMN input_format TEXT NOT NULL DEFAULT 'PLAIN_TEXT';
ALTER TABLE sources ADD COLUMN active_version_id TEXT;
ALTER TABLE sources ADD COLUMN quality_status TEXT NOT NULL DEFAULT 'UNREVIEWED';

ALTER TABLE source_versions ADD COLUMN content_hash TEXT;
ALTER TABLE source_versions ADD COLUMN normalized_text TEXT;
ALTER TABLE source_versions ADD COLUMN normalization_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE source_versions ADD COLUMN normalization_report_json TEXT;
ALTER TABLE source_versions ADD COLUMN version_origin TEXT NOT NULL DEFAULT 'INITIAL_INGEST';
ALTER TABLE source_versions ADD COLUMN parent_version_id TEXT;
ALTER TABLE source_versions ADD COLUMN review_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW';
ALTER TABLE source_versions ADD COLUMN reviewed_at TEXT;

UPDATE sources
SET ingest_channel = CASE
  WHEN origin LIKE 'obsidian:%' THEN 'OBSIDIAN'
  WHEN origin LIKE 'discovery:%' THEN 'DISCOVERY'
  WHEN origin LIKE 'homepage%' THEN 'HOMEPAGE'
  ELSE 'MANUAL'
END,
input_format = CASE
  WHEN origin LIKE 'obsidian:%' THEN 'OBSIDIAN_MARKDOWN'
  WHEN origin LIKE 'discovery:%' THEN 'DISCOVERY_LINK'
  WHEN origin LIKE 'homepage%' THEN 'HOMEPAGE_JSON'
  WHEN origin = 'upload:pdf' AND json_extract(COALESCE(metadata_json, '{}'), '$.scannedPdf') IN (1, 'true') THEN 'PDF_SCAN'
  WHEN origin = 'upload:pdf' THEN 'PDF_TEXT'
  WHEN origin = 'upload:md' THEN 'MARKDOWN'
  WHEN origin = 'url' THEN 'URL_HTML'
  ELSE 'PLAIN_TEXT'
END;

UPDATE sources
SET active_version_id = (
  SELECT v.id
  FROM source_versions v
  WHERE v.source_id = sources.id
  ORDER BY v.version DESC, v.created_at DESC
  LIMIT 1
)
WHERE active_version_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_source_version ON source_versions(source_id, version);
CREATE INDEX IF NOT EXISTS idx_versions_content_hash ON source_versions(source_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_sources_ingest_channel ON sources(ingest_channel);
CREATE INDEX IF NOT EXISTS idx_sources_input_format ON sources(input_format);
CREATE INDEX IF NOT EXISTS idx_sources_quality_status ON sources(quality_status);
CREATE INDEX IF NOT EXISTS idx_sources_active_version ON sources(active_version_id);
