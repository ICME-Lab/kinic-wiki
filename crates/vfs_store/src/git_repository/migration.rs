use super::*;

pub(crate) fn seed_repository(tx: &Transaction<'_>) -> Result<(), String> {
    reject_reserved_existing_paths(tx)?;
    tx.execute(
        "INSERT INTO fs_history_pages (current_node_id, current_path)
         SELECT node.id, node.path FROM fs_nodes node
         WHERE NOT EXISTS (SELECT 1 FROM fs_history_pages page WHERE page.current_node_id = node.id)
         ORDER BY node.id ASC",
        params![],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO fs_history_blobs (hash, kind, content, metadata_json)
         SELECT etag, kind, content, metadata_json FROM fs_nodes",
        params![],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "INSERT INTO fs_history_versions
             (page_id, blob_hash, path, etag, node_created_at, node_updated_at)
         SELECT page.id, node.etag, node.path, node.etag, node.created_at, node.updated_at
         FROM fs_history_pages page
         JOIN fs_nodes node ON node.id = page.current_node_id
         WHERE page.current_version_id IS NULL
         ORDER BY page.id ASC",
        params![],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE fs_history_pages
         SET current_version_id = (
             SELECT MAX(version.id) FROM fs_history_versions version
             WHERE version.page_id = fs_history_pages.id
         )
         WHERE current_node_id IS NOT NULL AND current_version_id IS NULL",
        params![],
    )
    .map_err(|error| error.to_string())?;

    let tree_oid = rebuild_head(tx, 0)?;
    let changed_at = tx
        .query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM fs_nodes",
            params![],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
        .map_err(|error| error.to_string())?;
    let commit = commit_object(
        &tree_oid,
        None,
        "Kinic migration",
        "migration@kinic.invalid",
        changed_at,
        "initialize history",
        None,
    );
    insert_object(tx, &commit, 0)?;
    fail_v003_migration_before_ref()?;
    update_ref(tx, &commit.oid, 0)?;
    Ok(())
}
