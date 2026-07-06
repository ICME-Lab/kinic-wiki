CREATE TABLE fs_nodes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    etag TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    parent_id INTEGER,
    name TEXT
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

CREATE TABLE fs_links (
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    raw_href TEXT NOT NULL,
    link_text TEXT NOT NULL,
    link_kind TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_path, target_path, raw_href)
);

CREATE INDEX fs_nodes_path_covering_idx
ON fs_nodes (path, kind, updated_at, etag);

CREATE INDEX fs_nodes_recent_covering_idx
ON fs_nodes (updated_at DESC, path ASC, kind, etag);

CREATE UNIQUE INDEX fs_nodes_parent_name_idx
ON fs_nodes (COALESCE(parent_id, 0), name);

CREATE INDEX fs_nodes_parent_idx
ON fs_nodes(parent_id);

CREATE INDEX fs_links_target_path_idx
ON fs_links (target_path, source_path);

CREATE INDEX fs_links_source_path_idx
ON fs_links (source_path, target_path);
