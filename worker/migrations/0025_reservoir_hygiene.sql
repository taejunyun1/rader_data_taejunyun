-- Logical duplicate consolidation is reversible: source, version, R2, and provenance rows stay intact.
CREATE TABLE source_merge_groups (
  id TEXT PRIMARY KEY,
  canonical_source_id TEXT NOT NULL REFERENCES sources(id),
  mode TEXT NOT NULL CHECK (mode IN ('AUTO', 'REVIEW', 'MANUAL')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reasons_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reversed_at TEXT
);

CREATE TABLE source_merge_members (
  group_id TEXT NOT NULL REFERENCES source_merge_groups(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  role TEXT NOT NULL CHECK (role IN ('CANONICAL', 'MEMBER')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, source_id)
);

CREATE INDEX idx_source_merge_members_active
  ON source_merge_members(source_id, group_id);
CREATE INDEX idx_source_merge_groups_active
  ON source_merge_groups(canonical_source_id, created_at)
  WHERE reversed_at IS NULL;

CREATE TABLE source_duplicate_candidates (
  id TEXT PRIMARY KEY,
  left_source_id TEXT NOT NULL REFERENCES sources(id),
  right_source_id TEXT NOT NULL REFERENCES sources(id),
  decision TEXT NOT NULL CHECK (decision IN ('AUTO_MERGE', 'REVIEW', 'SEPARATE')),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  reasons_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'MERGED', 'SEPARATE')),
  merge_group_id TEXT REFERENCES source_merge_groups(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (left_source_id < right_source_id),
  UNIQUE (left_source_id, right_source_id)
);

CREATE INDEX idx_source_duplicate_candidates_status
  ON source_duplicate_candidates(status, created_at);

CREATE TABLE source_fingerprints (
  source_id TEXT NOT NULL REFERENCES sources(id),
  kind TEXT NOT NULL CHECK (kind IN ('DOI', 'CANONICAL_URL', 'RAW_HASH', 'NORMALIZED_TEXT_HASH', 'OBSIDIAN_ORIGIN')),
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, kind, value)
);

CREATE INDEX idx_source_fingerprints_kind_value
  ON source_fingerprints(kind, value, source_id);

CREATE TABLE reservoir_refresh_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('PREVIEW', 'APPLY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  cursor_source_id TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  auto_merge_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  separate_count INTEGER NOT NULL DEFAULT 0,
  quality_issue_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_reservoir_refresh_runs_status
  ON reservoir_refresh_runs(status, created_at);
