CREATE TABLE owner_scope(slot INTEGER PRIMARY KEY CHECK(slot=1),owner BLOB NOT NULL);
CREATE TABLE settings(owner BLOB NOT NULL,key TEXT NOT NULL, value TEXT NOT NULL,PRIMARY KEY(owner,key));
CREATE TABLE vaults(owner BLOB NOT NULL,id BLOB NOT NULL CHECK(length(id)=16), operation BLOB NOT NULL CHECK(length(operation)=16), header TEXT NOT NULL,PRIMARY KEY(owner,id));
CREATE TABLE receipts(owner BLOB NOT NULL,operation BLOB NOT NULL, digest BLOB NOT NULL, result TEXT NOT NULL, expires INTEGER NOT NULL,PRIMARY KEY(owner,operation));
CREATE TABLE global_settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
CREATE TABLE key_flights(owner BLOB NOT NULL,token INTEGER NOT NULL,day INTEGER NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,created INTEGER NOT NULL,settled INTEGER,payment INTEGER NOT NULL DEFAULT 0,phase TEXT NOT NULL DEFAULT 'reserved',in_flight INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,token));
CREATE INDEX key_flights_day ON key_flights(day,settled);
CREATE TABLE operations(owner BLOB NOT NULL,operation BLOB NOT NULL CHECK(length(operation)=16),digest BLOB NOT NULL CHECK(length(digest)=32),result BLOB,expires INTEGER NOT NULL,token INTEGER NOT NULL,runtime INTEGER NOT NULL,cleanup INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,operation));
CREATE INDEX operations_expiry ON operations(expires,owner);
