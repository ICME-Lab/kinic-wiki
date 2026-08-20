CREATE TABLE nns_audit_cursors (
  database_id TEXT NOT NULL PRIMARY KEY,
  initial_proposal_id INTEGER NOT NULL,
  latest_proposal_id INTEGER NOT NULL,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE nns_proposal_jobs (
  database_id TEXT NOT NULL,
  proposal_id INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('discovered', 'queued', 'processing', 'generated', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  captured_input TEXT,
  generated_artifact TEXT,
  captured_at TEXT,
  action TEXT,
  topic TEXT,
  status_at_capture TEXT,
  review_depth TEXT
    CHECK (review_depth IS NULL OR review_depth IN ('basic', 'focused')),
  review_status TEXT
    CHECK (review_status IS NULL OR review_status IN ('ai_generated', 'skipped_not_open')),
  recommendation TEXT
    CHECK (recommendation IS NULL OR recommendation IN ('ADOPT', 'REJECT', 'NEEDS_CLARIFICATION', 'NOT_APPLICABLE')),
  source_path TEXT,
  reference_path TEXT,
  review_path TEXT,
  model TEXT,
  llm_duration_ms INTEGER,
  index_pending INTEGER NOT NULL DEFAULT 0
    CHECK (index_pending IN (0, 1)),
  index_enqueued_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (database_id, proposal_id)
);

CREATE INDEX nns_proposal_jobs_status_idx
ON nns_proposal_jobs (database_id, status, updated_at);

CREATE INDEX nns_proposal_jobs_completed_idx
ON nns_proposal_jobs (database_id, status, proposal_id DESC);
