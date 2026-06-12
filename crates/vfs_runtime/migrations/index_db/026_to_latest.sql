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
