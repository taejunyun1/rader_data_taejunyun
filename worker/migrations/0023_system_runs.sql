CREATE TABLE system_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  window_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL')),
  counts_json TEXT,
  result_json TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(kind, window_key)
);

CREATE INDEX idx_system_runs_recent ON system_runs(kind, started_at DESC);
