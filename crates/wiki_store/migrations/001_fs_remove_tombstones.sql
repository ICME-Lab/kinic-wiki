ALTER TABLE fs_nodes RENAME TO fs_nodes_old;

CREATE TABLE fs_nodes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    etag TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO fs_nodes (id, path, kind, content, created_at, updated_at, etag, metadata_json)
SELECT id, path, kind, content, created_at, updated_at, etag, metadata_json
FROM fs_nodes_old
WHERE deleted_at IS NULL
ORDER BY id ASC;

DROP TABLE fs_nodes_old;

DROP TABLE fs_nodes_fts;
CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
    content,
    content='fs_nodes',
    content_rowid='id'
);
INSERT INTO fs_nodes_fts (rowid, content)
SELECT id, content
FROM fs_nodes;

ALTER TABLE fs_change_log RENAME TO fs_change_log_old;

CREATE TABLE fs_change_log (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    change_kind TEXT NOT NULL
        CHECK (change_kind IN ('upsert', 'path_removal'))
);

INSERT INTO fs_change_log (revision, path, change_kind)
SELECT revision,
       path,
       CASE
           WHEN change_kind = 'upsert' THEN 'upsert'
           ELSE 'path_removal'
       END
FROM fs_change_log_old
WHERE change_kind IN ('upsert', 'path_removal')
   OR change_kind = 'tombstone'
ORDER BY revision ASC;

DROP TABLE fs_change_log_old;

DROP INDEX IF EXISTS fs_nodes_visible_path_covering_idx;
DROP INDEX IF EXISTS fs_nodes_path_covering_idx;
DROP INDEX IF EXISTS fs_nodes_visible_recent_covering_idx;
DROP INDEX IF EXISTS fs_nodes_recent_covering_idx;

CREATE INDEX fs_nodes_path_covering_idx
ON fs_nodes (path, kind, updated_at, etag);

CREATE INDEX fs_nodes_recent_covering_idx
ON fs_nodes (updated_at DESC, path ASC, kind, etag);
