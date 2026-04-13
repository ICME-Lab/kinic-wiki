// Where: crates/wiki_store/src/schema.rs
// What: Versioned SQL-file migrations for the FS-first SQLite schema.
// Why: The repo now has one node-based schema, so migration history only tracks FS tables.
use rusqlite::{Connection, OptionalExtension, params};

const MIGRATIONS: &[(&str, &str)] = &[
    (
        "wiki_store:000_fs_schema",
        include_str!("../migrations/000_fs_schema.sql"),
    ),
    (
        "wiki_store:001_fs_remove_tombstones",
        include_str!("../migrations/001_fs_remove_tombstones.sql"),
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
        if *version == "wiki_store:001_fs_remove_tombstones"
            && !table_has_column(&tx, "fs_nodes", "deleted_at")?
        {
            tx.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
                params![version],
            )
            .map_err(|error| error.to_string())?;
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

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let pragma = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&pragma).map_err(|error| error.to_string())?;
    let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let current = row.get::<_, String>(1).map_err(|error| error.to_string())?;
        if current == column {
            return Ok(true);
        }
    }
    Ok(false)
}
