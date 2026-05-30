ALTER TABLE database_credit_accounts
  RENAME COLUMN balance_credits TO balance_credit_units;

UPDATE database_credit_accounts
  SET balance_credit_units = balance_credit_units * 1000;

ALTER TABLE database_credit_ledger
  RENAME COLUMN amount_credits TO amount_credit_units;

ALTER TABLE database_credit_ledger
  RENAME COLUMN balance_after_credits TO balance_after_credit_units;

ALTER TABLE database_credit_ledger
  RENAME COLUMN credits_per_kinic TO credit_units_per_kinic;

UPDATE database_credit_ledger
  SET amount_credit_units = amount_credit_units * 1000,
      balance_after_credit_units = balance_after_credit_units * 1000,
      credit_units_per_kinic = credit_units_per_kinic * 1000
  WHERE credit_units_per_kinic IS NOT NULL;

UPDATE database_credit_ledger
  SET amount_credit_units = amount_credit_units * 1000,
      balance_after_credit_units = balance_after_credit_units * 1000
  WHERE credit_units_per_kinic IS NULL;

ALTER TABLE database_credit_pending_operations
  RENAME COLUMN credits TO credit_units;

UPDATE database_credit_pending_operations
  SET credit_units = credit_units * 1000;

UPDATE credits_config
  SET key = 'credit_units_per_kinic',
      value = CAST(CAST(value AS INTEGER) * 1000 AS TEXT)
  WHERE key = 'credits_per_kinic';

UPDATE credits_config
  SET key = 'min_update_credit_units',
      value = CAST(CAST(value AS INTEGER) * 1000 AS TEXT)
  WHERE key = 'min_update_credits';
