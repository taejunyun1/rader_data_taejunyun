CREATE TABLE visual_extraction_runs (
  id TEXT PRIMARY KEY,
  parent_source_id TEXT NOT NULL REFERENCES sources(id),
  parent_version_id TEXT NOT NULL REFERENCES source_versions(id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('PERSONAL_UPLOAD', 'PDF_PAGE_CROP', 'WEB_EMBED', 'DISCOVERY_EMBED')),
  status TEXT NOT NULL CHECK (status IN ('UPLOADING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  total_units INTEGER NOT NULL DEFAULT 0 CHECK (total_units >= 0),
  uploaded_units INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_units >= 0),
  processed_units INTEGER NOT NULL DEFAULT 0 CHECK (processed_units >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  filtered_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_count >= 0),
  unavailable_count INTEGER NOT NULL DEFAULT 0 CHECK (unavailable_count >= 0),
  error_code TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX idx_visual_extraction_runs_parent
  ON visual_extraction_runs(parent_source_id, created_at DESC);

CREATE UNIQUE INDEX idx_visual_extraction_runs_active_version
  ON visual_extraction_runs(parent_version_id, origin_kind)
  WHERE status IN ('UPLOADING', 'QUEUED', 'RUNNING');

CREATE TABLE visual_extraction_units (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES visual_extraction_runs(id),
  unit_number INTEGER NOT NULL CHECK (unit_number > 0),
  candidate_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('UPLOADED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DELETED')),
  temp_r2_key TEXT,
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  content_hash TEXT,
  error_code TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  deleted_at TEXT,
  UNIQUE (run_id, unit_number, candidate_key)
);

CREATE INDEX idx_visual_extraction_units_run
  ON visual_extraction_units(run_id, unit_number);

CREATE INDEX idx_visual_extraction_units_expired_temp
  ON visual_extraction_units(status, created_at)
  WHERE temp_r2_key IS NOT NULL
    AND deleted_at IS NULL
    AND status IN ('UPLOADED', 'FAILED');

ALTER TABLE visual_assets ADD COLUMN candidate_key TEXT;
ALTER TABLE visual_assets ADD COLUMN rights_basis TEXT;
ALTER TABLE visual_assets ADD COLUMN rights_reviewed_at TEXT;

CREATE UNIQUE INDEX idx_visual_assets_candidate_idempotency
  ON visual_assets(parent_version_id, origin_kind, candidate_key)
  WHERE candidate_key IS NOT NULL
    AND deleted_at IS NULL;

ALTER TABLE visual_analyses ADD COLUMN parent_analysis_id TEXT REFERENCES visual_analyses(id);
