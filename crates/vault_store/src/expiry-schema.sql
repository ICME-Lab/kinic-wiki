CREATE INDEX receipts_global_expiry ON receipts(expires,owner);
CREATE INDEX uploads_global_expiry ON uploads(expires,owner);
CREATE INDEX revisions_global_retired ON revisions(retired,owner) WHERE retired IS NOT NULL;
