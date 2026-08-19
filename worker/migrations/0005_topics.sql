-- topic tags on sources
ALTER TABLE sources ADD COLUMN topics TEXT;
CREATE INDEX IF NOT EXISTS idx_sources_topics ON sources(topics);
