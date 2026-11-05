CREATE TABLE fs_evidence_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
INSERT INTO fs_evidence_settings VALUES(1,0);
CREATE TABLE fs_evidence_blobs (run_id TEXT NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,sha256));
CREATE TABLE fs_evidence_manifests (reference TEXT PRIMARY KEY, manifest_json TEXT NOT NULL);
CREATE TABLE fs_evidence_bindings (path TEXT NOT NULL, etag TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(path,etag,reference), FOREIGN KEY(reference) REFERENCES fs_evidence_manifests(reference));
