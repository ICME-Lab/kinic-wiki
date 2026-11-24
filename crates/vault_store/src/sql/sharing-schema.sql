CREATE UNIQUE INDEX vault_global_id ON vaults(id);
CREATE TABLE vault_members(owner BLOB NOT NULL, vault BLOB NOT NULL CHECK(length(vault)=16), member BLOB NOT NULL CHECK(length(member) BETWEEN 1 AND 29 AND member!=owner), role INTEGER NOT NULL CHECK(role IN (1,2)), PRIMARY KEY(owner,vault,member));
CREATE INDEX vault_member_access ON vault_members(member,vault);
CREATE TABLE shared_upload_handles(owner BLOB NOT NULL, vault BLOB NOT NULL CHECK(length(vault)=16), upload BLOB NOT NULL CHECK(length(upload)=16), caller BLOB NOT NULL CHECK(length(caller) BETWEEN 1 AND 29), wire BLOB NOT NULL CHECK(length(wire)=16), PRIMARY KEY(owner,vault));
CREATE TRIGGER shared_upload_cleanup AFTER DELETE ON uploads BEGIN DELETE FROM shared_upload_handles WHERE owner=OLD.owner AND vault=OLD.vault AND upload=OLD.id; END;
