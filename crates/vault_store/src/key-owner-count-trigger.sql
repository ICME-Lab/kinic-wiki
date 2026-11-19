CREATE TRIGGER IF NOT EXISTS key_pool_count BEFORE INSERT ON key_flights
WHEN NOT EXISTS(SELECT 1 FROM key_flights WHERE owner=NEW.owner AND token=NEW.token)
AND (SELECT count(*) FROM key_flights WHERE owner=NEW.owner)>=512
BEGIN SELECT RAISE(ABORT,'key row count capacity'); END;
