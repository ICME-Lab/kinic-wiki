PRAGMA max_page_count=262144;
CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY NOT NULL,balance_cycles INTEGER NOT NULL CHECK(balance_cycles>=0),storage_bytes INTEGER NOT NULL DEFAULT 0,storage_charged_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vault_cycle_reservations(owner TEXT NOT NULL,token TEXT NOT NULL,account_owner TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,created_at_ms INTEGER NOT NULL,settled_at_ms INTEGER,in_flight INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,execution_checkpoint INTEGER NOT NULL DEFAULT 0,execution_billed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,token));
CREATE TABLE IF NOT EXISTS vault_storage_billing_state(slot INTEGER PRIMARY KEY CHECK(slot=1),cursor_owner TEXT NOT NULL,billing_now_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments(wallet TEXT NOT NULL,operation BLOB NOT NULL,record TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(wallet,operation));
CREATE INDEX IF NOT EXISTS payments_expiry ON payments(expires);
CREATE TABLE IF NOT EXISTS account_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,kind TEXT NOT NULL,amount_cycles INTEGER NOT NULL,balance_after INTEGER NOT NULL,at_ms INTEGER NOT NULL,operation BLOB);
CREATE INDEX IF NOT EXISTS account_ledger_owner ON account_ledger(owner,id);
