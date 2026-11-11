-- Each key row: two u32-length-prefixed byte strings and nine 8-byte scalars.
-- Protected legacy rows may shrink or settle unchanged; never erase them for admission.
CREATE TRIGGER IF NOT EXISTS key_pool_insert_size BEFORE INSERT ON key_flights
WHEN (80+length(NEW.owner)+length(CAST(NEW.phase AS BLOB)))>256 OR length(NEW.owner)>29 OR length(CAST(NEW.phase AS BLOB))>32
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
CREATE TRIGGER IF NOT EXISTS key_pool_update_size BEFORE UPDATE ON key_flights
WHEN ((80+length(NEW.owner)+length(CAST(NEW.phase AS BLOB)))>256 AND (length(NEW.owner)+length(CAST(NEW.phase AS BLOB)))>(length(OLD.owner)+length(CAST(OLD.phase AS BLOB))))
OR (length(NEW.owner)>29 AND length(NEW.owner)>length(OLD.owner))
OR (length(CAST(NEW.phase AS BLOB))>32 AND length(CAST(NEW.phase AS BLOB))>length(CAST(OLD.phase AS BLOB)))
BEGIN SELECT RAISE(ABORT,'key row capacity'); END;
CREATE TRIGGER IF NOT EXISTS key_pool_count BEFORE INSERT ON key_flights
WHEN NOT EXISTS(SELECT 1 FROM key_flights WHERE owner=NEW.owner AND token=NEW.token)
AND ((SELECT count(*) FROM key_flights)>=4096 OR (SELECT count(*) FROM key_flights WHERE owner=NEW.owner)>=512)
BEGIN SELECT RAISE(ABORT,'key row count capacity'); END;
