// Where: crates/vfs_cli_app/src/bin/vfs_bench/store_latency.rs
// What: Measure read-only Store API latency against a deployed canister.
// Why: Wiki skills should prefer query_context, snapshots, or deltas only when real API costs justify them.
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use candid::Encode;
use clap::ValueEnum;
use serde::Serialize;
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{ExportSnapshotRequest, FetchUpdatesRequest, QueryContextRequest, SearchNodeHit};

use crate::vfs_bench::common::{CallMetric, IoStats, LatencyStats, io_stats, latency_stats};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum StoreLatencyOperation {
    QueryContext,
    ExportSnapshot,
    FetchUpdatesEmpty,
}

#[derive(Clone, Debug)]
pub struct StoreLatencyBenchArgs {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub database_id: String,
    pub namespace: String,
    pub prefix: String,
    pub task: String,
    pub budget_tokens: u32,
    pub include_evidence: bool,
    pub depth: u32,
    pub limit: u32,
    pub iterations: usize,
    pub warmup_iterations: usize,
    pub operation: StoreLatencyOperation,
}

#[derive(Debug, Default, Serialize)]
pub struct StoreLatencyResponseShape {
    pub search_hit_count: usize,
    pub node_count: usize,
    pub evidence_count: usize,
    pub graph_link_count: usize,
    pub snapshot_node_count: usize,
    pub changed_node_count: usize,
    pub removed_path_count: usize,
    pub next_cursor_present: bool,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
pub struct StoreLatencyBenchResult {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub database_id: String,
    pub operation: StoreLatencyOperation,
    pub namespace: String,
    pub prefix: String,
    pub task: String,
    pub budget_tokens: u32,
    pub include_evidence: bool,
    pub depth: u32,
    pub limit: u32,
    pub iterations: usize,
    pub warmup_iterations: usize,
    #[serde(flatten)]
    pub latency: LatencyStats,
    #[serde(flatten)]
    pub io: IoStats,
    pub last_response: StoreLatencyResponseShape,
}

pub async fn run_store_latency_bench(
    args: StoreLatencyBenchArgs,
) -> Result<StoreLatencyBenchResult> {
    let client = Arc::new(CanisterVfsClient::new(&args.replica_host, &args.canister_id).await?);
    let baseline_revision = if args.operation == StoreLatencyOperation::FetchUpdatesEmpty {
        Some(fetch_baseline_revision(&client, &args).await?)
    } else {
        None
    };
    for _ in 0..args.warmup_iterations {
        let _ = run_store_request(&client, &args, baseline_revision.as_deref()).await?;
    }
    measure_store_latency_with_client(client, args, baseline_revision).await
}

async fn measure_store_latency_with_client<C>(
    client: Arc<C>,
    args: StoreLatencyBenchArgs,
    baseline_revision: Option<String>,
) -> Result<StoreLatencyBenchResult>
where
    C: VfsApi + Send + Sync + 'static,
{
    let started_at = Instant::now();
    let mut metrics = Vec::with_capacity(args.iterations);
    let mut last_response = StoreLatencyResponseShape::default();
    for _ in 0..args.iterations {
        let (metric, shape) =
            run_store_request(&client, &args, baseline_revision.as_deref()).await?;
        metrics.push(metric);
        last_response = shape;
    }
    let total_seconds = started_at.elapsed().as_secs_f64();
    let latency = latency_stats(
        &metrics
            .iter()
            .map(|metric| metric.latency_us)
            .collect::<Vec<_>>(),
        total_seconds,
    );
    let io = io_stats(&metrics);
    Ok(StoreLatencyBenchResult {
        benchmark_name: args.benchmark_name,
        replica_host: args.replica_host,
        canister_id: args.canister_id,
        database_id: args.database_id,
        operation: args.operation,
        namespace: args.namespace,
        prefix: args.prefix,
        task: args.task,
        budget_tokens: args.budget_tokens,
        include_evidence: args.include_evidence,
        depth: args.depth,
        limit: args.limit,
        iterations: args.iterations,
        warmup_iterations: args.warmup_iterations,
        latency,
        io,
        last_response,
    })
}

async fn run_store_request<C>(
    client: &Arc<C>,
    args: &StoreLatencyBenchArgs,
    baseline_revision: Option<&str>,
) -> Result<(CallMetric, StoreLatencyResponseShape)>
where
    C: VfsApi + Send + Sync + 'static,
{
    let started_at = Instant::now();
    match args.operation {
        StoreLatencyOperation::QueryContext => {
            let request = QueryContextRequest {
                database_id: args.database_id.clone(),
                task: args.task.clone(),
                entities: query_entities(&args.task),
                namespace: Some(args.namespace.clone()),
                budget_tokens: args.budget_tokens,
                include_evidence: args.include_evidence,
                depth: args.depth,
            };
            let response = client.query_context(request.clone()).await?;
            let metric = CallMetric {
                latency_us: started_at.elapsed().as_micros() as u64,
                request_payload_bytes: encoded_len(&request),
                response_payload_bytes: encoded_len(&response),
            };
            let shape = StoreLatencyResponseShape {
                search_hit_count: response.search_hits.len(),
                node_count: response.nodes.len(),
                evidence_count: response.evidence.len(),
                graph_link_count: response.graph_links.len(),
                truncated: response.truncated,
                ..StoreLatencyResponseShape::default()
            };
            Ok((metric, shape))
        }
        StoreLatencyOperation::ExportSnapshot => {
            let request = export_snapshot_request(args, None);
            let response = client.export_snapshot(request.clone()).await?;
            let metric = CallMetric {
                latency_us: started_at.elapsed().as_micros() as u64,
                request_payload_bytes: encoded_len(&request),
                response_payload_bytes: encoded_len(&response),
            };
            let shape = StoreLatencyResponseShape {
                snapshot_node_count: response.nodes.len(),
                next_cursor_present: response.next_cursor.is_some(),
                ..StoreLatencyResponseShape::default()
            };
            Ok((metric, shape))
        }
        StoreLatencyOperation::FetchUpdatesEmpty => {
            let request = FetchUpdatesRequest {
                database_id: args.database_id.clone(),
                known_snapshot_revision: baseline_revision
                    .expect("fetch_updates benchmark requires a baseline snapshot")
                    .to_string(),
                prefix: Some(args.prefix.clone()),
                limit: args.limit,
                cursor: None,
                target_snapshot_revision: None,
            };
            let response = client.fetch_updates(request.clone()).await?;
            let metric = CallMetric {
                latency_us: started_at.elapsed().as_micros() as u64,
                request_payload_bytes: encoded_len(&request),
                response_payload_bytes: encoded_len(&response),
            };
            let shape = StoreLatencyResponseShape {
                changed_node_count: response.changed_nodes.len(),
                removed_path_count: response.removed_paths.len(),
                next_cursor_present: response.next_cursor.is_some(),
                ..StoreLatencyResponseShape::default()
            };
            Ok((metric, shape))
        }
    }
}

async fn fetch_baseline_revision<C>(client: &Arc<C>, args: &StoreLatencyBenchArgs) -> Result<String>
where
    C: VfsApi + Send + Sync + 'static,
{
    let response = client
        .export_snapshot(export_snapshot_request(args, None))
        .await?;
    Ok(response.snapshot_revision)
}

fn export_snapshot_request(
    args: &StoreLatencyBenchArgs,
    snapshot_revision: Option<String>,
) -> ExportSnapshotRequest {
    ExportSnapshotRequest {
        database_id: args.database_id.clone(),
        prefix: Some(args.prefix.clone()),
        limit: args.limit,
        cursor: None,
        snapshot_revision,
        snapshot_session_id: None,
    }
}

fn query_entities(task: &str) -> Vec<String> {
    task.split_whitespace()
        .take(4)
        .map(ToString::to_string)
        .collect()
}

fn encoded_len<T: candid::CandidType>(value: &T) -> u64 {
    Encode!(value).expect("encode should succeed").len() as u64
}

#[allow(dead_code)]
fn _assert_search_hit_is_candid(_: &SearchNodeHit) {}
