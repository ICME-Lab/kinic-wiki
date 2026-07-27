CREATE TABLE node_publications (
  public_id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  path TEXT NOT NULL,
  published_at_ms INTEGER NOT NULL,
  UNIQUE (database_id, path),
  FOREIGN KEY (database_id) REFERENCES databases(database_id)
);

CREATE INDEX node_publications_database_idx
  ON node_publications(database_id, path);
