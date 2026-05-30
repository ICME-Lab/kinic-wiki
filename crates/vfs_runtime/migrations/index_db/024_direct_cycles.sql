ALTER TABLE database_credit_accounts
  RENAME TO database_cycle_accounts;

ALTER TABLE database_cycle_accounts
  RENAME COLUMN balance_credit_units TO balance_cycles;

UPDATE database_cycle_accounts
  SET balance_cycles = balance_cycles * 1000000;

ALTER TABLE database_credit_ledger
  RENAME TO database_cycle_ledger;

ALTER TABLE database_cycle_ledger
  RENAME COLUMN amount_credit_units TO amount_cycles;

ALTER TABLE database_cycle_ledger
  RENAME COLUMN balance_after_credit_units TO balance_after_cycles;

ALTER TABLE database_cycle_ledger
  RENAME COLUMN credit_units_per_kinic TO cycles_per_kinic;

UPDATE database_cycle_ledger
  SET amount_cycles = amount_cycles * 1000000,
      balance_after_cycles = balance_after_cycles * 1000000,
      cycles_per_kinic = cycles_per_kinic * 1000000
  WHERE cycles_per_kinic IS NOT NULL;

UPDATE database_cycle_ledger
  SET amount_cycles = amount_cycles * 1000000,
      balance_after_cycles = balance_after_cycles * 1000000
  WHERE cycles_per_kinic IS NULL;

UPDATE database_cycle_ledger
  SET kind = 'cycles_purchase'
  WHERE kind = 'credit_purchase';

UPDATE database_cycle_ledger
  SET kind = 'cycles_purchase_ambiguous'
  WHERE kind = 'credit_purchase_ambiguous';

UPDATE database_cycle_ledger
  SET kind = 'cycles_purchase_repair_complete'
  WHERE kind = 'credit_purchase_repair_complete';

UPDATE database_cycle_ledger
  SET kind = 'cycles_purchase_repair_cancelled'
  WHERE kind = 'credit_purchase_repair_cancelled';

DROP INDEX database_credit_ledger_database_idx;

CREATE INDEX database_cycle_ledger_database_idx
  ON database_cycle_ledger(database_id, entry_id);

ALTER TABLE database_credit_pending_operations
  RENAME TO database_cycle_pending_operations;

ALTER TABLE database_cycle_pending_operations
  RENAME COLUMN credit_units TO cycles;

UPDATE database_cycle_pending_operations
  SET cycles = cycles * 1000000;

UPDATE database_cycle_pending_operations
  SET kind = 'cycles_purchase'
  WHERE kind = 'credit_purchase';

DROP INDEX database_credit_pending_operations_database_idx;

CREATE INDEX database_cycle_pending_operations_database_idx
  ON database_cycle_pending_operations(database_id);

ALTER TABLE credits_config
  RENAME TO cycles_billing_config;

UPDATE cycles_billing_config
  SET key = 'cycles_per_kinic',
      value = CAST(CAST(value AS INTEGER) * 1000000 AS TEXT)
  WHERE key = 'credit_units_per_kinic';

UPDATE cycles_billing_config
  SET key = 'min_update_cycles',
      value = CAST(CAST(value AS INTEGER) * 1000000 AS TEXT)
  WHERE key = 'min_update_credit_units';
