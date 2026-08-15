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

CREATE TABLE publication_mutation_commits (
    operation_id INTEGER PRIMARY KEY
);

CREATE TABLE fs_history_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    current_node_id INTEGER UNIQUE,
    current_path TEXT,
    current_version_id INTEGER,
    deleted_at INTEGER,
    last_change_id INTEGER,
    last_item_id INTEGER
);

CREATE TABLE fs_history_blobs (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL
);

CREATE TABLE fs_history_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    blob_hash TEXT NOT NULL,
    git_blob_oid TEXT,
    path TEXT NOT NULL,
    etag TEXT NOT NULL,
    node_created_at INTEGER NOT NULL,
    node_updated_at INTEGER NOT NULL
);

CREATE TABLE fs_history_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_principal TEXT NOT NULL,
    operation TEXT NOT NULL,
    changed_at INTEGER NOT NULL,
    commit_oid TEXT
);

CREATE TABLE git_objects (
    oid TEXT PRIMARY KEY CHECK (length(oid) = 40 AND oid = lower(oid)),
    object_type TEXT NOT NULL CHECK (object_type IN ('blob', 'tree', 'commit')),
    size INTEGER NOT NULL CHECK (size >= 0),
    data BLOB NOT NULL,
    first_change_id INTEGER NOT NULL CHECK (first_change_id >= 0)
);

CREATE INDEX git_objects_snapshot_idx
ON git_objects (first_change_id, oid);

CREATE TABLE git_refs (
    name TEXT PRIMARY KEY,
    commit_oid TEXT NOT NULL,
    change_id INTEGER NOT NULL CHECK (change_id >= 0)
);

CREATE TABLE git_index_entries (
    path TEXT PRIMARY KEY,
    parent_path TEXT NOT NULL,
    name TEXT NOT NULL,
    mode INTEGER NOT NULL CHECK (mode IN (100644, 40000)),
    oid TEXT NOT NULL
);

CREATE INDEX git_index_entries_parent_idx
ON git_index_entries (parent_path, name);

CREATE TABLE fs_history_active_change (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    change_id INTEGER NOT NULL,
    changed_at INTEGER NOT NULL,
    forced_kind TEXT,
    restore_page_id INTEGER
);

CREATE TABLE fs_history_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id INTEGER NOT NULL,
    page_id INTEGER NOT NULL,
    change_kind TEXT NOT NULL
        CHECK (change_kind IN ('create', 'update', 'move', 'delete', 'restore')),
    before_version_id INTEGER,
    after_version_id INTEGER
);

CREATE INDEX fs_history_versions_page_idx
ON fs_history_versions (page_id, id DESC);

CREATE INDEX fs_history_items_page_idx
ON fs_history_items (page_id, id DESC);

CREATE INDEX fs_history_items_change_idx
ON fs_history_items (change_id, id ASC);

CREATE INDEX fs_history_pages_deleted_idx
ON fs_history_pages (last_item_id DESC)
WHERE deleted_at IS NOT NULL;

CREATE UNIQUE INDEX fs_history_pages_current_path_idx
ON fs_history_pages (current_path)
WHERE current_node_id IS NOT NULL;

CREATE TRIGGER fs_history_node_insert
AFTER INSERT ON fs_nodes
WHEN EXISTS (SELECT 1 FROM fs_history_active_change WHERE singleton = 1)
BEGIN
    UPDATE fs_history_pages
    SET current_node_id = NEW.id, current_path = NEW.path
    WHERE id = (SELECT restore_page_id FROM fs_history_active_change WHERE singleton = 1);
    UPDATE fs_history_pages
    SET current_node_id = NEW.id, current_path = NEW.path
    WHERE (SELECT restore_page_id FROM fs_history_active_change WHERE singleton = 1) IS NULL
      AND current_path = NEW.path
      AND current_node_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM fs_nodes WHERE id = fs_history_pages.current_node_id
      );
    INSERT INTO fs_history_pages (current_node_id, current_path)
    SELECT NEW.id, NEW.path
    WHERE (SELECT restore_page_id FROM fs_history_active_change WHERE singleton = 1) IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM fs_history_pages WHERE current_node_id = NEW.id
      );
    INSERT OR IGNORE INTO fs_history_blobs (hash, kind, content, metadata_json)
    VALUES (NEW.etag, NEW.kind, NEW.content, NEW.metadata_json);
    INSERT INTO fs_history_versions (page_id, blob_hash, path, etag, node_created_at, node_updated_at)
    SELECT id, NEW.etag, NEW.path, NEW.etag, NEW.created_at, NEW.updated_at
    FROM fs_history_pages WHERE current_node_id = NEW.id;
    INSERT INTO fs_history_items (change_id, page_id, change_kind, before_version_id, after_version_id)
    SELECT active.change_id, page.id, COALESCE(active.forced_kind, 'create'),
           CASE WHEN active.forced_kind = 'restore' THEN page.current_version_id ELSE NULL END,
           (SELECT MAX(id) FROM fs_history_versions WHERE page_id = page.id)
    FROM fs_history_active_change active, fs_history_pages page
    WHERE active.singleton = 1 AND page.current_node_id = NEW.id;
    UPDATE fs_history_pages
    SET current_path = NEW.path,
        current_version_id = (SELECT MAX(id) FROM fs_history_versions WHERE page_id = fs_history_pages.id),
        deleted_at = NULL,
        last_change_id = (SELECT change_id FROM fs_history_active_change WHERE singleton = 1),
        last_item_id = (SELECT MAX(id) FROM fs_history_items WHERE page_id = fs_history_pages.id)
    WHERE current_node_id = NEW.id;
END;

CREATE TRIGGER fs_history_node_update
AFTER UPDATE OF path, kind, content, created_at, updated_at, etag, metadata_json ON fs_nodes
WHEN EXISTS (SELECT 1 FROM fs_history_active_change WHERE singleton = 1)
BEGIN
    INSERT OR IGNORE INTO fs_history_blobs (hash, kind, content, metadata_json)
    SELECT OLD.etag, OLD.kind, OLD.content, OLD.metadata_json
    WHERE EXISTS (
        SELECT 1 FROM fs_history_pages
        WHERE current_node_id = OLD.id AND current_version_id IS NULL
    );
    INSERT INTO fs_history_versions (page_id, blob_hash, path, etag, node_created_at, node_updated_at)
    SELECT id, OLD.etag, OLD.path, OLD.etag, OLD.created_at, OLD.updated_at
    FROM fs_history_pages WHERE current_node_id = OLD.id AND current_version_id IS NULL;
    UPDATE fs_history_pages
    SET current_version_id = (SELECT MAX(id) FROM fs_history_versions WHERE page_id = fs_history_pages.id)
    WHERE current_node_id = OLD.id AND current_version_id IS NULL;
    INSERT OR IGNORE INTO fs_history_blobs (hash, kind, content, metadata_json)
    SELECT NEW.etag, NEW.kind, NEW.content, NEW.metadata_json
    WHERE OLD.path = NEW.path;
    INSERT INTO fs_history_versions (page_id, blob_hash, path, etag, node_created_at, node_updated_at)
    SELECT id,
           CASE WHEN OLD.path <> NEW.path THEN
               (SELECT blob_hash FROM fs_history_versions
                WHERE id = fs_history_pages.current_version_id)
           ELSE NEW.etag END,
           NEW.path, NEW.etag, NEW.created_at, NEW.updated_at
    FROM fs_history_pages WHERE current_node_id = NEW.id;
    INSERT INTO fs_history_items (change_id, page_id, change_kind, before_version_id, after_version_id)
    SELECT active.change_id, page.id,
           COALESCE(active.forced_kind, CASE WHEN OLD.path <> NEW.path THEN 'move' ELSE 'update' END),
           page.current_version_id,
           (SELECT MAX(id) FROM fs_history_versions WHERE page_id = page.id)
    FROM fs_history_active_change active, fs_history_pages page
    WHERE active.singleton = 1 AND page.current_node_id = NEW.id;
    UPDATE fs_history_pages
    SET current_path = NEW.path,
        current_version_id = (SELECT MAX(id) FROM fs_history_versions WHERE page_id = fs_history_pages.id),
        deleted_at = NULL,
        last_change_id = (SELECT change_id FROM fs_history_active_change WHERE singleton = 1),
        last_item_id = (SELECT MAX(id) FROM fs_history_items WHERE page_id = fs_history_pages.id)
    WHERE current_node_id = NEW.id;
END;

CREATE TRIGGER fs_history_node_delete
AFTER DELETE ON fs_nodes
WHEN EXISTS (SELECT 1 FROM fs_history_active_change WHERE singleton = 1)
BEGIN
    INSERT OR IGNORE INTO fs_history_blobs (hash, kind, content, metadata_json)
    VALUES (OLD.etag, OLD.kind, OLD.content, OLD.metadata_json);
    INSERT INTO fs_history_versions (page_id, blob_hash, path, etag, node_created_at, node_updated_at)
    SELECT id, OLD.etag, OLD.path, OLD.etag, OLD.created_at, OLD.updated_at
    FROM fs_history_pages WHERE current_node_id = OLD.id AND current_version_id IS NULL;
    UPDATE fs_history_pages
    SET current_version_id = (SELECT MAX(id) FROM fs_history_versions WHERE page_id = fs_history_pages.id)
    WHERE current_node_id = OLD.id AND current_version_id IS NULL;
    INSERT INTO fs_history_items (change_id, page_id, change_kind, before_version_id, after_version_id)
    SELECT active.change_id, page.id, COALESCE(active.forced_kind, 'delete'), page.current_version_id, NULL
    FROM fs_history_active_change active, fs_history_pages page
    WHERE active.singleton = 1 AND page.current_node_id = OLD.id;
    UPDATE fs_history_pages
    SET current_node_id = NULL,
        current_path = OLD.path,
        deleted_at = (SELECT changed_at FROM fs_history_active_change WHERE singleton = 1),
        last_change_id = (SELECT change_id FROM fs_history_active_change WHERE singleton = 1),
        last_item_id = (SELECT MAX(id) FROM fs_history_items WHERE page_id = fs_history_pages.id)
    WHERE current_node_id = OLD.id;
END;
