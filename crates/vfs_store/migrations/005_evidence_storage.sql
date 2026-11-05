CREATE TABLE fs_evidence_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
INSERT INTO fs_evidence_settings VALUES(1,0);
CREATE TABLE fs_evidence_blobs (run_id TEXT NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(run_id,sha256));
CREATE TABLE fs_evidence_manifests (reference TEXT PRIMARY KEY, manifest_json TEXT NOT NULL);
CREATE TABLE fs_evidence_bindings (path TEXT NOT NULL, etag TEXT NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(path,etag,reference), FOREIGN KEY(reference) REFERENCES fs_evidence_manifests(reference));
CREATE TABLE fs_search_metadata (node_row_id INTEGER PRIMARY KEY, title TEXT NOT NULL, shared INTEGER NOT NULL CHECK(shared IN (0,1)), summary TEXT NOT NULL);
CREATE VIEW fs_search_content AS SELECT n.id,n.path,n.kind,COALESCE(m.title,n.name,n.path) AS title,CASE WHEN m.shared=1 THEN m.summary ELSE n.content END AS content FROM fs_nodes n LEFT JOIN fs_search_metadata m ON m.node_row_id=n.id;
