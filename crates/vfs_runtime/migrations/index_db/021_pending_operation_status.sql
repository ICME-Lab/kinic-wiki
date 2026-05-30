ALTER TABLE database_credit_pending_operations
  ADD COLUMN operation_status TEXT NOT NULL DEFAULT 'ambiguous';
