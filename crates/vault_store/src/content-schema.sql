CREATE TABLE revisions(owner BLOB NOT NULL,vault BLOB NOT NULL, object BLOB NOT NULL, revision INTEGER NOT NULL, born INTEGER NOT NULL, retired INTEGER, plain_size INTEGER NOT NULL, manifest BLOB NOT NULL, hashes TEXT NOT NULL, deleted INTEGER NOT NULL, charge INTEGER NOT NULL, PRIMARY KEY(owner,vault,object,revision));
CREATE INDEX revision_sequence ON revisions(owner,vault,born,retired);
CREATE TABLE objects(owner BLOB NOT NULL,vault BLOB NOT NULL, object BLOB NOT NULL, head INTEGER NOT NULL, PRIMARY KEY(owner,vault,object));
CREATE TABLE uploads(owner BLOB NOT NULL,id BLOB NOT NULL, vault BLOB NOT NULL, object BLOB NOT NULL, expected INTEGER NOT NULL, expires INTEGER NOT NULL, digest BLOB NOT NULL, request TEXT NOT NULL, reserved INTEGER NOT NULL,PRIMARY KEY(owner,id));
CREATE UNIQUE INDEX one_upload_per_vault ON uploads(owner,vault);
CREATE TABLE chunks(owner BLOB NOT NULL,upload BLOB NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(owner,upload,idx));
CREATE TABLE revision_chunks(owner BLOB NOT NULL,vault BLOB NOT NULL, object BLOB NOT NULL, revision INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(owner,vault,object,revision,idx));
CREATE TABLE exports(owner BLOB NOT NULL,id BLOB NOT NULL, vault BLOB NOT NULL, snapshot TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL,PRIMARY KEY(owner,id));
