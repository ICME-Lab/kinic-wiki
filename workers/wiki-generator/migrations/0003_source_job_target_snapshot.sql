ALTER TABLE source_jobs
ADD COLUMN generated_target_etag TEXT;

ALTER TABLE source_jobs
ADD COLUMN generated_target_observed INTEGER NOT NULL DEFAULT 0
CHECK (generated_target_observed IN (0, 1));
