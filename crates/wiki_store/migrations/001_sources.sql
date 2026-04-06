CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    title TEXT,
    canonical_uri TEXT,
    sha256 TEXT NOT NULL UNIQUE,
    mime_type TEXT,
    imported_at INTEGER NOT NULL,
    metadata_json TEXT NOT NULL
);

CREATE TABLE source_bodies (
    source_id TEXT PRIMARY KEY,
    body_text TEXT NOT NULL
);

CREATE INDEX idx_sources_sha256 ON sources(sha256);
