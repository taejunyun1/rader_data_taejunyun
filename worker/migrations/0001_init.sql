-- Research Radar D1 schema v1 (DEV_PLAN Phase 1)
-- Sources / Reservoir core

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT,
  authors TEXT,
  year INTEGER,
  canonical_url TEXT,
  doi TEXT,
  file_hash TEXT,
  reliability TEXT NOT NULL DEFAULT 'DISCOVERY',
  provenance_class TEXT NOT NULL DEFAULT 'SOURCE',
  status TEXT NOT NULL DEFAULT 'received',
  origin TEXT,
  origins_json TEXT,
  r2_key TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_file_hash ON sources(file_hash);
CREATE INDEX IF NOT EXISTS idx_sources_canonical_url ON sources(canonical_url);
CREATE INDEX IF NOT EXISTS idx_sources_doi ON sources(doi);
CREATE INDEX IF NOT EXISTS idx_sources_title_norm ON sources(title_norm);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_created ON sources(created_at DESC);

CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  version INTEGER NOT NULL,
  r2_key TEXT,
  extracted_text TEXT,
  char_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_source ON source_versions(source_id);

CREATE TABLE IF NOT EXISTS source_analysis (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  version_id TEXT,
  analysis_type TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'INTERPRETATION',
  model TEXT,
  prompt_version TEXT,
  payload_json TEXT NOT NULL,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analysis_source ON source_analysis(source_id);

CREATE TABLE IF NOT EXISTS keywords (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  keyword TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_keywords_source ON keywords(source_id);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_source ON questions(source_id);

CREATE TABLE IF NOT EXISTS fragments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  text TEXT NOT NULL,
  context_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fragments_source ON fragments(source_id);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SEED',
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_links (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  keyword TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, source_id)
);

CREATE TABLE IF NOT EXISTS directions (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_signals (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id),
  action TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_source ON user_signals(source_id);
CREATE INDEX IF NOT EXISTS idx_signals_action ON user_signals(action);
CREATE INDEX IF NOT EXISTS idx_signals_created ON user_signals(created_at DESC);

CREATE TABLE IF NOT EXISTS radar_snapshots (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS distill_sessions (
  id TEXT PRIMARY KEY,
  input_context_json TEXT,
  sources_used_json TEXT,
  output_json TEXT,
  critic_output_json TEXT,
  counter_output_json TEXT,
  user_selection_json TEXT,
  redistill_of TEXT REFERENCES distill_sessions(id),
  model_version TEXT,
  prompt_version TEXT,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reading_queue (
  id TEXT PRIMARY KEY,
  distill_session_id TEXT REFERENCES distill_sessions(id),
  title TEXT NOT NULL,
  author TEXT,
  source_url TEXT,
  openalex_id TEXT,
  priority TEXT NOT NULL,
  why_read TEXT,
  related_question TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_gaps (
  id TEXT PRIMARY KEY,
  distill_session_id TEXT REFERENCES distill_sessions(id),
  gap_text TEXT NOT NULL,
  kind TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id TEXT PRIMARY KEY,
  openalex_id TEXT,
  title TEXT NOT NULL,
  authors TEXT,
  year INTEGER,
  abstract TEXT,
  relevance_score REAL,
  status TEXT NOT NULL DEFAULT 'CANDIDATE',
  query_used TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_status ON discovery_candidates(status);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  stage TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON processing_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON processing_jobs(source_id);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_month ON ai_usage(month);
