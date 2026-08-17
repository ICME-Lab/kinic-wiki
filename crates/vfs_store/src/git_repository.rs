// Where: crates/vfs_store/src/git_repository.rs
// What: Canonical SHA-1 Git objects and the materialized repository HEAD.
// Why: Page history must export as a repository accepted by ordinary Git.
#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use sha1::{Digest, Sha1};

use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
use vfs_types::{
    GitObjectChunk, GitObjectSummary, GitRepositorySnapshot, ListGitObjectsResponse, Node,
};

mod migration;
mod snapshot;
pub(crate) use migration::seed_repository;
pub(crate) use snapshot::{list_objects, read_object_chunk, repository_snapshot};

pub(crate) const HEAD_REF: &str = "refs/heads/main";
pub(crate) const OBJECT_PAGE_LIMIT_MAX: u32 = 100;
pub(crate) const OBJECT_CHUNK_BYTES_MAX: u32 = 512 * 1024;
pub(crate) const MUTATION_NODES_MAX: i64 = 100;
pub(crate) const MUTATION_BYTES_MAX: i64 = 1_500 * 1024;
const MIGRATION_NODE_ID_PAGE_SIZE: i64 = 128;

#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
thread_local! {
    static FINALIZE_FAILPOINT: Cell<u8> = const { Cell::new(0) };
}

#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
pub(crate) fn set_finalize_failpoint(stage: u8) {
    FINALIZE_FAILPOINT.set(stage);
}

fn fail_after(_stage: u8) -> Result<(), String> {
    #[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
    if FINALIZE_FAILPOINT.get() == _stage {
        FINALIZE_FAILPOINT.set(0);
        return Err(format!(
            "injected Git finalize failure after stage {_stage}"
        ));
    }
    Ok(())
}

fn fail_v003_migration_before_ref() -> Result<(), String> {
    #[cfg(all(target_arch = "wasm32", feature = "pocketic-migration-failpoint"))]
    return Err("injected v003 Git migration failure before ref update".to_string());
    #[cfg(not(all(target_arch = "wasm32", feature = "pocketic-migration-failpoint")))]
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObjectKind {
    Blob,
    Tree,
    Commit,
}

impl ObjectKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::Tree => "tree",
            Self::Commit => "commit",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitObject {
    pub(crate) oid: String,
    pub(crate) kind: ObjectKind,
    pub(crate) data: Vec<u8>,
}

pub(crate) fn object(kind: ObjectKind, data: Vec<u8>) -> GitObject {
    let mut hasher = Sha1::new();
    hasher.update(format!("{} {}\0", kind.as_str(), data.len()).as_bytes());
    hasher.update(&data);
    GitObject {
        oid: hex_lower(&hasher.finalize()),
        kind,
        data,
    }
}

pub(crate) fn validate_mutation_budget(
    affected_nodes: i64,
    changed_bytes: i64,
) -> Result<(), String> {
    if affected_nodes > MUTATION_NODES_MAX {
        return Err("Git history mutation affects more than 100 nodes".to_string());
    }
    if changed_bytes > MUTATION_BYTES_MAX {
        return Err("Git history mutation exceeds the 1.5 MiB byte budget".to_string());
    }
    Ok(())
}

pub(crate) fn node_mutation_bytes(
    change_kind: &str,
    before: Option<&Node>,
    after: Option<&Node>,
) -> Result<i64, String> {
    let byte_len = |value: &str| {
        i64::try_from(value.len()).map_err(|_| "Git mutation byte length is too large".to_string())
    };
    let add = |left: i64, right: i64| {
        left.checked_add(right)
            .ok_or_else(|| "Git mutation byte length is too large".to_string())
    };
    let add_node = |node: &Node, include_content: bool| -> Result<i64, String> {
        let mut total = add(byte_len(&node.path)?, byte_len(&node.metadata_json)?)?;
        if include_content {
            total = add(total, byte_len(&node.content)?)?;
        }
        Ok(total)
    };

    match change_kind {
        "move" => after
            .ok_or_else(|| "Git move budget requires an after node".to_string())
            .and_then(|node| add_node(node, false)),
        "delete" => before
            .ok_or_else(|| "Git delete budget requires a before node".to_string())
            .and_then(|node| byte_len(&node.path)),
        "create" | "update" | "restore" => after
            .ok_or_else(|| format!("Git {change_kind} budget requires an after node"))
            .and_then(|node| add_node(node, true)),
        _ => Err(format!("unknown Git mutation kind: {change_kind}")),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn oid_bytes(oid: &str) -> Result<[u8; 20], String> {
    if oid.len() != 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("invalid Git object id: {oid}"));
    }
    let mut output = [0_u8; 20];
    for (index, pair) in oid.as_bytes().chunks_exact(2).enumerate() {
        let digits = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
        output[index] = u8::from_str_radix(digits, 16).map_err(|error| error.to_string())?;
    }
    Ok(output)
}

#[derive(Clone)]
struct Leaf {
    path: String,
    mode: i64,
    oid: String,
}

#[derive(Clone)]
struct NodeRow {
    page_id: i64,
    path: String,
    kind: String,
    content: Option<String>,
    created_at: i64,
    updated_at: i64,
    metadata_json: String,
    version_id: i64,
}

#[derive(Clone)]
struct PreviousNodeRow {
    version_id: i64,
    path: String,
    kind: String,
    git_blob_oid: Option<String>,
}

/// Finalizes a history change after its node mutation has completed.
///
/// The caller must preserve the transaction invariant:
/// `begin_change` -> node mutation (SQLite triggers record items) -> `finish_change`
/// -> this Git finalize step. All stages run in the same SQLite transaction so a
/// failure rolls back both the history rows and the materialized Git repository.
pub(crate) fn finalize_change(tx: &Transaction<'_>, change_id: i64) -> Result<String, String> {
    let (principal, operation, changed_at): (String, String, i64) = tx
        .query_row(
            "SELECT author_principal, operation, changed_at FROM fs_history_changes WHERE id = ?1",
            params![change_id],
            |row| {
                Ok((
                    crate::sqlite::row_get(row, 0)?,
                    crate::sqlite::row_get(row, 1)?,
                    crate::sqlite::row_get(row, 2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let affected = tx
        .query_row(
            "SELECT COUNT(DISTINCT page_id) FROM fs_history_items WHERE change_id = ?1",
            params![change_id],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
        .map_err(|error| error.to_string())?;
    let changed_bytes = tx
        .query_row(
            "SELECT COALESCE(SUM(
                         CASE item.change_kind
                         WHEN 'move' THEN
                             length(CAST(after_version.path AS BLOB))
                             + length(CAST(after_blob.metadata_json AS BLOB))
                         WHEN 'delete' THEN
                             length(CAST(before_version.path AS BLOB))
                         ELSE
                             length(CAST(after_version.path AS BLOB))
                             + length(CAST(after_blob.content AS BLOB))
                             + length(CAST(after_blob.metadata_json AS BLOB))
                         END
                     ), 0)
             FROM fs_history_items item
             LEFT JOIN fs_history_versions before_version
               ON before_version.id = item.before_version_id
             LEFT JOIN fs_history_blobs before_blob
               ON before_blob.hash = before_version.blob_hash
             LEFT JOIN fs_history_versions after_version
               ON after_version.id = item.after_version_id
             LEFT JOIN fs_history_blobs after_blob
               ON after_blob.hash = after_version.blob_hash
             WHERE item.change_id = ?1",
            params![change_id],
            |row| crate::sqlite::row_get::<i64>(row, 0),
        )
        .map_err(|error| error.to_string())?;
    validate_mutation_budget(affected, changed_bytes)?;
    let parent = head(tx)?.map(|head| head.commit_oid);
    let tree_oid = update_head(tx, change_id)?;
    fail_after(2)?;
    let email = format!("{principal}@principal.kinic");
    let commit = commit_object(
        &tree_oid,
        parent.as_deref(),
        &principal,
        &email,
        changed_at,
        &operation,
        Some((principal.as_str(), change_id)),
    );
    insert_object(tx, &commit, change_id)?;
    fail_after(3)?;
    tx.execute(
        "UPDATE fs_history_changes SET commit_oid = ?2 WHERE id = ?1",
        params![change_id, commit.oid],
    )
    .map_err(|error| error.to_string())?;
    fail_after(4)?;
    update_ref(tx, &commit.oid, change_id)?;
    Ok(commit.oid)
}

fn reject_reserved_existing_paths(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT path FROM fs_nodes ORDER BY path ASC")
        .map_err(|error| error.to_string())?;
    let paths = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 0)
    })
    .map_err(|error| error.to_string())?;
    for path in paths {
        if is_reserved_path(&path) {
            return Err(format!("path uses reserved Git namespace: {path}"));
        }
    }
    Ok(())
}

pub(crate) fn is_reserved_path(path: &str) -> bool {
    path.split('/').nth(1).is_some_and(|segment| {
        segment.eq_ignore_ascii_case(".git") || segment.eq_ignore_ascii_case(".kinic")
    })
}

fn rebuild_head(tx: &Transaction<'_>, change_id: i64) -> Result<String, String> {
    tx.execute("DELETE FROM git_index_entries", params![])
        .map_err(|error| error.to_string())?;
    let mut dirty_directories = BTreeSet::new();
    dirty_directories.insert(String::new());
    let format = object(
        ObjectKind::Blob,
        b"{\"format_version\":1,\"object_format\":\"sha1\"}\n".to_vec(),
    );
    insert_object(tx, &format, change_id)?;
    upsert_index_leaf(
        tx,
        ".kinic/format.json",
        100_644,
        &format.oid,
        &mut dirty_directories,
    )?;

    let mut after_page_id = 0_i64;
    loop {
        let page_ids = live_node_id_page(tx, after_page_id)?;
        if page_ids.is_empty() {
            break;
        }
        for page_id in page_ids {
            let row = live_node(tx, page_id)?;
            let content = row
                .content
                .as_deref()
                .ok_or_else(|| format!("Git baseline content is missing for {}", row.path))?;
            let content = object(ObjectKind::Blob, content.as_bytes().to_vec());
            insert_object(tx, &content, change_id)?;
            tx.execute(
                "UPDATE fs_history_versions SET git_blob_oid = ?2 WHERE id = ?1",
                params![row.version_id, content.oid],
            )
            .map_err(|error| error.to_string())?;
            if row.kind != "folder" {
                upsert_index_leaf(
                    tx,
                    row.path.trim_start_matches('/'),
                    100_644,
                    &content.oid,
                    &mut dirty_directories,
                )?;
            }
            let sidecar = object(ObjectKind::Blob, sidecar_json(&row)?.into_bytes());
            insert_object(tx, &sidecar, change_id)?;
            upsert_index_leaf(
                tx,
                &sidecar_path(row.page_id),
                100_644,
                &sidecar.oid,
                &mut dirty_directories,
            )?;
            after_page_id = page_id;
        }
    }
    rebuild_dirty_trees(tx, dirty_directories, change_id)
}

fn update_head(tx: &Transaction<'_>, change_id: i64) -> Result<String, String> {
    let mut stmt = tx
        .prepare(
            "SELECT item.change_kind, item.page_id,
                    before_version.id, before_version.path, before_blob.kind,
                    before_version.git_blob_oid,
                    after_version.id, after_version.path, after_blob.kind,
                    CASE WHEN item.change_kind = 'move' THEN NULL ELSE after_blob.content END,
                    after_version.node_created_at, after_version.node_updated_at,
                    after_blob.metadata_json,
                    CASE WHEN before_version.id IS NOT NULL
                               AND after_version.id IS NOT NULL
                               AND before_blob.content = after_blob.content
                         THEN 1 ELSE 0 END
             FROM fs_history_items item
             LEFT JOIN fs_history_versions before_version ON before_version.id = item.before_version_id
             LEFT JOIN fs_history_blobs before_blob ON before_blob.hash = before_version.blob_hash
             LEFT JOIN fs_history_versions after_version ON after_version.id = item.after_version_id
             LEFT JOIN fs_history_blobs after_blob ON after_blob.hash = after_version.blob_hash
             WHERE item.change_id = ?1
             ORDER BY item.id ASC",
        )
        .map_err(|error| error.to_string())?;
    let changed = crate::sqlite::query_map(&mut stmt, params![change_id], |row| {
        let change_kind = crate::sqlite::row_get::<String>(row, 0)?;
        let page_id = crate::sqlite::row_get::<i64>(row, 1)?;
        let before_version_id = crate::sqlite::row_get::<Option<i64>>(row, 2)?;
        let before_path = crate::sqlite::row_get::<Option<String>>(row, 3)?;
        let before = before_path
            .zip(before_version_id)
            .map(|(path, version_id)| {
                Ok::<PreviousNodeRow, crate::sqlite::Error>(PreviousNodeRow {
                    version_id,
                    path,
                    kind: crate::sqlite::row_get(row, 4)?,
                    git_blob_oid: crate::sqlite::row_get(row, 5)?,
                })
            })
            .transpose()?;
        let after_version_id = crate::sqlite::row_get::<Option<i64>>(row, 6)?;
        let after = after_version_id
            .map(|version_id| {
                Ok::<NodeRow, crate::sqlite::Error>(NodeRow {
                    page_id,
                    path: crate::sqlite::row_get(row, 7)?,
                    kind: crate::sqlite::row_get(row, 8)?,
                    content: crate::sqlite::row_get(row, 9)?,
                    created_at: crate::sqlite::row_get(row, 10)?,
                    updated_at: crate::sqlite::row_get(row, 11)?,
                    metadata_json: crate::sqlite::row_get(row, 12)?,
                    version_id,
                })
            })
            .transpose()?;
        let same_content = crate::sqlite::row_get::<i64>(row, 13)? != 0;
        Ok((change_kind, page_id, before, after, same_content))
    })
    .map_err(|error| error.to_string())?;
    drop(stmt);

    let mut dirty_directories = BTreeSet::new();
    dirty_directories.insert(String::new());
    let mut resolved_blob_oids = BTreeMap::<i64, String>::new();
    for (change_kind, page_id, before, after, same_content) in changed {
        if let Some(previous) = &before
            && previous.kind != "folder"
        {
            remove_index_leaf(
                tx,
                previous.path.trim_start_matches('/'),
                &mut dirty_directories,
            )?;
        }
        remove_index_leaf(tx, &sidecar_path(page_id), &mut dirty_directories)?;

        let Some(row) = after else { continue };
        let content_oid = if change_kind == "move" {
            before
                .as_ref()
                .and_then(|previous| {
                    resolved_blob_oids
                        .get(&previous.version_id)
                        .cloned()
                        .or_else(|| previous.git_blob_oid.clone())
                })
                .ok_or_else(|| {
                    format!(
                        "Git blob OID is missing for moved page {page_id} at {}",
                        row.path
                    )
                })?
        } else if same_content {
            if let Some(content_oid) = before.as_ref().and_then(|previous| {
                resolved_blob_oids
                    .get(&previous.version_id)
                    .cloned()
                    .or_else(|| previous.git_blob_oid.clone())
            }) {
                content_oid
            } else {
                let content = row.content.as_deref().ok_or_else(|| {
                    format!(
                        "Git content is missing for {change_kind} page {page_id} at {}",
                        row.path
                    )
                })?;
                let content = object(ObjectKind::Blob, content.as_bytes().to_vec());
                insert_object(tx, &content, change_id)?;
                content.oid
            }
        } else {
            let content = row.content.as_deref().ok_or_else(|| {
                format!(
                    "Git content is missing for {change_kind} page {page_id} at {}",
                    row.path
                )
            })?;
            let content = object(ObjectKind::Blob, content.as_bytes().to_vec());
            insert_object(tx, &content, change_id)?;
            content.oid
        };
        tx.execute(
            "UPDATE fs_history_versions SET git_blob_oid = ?2 WHERE id = ?1",
            params![row.version_id, content_oid],
        )
        .map_err(|error| error.to_string())?;
        resolved_blob_oids.insert(row.version_id, content_oid.clone());
        if row.kind != "folder" {
            upsert_index_leaf(
                tx,
                row.path.trim_start_matches('/'),
                100_644,
                &content_oid,
                &mut dirty_directories,
            )?;
        }
        let sidecar = object(ObjectKind::Blob, sidecar_json(&row)?.into_bytes());
        insert_object(tx, &sidecar, change_id)?;
        upsert_index_leaf(
            tx,
            &sidecar_path(page_id),
            100_644,
            &sidecar.oid,
            &mut dirty_directories,
        )?;
    }
    fail_after(1)?;
    rebuild_dirty_trees(tx, dirty_directories, change_id)
}

fn mark_ancestors(path: &str, directories: &mut BTreeSet<String>) -> Result<(), String> {
    let mut current = split_git_path(path)?.0;
    loop {
        directories.insert(current.clone());
        if current.is_empty() {
            return Ok(());
        }
        current = split_git_path(&current)?.0;
    }
}

fn remove_index_leaf(
    tx: &Transaction<'_>,
    path: &str,
    dirty_directories: &mut BTreeSet<String>,
) -> Result<(), String> {
    mark_ancestors(path, dirty_directories)?;
    tx.execute(
        "DELETE FROM git_index_entries WHERE path = ?1",
        params![path],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn upsert_index_leaf(
    tx: &Transaction<'_>,
    path: &str,
    mode: i64,
    oid: &str,
    dirty_directories: &mut BTreeSet<String>,
) -> Result<(), String> {
    mark_ancestors(path, dirty_directories)?;
    insert_index_entry(tx, path, mode, oid)
}

fn rebuild_dirty_trees(
    tx: &Transaction<'_>,
    dirty_directories: BTreeSet<String>,
    change_id: i64,
) -> Result<String, String> {
    let mut ordered = dirty_directories.into_iter().collect::<Vec<_>>();
    ordered.sort_by_key(|path| {
        std::cmp::Reverse(path.matches('/').count() + usize::from(!path.is_empty()))
    });
    let mut root_oid = None;
    for directory in ordered {
        let mut stmt = tx
            .prepare(
                "SELECT path, mode, oid FROM git_index_entries
                 WHERE parent_path = ?1 ORDER BY name ASC",
            )
            .map_err(|error| error.to_string())?;
        let mut entries = crate::sqlite::query_map(&mut stmt, params![directory], |row| {
            Ok(Leaf {
                path: crate::sqlite::row_get(row, 0)?,
                mode: crate::sqlite::row_get(row, 1)?,
                oid: crate::sqlite::row_get(row, 2)?,
            })
        })
        .map_err(|error| error.to_string())?;
        drop(stmt);
        if entries.is_empty() && !directory.is_empty() {
            tx.execute(
                "DELETE FROM git_index_entries WHERE path = ?1",
                params![directory],
            )
            .map_err(|error| error.to_string())?;
            continue;
        }
        entries.sort_by(git_entry_cmp);
        let mut data = Vec::new();
        for entry in entries {
            let (_, name) = split_git_path(&entry.path)?;
            data.extend_from_slice(entry.mode.to_string().as_bytes());
            data.push(b' ');
            data.extend_from_slice(name.as_bytes());
            data.push(0);
            data.extend_from_slice(&oid_bytes(&entry.oid)?);
        }
        let tree = object(ObjectKind::Tree, data);
        insert_object(tx, &tree, change_id)?;
        if directory.is_empty() {
            root_oid = Some(tree.oid);
        } else {
            insert_index_entry(tx, &directory, 40_000, &tree.oid)?;
        }
    }
    root_oid.ok_or_else(|| "Git root tree was not generated".to_string())
}

fn live_node_id_page(conn: &Connection, after_page_id: i64) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT page.id
             FROM fs_history_pages page
             JOIN fs_nodes node ON node.id = page.current_node_id
             WHERE page.id > ?1
             ORDER BY page.id ASC
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(
        &mut stmt,
        params![after_page_id, MIGRATION_NODE_ID_PAGE_SIZE],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn live_node(conn: &Connection, page_id: i64) -> Result<NodeRow, String> {
    conn.query_row(
        "SELECT page.id, node.path, node.kind, node.content,
                node.created_at, node.updated_at, node.metadata_json,
                page.current_version_id
         FROM fs_history_pages page
         JOIN fs_nodes node ON node.id = page.current_node_id
         WHERE page.id = ?1",
        params![page_id],
        |row| {
            Ok(NodeRow {
                page_id: crate::sqlite::row_get(row, 0)?,
                path: crate::sqlite::row_get(row, 1)?,
                kind: crate::sqlite::row_get(row, 2)?,
                content: Some(crate::sqlite::row_get(row, 3)?),
                created_at: crate::sqlite::row_get(row, 4)?,
                updated_at: crate::sqlite::row_get(row, 5)?,
                metadata_json: crate::sqlite::row_get(row, 6)?,
                version_id: crate::sqlite::row_get(row, 7)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

fn sidecar_path(page_id: i64) -> String {
    let hex = format!("{:016x}", page_id as u64);
    format!(
        ".kinic/pages/{}/{}/{}.json",
        &hex[14..16],
        &hex[12..14],
        hex
    )
}

fn sidecar_json(row: &NodeRow) -> Result<String, String> {
    let path = serde_json::to_string(&row.path).map_err(|error| error.to_string())?;
    let kind = serde_json::to_string(&row.kind).map_err(|error| error.to_string())?;
    let metadata = serde_json::to_string(&row.metadata_json).map_err(|error| error.to_string())?;
    Ok(format!(
        "{{\"page_id\":{},\"path\":{},\"kind\":{},\"metadata_json\":{},\"created_at\":{},\"updated_at\":{}}}\n",
        row.page_id, path, kind, metadata, row.created_at, row.updated_at
    ))
}

fn git_entry_cmp(left: &Leaf, right: &Leaf) -> Ordering {
    let left_name = split_git_path(&left.path)
        .map(|(_, name)| name)
        .unwrap_or_default();
    let right_name = split_git_path(&right.path)
        .map(|(_, name)| name)
        .unwrap_or_default();
    let mut left_key = left_name.into_bytes();
    let mut right_key = right_name.into_bytes();
    if left.mode == 40_000 {
        left_key.push(b'/');
    }
    if right.mode == 40_000 {
        right_key.push(b'/');
    }
    left_key.cmp(&right_key)
}

fn split_git_path(path: &str) -> Result<(String, String), String> {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    if name.is_empty() || name.as_bytes().contains(&0) {
        return Err(format!("path cannot be represented by Git: {path}"));
    }
    Ok((parent.to_string(), name.to_string()))
}

fn insert_index_entry(
    tx: &Transaction<'_>,
    path: &str,
    mode: i64,
    oid: &str,
) -> Result<(), String> {
    let (parent, name) = split_git_path(path)?;
    tx.execute(
        "INSERT OR REPLACE INTO git_index_entries (path, parent_path, name, mode, oid)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![path, parent, name, mode, oid],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn commit_object(
    tree_oid: &str,
    parent_oid: Option<&str>,
    author_name: &str,
    author_email: &str,
    changed_at_ms: i64,
    operation: &str,
    trailers: Option<(&str, i64)>,
) -> GitObject {
    let seconds = changed_at_ms.div_euclid(1_000);
    let mut data = format!("tree {tree_oid}\n");
    if let Some(parent) = parent_oid {
        data.push_str(&format!("parent {parent}\n"));
    }
    let identity = format!("{author_name} <{author_email}> {seconds} +0000");
    data.push_str(&format!(
        "author {identity}\ncommitter {identity}\n\nkinic: {operation}\n"
    ));
    if let Some((principal, change_id)) = trailers {
        data.push_str(&format!(
            "\nKinic-Principal: {principal}\nKinic-Change-Id: {change_id}\n"
        ));
    }
    object(ObjectKind::Commit, data.into_bytes())
}

fn insert_object(tx: &Transaction<'_>, object: &GitObject, change_id: i64) -> Result<(), String> {
    let size = i64::try_from(object.data.len())
        .map_err(|_| format!("Git object is too large to store: {}", object.oid))?;
    let mut values = vec![
        crate::sqlite::text_value(object.oid.clone()),
        crate::sqlite::text_value(object.kind.as_str()),
        crate::sqlite::integer_value(size),
        crate::sqlite::types::Value::from(object.data.clone()),
    ];
    let mut statement = tx
        .prepare(
            "SELECT object_type = ?2 AND size = ?3 AND data = ?4
             FROM git_objects WHERE oid = ?1",
        )
        .map_err(|error| error.to_string())?;
    let existing_matches = crate::sqlite::query_one(
        &mut statement,
        crate::sqlite::params_from_values(&values),
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())?;
    drop(statement);
    match existing_matches {
        Some(1) => return Ok(()),
        Some(_) => {
            return Err(format!(
                "Git object OID collision or corrupt stored payload: {}",
                object.oid
            ));
        }
        None => {}
    }
    values.push(crate::sqlite::integer_value(change_id));
    crate::sqlite::execute_values(
        tx,
        "INSERT INTO git_objects (oid, object_type, size, data, first_change_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        &values,
    )
    .map_err(|error| error.to_string())
}

fn update_ref(tx: &Transaction<'_>, commit_oid: &str, change_id: i64) -> Result<(), String> {
    tx.execute(
        "INSERT OR REPLACE INTO git_refs (name, commit_oid, change_id) VALUES (?1, ?2, ?3)",
        params![HEAD_REF, commit_oid, change_id],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[derive(Clone)]
pub(crate) struct Head {
    pub(crate) commit_oid: String,
    pub(crate) change_id: i64,
}

pub(crate) fn head(conn: &Connection) -> Result<Option<Head>, String> {
    conn.query_row(
        "SELECT commit_oid, change_id FROM git_refs WHERE name = ?1",
        params![HEAD_REF],
        |row| {
            Ok(Head {
                commit_oid: crate::sqlite::row_get(row, 0)?,
                change_id: crate::sqlite::row_get(row, 1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object_store_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory SQLite should open");
        connection
            .execute_batch(
                "CREATE TABLE git_objects (
                    oid TEXT PRIMARY KEY NOT NULL,
                    object_type TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    data BLOB NOT NULL,
                    first_change_id INTEGER NOT NULL
                );",
            )
            .expect("Git object table should be created");
        connection
    }

    #[test]
    fn empty_blob_matches_git_sha1_vector() {
        assert_eq!(
            object(ObjectKind::Blob, Vec::new()).oid,
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    }

    #[test]
    fn content_blob_does_not_depend_on_path() {
        let left = object(ObjectKind::Blob, b"same".to_vec());
        let right = object(ObjectKind::Blob, b"same".to_vec());
        assert_eq!(left.oid, right.oid);
    }

    #[test]
    fn page_sidecar_is_sharded_by_low_bytes() {
        assert_eq!(
            sidecar_path(0x1234),
            ".kinic/pages/34/12/0000000000001234.json"
        );
    }

    #[test]
    fn identical_object_reuse_preserves_first_change_id() {
        let mut connection = object_store_connection();
        let object = object(ObjectKind::Blob, b"same payload".to_vec());
        let transaction = connection.transaction().unwrap();
        insert_object(&transaction, &object, 7).unwrap();
        insert_object(&transaction, &object, 11).unwrap();
        transaction.commit().unwrap();

        let (count, first_change_id) = connection
            .query_row(
                "SELECT COUNT(*), MIN(first_change_id) FROM git_objects WHERE oid = ?1",
                params![object.oid],
                |row| {
                    Ok((
                        crate::sqlite::row_get::<i64>(row, 0)?,
                        crate::sqlite::row_get::<i64>(row, 1)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(first_change_id, 7);
    }

    #[test]
    fn same_oid_with_different_payload_is_rejected() {
        let mut connection = object_store_connection();
        let original = object(ObjectKind::Blob, b"original".to_vec());
        let transaction = connection.transaction().unwrap();
        insert_object(&transaction, &original, 3).unwrap();
        transaction.commit().unwrap();

        let forged = GitObject {
            oid: original.oid.clone(),
            kind: ObjectKind::Blob,
            data: b"different".to_vec(),
        };
        let transaction = connection.transaction().unwrap();
        let error = insert_object(&transaction, &forged, 4).unwrap_err();
        assert!(error.contains("collision or corrupt"), "{error}");
        transaction.rollback().unwrap();
    }
}
