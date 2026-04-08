// Where: crates/wiki_store/src/schema.rs
// What: Versioned SQL-file migrations for the FS-first SQLite schema.
// Why: The repo now has one node-based schema, so migration history only tracks FS tables.
use rusqlite::{Connection, OptionalExtension, params};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "wiki_store:000_fs_nodes",
        include_str!("../migrations/005_fs_nodes.sql"),
    ),
    (
        "wiki_store:001_fs_snapshot_nodes",
        include_str!("../migrations/006_fs_snapshot_nodes.sql"),
    ),
];
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL: &str =
    include_str!("../migrations/000_schema_migrations.sql");

pub fn run_fs_migrations(conn: &mut Connection) -> Result<(), String> {
    ensure_schema_migrations_table(conn)?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for (version, sql) in MIGRATIONS {
        if migration_already_applied(&tx, version)? {
            continue;
        }
        tx.execute_batch(sql).map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            params![version],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn ensure_schema_migrations_table(conn: &Connection) -> Result<(), String> {
    if table_exists(conn, "schema_migrations")? {
        return Ok(());
    }
    conn.execute_batch(SCHEMA_MIGRATIONS_BOOTSTRAP_SQL)
        .map_err(|error| error.to_string())
}

fn migration_already_applied(conn: &Connection, version: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM schema_migrations WHERE version = ?1",
        params![version],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        params![table],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}
