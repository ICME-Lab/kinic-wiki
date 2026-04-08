CREATE TABLE fs_nodes (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    etag TEXT NOT NULL,
    deleted_at INTEGER,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE VIRTUAL TABLE fs_nodes_fts USING fts5(
    path,
    kind,
    content
);

INSERT INTO fs_nodes_fts (path, kind, content)
SELECT path, kind, content
FROM fs_nodes
WHERE deleted_at IS NULL;
