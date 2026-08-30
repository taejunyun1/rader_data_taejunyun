-- Serialize permanent source deletion across D1 and R2.
-- A claim row is operational lock metadata only; it contains no source content or R2 keys.
CREATE TABLE source_deletion_claims (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('R2_PENDING', 'R2_COMPLETE')),
  lease_expires_at TEXT NOT NULL,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_source_deletion_claims_lease
  ON source_deletion_claims(lease_expires_at);

CREATE INDEX idx_source_deletion_claims_error
  ON source_deletion_claims(last_error_code, updated_at);

-- Keep the storage boundary safe for callers that do not pass through the central
-- enqueue/writer helpers. Deletion uses DELETE statements, so these guards do not
-- interfere with the final purge batch.
CREATE TRIGGER source_deletion_claim_guard_sources_update
BEFORE UPDATE ON sources
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_versions_insert
BEFORE INSERT ON source_versions
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_versions_update
BEFORE UPDATE ON source_versions
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_analysis_insert
BEFORE INSERT ON source_analysis
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_analysis_update
BEFORE UPDATE ON source_analysis
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_keywords_insert
BEFORE INSERT ON keywords
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_keywords_update
BEFORE UPDATE ON keywords
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_questions_insert
BEFORE INSERT ON questions
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_questions_update
BEFORE UPDATE ON questions
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_fragments_insert
BEFORE INSERT ON fragments
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_fragments_update
BEFORE UPDATE ON fragments
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_thread_links_insert
BEFORE INSERT ON thread_links
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_thread_links_update
BEFORE UPDATE ON thread_links
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_signals_insert
BEFORE INSERT ON user_signals
WHEN NEW.source_id IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_signals_update
BEFORE UPDATE ON user_signals
WHEN OLD.source_id IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_identity_keys_insert
BEFORE INSERT ON source_identity_keys
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_identity_keys_update
BEFORE UPDATE ON source_identity_keys
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_fingerprints_insert
BEFORE INSERT ON source_fingerprints
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_fingerprints_update
BEFORE UPDATE ON source_fingerprints
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_processing_jobs_insert
BEFORE INSERT ON processing_jobs
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_processing_jobs_update
BEFORE UPDATE ON processing_jobs
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim WHERE claim.source_id = OLD.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_assets_insert
BEFORE INSERT ON visual_assets
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.parent_source_id
     OR claim.source_id IN (
       SELECT version.source_id FROM source_versions version WHERE version.id = NEW.parent_version_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_assets_update
BEFORE UPDATE ON visual_assets
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = OLD.parent_source_id
     OR claim.source_id IN (
       SELECT version.source_id FROM source_versions version WHERE version.id = OLD.parent_version_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_asset_versions_insert
BEFORE INSERT ON visual_asset_versions
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = NEW.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_asset_versions_update
BEFORE UPDATE ON visual_asset_versions
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = OLD.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_analyses_insert
BEFORE INSERT ON visual_analyses
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = NEW.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_analyses_update
BEFORE UPDATE ON visual_analyses
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = OLD.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_embeddings_insert
BEFORE INSERT ON visual_embeddings
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = NEW.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_embeddings_update
BEFORE UPDATE ON visual_embeddings
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = OLD.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_relations_insert
BEFORE INSERT ON visual_relations
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  LEFT JOIN visual_assets source_asset ON source_asset.id = NEW.from_visual_asset_id
  LEFT JOIN source_versions source_version ON source_version.id = source_asset.parent_version_id
  LEFT JOIN visual_assets target_asset ON target_asset.id = NEW.to_visual_asset_id
  LEFT JOIN source_versions target_version ON target_version.id = target_asset.parent_version_id
  WHERE claim.source_id = NEW.related_source_id
     OR claim.source_id = source_asset.parent_source_id
     OR claim.source_id = source_version.source_id
     OR claim.source_id = target_asset.parent_source_id
     OR claim.source_id = target_version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_relations_update
BEFORE UPDATE ON visual_relations
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  LEFT JOIN visual_assets source_asset ON source_asset.id = OLD.from_visual_asset_id
  LEFT JOIN source_versions source_version ON source_version.id = source_asset.parent_version_id
  LEFT JOIN visual_assets target_asset ON target_asset.id = OLD.to_visual_asset_id
  LEFT JOIN source_versions target_version ON target_version.id = target_asset.parent_version_id
  WHERE claim.source_id = OLD.related_source_id
     OR claim.source_id = source_asset.parent_source_id
     OR claim.source_id = source_version.source_id
     OR claim.source_id = target_asset.parent_source_id
     OR claim.source_id = target_version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_operations_insert
BEFORE INSERT ON visual_asset_operations
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = NEW.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_visual_operations_update
BEFORE UPDATE ON visual_asset_operations
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_assets asset ON asset.id = OLD.visual_asset_id
  LEFT JOIN source_versions version ON version.id = asset.parent_version_id
  WHERE claim.source_id = asset.parent_source_id OR claim.source_id = version.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_extraction_runs_insert
BEFORE INSERT ON visual_extraction_runs
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.parent_source_id
     OR claim.source_id IN (
       SELECT version.source_id FROM source_versions version WHERE version.id = NEW.parent_version_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_extraction_runs_update
BEFORE UPDATE ON visual_extraction_runs
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = OLD.parent_source_id
     OR claim.source_id IN (
       SELECT version.source_id FROM source_versions version WHERE version.id = OLD.parent_version_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_extraction_units_insert
BEFORE INSERT ON visual_extraction_units
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_extraction_runs run ON run.id = NEW.run_id
  WHERE claim.source_id = run.parent_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_extraction_units_update
BEFORE UPDATE ON visual_extraction_units
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN visual_extraction_runs run ON run.id = OLD.run_id
  WHERE claim.source_id = run.parent_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_research_jobs_insert
BEFORE INSERT ON research_jobs
WHEN json_valid(NEW.input_json)
 AND EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = CASE
          WHEN json_type(NEW.input_json, '$.sourceId') = 'text'
          THEN json_extract(NEW.input_json, '$.sourceId')
        END
     OR claim.source_id IN (
       SELECT version.source_id
       FROM source_versions version
       WHERE version.id IN (
         CASE WHEN json_type(NEW.input_json, '$.sourceVersionId') = 'text'
              THEN json_extract(NEW.input_json, '$.sourceVersionId') END,
         CASE WHEN json_type(NEW.input_json, '$.versionId') = 'text'
              THEN json_extract(NEW.input_json, '$.versionId') END
       )
     )
     OR claim.source_id IN (
       SELECT COALESCE(asset.parent_source_id, version.source_id)
       FROM visual_assets asset
       LEFT JOIN source_versions version ON version.id = asset.parent_version_id
       WHERE asset.id = CASE
         WHEN json_type(NEW.input_json, '$.visualAssetId') = 'text'
         THEN json_extract(NEW.input_json, '$.visualAssetId')
       END
     )
     OR claim.source_id IN (
       SELECT run.parent_source_id
       FROM visual_extraction_runs run
       WHERE run.id = CASE
         WHEN json_type(NEW.input_json, '$.extractionRunId') = 'text'
         THEN json_extract(NEW.input_json, '$.extractionRunId')
       END
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_research_jobs_update
BEFORE UPDATE OF input_json, status ON research_jobs
WHEN json_valid(NEW.input_json)
 AND (
   NEW.input_json <> OLD.input_json
   OR NEW.status IN ('QUEUED', 'RUNNING')
 )
 AND EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  WHERE claim.source_id = CASE
          WHEN json_type(NEW.input_json, '$.sourceId') = 'text'
          THEN json_extract(NEW.input_json, '$.sourceId')
        END
     OR claim.source_id IN (
       SELECT version.source_id
       FROM source_versions version
       WHERE version.id IN (
         CASE WHEN json_type(NEW.input_json, '$.sourceVersionId') = 'text'
              THEN json_extract(NEW.input_json, '$.sourceVersionId') END,
         CASE WHEN json_type(NEW.input_json, '$.versionId') = 'text'
              THEN json_extract(NEW.input_json, '$.versionId') END
       )
     )
     OR claim.source_id IN (
       SELECT COALESCE(asset.parent_source_id, version.source_id)
       FROM visual_assets asset
       LEFT JOIN source_versions version ON version.id = asset.parent_version_id
       WHERE asset.id = CASE
         WHEN json_type(NEW.input_json, '$.visualAssetId') = 'text'
         THEN json_extract(NEW.input_json, '$.visualAssetId')
       END
     )
     OR claim.source_id IN (
       SELECT run.parent_source_id
       FROM visual_extraction_runs run
       WHERE run.id = CASE
         WHEN json_type(NEW.input_json, '$.extractionRunId') = 'text'
         THEN json_extract(NEW.input_json, '$.extractionRunId')
       END
     )
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

-- Merge metadata is another source-owned write surface. INSERTs and updates
-- that assign the claimed source back into a group are rejected while the
-- source is being purged. The final deletion batch only deletes merge rows or
-- reassigns a claimed canonical to an unclaimed survivor, so it remains
-- allowed; its fingerprint guard still rejects any unrelated merge rewrite.
CREATE TRIGGER source_deletion_claim_guard_merge_groups_insert
BEFORE INSERT ON source_merge_groups
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.canonical_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_merge_groups_update
BEFORE UPDATE ON source_merge_groups
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.canonical_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_merge_group_metadata_update
BEFORE UPDATE ON source_merge_groups
WHEN EXISTS (
  SELECT 1
  FROM source_deletion_claims claim
  JOIN source_merge_members member ON member.source_id = claim.source_id
  WHERE member.group_id = OLD.id
)
AND (
  NEW.reversed_at IS NOT OLD.reversed_at
  OR NEW.mode IS NOT OLD.mode
  OR NEW.confidence IS NOT OLD.confidence
  OR NEW.reasons_json IS NOT OLD.reasons_json
  OR NEW.canonical_source_id IS OLD.canonical_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_merge_members_insert
BEFORE INSERT ON source_merge_members
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_merge_members_update
BEFORE UPDATE ON source_merge_members
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id = OLD.source_id OR claim.source_id = NEW.source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_duplicate_candidates_insert
BEFORE INSERT ON source_duplicate_candidates
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id = NEW.left_source_id OR claim.source_id = NEW.right_source_id
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;

CREATE TRIGGER source_deletion_claim_guard_duplicate_candidates_update
BEFORE UPDATE ON source_duplicate_candidates
WHEN EXISTS (
  SELECT 1 FROM source_deletion_claims claim
  WHERE claim.source_id IN (OLD.left_source_id, OLD.right_source_id, NEW.left_source_id, NEW.right_source_id)
)
BEGIN
  SELECT RAISE(ABORT, 'source_deletion_in_progress');
END;
