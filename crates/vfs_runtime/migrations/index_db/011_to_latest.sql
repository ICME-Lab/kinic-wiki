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

CREATE TABLE kinic_accounts (
  principal TEXT PRIMARY KEY,
  balance_e8s INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE kinic_ledger (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_e8s INTEGER NOT NULL,
  balance_after_e8s INTEGER NOT NULL,
  counterparty TEXT,
  listing_id TEXT,
  order_id TEXT,
  external_block_index INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX kinic_ledger_principal_idx
  ON kinic_ledger(principal, entry_id);

CREATE UNIQUE INDEX kinic_ledger_external_block_idx
  ON kinic_ledger(external_block_index)
  WHERE external_block_index IS NOT NULL;

CREATE TABLE kinic_pending_operations (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  caller TEXT NOT NULL,
  amount_e8s INTEGER NOT NULL,
  from_owner TEXT,
  from_subaccount BLOB,
  to_owner TEXT,
  to_subaccount BLOB,
  ledger_fee_e8s INTEGER,
  operation_status TEXT NOT NULL,
  external_block_index INTEGER,
  ledger_created_at_time_ns INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX kinic_pending_operations_caller_idx
  ON kinic_pending_operations(caller, operation_id);

CREATE UNIQUE INDEX kinic_pending_operations_external_block_kind_idx
  ON kinic_pending_operations(external_block_index, kind)
  WHERE external_block_index IS NOT NULL;

CREATE TABLE market_listings (
  listing_id TEXT PRIMARY KEY,
  seller_principal TEXT NOT NULL,
  database_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  llm_summary TEXT,
  summary_snapshot_revision TEXT,
  sample_excerpts_json TEXT NOT NULL,
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
  price_e8s INTEGER NOT NULL,
  listing_revision INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX market_orders_buyer_idx
  ON market_orders(buyer_principal, order_id);

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
