-- A source deletion makes materialized Radar narratives stale. Keep the
-- historical snapshot for auditability, but mark it so the live Radar does
-- not present it as current research direction.
ALTER TABLE radar_snapshots ADD COLUMN invalidated_at TEXT;
