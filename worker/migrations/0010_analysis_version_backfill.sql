-- Existing analyses were created before source version activation was tracked.
-- Associate them with the active version so the Inbox can report freshness.
UPDATE source_analysis
SET version_id = (
  SELECT active_version_id FROM sources WHERE sources.id = source_analysis.source_id
)
WHERE version_id IS NULL;
