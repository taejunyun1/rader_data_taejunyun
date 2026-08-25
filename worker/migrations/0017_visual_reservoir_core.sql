PRAGMA defer_foreign_keys = ON;

CREATE TABLE visual_assets (
  id TEXT PRIMARY KEY,
  parent_source_id TEXT REFERENCES sources(id),
  parent_version_id TEXT REFERENCES source_versions(id),
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('PERSONAL_UPLOAD', 'PDF_PAGE_CROP', 'WEB_EMBED', 'DISCOVERY_EMBED')),
  source_url TEXT,
  page_number INTEGER,
  figure_label TEXT,
  bbox_json TEXT,
  caption TEXT,
  nearby_text TEXT,
  asset_role TEXT NOT NULL DEFAULT 'PERSONAL_WORK' CHECK (asset_role IN ('PERSONAL_WORK', 'REFERENCE', 'DOCUMENTATION', 'UNKNOWN')),
  visual_kind TEXT NOT NULL DEFAULT 'OTHER' CHECK (visual_kind IN ('PHOTO', 'ARTWORK', 'INSTALLATION', 'GRAPHIC', 'DIAGRAM', 'DOCUMENT_SCAN', 'OTHER')),
  selection_status TEXT NOT NULL DEFAULT 'SELECTED' CHECK (selection_status IN ('SELECTED', 'REVIEW', 'DECORATIVE', 'DUPLICATE', 'UNAVAILABLE')),
  selection_reason TEXT,
  rights_status TEXT NOT NULL DEFAULT 'PERSONAL' CHECK (rights_status IN ('PERSONAL', 'PERMITTED', 'PUBLIC_LINK', 'UNKNOWN', 'RESTRICTED')),
  is_personal_work INTEGER NOT NULL DEFAULT 1 CHECK (is_personal_work IN (0, 1)),
  assignment_status TEXT NOT NULL DEFAULT 'UNASSIGNED' CHECK (assignment_status IN ('ASSIGNED', 'UNASSIGNED')),
  storage_state TEXT NOT NULL DEFAULT 'ARCHIVAL' CHECK (storage_state IN ('ARCHIVAL', 'CAPSULE', 'TEXT_ONLY', 'LINK_ONLY')),
  pending_storage_state TEXT CHECK (pending_storage_state IS NULL OR pending_storage_state IN ('CAPSULE', 'TEXT_ONLY')),
  processing_status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (processing_status IN ('UPLOADED', 'TRANSFORM_PENDING', 'TRANSFORMING', 'ANALYSIS_PENDING', 'ANALYZING', 'READY', 'FAILED')),
  last_error TEXT,
  content_hash TEXT,
  perceptual_hash TEXT,
  perceptual_hash_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (parent_source_id IS NOT NULL OR assignment_status = 'UNASSIGNED'),
  CHECK (origin_kind = 'PERSONAL_UPLOAD' OR parent_source_id IS NOT NULL),
  CHECK (is_personal_work = 1 OR rights_status <> 'PERSONAL')
);

CREATE INDEX idx_visual_assets_parent_source
  ON visual_assets(parent_source_id, selection_status, updated_at DESC);
CREATE INDEX idx_visual_assets_parent_version
  ON visual_assets(parent_version_id);
CREATE INDEX idx_visual_assets_content_hash
  ON visual_assets(content_hash);
CREATE INDEX idx_visual_assets_perceptual_hash
  ON visual_assets(perceptual_hash);
CREATE INDEX idx_visual_assets_processing
  ON visual_assets(processing_status, updated_at DESC);

CREATE TABLE visual_asset_versions (
  id TEXT PRIMARY KEY,
  visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
  version INTEGER NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('ORIGINAL', 'CAPSULE', 'SVG_SOURCE')),
  r2_key TEXT,
  mime_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_hash TEXT NOT NULL,
  transform_profile_json TEXT,
  parent_asset_version_id TEXT REFERENCES visual_asset_versions(id),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (visual_asset_id, version, variant)
);
CREATE INDEX idx_visual_asset_versions_asset
  ON visual_asset_versions(visual_asset_id, version DESC);

CREATE TABLE visual_analyses (
  id TEXT PRIMARY KEY,
  visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
  visual_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id),
  analysis_type TEXT NOT NULL CHECK (analysis_type IN ('AUTO_SUGGESTION', 'USER_VERIFIED')),
  provenance_class TEXT NOT NULL CHECK (provenance_class IN ('INTERPRETATION', 'ARTISTIC_PROPOSITION')),
  payload_json TEXT NOT NULL,
  model_id TEXT,
  prompt_version TEXT,
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'ACCEPTED', 'EDITED', 'DISMISSED')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX idx_visual_analyses_asset
  ON visual_analyses(visual_asset_id, created_at DESC);

CREATE TABLE visual_embeddings (
  id TEXT PRIMARY KEY,
  visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
  visual_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id),
  basis TEXT NOT NULL CHECK (basis IN ('ANALYSIS_TEXT')),
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0),
  vector_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (visual_asset_id, visual_version_id, basis, model_id)
);
CREATE INDEX idx_visual_embeddings_asset
  ON visual_embeddings(visual_asset_id, created_at DESC);

CREATE TABLE visual_relations (
  id TEXT PRIMARY KEY,
  from_visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
  to_visual_asset_id TEXT REFERENCES visual_assets(id),
  related_source_id TEXT REFERENCES sources(id),
  related_thread_id TEXT REFERENCES threads(id),
  relation_kind TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK (created_by IN ('SYSTEM', 'USER')),
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_visual_relations_from
  ON visual_relations(from_visual_asset_id, relation_kind);
CREATE INDEX idx_visual_relations_to
  ON visual_relations(to_visual_asset_id, relation_kind);

CREATE TABLE visual_asset_operations (
  id TEXT PRIMARY KEY,
  visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('DELETE_ORIGINAL', 'DELETE_CAPSULE')),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_visual_asset_operations_pending
  ON visual_asset_operations(status, created_at);

CREATE TABLE research_jobs_new (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY_RUN', 'DISTILL_RUN', 'RADAR_SYNTHESIS', 'DEEP_ANALYSIS', 'SOURCE_ACQUISITION', 'VISUAL_TRANSFORM', 'VISUAL_ANALYSIS', 'VISUAL_EXTRACTION')),
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  message TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  result_ref_json TEXT,
  error_code TEXT,
  error TEXT,
  retry_of TEXT REFERENCES research_jobs_new(id),
  requested_by TEXT,
  dedupe_key TEXT NOT NULL,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO research_jobs_new
SELECT id, workflow_instance_id, kind, status, progress, message, input_json, result_json, result_ref_json,
       error_code, error, retry_of, requested_by, dedupe_key, dismissed_at, created_at, started_at, finished_at,
       updated_at
FROM research_jobs;

DROP TABLE research_jobs;
ALTER TABLE research_jobs_new RENAME TO research_jobs;
CREATE INDEX idx_research_jobs_recent ON research_jobs(created_at DESC);
CREATE INDEX idx_research_jobs_status ON research_jobs(status, updated_at DESC);
CREATE UNIQUE INDEX idx_research_jobs_active_dedupe ON research_jobs(dedupe_key) WHERE status IN ('QUEUED', 'RUNNING');
