CREATE TABLE publication_mutation_recovery_batches (
  operation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_id TEXT NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(database_id) ON DELETE CASCADE
);

CREATE TABLE publication_mutation_recovery_items (
  operation_id INTEGER NOT NULL,
  public_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  path TEXT NOT NULL,
  published_at_ms INTEGER NOT NULL,
  PRIMARY KEY (operation_id, public_id),
  FOREIGN KEY (operation_id) REFERENCES publication_mutation_recovery_batches(operation_id) ON DELETE CASCADE
);

CREATE INDEX publication_mutation_recovery_database_idx
  ON publication_mutation_recovery_batches(database_id, operation_id);
