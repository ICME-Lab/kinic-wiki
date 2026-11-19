CREATE INDEX upload_outcomes_global_expiry ON upload_outcomes(expires,owner);
CREATE INDEX uploads_global_expiry ON uploads(expires,owner);
CREATE INDEX revisions_global_retired ON revisions(retired,owner) WHERE retired IS NOT NULL;
