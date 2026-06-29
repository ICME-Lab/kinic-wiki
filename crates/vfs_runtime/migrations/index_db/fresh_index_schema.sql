CREATE TABLE databases (
  database_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  db_file_name TEXT NOT NULL,
  mount_id INTEGER NOT NULL,
  active_mount_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  schema_version TEXT NOT NULL,
  logical_size_bytes INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms INTEGER,
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

CREATE TABLE database_mount_history (
  database_id TEXT NOT NULL,
  mount_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (mount_id)
);

CREATE TABLE source_capture_trigger_sessions (
  database_id TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  principal TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  refreshed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (database_id, session_nonce),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX source_capture_trigger_sessions_expiry_idx
  ON source_capture_trigger_sessions(expires_at_ms);

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
  ledger_block_index INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX database_cycle_pending_operations_database_idx
  ON database_cycle_pending_operations(database_id);

CREATE TABLE cycles_billing_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE storage_billing_state (
  key TEXT PRIMARY KEY,
  cursor_mount_id INTEGER,
  billing_now_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (key = 'timer')
);

CREATE TABLE market_listings (
  listing_id TEXT PRIMARY KEY,
  seller_principal TEXT NOT NULL,
  payout_principal TEXT NOT NULL,
  database_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  llm_summary TEXT,
  tags_json TEXT NOT NULL,
  price_e8s INTEGER NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  purchase_count INTEGER NOT NULL,
  report_count INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX market_listings_status_idx
  ON market_listings(status, listing_id);

CREATE INDEX market_listings_database_idx
  ON market_listings(database_id);

CREATE TABLE market_orders (
  order_id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  buyer_principal TEXT NOT NULL,
  seller_principal TEXT NOT NULL,
  payout_principal TEXT NOT NULL,
  price_e8s INTEGER NOT NULL,
  ledger_block_index INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX market_orders_buyer_idx
  ON market_orders(buyer_principal, order_id);

CREATE TABLE market_purchase_pending_operations (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  buyer_principal TEXT NOT NULL,
  seller_principal TEXT NOT NULL,
  price_e8s INTEGER NOT NULL,
  from_owner TEXT NOT NULL,
  from_subaccount BLOB,
  to_owner TEXT NOT NULL,
  to_subaccount BLOB,
  ledger_fee_e8s INTEGER NOT NULL,
  ledger_created_at_time_ns INTEGER NOT NULL,
  operation_status TEXT NOT NULL,
  ledger_block_index INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX market_purchase_pending_buyer_idx
  ON market_purchase_pending_operations(buyer_principal, listing_id);

CREATE TABLE market_entitlements (
  database_id TEXT NOT NULL,
  buyer_principal TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  purchased_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (database_id, buyer_principal, listing_id),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE UNIQUE INDEX market_entitlements_database_buyer_active_idx
  ON market_entitlements(database_id, buyer_principal)
  WHERE status = 'active';

CREATE INDEX market_entitlements_buyer_idx
  ON market_entitlements(buyer_principal, database_id);
