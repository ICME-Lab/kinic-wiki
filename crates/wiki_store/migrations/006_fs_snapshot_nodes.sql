CREATE TABLE fs_snapshots (
    snapshot_revision TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE fs_snapshot_nodes (
    snapshot_revision TEXT NOT NULL,
    path TEXT NOT NULL,
    etag TEXT NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (snapshot_revision, path)
);
