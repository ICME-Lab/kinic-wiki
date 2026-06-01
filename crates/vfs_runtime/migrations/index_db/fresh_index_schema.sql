CREATE TABLE databases (
  database_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  db_file_name TEXT NOT NULL,
  mount_id INTEGER NOT NULL,
  active_mount_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  schema_version TEXT NOT NULL,
  logical_size_bytes INTEGER NOT NULL DEFAULT 0,
  snapshot_hash BLOB,
  archived_at_ms INTEGER,
  deleted_at_ms INTEGER,
  restore_size_bytes INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX databases_active_mount_id_idx
  ON databases(active_mount_id)
  WHERE active_mount_id IS NOT NULL;

CREATE TABLE database_members (
  database_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (database_id, principal),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE TABLE database_restore_chunks (
  database_id TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL,
  end_bytes INTEGER NOT NULL,
  bytes BLOB,
  PRIMARY KEY (database_id, offset_bytes, end_bytes),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX database_restore_chunks_database_id_idx
  ON database_restore_chunks(database_id, offset_bytes);

CREATE TABLE database_mount_history (
  database_id TEXT NOT NULL,
  mount_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (mount_id)
);

CREATE TABLE url_ingest_trigger_sessions (
  database_id TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  principal TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (database_id, session_nonce),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX url_ingest_trigger_sessions_expiry_idx
  ON url_ingest_trigger_sessions(expires_at_ms);

CREATE TABLE ops_answer_sessions (
  database_id TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  principal TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (database_id, session_nonce),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX ops_answer_sessions_expiry_idx
  ON ops_answer_sessions(expires_at_ms);

CREATE TABLE source_run_sessions (
  database_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  principal TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (database_id, session_nonce),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX source_run_sessions_expiry_idx
  ON source_run_sessions(expires_at_ms);

CREATE TABLE database_restore_sessions (
  database_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  active_mount_id INTEGER,
  snapshot_hash BLOB,
  archived_at_ms INTEGER,
  deleted_at_ms INTEGER,
  restore_size_bytes INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE TABLE database_credit_accounts (
  database_id TEXT PRIMARY KEY,
  balance_credits INTEGER NOT NULL,
  suspended_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE TABLE database_credit_ledger (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_credits INTEGER NOT NULL,
  balance_after_credits INTEGER NOT NULL,
  payment_amount_e8s INTEGER,
  caller TEXT NOT NULL,
  method TEXT,
  cycles_delta INTEGER,
  credits_per_kinic INTEGER,
  ledger_block_index INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX database_credit_ledger_database_idx
  ON database_credit_ledger(database_id, entry_id);

CREATE TABLE database_credit_pending_operations (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  caller TEXT NOT NULL,
  credits INTEGER NOT NULL,
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

CREATE INDEX database_credit_pending_operations_database_idx
  ON database_credit_pending_operations(database_id);

CREATE TABLE credits_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
