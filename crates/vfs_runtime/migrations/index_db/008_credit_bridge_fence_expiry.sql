ALTER TABLE credit_bridge_fences ADD COLUMN expires_at_ns INTEGER CHECK(expires_at_ns IS NULL OR expires_at_ns>=0);
