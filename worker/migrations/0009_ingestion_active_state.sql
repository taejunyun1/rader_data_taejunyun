-- Mark the pre-existing latest version as active after 0008 added review fields.
-- Existing sources remain UNREVIEWED until the normalization backfill is run.
UPDATE source_versions
SET review_status = 'ACTIVE'
WHERE id IN (SELECT active_version_id FROM sources WHERE active_version_id IS NOT NULL);
