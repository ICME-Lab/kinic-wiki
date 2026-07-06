// Where: crates/vfs_store/src/schema.rs
// What: Fresh-only SQLite schema initialization for FS stores.
// Why: New canisters start clean, so old FS schema absorption and backfill paths are unsupported.
use crate::sqlite::{
    Connection, OptionalExtension, Transaction, execute_values, nullable_integer_value, params,
    text_value,
};

const CURRENT_SCHEMA_VERSION: &str = "vfs_store:001_initial";
const FRESH_FS_SCHEMA_SQL: &str = include_str!("../migrations/fresh_fs_schema.sql");
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL: &str =
    include_str!("../migrations/000_schema_migrations.sql");

#[cfg(not(target_arch = "wasm32"))]
pub fn run_fs_migrations(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    run_fs_migrations_in_tx(&tx)?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn run_fs_migrations_in_tx(tx: &Transaction<'_>) -> Result<(), String> {
    if !table_exists(tx, "schema_migrations")? {
        reject_existing_managed_tables(tx)?;
        create_fresh_schema(tx)?;
        seed_initial_store_roots(tx)?;
        record_schema_migration(tx, CURRENT_SCHEMA_VERSION)?;
        return Ok(());
    }

    validate_current_schema_marker(tx)?;
    validate_current_schema_shape(tx)
}

#[cfg(not(target_arch = "wasm32"))]
fn record_schema_migration(conn: &Transaction<'_>, version: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
        params![version],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn record_schema_migration(conn: &Transaction<'_>, version: &str) -> Result<(), String> {
    // Wasm migrations use deterministic metadata because canister code must not depend on host time.
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params![version],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn create_fresh_schema(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute_batch(SCHEMA_MIGRATIONS_BOOTSTRAP_SQL)
        .map_err(|error| error.to_string())?;
    conn.execute_batch(FRESH_FS_SCHEMA_SQL)
        .map_err(|error| error.to_string())
}

fn reject_existing_managed_tables(conn: &Connection) -> Result<(), String> {
    for table in managed_tables() {
        if table_exists(conn, table)? {
            return Err(format!(
                "unsupported vfs_store schema: {table} exists without schema_migrations; recreate database"
            ));
        }
    }
    Ok(())
}

fn validate_current_schema_marker(conn: &Connection) -> Result<(), String> {
    let versions = applied_versions(conn)?;
    if versions.len() == 1 && versions[0] == CURRENT_SCHEMA_VERSION {
        return Ok(());
    }
    Err(format!(
        "unsupported vfs_store schema version; recreate database: {}",
        versions.join(", ")
    ))
}

fn validate_current_schema_shape(conn: &Connection) -> Result<(), String> {
    for table in managed_tables() {
        if !table_exists(conn, table)? {
            return Err(format!(
                "unsupported vfs_store schema: missing table {table}"
            ));
        }
    }
    for index in [
        "fs_nodes_path_covering_idx",
        "fs_nodes_recent_covering_idx",
        "fs_nodes_parent_name_idx",
        "fs_nodes_parent_idx",
        "fs_links_target_path_idx",
        "fs_links_source_path_idx",
    ] {
        if !index_exists(conn, index)? {
            return Err(format!(
                "unsupported vfs_store schema: missing index {index}"
            ));
        }
    }
    for (table, columns) in [
        (
            "fs_nodes",
            &[
                "id",
                "path",
                "kind",
                "content",
                "created_at",
                "updated_at",
                "etag",
                "metadata_json",
                "parent_id",
                "name",
            ][..],
        ),
        ("fs_nodes_fts", &["path", "title", "content"][..]),
        ("fs_change_log", &["revision", "path", "change_kind"][..]),
        ("fs_path_state", &["path", "last_change_revision"][..]),
        (
            "fs_links",
            &[
                "source_path",
                "target_path",
                "raw_href",
                "link_text",
                "link_kind",
                "updated_at",
            ][..],
        ),
    ] {
        for column in columns {
            if !table_column_exists(conn, table, column)? {
                return Err(format!(
                    "unsupported vfs_store schema: missing column {table}.{column}"
                ));
            }
        }
    }
    validate_fts_shape(conn)
}

fn validate_fts_shape(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_xinfo(fs_nodes_fts)")
        .map_err(|error| error.to_string())?;
    let columns = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 1)?,
            crate::sqlite::row_get::<i64>(row, 6)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    let public_columns: Vec<String> = columns
        .into_iter()
        .filter_map(|(name, hidden)| if hidden == 0 { Some(name) } else { None })
        .collect();
    if public_columns == ["path", "title", "content"] {
        return Ok(());
    }
    Err("unsupported vfs_store schema: invalid fs_nodes_fts shape".to_string())
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        params![table],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn index_exists(conn: &Connection, index: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1 LIMIT 1",
        params![index],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn table_column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 1)
    })
    .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|name| name == column))
}

fn applied_versions(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 0)
    })
    .map_err(|error| error.to_string())
}

fn managed_tables() -> &'static [&'static str] {
    &[
        "fs_nodes",
        "fs_nodes_fts",
        "fs_change_log",
        "fs_path_state",
        "fs_links",
    ]
}

fn seed_initial_store_roots(conn: &Transaction<'_>) -> Result<(), String> {
    for path in [
        "/Memory",
        "/Knowledge",
        "/Skills",
        "/Sessions",
        "/Sources",
        "/Sources/sessions",
        "/Sources/skill-runs",
        "/Sources/source-capture-requests",
    ] {
        insert_initial_folder(conn, path)?;
    }
    Ok(())
}

fn insert_initial_folder(conn: &Transaction<'_>, path: &str) -> Result<(), String> {
    let (parent_path, name) = split_parent_and_name(path)?;
    let parent_id = parent_path
        .as_deref()
        .map(|parent| folder_id(conn, parent))
        .transpose()?;
    let etag = folder_etag(path);
    let values = vec![
        text_value(path),
        text_value(etag),
        nullable_integer_value(parent_id),
        text_value(name),
    ];
    execute_values(
        conn,
        "INSERT INTO fs_nodes
         (path, kind, content, created_at, updated_at, etag, metadata_json, parent_id, name)
         VALUES (?1, 'folder', '', 0, 0, ?2, '{}', ?3, ?4)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, 'upsert')",
        params![path],
    )
    .map_err(|error| error.to_string())?;
    let revision = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO fs_path_state (path, last_change_revision) VALUES (?1, ?2)",
        params![path, revision],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn folder_id(conn: &Transaction<'_>, path: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT id FROM fs_nodes WHERE path = ?1",
        params![path],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn split_parent_and_name(path: &str) -> Result<(Option<String>, String), String> {
    let Some((parent, name)) = path.rsplit_once('/') else {
        return Err(format!("invalid node path: {path}"));
    };
    if name.is_empty() {
        return Err(format!("invalid node path: {path}"));
    }
    let parent = if parent.is_empty() {
        None
    } else {
        Some(parent.to_string())
    };
    Ok((parent, name.to_string()))
}

fn folder_etag(path: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(b"\nfolder\n\n{}");
    format!("v4h:{:x}", hasher.finalize())
}
