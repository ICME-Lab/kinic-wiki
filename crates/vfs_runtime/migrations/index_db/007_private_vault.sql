-- Private runtime state. Deliberately absent from public SQL's table allowlist.
CREATE TABLE internal_mounts(name TEXT PRIMARY KEY NOT NULL,mount_id INTEGER UNIQUE NOT NULL CHECK(mount_id BETWEEN 11 AND 32767));
CREATE TABLE vault_payers(owner TEXT PRIMARY KEY NOT NULL,database_id TEXT NOT NULL,storage_bytes INTEGER NOT NULL DEFAULT 0,storage_charged_at_ms INTEGER NOT NULL);
CREATE INDEX vault_payers_database ON vault_payers(database_id);
CREATE TABLE vault_cycle_reservations(owner TEXT NOT NULL,token TEXT NOT NULL,database_id TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,created_at_ms INTEGER NOT NULL,settled_at_ms INTEGER,in_flight INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(owner,token));
CREATE INDEX vault_reservations_database ON vault_cycle_reservations(database_id,settled_at_ms);
CREATE TABLE vault_storage_billing_state(slot INTEGER PRIMARY KEY CHECK(slot=1),cursor_owner TEXT NOT NULL,billing_now_ms INTEGER NOT NULL);
