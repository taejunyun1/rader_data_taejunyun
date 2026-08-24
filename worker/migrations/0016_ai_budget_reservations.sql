CREATE TABLE ai_budget_reservations (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  research_job_id TEXT NOT NULL UNIQUE REFERENCES research_jobs(id),
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'RELEASED')),
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE INDEX idx_ai_budget_reservations_month_status
  ON ai_budget_reservations(month, status);
