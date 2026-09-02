CREATE TABLE database_iap_cycle_grants (
  grant_id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  external_payment_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  purchaser_principal TEXT NOT NULL,
  amount_cycles INTEGER NOT NULL,
  balance_after_cycles INTEGER NOT NULL,
  caller TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(provider, external_payment_id)
);

CREATE INDEX database_iap_cycle_grants_database_idx
  ON database_iap_cycle_grants(database_id, grant_id);
