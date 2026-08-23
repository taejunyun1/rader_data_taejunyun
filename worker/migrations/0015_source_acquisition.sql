ALTER TABLE source_versions ADD COLUMN text_scope TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE source_versions ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE source_versions ADD COLUMN extraction_error TEXT;
ALTER TABLE source_versions ADD COLUMN content_type TEXT;
ALTER TABLE source_versions ADD COLUMN final_url TEXT;
ALTER TABLE source_versions ADD COLUMN acquired_at TEXT;

UPDATE source_versions
SET text_scope = CASE
  WHEN char_count IS NULL OR char_count = 0 THEN 'EMPTY'
  WHEN source_id IN (SELECT id FROM sources WHERE origin LIKE 'discovery:%') AND char_count < 1000 THEN 'METADATA_ONLY'
  WHEN char_count < 1000 THEN 'PARTIAL'
  ELSE 'FULLTEXT'
END,
extraction_method = CASE
  WHEN source_id IN (SELECT id FROM sources WHERE origin LIKE 'discovery:%') THEN 'DISCOVERY_METADATA'
  ELSE 'LEGACY'
END;

CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY_RUN', 'DISTILL_RUN', 'RADAR_SYNTHESIS', 'DEEP_ANALYSIS', 'SOURCE_ACQUISITION')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  result_ref_json TEXT,
  error_code TEXT,
  error TEXT,
  retry_of TEXT REFERENCES research_jobs(id),
  requested_by TEXT,
  dedupe_key TEXT NOT NULL,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO research_jobs_new SELECT id, workflow_instance_id, kind, status, progress, message, input_json, result_json, result_ref_json, error_code, error, retry_of, requested_by, dedupe_key, dismissed_at, created_at, started_at, finished_at, updated_at FROM research_jobs;
DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX idx_research_jobs_recent ON research_jobs(created_at DESC);
CREATE INDEX idx_research_jobs_status ON research_jobs(status, updated_at DESC);
CREATE UNIQUE INDEX idx_research_jobs_active_dedupe ON research_jobs(dedupe_key) WHERE status IN ('QUEUED', 'RUNNING');
