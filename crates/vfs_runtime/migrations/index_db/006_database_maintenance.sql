CREATE TABLE database_maintenance (
 migration_id TEXT PRIMARY KEY,
 database_id TEXT NOT NULL,
 is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
 state_json TEXT NOT NULL,
 source_file TEXT NOT NULL,
 target_file TEXT NOT NULL,
 last_operation TEXT,
 last_request_hash TEXT
);
CREATE UNIQUE INDEX database_maintenance_current ON database_maintenance(database_id) WHERE is_current=1;
