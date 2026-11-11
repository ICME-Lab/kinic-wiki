CREATE INDEX receipts_global_expiry ON receipts(expires,owner);
CREATE INDEX uploads_global_expiry ON uploads(expires,owner);
CREATE INDEX vaults_global_expiry ON vaults(expires,owner) WHERE expires>0;
CREATE INDEX exports_global_expiry ON exports(expires,owner);
CREATE INDEX revisions_global_retired ON revisions(retired,owner) WHERE retired IS NOT NULL;
