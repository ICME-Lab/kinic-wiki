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
