// Where: crates/vfs_store/src/schema.rs
// What: Versioned SQL-file migrations for the FS-first SQLite schema.
// Why: The repo now has one node-based schema, so migration history only tracks FS tables.
use rusqlite::{Connection, OptionalExtension, params};

const CURRENT_SCHEMA_VERSION: &str = "wiki_store:000_fs_schema";
const MIGRATIONS: &[(&str, &str)] = &[(
    CURRENT_SCHEMA_VERSION,
    include_str!("../migrations/000_fs_schema.sql"),
)];
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL: &str =
    include_str!("../migrations/000_schema_migrations.sql");

pub fn run_fs_migrations(conn: &mut Connection) -> Result<(), String> {
    ensure_schema_migrations_table(conn)?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    reject_legacy_schema(&tx)?;
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

fn reject_legacy_schema(conn: &Connection) -> Result<(), String> {
    let versions = applied_versions(conn)?;
    if versions.is_empty() {
        if managed_table_exists(conn)? {
            return Err("legacy wiki_store schema is unsupported; recreate database".to_string());
        }
        return Ok(());
    }
    if versions.len() == 1 && versions[0] == CURRENT_SCHEMA_VERSION {
        return Ok(());
    }
    Err(format!(
        "legacy wiki_store schema is unsupported; recreate database: {}",
        versions.join(", ")
    ))
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

fn applied_versions(conn: &Connection) -> Result<Vec<String>, String> {
    conn.prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn managed_table_exists(conn: &Connection) -> Result<bool, String> {
    for table in [
        "fs_nodes",
        "fs_nodes_fts",
        "fs_change_log",
        "fs_path_state",
        "fs_snapshot_sessions",
        "fs_snapshot_session_paths",
    ] {
        if table_exists(conn, table)? {
            return Ok(true);
        }
    }
    Ok(false)
}
