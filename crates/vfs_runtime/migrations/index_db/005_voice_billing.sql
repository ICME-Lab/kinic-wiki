CREATE TABLE voice_rates (version INTEGER PRIMARY KEY, cycles_per_minute INTEGER NOT NULL, authority TEXT NOT NULL);
CREATE TABLE voice_policies (database_id TEXT NOT NULL, principal TEXT NOT NULL, enabled INTEGER NOT NULL, daily_budget_cycles INTEGER NOT NULL, PRIMARY KEY(database_id, principal));
CREATE TABLE voice_reservations (session_id TEXT PRIMARY KEY, database_id TEXT NOT NULL, principal TEXT NOT NULL, usage_day INTEGER NOT NULL, held_cycles INTEGER NOT NULL, charged_cycles INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, closed INTEGER NOT NULL, state_json TEXT NOT NULL);
CREATE INDEX voice_reservations_budget_idx ON voice_reservations(database_id, principal, usage_day);
CREATE INDEX voice_reservations_expiry_idx ON voice_reservations(closed, expires_at_ms);
ALTER TABLE database_cycle_ledger ADD COLUMN voice_session_id TEXT;
ALTER TABLE database_cycle_ledger ADD COLUMN voice_seconds INTEGER;
ALTER TABLE database_cycle_ledger ADD COLUMN voice_rate_version INTEGER;
