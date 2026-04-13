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

CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
    content,
    content='fs_nodes',
    content_rowid='id'
);

INSERT INTO fs_nodes_fts (rowid, content)
SELECT id, content
FROM fs_nodes;

CREATE TABLE fs_change_log (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    change_kind TEXT NOT NULL
        CHECK (change_kind IN ('upsert', 'path_removal'))
);

INSERT INTO fs_change_log (path, change_kind)
SELECT path, 'upsert'
FROM fs_nodes
ORDER BY path ASC;

CREATE INDEX fs_nodes_path_covering_idx
ON fs_nodes (path, kind, updated_at, etag);

CREATE INDEX fs_nodes_recent_covering_idx
ON fs_nodes (updated_at DESC, path ASC, kind, etag);
