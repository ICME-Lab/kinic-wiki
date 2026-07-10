CREATE TABLE iap_fulfillments (
  transaction_id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  purchaser_principal TEXT NOT NULL,
  app_account_token TEXT,
  product_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  cycles TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX iap_fulfillments_database_idx
  ON iap_fulfillments(database_id, updated_at_ms);

CREATE TABLE iap_purchase_intents (
  app_account_token TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  purchaser_principal TEXT NOT NULL,
  product_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  transaction_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX iap_purchase_intents_database_idx
  ON iap_purchase_intents(database_id, updated_at_ms);

CREATE TABLE app_store_notifications (
  notification_uuid TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  transaction_id TEXT,
  signed_payload TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL
);
