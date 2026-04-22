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
    path,
    title,
    content
);

CREATE TABLE fs_change_log (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    change_kind TEXT NOT NULL
        CHECK (change_kind IN ('upsert', 'path_removal'))
);

CREATE TABLE fs_path_state (
    path TEXT PRIMARY KEY,
    last_change_revision INTEGER NOT NULL
);

CREATE TABLE fs_snapshot_sessions (
    session_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL,
    snapshot_revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE fs_snapshot_session_paths (
    session_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (session_id, ordinal),
    UNIQUE (session_id, path)
);

CREATE INDEX fs_nodes_path_covering_idx
ON fs_nodes (path, kind, updated_at, etag);

CREATE INDEX fs_nodes_recent_covering_idx
ON fs_nodes (updated_at DESC, path ASC, kind, etag);

CREATE INDEX fs_snapshot_sessions_expires_at_idx
ON fs_snapshot_sessions (expires_at);
