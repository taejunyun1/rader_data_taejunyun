-- Reconcile legacy active versions classified by 0015 with source-level quality.
-- Keep FULLTEXT/UNKNOWN rows untouched because they still require real normalization review.
UPDATE sources
SET quality_status = CASE
  WHEN active.text_scope = 'EMPTY' THEN 'EMPTY'
  WHEN active.text_scope IN ('PARTIAL', 'METADATA_ONLY') THEN 'REVIEW'
  ELSE sources.quality_status
END
FROM source_versions AS active
WHERE sources.active_version_id = active.id
  AND sources.quality_status = 'UNREVIEWED'
  AND active.text_scope IN ('EMPTY', 'PARTIAL', 'METADATA_ONLY');
