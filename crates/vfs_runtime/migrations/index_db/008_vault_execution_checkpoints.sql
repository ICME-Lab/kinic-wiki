ALTER TABLE vault_cycle_reservations ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_cycle_reservations ADD COLUMN execution_checkpoint INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_cycle_reservations ADD COLUMN execution_billed INTEGER NOT NULL DEFAULT 0;
