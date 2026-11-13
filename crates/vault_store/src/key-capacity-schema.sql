-- Each key row: three u32-length-prefixed byte strings and nine 8-byte scalars.
-- Current schema enforces these value bounds on every write.
CREATE TRIGGER IF NOT EXISTS key_pool_insert_size BEFORE INSERT ON key_flights
WHEN (84+length(NEW.owner)+length(NEW.vault)+length(CAST(NEW.phase AS BLOB)))>256 OR length(NEW.owner)>29 OR length(CAST(NEW.phase AS BLOB))>32
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
CREATE TRIGGER IF NOT EXISTS key_pool_update_size BEFORE UPDATE ON key_flights
WHEN (84+length(NEW.owner)+length(NEW.vault)+length(CAST(NEW.phase AS BLOB)))>256 OR length(NEW.owner)>29 OR length(CAST(NEW.phase AS BLOB))>32
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
CREATE TRIGGER IF NOT EXISTS key_pool_count BEFORE INSERT ON key_flights
WHEN NOT EXISTS(SELECT 1 FROM key_flights WHERE owner=NEW.owner AND token=NEW.token)
AND ((SELECT count(*) FROM key_flights)>=4096 OR (SELECT count(*) FROM key_flights WHERE owner=NEW.owner)>=512)
BEGIN SELECT RAISE(ABORT,'key row count capacity'); END;
