CREATE TABLE database_cycle_accounts (
  database_id TEXT PRIMARY KEY,
  balance_cycles INTEGER NOT NULL,
  suspended_at_ms INTEGER,
  storage_charged_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE TABLE database_cycle_ledger (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_cycles INTEGER NOT NULL,
  balance_after_cycles INTEGER NOT NULL,
  payment_amount_e8s INTEGER,
  caller TEXT NOT NULL,
  method TEXT,
  cycles_delta INTEGER,
  cycles_per_kinic INTEGER,
  ledger_block_index INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX database_cycle_ledger_database_idx
  ON database_cycle_ledger(database_id, entry_id);

CREATE TABLE database_cycle_pending_operations (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  caller TEXT NOT NULL,
  cycles INTEGER NOT NULL,
  payment_amount_e8s INTEGER NOT NULL,
  from_owner TEXT,
  from_subaccount BLOB,
  to_owner TEXT,
  to_subaccount BLOB,
  ledger_fee_e8s INTEGER,
  ledger_created_at_time_ns INTEGER,
  operation_status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX database_cycle_pending_operations_database_idx
  ON database_cycle_pending_operations(database_id);

CREATE TABLE cycles_billing_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO database_cycle_accounts
  (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
   created_at_ms, updated_at_ms)
  SELECT database_id, 0, 0, NULL, 0, 0 FROM databases;

UPDATE databases
  SET status = 'active'
  WHERE status = 'hot';

DELETE FROM database_cycle_pending_operations
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM database_cycle_ledger
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM database_cycle_accounts
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM database_members
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM database_restore_chunks
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM database_restore_sessions
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM url_ingest_trigger_sessions
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM ops_answer_sessions
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM source_run_sessions
  WHERE database_id IN (SELECT database_id FROM databases WHERE status = 'deleted');

DELETE FROM databases
  WHERE status = 'deleted';
