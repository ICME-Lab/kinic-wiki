// Where: crates/vfs_cli_app/src/bin/local_canister_archive_restore_smoke.rs
// What: Manual local-canister archive/restore smoke over vfs_client.
// Why: Byte-range SQLite archive flows need an end-to-end canister check outside unit tests.
use std::env;

use anyhow::{Context, Result, anyhow};
use sha2::{Digest, Sha256};
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{
    DatabaseRestoreChunkRequest, DatabaseStatus, NodeKind, OutgoingLinksRequest,
    SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

#[tokio::main]
async fn main() -> Result<()> {
    let replica_host =
        env::var("REPLICA_HOST").unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());
    let canister_id = env::var("CANISTER_ID")
        .or_else(|_| env::var("VFS_CANISTER_ID"))
        .context("CANISTER_ID or VFS_CANISTER_ID is required")?;
    let chunk_size = env::var("ARCHIVE_CHUNK_SIZE")
        .ok()
        .map(|value| value.parse::<u32>())
        .transpose()
        .context("ARCHIVE_CHUNK_SIZE must be a u32")?
        .unwrap_or(64 * 1024);

    let client = CanisterVfsClient::new(&replica_host, &canister_id).await?;
    let manifest = client.memory_manifest().await?;
    if manifest.recommended_entrypoint != "query_context" {
        return Err(anyhow!("unexpected memory manifest entrypoint"));
    }

    let database_id = client.create_database("Smoke", 1_000_000).await?;
    let isolation_database_id = client.create_database("Smoke Isolation", 1_000_000).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: "/Sources/raw/smoke/smoke.md".to_string(),
            kind: NodeKind::Source,
            content: "raw smoke evidence".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: "/Wiki/smoke.md".to_string(),
            kind: NodeKind::File,
            content: "# Smoke\n\nalpha canister smoke [raw](/Sources/raw/smoke/smoke.md)"
                .to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: isolation_database_id.clone(),
            path: "/Sources/raw/smoke/smoke.md".to_string(),
            kind: NodeKind::Source,
            content: "raw isolation evidence".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: isolation_database_id.clone(),
            path: "/Wiki/smoke.md".to_string(),
            kind: NodeKind::File,
            content: "# Isolation\n\nbeta isolated db [raw](/Sources/raw/smoke/smoke.md)"
                .to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;

    assert_database_isolation(&client, &database_id, &isolation_database_id).await?;

    let before_links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: database_id.clone(),
            path: "/Wiki/smoke.md".to_string(),
            limit: 10,
        })
        .await?;
    ensure(
        before_links
            .iter()
            .any(|edge| edge.target_path == "/Sources/raw/smoke/smoke.md"),
        "expected smoke outgoing link before archive",
    )?;

    let archive = client.begin_database_archive(&database_id).await?;
    let archive_bytes =
        read_archive_bytes(&client, &database_id, archive.size_bytes, chunk_size).await?;
    let snapshot_hash = Sha256::digest(&archive_bytes).to_vec();
    client
        .finalize_database_archive(&database_id, snapshot_hash.clone())
        .await?;
    if client
        .read_node(&database_id, "/Wiki/smoke.md")
        .await
        .is_ok()
    {
        return Err(anyhow!("archived database unexpectedly allowed read_node"));
    }
    assert_isolation_database_still_hot(&client, &isolation_database_id).await?;

    client
        .begin_database_restore(&database_id, snapshot_hash.clone(), archive.size_bytes)
        .await?;
    let overflow = client
        .write_database_restore_chunk(DatabaseRestoreChunkRequest {
            database_id: database_id.clone(),
            offset: archive.size_bytes,
            bytes: vec![0],
        })
        .await
        .expect_err("oversized restore chunk should fail");
    if !overflow
        .to_string()
        .contains("restore chunk exceeds expected size")
    {
        return Err(anyhow!("unexpected overflow error: {overflow}"));
    }

    let split_at = archive_bytes.len() / 2;
    client
        .write_database_restore_chunk(DatabaseRestoreChunkRequest {
            database_id: database_id.clone(),
            offset: split_at as u64,
            bytes: archive_bytes[split_at..].to_vec(),
        })
        .await?;
    client
        .write_database_restore_chunk(DatabaseRestoreChunkRequest {
            database_id: database_id.clone(),
            offset: 0,
            bytes: archive_bytes[..split_at].to_vec(),
        })
        .await?;
    client.finalize_database_restore(&database_id).await?;

    let node = client
        .read_node(&database_id, "/Wiki/smoke.md")
        .await?
        .ok_or_else(|| anyhow!("restored smoke node missing"))?;
    if !node.content.contains("alpha canister smoke") {
        return Err(anyhow!("restored smoke node content mismatch"));
    }
    let hits = client
        .search_nodes(SearchNodesRequest {
            database_id: database_id.clone(),
            query_text: "alpha canister smoke".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .await?;
    ensure(
        hits.iter().any(|hit| hit.path == "/Wiki/smoke.md"),
        "restored search should find smoke node",
    )?;
    let restored_links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: database_id.clone(),
            path: "/Wiki/smoke.md".to_string(),
            limit: 10,
        })
        .await?;
    ensure(
        restored_links
            .iter()
            .any(|edge| edge.target_path == "/Sources/raw/smoke/smoke.md"),
        "restored outgoing link should exist",
    )?;
    let info = client
        .list_databases()
        .await?
        .into_iter()
        .find(|info| info.database_id == database_id)
        .ok_or_else(|| anyhow!("smoke database info missing"))?;
    ensure(
        info.status == DatabaseStatus::Hot,
        "smoke database should be hot",
    )?;
    println!("local_canister_archive_restore_smoke ok");
    println!("canister_id={canister_id}");
    println!("database_id={database_id}");
    println!("isolation_database_id={isolation_database_id}");
    println!("archive_size={}", archive.size_bytes);
    println!("chunk_size={chunk_size}");
    println!(
        "chunk_count={}",
        archive_bytes.len().div_ceil(chunk_size as usize)
    );
    Ok(())
}

async fn assert_database_isolation(
    client: &CanisterVfsClient,
    database_id: &str,
    isolation_database_id: &str,
) -> Result<()> {
    let primary = client
        .read_node(database_id, "/Wiki/smoke.md")
        .await?
        .ok_or_else(|| anyhow!("primary smoke node missing"))?;
    let isolated = client
        .read_node(isolation_database_id, "/Wiki/smoke.md")
        .await?
        .ok_or_else(|| anyhow!("isolation smoke node missing"))?;
    ensure(
        primary.content.contains("alpha canister smoke"),
        "primary DB content should remain isolated",
    )?;
    ensure(
        isolated.content.contains("beta isolated db"),
        "isolation DB content should remain isolated",
    )?;
    let primary_hits = client
        .search_nodes(SearchNodesRequest {
            database_id: database_id.to_string(),
            query_text: "beta isolated".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .await?;
    ensure(
        primary_hits.is_empty(),
        "primary DB search should not see isolation DB content",
    )?;
    let isolation_hits = client
        .search_nodes(SearchNodesRequest {
            database_id: isolation_database_id.to_string(),
            query_text: "alpha canister".to_string(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .await?;
    ensure(
        isolation_hits.is_empty(),
        "isolation DB search should not see primary DB content",
    )?;
    Ok(())
}

async fn assert_isolation_database_still_hot(
    client: &CanisterVfsClient,
    isolation_database_id: &str,
) -> Result<()> {
    let isolated = client
        .read_node(isolation_database_id, "/Wiki/smoke.md")
        .await?
        .ok_or_else(|| anyhow!("isolation node disappeared while primary archived"))?;
    ensure(
        isolated.content.contains("beta isolated db"),
        "isolation DB read should survive primary archive",
    )?;
    let links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: isolation_database_id.to_string(),
            path: "/Wiki/smoke.md".to_string(),
            limit: 10,
        })
        .await?;
    ensure(
        links
            .iter()
            .any(|edge| edge.target_path == "/Sources/raw/smoke/smoke.md"),
        "isolation DB links should survive primary archive",
    )?;
    let info = client
        .list_databases()
        .await?
        .into_iter()
        .find(|info| info.database_id == isolation_database_id)
        .ok_or_else(|| anyhow!("isolation database info missing"))?;
    ensure(
        info.status == DatabaseStatus::Hot,
        "isolation DB should remain hot while primary archived",
    )?;
    Ok(())
}

async fn read_archive_bytes(
    client: &CanisterVfsClient,
    database_id: &str,
    size_bytes: u64,
    chunk_size: u32,
) -> Result<Vec<u8>> {
    let mut offset = 0_u64;
    let mut bytes = Vec::new();
    while offset < size_bytes {
        let chunk = client
            .read_database_archive_chunk(database_id, offset, chunk_size)
            .await?
            .bytes;
        ensure(
            !chunk.is_empty(),
            "archive chunk must not be empty before EOF",
        )?;
        offset += chunk.len() as u64;
        bytes.extend(chunk);
    }
    ensure(
        bytes.len() as u64 == size_bytes,
        "archive byte length mismatch",
    )?;
    Ok(bytes)
}

fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(anyhow!(message.to_string()))
    }
}
