CREATE TABLE ai_call_attempts (
  id TEXT PRIMARY KEY,
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED','CALLED','SETTLED','FAILED','SETTLEMENT_PENDING')),
  reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
  actual_usd REAL CHECK (actual_usd IS NULL OR actual_usd >= 0),
  provider_request_id TEXT,
  error_code TEXT,
  response_text TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX idx_ai_call_attempts_job_status ON ai_call_attempts(research_job_id, status);
CREATE INDEX idx_ai_call_attempts_lease ON ai_call_attempts(status, updated_at);
