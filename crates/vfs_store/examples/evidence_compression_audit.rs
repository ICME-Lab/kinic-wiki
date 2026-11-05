//! Offline audit: source archive is read-only; destination lives in a temporary directory.
//! Outputs aggregates only, never conversation text, paths, or identifiers.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::Path};
use vfs_store::FsStore;
use vfs_types::{MkdirNodeRequest, NodeKind, WriteNodeRequest};
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arg = std::env::args_os()
        .nth(1)
        .ok_or("verified manifest required")?;
    let file = Path::new(&arg);
    let parent = file
        .parent()
        .ok_or("archive parent missing")?
        .canonicalize()?;
    let manifest: Value = serde_json::from_slice(&std::fs::read(file)?)?;
    let rows = manifest["rows"].as_array().ok_or("archive rows missing")?;
    if rows.is_empty() || rows.len() > 10000 {
        return Err("archive count outside budget".into());
    }
    let dir = tempfile::tempdir()?;
    let db_path = dir.path().join("audit.sqlite3");
    let store = FsStore::new(db_path.clone());
    store.run_fs_migrations()?;
    store.enable_evidence_storage()?;
    let mut folders = BTreeSet::new();
    let mut bytes = 0;
    for row in rows {
        let name = Path::new(row["backup_file"].as_str().ok_or("backup file missing")?)
            .file_name()
            .ok_or("backup name missing")?;
        let path = parent.join(name).canonicalize()?;
        if !path.starts_with(&parent) || std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 {
            return Err("invalid backup path or size".into());
        }
        let data = std::fs::read(path)?;
        if row["backup_sha256"].as_str() != Some(sha(&data).as_str()) {
            return Err("backup hash mismatch".into());
        }
        let node: Value = serde_json::from_slice(&data)?;
        let path = node["path"].as_str().ok_or("node path missing")?;
        let body = node["content"].as_str().ok_or("node content missing")?;
        if row["bytes"].as_u64() != Some(body.len() as u64) {
            return Err("body size mismatch".into());
        }
        bytes += body.len();
        if bytes > 256 * 1024 * 1024 {
            return Err("total archive budget exceeded".into());
        }
        let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
        let mut folder = String::new();
        for part in parts.iter().take(parts.len().saturating_sub(1)) {
            folder.push('/');
            folder.push_str(part);
            if folders.insert(folder.clone()) {
                store.mkdir_node(
                    MkdirNodeRequest {
                        database_id: "default".into(),
                        path: folder.clone(),
                    },
                    1,
                )?;
            }
        }
        let ack = store
            .write_node(
                WriteNodeRequest {
                    database_id: "default".into(),
                    path: path.into(),
                    kind: NodeKind::Source,
                    content: body.into(),
                    metadata_json: node["metadata_json"]
                        .as_str()
                        .ok_or("node metadata missing")?
                        .into(),
                    expected_etag: None,
                },
                10,
            )?
            .node;
        if ack.etag != row["etag"]
            || store.read_node(path)?.ok_or("node missing")?.content != body
            || store
                .current_node_revision(path)?
                .ok_or("revision missing")?
                .node
                .content
                != body
        {
            return Err("stored identity or reconstruction mismatch".into());
        }
    }
    let db = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let size = |sql: &str| -> Result<u64, rusqlite::Error> { db.query_row(sql, [], |r| r.get(0)) };
    let manifests = size(
        "SELECT coalesce(sum(length(CAST(manifest_json AS BLOB))),0) FROM fs_evidence_manifests",
    )?;
    let blobs = size("SELECT coalesce(sum(length(CAST(body AS BLOB))),0) FROM fs_evidence_blobs")?;
    let raw = size(
        "SELECT coalesce(sum(length(CAST(content AS BLOB))),0) FROM fs_nodes WHERE kind <> 'folder' AND content NOT LIKE 'kinic:evidence:v1:%'",
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"scope":"verified current learning records in temporary native SQLite; not full production DB/history/stable memory","nodes":rows.len(),"original_body_bytes":bytes,"compressed_manifest_bytes":manifests,"compressed_blob_bytes":blobs,"unchanged_body_bytes":raw,"payload_bytes":manifests+blobs+raw,"temporary_logical_database_bytes":store.logical_size_bytes()?,"all_current_and_initial_history_bodies_and_etags_verified":true})
        )?
    );
    Ok(())
}
