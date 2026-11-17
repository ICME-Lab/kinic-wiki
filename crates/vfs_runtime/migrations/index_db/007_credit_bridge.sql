CREATE TABLE credit_bridge_settings (id INTEGER PRIMARY KEY CHECK(id=1), record TEXT NOT NULL CHECK(length(record)<=4096));
CREATE TABLE credit_bridge_links (wiki_owner TEXT PRIMARY KEY, vault_owner TEXT NOT NULL UNIQUE, record TEXT NOT NULL CHECK(length(record)<=4096));
CREATE TABLE credit_bridge_fences (vault_owner TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>=0));
CREATE TABLE credit_bridge_owners (wiki_owner TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=0), expires_at_ns INTEGER CHECK(expires_at_ns IS NULL OR expires_at_ns>=0));
CREATE TABLE credit_bridge_transfers (
 operation TEXT PRIMARY KEY, database_id TEXT NOT NULL, payer TEXT NOT NULL,
 unresolved INTEGER NOT NULL CHECK(unresolved IN (0,1)), refund_reserve INTEGER NOT NULL CHECK(refund_reserve>=0),
 record TEXT NOT NULL CHECK(length(record)<=8192)
);
CREATE UNIQUE INDEX credit_bridge_pending_database ON credit_bridge_transfers(database_id) WHERE unresolved=1;
CREATE UNIQUE INDEX credit_bridge_pending_payer ON credit_bridge_transfers(payer) WHERE unresolved=1;
