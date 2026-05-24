// Where: crates/vfs_cli_app/src/bin/local_canister_archive_restore_smoke.rs
// What: Manual local-canister archive/restore smoke over vfs_client.
// Why: Byte-range SQLite archive flows need an end-to-end canister check outside unit tests.
use std::{env, fs, path::Path};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{
    DatabaseRestoreChunkRequest, DatabaseStatus, MkdirNodeRequest, NodeKind, OutgoingLinksRequest,
    SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

const PRIMARY_SOURCE_PATH: &str = "/Sources/raw/smoke/smoke.md";
const PRIMARY_WIKI_PATH: &str = "/Wiki/smoke.md";
const PRIMARY_CONTENT_MARKER: &str = "alpha canister smoke";
const PRIMARY_QUERY: &str = "alpha canister";
const CJK_CONTENT_MARKER: &str = "検索精度改善";
const CJK_QUERY: &str = "検索精度改善";
const ISOLATION_CONTENT_MARKER: &str = "beta isolated db";

#[derive(Debug)]
struct SmokeArgs {
    state_output: Option<String>,
    verify_state: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SmokeState {
    canister_id: String,
    database_id: String,
    isolation_database_id: String,
    wiki_path: String,
    source_path: String,
    content_marker: String,
    query_text: String,
    cjk_query_text: String,
    isolation_content_marker: String,
    archive_size: u64,
    chunk_size: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
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
    assert_memory_manifest(&client).await?;
    if let Some(path) = args.verify_state {
        let state = read_state(&path)?;
        verify_smoke_state(&client, &state).await?;
        println!("local_canister_archive_restore_smoke verify ok");
        println!("canister_id={}", state.canister_id);
        println!("database_id={}", state.database_id);
        println!("isolation_database_id={}", state.isolation_database_id);
        return Ok(());
    }
    let state = run_create_restore_smoke(&client, &canister_id, chunk_size).await?;
    if let Some(path) = args.state_output {
        write_state(&path, &state)?;
    }
    Ok(())
}

fn parse_args() -> Result<SmokeArgs> {
    let mut state_output = None;
    let mut verify_state = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--state-output" => {
                state_output = Some(
                    args.next()
                        .ok_or_else(|| anyhow!("--state-output requires a path"))?,
                );
            }
            "--verify-state" => {
                verify_state = Some(
                    args.next()
                        .ok_or_else(|| anyhow!("--verify-state requires a path"))?,
                );
            }
            _ => return Err(anyhow!("unknown argument: {arg}")),
        }
    }
    if state_output.is_some() && verify_state.is_some() {
        return Err(anyhow!(
            "--state-output and --verify-state cannot be used together"
        ));
    }
    Ok(SmokeArgs {
        state_output,
        verify_state,
    })
}

async fn assert_memory_manifest(client: &CanisterVfsClient) -> Result<()> {
    let manifest = client.memory_manifest().await?;
    if manifest.recommended_entrypoint != "query_context" {
        return Err(anyhow!("unexpected memory manifest entrypoint"));
    }
    Ok(())
}

async fn run_create_restore_smoke(
    client: &CanisterVfsClient,
    canister_id: &str,
    chunk_size: u32,
) -> Result<SmokeState> {
    let database_id = client.create_database("Archive smoke").await?.database_id;
    let isolation_database_id = client
        .create_database("Archive smoke isolation")
        .await?
        .database_id;
    ensure_parent_folders(client, &database_id, PRIMARY_SOURCE_PATH).await?;
    ensure_parent_folders(client, &isolation_database_id, PRIMARY_SOURCE_PATH).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: PRIMARY_SOURCE_PATH.to_string(),
            kind: NodeKind::Source,
            content: "raw smoke evidence".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: PRIMARY_WIKI_PATH.to_string(),
            kind: NodeKind::File,
            content: format!(
                "# Smoke\n\n{PRIMARY_CONTENT_MARKER} {CJK_CONTENT_MARKER} [raw]({PRIMARY_SOURCE_PATH})"
            ),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: isolation_database_id.clone(),
            path: PRIMARY_SOURCE_PATH.to_string(),
            kind: NodeKind::Source,
            content: "raw isolation evidence".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    client
        .write_node(WriteNodeRequest {
            database_id: isolation_database_id.clone(),
            path: PRIMARY_WIKI_PATH.to_string(),
            kind: NodeKind::File,
            content: format!(
                "# Isolation\n\n{ISOLATION_CONTENT_MARKER} [raw]({PRIMARY_SOURCE_PATH})"
            ),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;

    assert_database_isolation(client, &database_id, &isolation_database_id).await?;

    let before_links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: database_id.clone(),
            path: PRIMARY_WIKI_PATH.to_string(),
            limit: 10,
        })
        .await?;
    ensure(
        before_links
            .iter()
            .any(|edge| edge.target_path == PRIMARY_SOURCE_PATH),
        "expected smoke outgoing link before archive",
    )?;

    let archive = client.begin_database_archive(&database_id).await?;
    let archive_bytes =
        read_archive_bytes(client, &database_id, archive.size_bytes, chunk_size).await?;
    let snapshot_hash = Sha256::digest(&archive_bytes).to_vec();
    client
        .finalize_database_archive(&database_id, snapshot_hash.clone())
        .await?;
    if client
        .read_node(&database_id, PRIMARY_WIKI_PATH)
        .await
        .is_ok()
    {
        return Err(anyhow!("archived database unexpectedly allowed read_node"));
    }
    assert_isolation_database_still_hot(client, &isolation_database_id).await?;

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

    let state = SmokeState {
        canister_id: canister_id.to_string(),
        database_id: database_id.clone(),
        isolation_database_id: isolation_database_id.clone(),
        wiki_path: PRIMARY_WIKI_PATH.to_string(),
        source_path: PRIMARY_SOURCE_PATH.to_string(),
        content_marker: PRIMARY_CONTENT_MARKER.to_string(),
        query_text: PRIMARY_QUERY.to_string(),
        cjk_query_text: CJK_QUERY.to_string(),
        isolation_content_marker: ISOLATION_CONTENT_MARKER.to_string(),
        archive_size: archive.size_bytes,
        chunk_size,
    };
    verify_smoke_state(client, &state).await?;
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
    Ok(state)
}

async fn ensure_parent_folders(
    client: &CanisterVfsClient,
    database_id: &str,
    path: &str,
) -> Result<()> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        client
            .mkdir_node(MkdirNodeRequest {
                database_id: database_id.to_string(),
                path: current.clone(),
            })
            .await?;
    }
    Ok(())
}

async fn verify_smoke_state(client: &CanisterVfsClient, state: &SmokeState) -> Result<()> {
    assert_primary_database_restored(client, state).await?;
    assert_isolation_database_still_hot(client, &state.isolation_database_id).await?;
    assert_database_isolation(client, &state.database_id, &state.isolation_database_id).await
}

async fn assert_primary_database_restored(
    client: &CanisterVfsClient,
    state: &SmokeState,
) -> Result<()> {
    let node = client
        .read_node(&state.database_id, &state.wiki_path)
        .await?
        .ok_or_else(|| anyhow!("restored smoke node missing"))?;
    if !node.content.contains(&state.content_marker) {
        return Err(anyhow!("restored smoke node content mismatch"));
    }
    let hits = client
        .search_nodes(SearchNodesRequest {
            database_id: state.database_id.clone(),
            query_text: state.query_text.clone(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .await?;
    ensure(
        hits.iter().any(|hit| hit.path == state.wiki_path),
        "restored search should find smoke node",
    )?;
    let cjk_hits = client
        .search_nodes(SearchNodesRequest {
            database_id: state.database_id.clone(),
            query_text: state.cjk_query_text.clone(),
            prefix: Some("/Wiki".to_string()),
            top_k: 10,
            preview_mode: Some(SearchPreviewMode::None),
        })
        .await?;
    ensure(
        cjk_hits.iter().any(|hit| hit.path == state.wiki_path),
        "restored CJK search should find smoke node",
    )?;
    let restored_links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: state.database_id.clone(),
            path: state.wiki_path.clone(),
            limit: 10,
        })
        .await?;
    ensure(
        restored_links
            .iter()
            .any(|edge| edge.target_path == state.source_path),
        "restored outgoing link should exist",
    )?;
    let info = client
        .list_databases()
        .await?
        .into_iter()
        .find(|info| info.database_id == state.database_id)
        .ok_or_else(|| anyhow!("smoke database info missing"))?;
    ensure(
        info.status == DatabaseStatus::Hot,
        "smoke database should be hot",
    )?;
    Ok(())
}

async fn assert_database_isolation(
    client: &CanisterVfsClient,
    database_id: &str,
    isolation_database_id: &str,
) -> Result<()> {
    let primary = client
        .read_node(database_id, PRIMARY_WIKI_PATH)
        .await?
        .ok_or_else(|| anyhow!("primary smoke node missing"))?;
    let isolated = client
        .read_node(isolation_database_id, PRIMARY_WIKI_PATH)
        .await?
        .ok_or_else(|| anyhow!("isolation smoke node missing"))?;
    ensure(
        primary.content.contains(PRIMARY_CONTENT_MARKER),
        "primary DB content should remain isolated",
    )?;
    ensure(
        isolated.content.contains(ISOLATION_CONTENT_MARKER),
        "isolation DB content should remain isolated",
    )?;
    let primary_hits = client
        .search_nodes(SearchNodesRequest {
            database_id: database_id.to_string(),
            query_text: ISOLATION_CONTENT_MARKER.to_string(),
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
            query_text: PRIMARY_QUERY.to_string(),
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
        .read_node(isolation_database_id, PRIMARY_WIKI_PATH)
        .await?
        .ok_or_else(|| anyhow!("isolation node disappeared while primary archived"))?;
    ensure(
        isolated.content.contains(ISOLATION_CONTENT_MARKER),
        "isolation DB read should survive primary archive",
    )?;
    let links = client
        .outgoing_links(OutgoingLinksRequest {
            database_id: isolation_database_id.to_string(),
            path: PRIMARY_WIKI_PATH.to_string(),
            limit: 10,
        })
        .await?;
    ensure(
        links
            .iter()
            .any(|edge| edge.target_path == PRIMARY_SOURCE_PATH),
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

fn read_state(path: &str) -> Result<SmokeState> {
    let bytes = fs::read(path).with_context(|| format!("failed to read smoke state: {path}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("failed to parse smoke state: {path}"))
}

fn write_state(path: &str, state: &SmokeState) -> Result<()> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create smoke state directory: {}",
                parent.display()
            )
        })?;
    }
    let bytes = serde_json::to_vec_pretty(state).context("failed to serialize smoke state")?;
    fs::write(path, bytes).with_context(|| format!("failed to write smoke state: {path}"))
}

fn ensure(condition: bool, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(anyhow!(message.to_string()))
    }
}
