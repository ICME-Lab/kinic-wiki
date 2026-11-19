-- Each key row: three u32-length-prefixed byte strings and nine 8-byte scalars.
-- Current schema enforces these value bounds on every write.
CREATE TRIGGER IF NOT EXISTS key_pool_insert_size BEFORE INSERT ON key_flights
WHEN (84+length(NEW.owner)+length(NEW.vault)+length(CAST(NEW.phase AS BLOB)))>256 OR length(NEW.owner)>29 OR length(CAST(NEW.phase AS BLOB))>32
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
CREATE TRIGGER IF NOT EXISTS key_pool_update_size BEFORE UPDATE ON key_flights
WHEN (84+length(NEW.owner)+length(NEW.vault)+length(CAST(NEW.phase AS BLOB)))>256 OR length(NEW.owner)>29 OR length(CAST(NEW.phase AS BLOB))>32
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
