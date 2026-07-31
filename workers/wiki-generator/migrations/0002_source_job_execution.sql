CREATE TABLE source_jobs_v2 (
  database_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'processing', 'generated', 'completed', 'failed')),
  target_path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  generated_target_path TEXT,
  generated_content TEXT,
  generated_context_paths TEXT,
  llm_duration_ms INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (database_id, source_path)
);

INSERT INTO source_jobs_v2 (
  database_id,
  source_path,
  source_etag,
  status,
  target_path,
  attempts,
  last_error,
  updated_at
)
SELECT
  database_id,
  source_path,
  source_etag,
  status,
  target_path,
  attempts,
  last_error,
  updated_at
FROM source_jobs;

DROP TABLE source_jobs;

ALTER TABLE source_jobs_v2 RENAME TO source_jobs;

CREATE INDEX source_jobs_status_idx
ON source_jobs (status, updated_at);
