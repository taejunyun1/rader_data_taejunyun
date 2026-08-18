-- reading queue provenance verification
ALTER TABLE reading_queue ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_queue ADD COLUMN verified_at TEXT;
