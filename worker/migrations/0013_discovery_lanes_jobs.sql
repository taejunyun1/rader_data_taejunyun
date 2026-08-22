ALTER TABLE discovery_candidates
  ADD COLUMN discovery_lane TEXT NOT NULL DEFAULT 'ORIGINAL';

ALTER TABLE discovery_candidates
  ADD COLUMN query_source TEXT NOT NULL DEFAULT 'MOMENTUM';

CREATE INDEX IF NOT EXISTS idx_discovery_lane_status
  ON discovery_candidates(discovery_lane, status, relevance_score DESC);

CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'DISCOVERY_RUN', 'DISTILL_RUN', 'RADAR_SYNTHESIS', 'DEEP_ANALYSIS'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED'
  )),
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

CREATE INDEX IF NOT EXISTS idx_research_jobs_recent
  ON research_jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_jobs_status
  ON research_jobs(status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_research_jobs_active_dedupe
  ON research_jobs(dedupe_key)
  WHERE status IN ('QUEUED', 'RUNNING');
