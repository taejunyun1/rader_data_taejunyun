ALTER TABLE sources ADD COLUMN excluded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_excluded_at ON sources(excluded_at);
