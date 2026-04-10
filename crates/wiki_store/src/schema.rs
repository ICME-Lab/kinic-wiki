// Where: crates/wiki_store/src/schema.rs
// What: Versioned SQL-file migrations for the FS-first SQLite schema.
// Why: The repo now has one node-based schema, so migration history only tracks FS tables.
use rusqlite::{Connection, OptionalExtension, params};

const MIGRATIONS: &[(&str, &str)] = &[(
    "wiki_store:000_fs_schema",
    include_str!("../migrations/000_fs_schema.sql"),
)];
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL: &str =
    include_str!("../migrations/000_schema_migrations.sql");

pub fn run_fs_migrations(conn: &mut Connection) -> Result<(), String> {
    ensure_schema_migrations_table(conn)?;
    ensure_supported_schema_state(conn)?;

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
    tx.commit().map_err(|error| error.to_string())?;
    ensure_supported_schema_state(conn)
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

fn ensure_supported_schema_state(conn: &Connection) -> Result<(), String> {
    if !table_exists(conn, "fs_nodes")? {
        return Ok(());
    }

    if !fs_nodes_has_rowid_primary_key(conn)? {
        return Err(
            "legacy fs_nodes schema is not supported; rebuild the database with the current bootstrap schema"
                .to_string(),
        );
    }

    if !table_exists(conn, "fs_nodes_fts")? {
        return Err("fs_nodes_fts table is missing from the current bootstrap schema".to_string());
    }

    if !fs_nodes_fts_uses_external_content(conn)? {
        return Err(
            "legacy fs_nodes_fts schema is not supported; rebuild the database with the current bootstrap schema"
                .to_string(),
        );
    }

    Ok(())
}

fn fs_nodes_has_rowid_primary_key(conn: &Connection) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(fs_nodes)")
        .map_err(|error| error.to_string())?;
    let columns = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let id_column = columns
        .iter()
        .find(|(name, _, _)| name == "id")
        .map(|(_, ty, pk)| ty.eq_ignore_ascii_case("INTEGER") && *pk == 1)
        .unwrap_or(false);
    let path_column = columns.iter().any(|(name, _, _)| name == "path");

    Ok(id_column && path_column)
}

fn fs_nodes_fts_uses_external_content(conn: &Connection) -> Result<bool, String> {
    let sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fs_nodes_fts'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(sql
        .map(|value| value.contains("content='fs_nodes'") && value.contains("content_rowid='id'"))
        .unwrap_or(false))
}
