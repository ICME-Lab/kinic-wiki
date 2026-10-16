-- Baseline snapshots start at migration time. Earlier content is never inferred.
CREATE TABLE fs_node_identities (
    node_id INTEGER PRIMARY KEY AUTOINCREMENT,
    current_row_id INTEGER UNIQUE
);
CREATE TABLE fs_node_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    etag TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    deleted INTEGER NOT NULL CHECK (deleted IN (0, 1))
);
CREATE INDEX fs_node_revisions_identity ON fs_node_revisions(node_id, revision DESC);
CREATE TABLE learning_publication_commits (
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
);
INSERT INTO fs_node_identities(current_row_id) SELECT id FROM fs_nodes ORDER BY id;
INSERT INTO fs_node_revisions(node_id,path,kind,content,created_at,updated_at,etag,metadata_json,deleted)
SELECT i.node_id,n.path,n.kind,n.content,n.created_at,n.updated_at,n.etag,n.metadata_json,0
FROM fs_nodes n JOIN fs_node_identities i ON i.current_row_id=n.id ORDER BY n.id;
CREATE TRIGGER fs_node_revision_insert AFTER INSERT ON fs_nodes BEGIN
    INSERT INTO fs_node_identities(current_row_id) VALUES (NEW.id);
    INSERT INTO fs_node_revisions(node_id,path,kind,content,created_at,updated_at,etag,metadata_json,deleted)
    SELECT node_id,NEW.path,NEW.kind,NEW.content,NEW.created_at,NEW.updated_at,NEW.etag,NEW.metadata_json,0
    FROM fs_node_identities WHERE current_row_id=NEW.id;
END;
CREATE TRIGGER fs_node_revision_update AFTER UPDATE ON fs_nodes
WHEN OLD.path != NEW.path OR OLD.kind != NEW.kind OR OLD.content != NEW.content OR OLD.created_at != NEW.created_at OR OLD.updated_at != NEW.updated_at OR OLD.etag != NEW.etag OR OLD.metadata_json != NEW.metadata_json
BEGIN
    INSERT INTO fs_node_revisions(node_id,path,kind,content,created_at,updated_at,etag,metadata_json,deleted)
    SELECT node_id,NEW.path,NEW.kind,NEW.content,NEW.created_at,NEW.updated_at,NEW.etag,NEW.metadata_json,0
    FROM fs_node_identities WHERE current_row_id=NEW.id;
END;
CREATE TRIGGER fs_node_revision_delete AFTER DELETE ON fs_nodes BEGIN
    INSERT INTO fs_node_revisions(node_id,path,kind,content,created_at,updated_at,etag,metadata_json,deleted)
    SELECT node_id,OLD.path,OLD.kind,OLD.content,OLD.created_at,OLD.updated_at,OLD.etag,OLD.metadata_json,1
    FROM fs_node_identities WHERE current_row_id=OLD.id;
    UPDATE fs_node_identities SET current_row_id=NULL WHERE current_row_id=OLD.id;
END;
