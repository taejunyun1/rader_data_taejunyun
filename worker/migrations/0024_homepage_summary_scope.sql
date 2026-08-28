-- Homepage-reading payloads contain curated summaries, not acquired remote full text.
UPDATE source_versions
SET text_scope = 'METADATA_ONLY',
    extraction_method = 'DISCOVERY_METADATA'
WHERE version_origin = 'INITIAL_INGEST'
  AND parent_version_id IS NULL
  AND extraction_method = 'MANUAL_TEXT'
  AND source_id IN (
    SELECT id
    FROM sources
    WHERE origin = 'homepage-reading'
      AND input_format = 'HOMEPAGE_JSON'
  );

UPDATE sources
SET quality_status = 'REVIEW'
WHERE origin = 'homepage-reading'
  AND input_format = 'HOMEPAGE_JSON'
  AND active_version_id IN (
    SELECT v.id
    FROM source_versions v
    WHERE v.source_id = sources.id
      AND v.version_origin = 'INITIAL_INGEST'
      AND v.parent_version_id IS NULL
      AND v.text_scope = 'METADATA_ONLY'
      AND v.extraction_method = 'DISCOVERY_METADATA'
  );
