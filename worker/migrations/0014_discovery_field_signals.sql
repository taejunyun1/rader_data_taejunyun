ALTER TABLE discovery_candidates ADD COLUMN source_id TEXT;

CREATE INDEX IF NOT EXISTS idx_discovery_candidate_source
  ON discovery_candidates(source_id, status, relevance_score DESC);

CREATE TABLE IF NOT EXISTS discovery_field_signals (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'CONFERENCE', 'CALL_FOR_PAPERS', 'EXHIBITION', 'GRANT',
    'RESIDENCY', 'WORKSHOP', 'INSTITUTION_NEWS', 'OTHER'
  )),
  published_at TEXT,
  event_at TEXT,
  deadline_at TEXT,
  matched_terms_json TEXT NOT NULL DEFAULT '[]',
  relevance_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'SAVED', 'DISMISSED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_field_signal_url
  ON discovery_field_signals(external_url);

CREATE INDEX IF NOT EXISTS idx_discovery_field_signal_status
  ON discovery_field_signals(status, relevance_score DESC, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_field_signal_deadline
  ON discovery_field_signals(deadline_at, status);
