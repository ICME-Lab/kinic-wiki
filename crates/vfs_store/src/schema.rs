// Where: crates/vfs_store/src/schema.rs
// What: Versioned SQL-file migrations for the FS-first SQLite schema.
// Why: The repo now has one node-based schema, so migration history only tracks FS tables.
use crate::sqlite::{Connection, OptionalExtension, Transaction, params};

use crate::fs_links::backfill_node_links;

// Keep the persisted version token stable so existing local databases do not
// require a forced migration just because the crate naming moved from wiki_* to vfs_*.
const CURRENT_SCHEMA_VERSION: &str = "wiki_store:005_seed_raw_sources_root";
const INITIAL_FS_SCHEMA_SQL: &str = include_str!("../migrations/000_fs_schema.sql");
const MIGRATIONS: &[(&str, &str)] = &[
    ("wiki_store:000_fs_schema", INITIAL_FS_SCHEMA_SQL),
    (
        "wiki_store:001_fs_links",
        include_str!("../migrations/001_fs_links.sql"),
    ),
    (
        "wiki_store:002_fs_folders",
        include_str!("../migrations/002_fs_folders.sql"),
    ),
    (
        "wiki_store:003_wikilink_alias_links",
        include_str!("../migrations/003_wikilink_alias_links.sql"),
    ),
    (
        "wiki_store:004_rebuild_links_after_code_filter",
        include_str!("../migrations/004_rebuild_links_after_code_filter.sql"),
    ),
    (
        CURRENT_SCHEMA_VERSION,
        include_str!("../migrations/005_seed_raw_sources_root.sql"),
    ),
];
const SCHEMA_MIGRATIONS_BOOTSTRAP_SQL: &str =
    include_str!("../migrations/000_schema_migrations.sql");

#[cfg(not(target_arch = "wasm32"))]
pub fn run_fs_migrations(conn: &mut Connection) -> Result<(), String> {
    ensure_schema_migrations_table(conn)?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    run_fs_migrations_in_tx(&tx)?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn run_fs_migrations_in_tx(tx: &Transaction<'_>) -> Result<(), String> {
    ensure_schema_migrations_table(tx)?;
    reject_legacy_schema(tx)?;
    for (version, sql) in MIGRATIONS {
        if migration_already_applied(tx, version)? {
            continue;
        }
        tx.execute_batch(sql).map_err(|error| error.to_string())?;
        run_post_migration_hook(tx, version)?;
        record_schema_migration(tx, version)?;
    }
    Ok(())
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
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params![version],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn run_post_migration_hook(
    conn: &crate::sqlite::Transaction<'_>,
    version: &str,
) -> Result<(), String> {
    if version == "wiki_store:001_fs_links" {
        backfill_node_links(conn)?;
    }
    if version == "wiki_store:002_fs_folders" {
        backfill_folder_nodes(conn)?;
    }
    if version == "wiki_store:003_wikilink_alias_links" {
        backfill_node_links(conn)?;
    }
    if version == "wiki_store:004_rebuild_links_after_code_filter" {
        backfill_node_links(conn)?;
    }
    if version == "wiki_store:005_seed_raw_sources_root" {
        seed_sources_root_folders(conn)?;
    }
    Ok(())
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
    let known_versions = MIGRATIONS
        .iter()
        .map(|(version, _sql)| version.to_string())
        .collect::<Vec<_>>();
    if !known_versions.starts_with(&versions) || versions.is_empty() {
        return Err(format!(
            "legacy wiki_store schema is unsupported; recreate database: {}",
            versions.join(", ")
        ));
    }
    if !base_schema_shape_is_present(conn)? {
        return Err(format!(
            "legacy wiki_store schema is unsupported; recreate database: {}",
            versions.join(", ")
        ));
    }
    if versions
        .last()
        .is_some_and(|version| version == CURRENT_SCHEMA_VERSION)
        && !current_schema_shape_is_present(conn)?
    {
        return Err(format!(
            "legacy wiki_store schema is unsupported; recreate database: {}",
            versions.join(", ")
        ));
    }
    Ok(())
}

fn migration_already_applied(conn: &Connection, version: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM schema_migrations WHERE version = ?1",
        params![version],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
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

fn current_schema_shape_is_present(conn: &Connection) -> Result<bool, String> {
    if !base_schema_shape_is_present(conn)? {
        return Ok(false);
    }
    for table in ["fs_links"] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    for index in [
        "fs_links_target_path_idx",
        "fs_links_source_path_idx",
        "fs_nodes_parent_name_idx",
        "fs_nodes_parent_idx",
    ] {
        if !index_exists(conn, index)? {
            return Ok(false);
        }
    }
    for column in ["parent_id", "name"] {
        if !table_column_exists(conn, "fs_nodes", column)? {
            return Ok(false);
        }
    }
    Ok(true)
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

fn backfill_folder_nodes(conn: &crate::sqlite::Transaction<'_>) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT path, created_at, updated_at FROM fs_nodes ORDER BY path ASC")
        .map_err(|error| error.to_string())?;
    let nodes = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 0)?,
            crate::sqlite::row_get::<i64>(row, 1)?,
            crate::sqlite::row_get::<i64>(row, 2)?,
        ))
    })
    .map_err(|error| error.to_string())?;

    let mut folders = std::collections::BTreeMap::<String, (i64, i64)>::new();
    folders.insert("/Memory".to_string(), (0, 0));
    folders.insert("/Sessions".to_string(), (0, 0));
    folders.insert("/Knowledge".to_string(), (0, 0));
    folders.insert("/Skills".to_string(), (0, 0));
    folders.insert("/Sources".to_string(), (0, 0));
    folders.insert("/Sources/sessions".to_string(), (0, 0));
    folders.insert("/Sources/skill-runs".to_string(), (0, 0));
    for (path, created_at, updated_at) in &nodes {
        let mut current = String::new();
        let mut segments = path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .peekable();
        while let Some(segment) = segments.next() {
            current.push('/');
            current.push_str(segment);
            if segments.peek().is_none() {
                break;
            }
            folders
                .entry(current.clone())
                .and_modify(|(_, folder_updated_at)| {
                    *folder_updated_at = (*folder_updated_at).max(*updated_at);
                })
                .or_insert((*created_at, *updated_at));
        }
    }

    let mut changed_folder_paths = Vec::new();
    for (folder_path, (created_at, updated_at)) in folders {
        if ensure_folder_backfill_node(conn, &folder_path, created_at, updated_at)?
            != FolderBackfillChange::Existing
        {
            changed_folder_paths.push(folder_path);
        }
    }

    let mut stmt = conn
        .prepare("SELECT id, path FROM fs_nodes ORDER BY length(path), path")
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<i64>(row, 0)?,
            crate::sqlite::row_get::<String>(row, 1)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    let id_by_path = rows
        .iter()
        .map(|(id, path)| (path.clone(), *id))
        .collect::<std::collections::BTreeMap<_, _>>();

    for (id, path) in rows {
        let (parent_path, name) = split_parent_and_name(&path)?;
        let parent_id = parent_path
            .as_deref()
            .map(|parent| {
                id_by_path
                    .get(parent)
                    .copied()
                    .ok_or_else(|| format!("parent folder does not exist: {parent}"))
            })
            .transpose()?;
        let values = vec![
            crate::sqlite::nullable_integer_value(parent_id),
            crate::sqlite::text_value(name),
            crate::sqlite::integer_value(id),
        ];
        crate::sqlite::execute_values(
            conn,
            "UPDATE fs_nodes SET parent_id = ?1, name = ?2 WHERE id = ?3",
            &values,
        )
        .map_err(|error| error.to_string())?;
    }

    for folder_path in changed_folder_paths {
        conn.execute(
            "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, 'upsert')",
            params![folder_path],
        )
        .map_err(|error| error.to_string())?;
        let revision = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO fs_path_state (path, last_change_revision)
             VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET last_change_revision = excluded.last_change_revision",
            params![folder_path, revision],
        )
        .map_err(|error| error.to_string())?;
    }

    conn.execute_batch(
        "CREATE UNIQUE INDEX fs_nodes_parent_name_idx
         ON fs_nodes (COALESCE(parent_id, 0), name);
         CREATE INDEX fs_nodes_parent_idx ON fs_nodes(parent_id);",
    )
    .map_err(|error| error.to_string())
}

fn seed_sources_root_folders(conn: &crate::sqlite::Transaction<'_>) -> Result<(), String> {
    let mut changed_folder_paths = Vec::new();
    // This migration is limited to /Sources evidence subroots. Full store root
    // seeding is handled when creating stores and by the runtime index migration.
    for folder_path in ["/Sources", "/Sources/sessions", "/Sources/skill-runs"] {
        if ensure_folder_backfill_node(conn, folder_path, 0, 0)? != FolderBackfillChange::Existing {
            changed_folder_paths.push(folder_path.to_string());
        }
    }

    let mut stmt = conn
        .prepare("SELECT id, path FROM fs_nodes ORDER BY length(path), path")
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<i64>(row, 0)?,
            crate::sqlite::row_get::<String>(row, 1)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    let id_by_path = rows
        .iter()
        .map(|(id, path)| (path.clone(), *id))
        .collect::<std::collections::BTreeMap<_, _>>();

    for (id, path) in rows {
        let (parent_path, name) = split_parent_and_name(&path)?;
        let parent_id = parent_path
            .as_deref()
            .map(|parent| {
                id_by_path
                    .get(parent)
                    .copied()
                    .ok_or_else(|| format!("parent folder does not exist: {parent}"))
            })
            .transpose()?;
        let values = vec![
            crate::sqlite::nullable_integer_value(parent_id),
            crate::sqlite::text_value(name),
            crate::sqlite::integer_value(id),
        ];
        crate::sqlite::execute_values(
            conn,
            "UPDATE fs_nodes SET parent_id = ?1, name = ?2 WHERE id = ?3",
            &values,
        )
        .map_err(|error| error.to_string())?;
    }

    for folder_path in changed_folder_paths {
        conn.execute(
            "INSERT INTO fs_change_log (path, change_kind) VALUES (?1, 'upsert')",
            params![folder_path],
        )
        .map_err(|error| error.to_string())?;
        let revision = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
        conn.execute(
            "INSERT INTO fs_path_state (path, last_change_revision)
             VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET last_change_revision = excluded.last_change_revision",
            params![folder_path, revision],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FolderBackfillChange {
    Existing,
    Created,
    Promoted,
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

fn ensure_folder_backfill_node(
    conn: &crate::sqlite::Transaction<'_>,
    path: &str,
    created_at: i64,
    updated_at: i64,
) -> Result<FolderBackfillChange, String> {
    let existing = conn
        .query_row(
            "SELECT kind, content, metadata_json FROM fs_nodes WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    crate::sqlite::row_get::<String>(row, 0)?,
                    crate::sqlite::row_get::<String>(row, 1)?,
                    crate::sqlite::row_get::<String>(row, 2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match existing {
        None => {
            let etag = folder_migration_etag(path, "folder", "", "{}");
            conn.execute(
                "INSERT INTO fs_nodes (path, kind, content, created_at, updated_at, etag, metadata_json)
                 VALUES (?1, 'folder', '', ?2, ?3, ?4, '{}')",
                params![path, created_at, updated_at, etag],
            )
            .map(|_| FolderBackfillChange::Created)
            .map_err(|error| error.to_string())
        }
        Some((kind, _, _)) if kind == "folder" => Ok(FolderBackfillChange::Existing),
        Some((kind, content, metadata_json))
            if kind == "file" && content.is_empty() && metadata_json == "{}" =>
        {
            let etag = folder_migration_etag(path, "folder", "", "{}");
            conn.execute(
                "UPDATE fs_nodes SET kind = 'folder', content = '', etag = ?2, metadata_json = '{}' WHERE path = ?1",
                params![path, etag],
            )
            .map(|_| FolderBackfillChange::Promoted)
            .map_err(|error| error.to_string())
        }
        Some(_) => Err(format!("folder path conflicts with non-empty node: {path}")),
    }
}

fn folder_migration_etag(path: &str, kind: &str, content: &str, metadata_json: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(b"\n");
    hasher.update(kind.as_bytes());
    hasher.update(b"\n");
    hasher.update(content.as_bytes());
    hasher.update(b"\n");
    hasher.update(metadata_json.as_bytes());
    format!("v4h:{:x}", hasher.finalize())
}

fn base_schema_shape_is_present(conn: &Connection) -> Result<bool, String> {
    for table in base_schema_tables() {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    for index in ["fs_nodes_path_covering_idx", "fs_nodes_recent_covering_idx"] {
        if !index_exists(conn, index)? {
            return Ok(false);
        }
    }
    fts_shape_is_current(conn)
}

fn base_schema_tables() -> &'static [&'static str] {
    &["fs_nodes", "fs_nodes_fts", "fs_change_log", "fs_path_state"]
}

fn fts_shape_is_current(conn: &Connection) -> Result<bool, String> {
    let sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fs_nodes_fts'",
            params![],
            |row| crate::sqlite::row_get::<String>(row, 0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(sql) = sql else {
        return Ok(false);
    };
    Ok(sql.contains("path") && sql.contains("title") && sql.contains("content"))
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

fn managed_table_exists(conn: &Connection) -> Result<bool, String> {
    for table in base_schema_tables() {
        if table_exists(conn, table)? {
            return Ok(true);
        }
    }
    table_exists(conn, "fs_links")
}
