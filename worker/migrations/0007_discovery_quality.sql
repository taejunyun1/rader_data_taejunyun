ALTER TABLE discovery_candidates ADD COLUMN access_status TEXT NOT NULL DEFAULT 'UNKNOWN';
CREATE INDEX IF NOT EXISTS idx_discovery_access_status ON discovery_candidates(access_status);
