-- Derived from append-only learning_publication_commits. Rebuilds recreate it on demand.
CREATE TABLE IF NOT EXISTS archive_publication_refs (
    node_id INTEGER PRIMARY KEY CHECK (node_id > 0)
);
CREATE TABLE IF NOT EXISTS archive_publication_scan (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_receipt_rowid INTEGER NOT NULL
);
