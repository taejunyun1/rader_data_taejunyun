CREATE TABLE homepage_publications (
  id TEXT PRIMARY KEY,
  distill_session_id TEXT NOT NULL REFERENCES distill_sessions(id),
  status TEXT NOT NULL CHECK (status IN ('PUBLISHING','PUBLISHED','SUPERSEDED','WITHDRAWN','FAILED','PURGING','PURGED')),
  payload_json TEXT,
  content_hash TEXT NOT NULL,
  error_code TEXT,
  approved_by_sub TEXT,
  withdrawn_by_sub TEXT,
  pending_action TEXT CHECK (pending_action IS NULL OR pending_action IN ('PUBLISH','REPUBLISH','WITHDRAW')),
  pending_actor_sub TEXT,
  pending_event_at TEXT,
  lease_generation INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  first_published_at TEXT,
  last_published_at TEXT,
  superseded_at TEXT,
  withdrawn_at TEXT,
  purge_requested_publication_id TEXT REFERENCES homepage_publications(id),
  purge_requested_by_sub TEXT,
  purge_requested_at TEXT,
  purge_marker_at TEXT,
  purge_zero_verified_at TEXT,
  CHECK ((pending_action IS NULL AND pending_actor_sub IS NULL AND pending_event_at IS NULL) OR (pending_action IS NOT NULL AND pending_actor_sub IS NOT NULL AND pending_event_at IS NOT NULL)),
  CHECK ((purge_requested_publication_id IS NULL AND purge_requested_by_sub IS NULL AND purge_requested_at IS NULL) OR (purge_requested_publication_id IS NOT NULL AND purge_requested_by_sub IS NOT NULL AND purge_requested_at IS NOT NULL)),
  CHECK (status NOT IN ('PURGING','PURGED') OR (purge_requested_publication_id IS NOT NULL AND purge_requested_by_sub IS NOT NULL AND purge_requested_at IS NOT NULL)),
  CHECK (status NOT IN ('PURGING','PURGED') OR (pending_action IS NULL AND pending_actor_sub IS NULL AND pending_event_at IS NULL)),
  CHECK (status <> 'PURGED' OR (purge_marker_at IS NOT NULL AND purge_zero_verified_at IS NOT NULL AND payload_json IS NULL)),
  UNIQUE (distill_session_id, content_hash)
);

CREATE INDEX idx_homepage_publications_status ON homepage_publications(status, updated_at);
CREATE INDEX idx_homepage_publications_session ON homepage_publications(distill_session_id, created_at);

CREATE TABLE homepage_publication_events (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES homepage_publications(id),
  action TEXT NOT NULL CHECK (action IN ('PUBLISH','REPUBLISH','WITHDRAW','RECONCILE','HARD_PURGE')),
  actor_sub TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  error_code TEXT,
  UNIQUE (publication_id, action, occurred_at)
);

CREATE TRIGGER homepage_publication_events_no_update
BEFORE UPDATE ON homepage_publication_events
BEGIN SELECT RAISE(ABORT, 'homepage_publication_events_append_only'); END;

CREATE TRIGGER homepage_publication_events_no_delete
BEFORE DELETE ON homepage_publication_events
BEGIN SELECT RAISE(ABORT, 'homepage_publication_events_append_only'); END;

CREATE TRIGGER homepage_publications_purge_request_immutable
BEFORE UPDATE OF purge_requested_publication_id, purge_requested_by_sub, purge_requested_at ON homepage_publications
WHEN OLD.purge_requested_publication_id IS NOT NULL
 AND (NEW.purge_requested_publication_id IS NOT OLD.purge_requested_publication_id OR NEW.purge_requested_by_sub IS NOT OLD.purge_requested_by_sub OR NEW.purge_requested_at IS NOT OLD.purge_requested_at)
BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_request_immutable'); END;

CREATE TRIGGER homepage_publications_purge_marker_immutable
BEFORE UPDATE OF purge_marker_at ON homepage_publications
WHEN OLD.purge_marker_at IS NOT NULL AND NEW.purge_marker_at IS NOT OLD.purge_marker_at
BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_marker_immutable'); END;

CREATE TRIGGER homepage_publications_purge_state_terminal
BEFORE UPDATE OF status ON homepage_publications
WHEN (OLD.status = 'PURGING' AND NEW.status NOT IN ('PURGING','PURGED')) OR (OLD.status = 'PURGED' AND NEW.status <> 'PURGED')
BEGIN SELECT RAISE(ABORT, 'homepage_publication_purge_state_terminal'); END;

CREATE TABLE homepage_publication_lease (
  lock_name TEXT PRIMARY KEY CHECK (lock_name = 'homepage-current-research'),
  owner_token TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER,
  updated_at TEXT NOT NULL,
  CHECK ((owner_token IS NULL AND expires_at_ms IS NULL) OR (owner_token IS NOT NULL AND expires_at_ms IS NOT NULL))
);

INSERT INTO homepage_publication_lease(lock_name, owner_token, generation, expires_at_ms, updated_at)
VALUES ('homepage-current-research', NULL, 0, NULL, '1970-01-01T00:00:00.000Z');
