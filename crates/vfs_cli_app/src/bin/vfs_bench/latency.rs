// Where: crates/vfs_cli_app/src/bin/vfs_bench/latency.rs
// What: Run deployed-canister mutation latency benchmarks with optional isolated setup/measure phases.
// Why: We need to separate seed cost from measured request cost when reading cycles per request.
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Result, anyhow};
use candid::Encode;
use serde::Serialize;
use vfs_client::{CanisterVfsClient, VfsApi};
use vfs_types::{AppendNodeRequest, MkdirNodeRequest, NodeKind, WriteNodeRequest};

use crate::vfs_bench::common::{
    CallMetric, LatencyOperation, MeasurementMode, SetupStats, io_stats, latency_stats,
    make_payload,
};

#[derive(Clone, Debug)]
pub struct LatencyBenchArgs {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub prefix: String,
    pub database_id: String,
    pub payload_size_bytes: usize,
    pub iterations: usize,
    pub warmup_iterations: usize,
    pub operation: LatencyOperation,
    pub measurement_mode: MeasurementMode,
}

#[derive(Debug, Serialize)]
pub struct LatencyBenchResult {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub prefix: String,
    pub database_id: String,
    pub operation: LatencyOperation,
    pub measurement_mode: MeasurementMode,
    pub payload_size_bytes: usize,
    pub iterations: usize,
    pub warmup_iterations: usize,
    pub request_count: usize,
    pub total_seconds: f64,
    pub avg_latency_us: f64,
    pub p50_latency_us: u64,
    pub p95_latency_us: u64,
    pub p99_latency_us: u64,
    pub total_request_payload_bytes: u64,
    pub total_response_payload_bytes: u64,
    pub avg_request_payload_bytes: u64,
    pub avg_response_payload_bytes: u64,
}

pub async fn run_latency_bench(args: LatencyBenchArgs) -> Result<LatencyBenchResult> {
    let client = Arc::new(CanisterVfsClient::new(&args.replica_host, &args.canister_id).await?);
    seed_latency_base_node(&client, &args).await?;
    for _ in 0..args.warmup_iterations {
        let current = current_latency_etag(&client, &args).await?;
        let _ = run_latency_request(&client, &args, &current).await?;
    }
    measure_latency_with_client(client, args).await
}

pub async fn setup_latency_bench(args: LatencyBenchArgs) -> Result<SetupStats> {
    let client = Arc::new(CanisterVfsClient::new(&args.replica_host, &args.canister_id).await?);
    seed_latency_base_node(&client, &args).await?;
    Ok(SetupStats { request_count: 1 })
}

pub async fn measure_latency_bench(args: LatencyBenchArgs) -> Result<LatencyBenchResult> {
    let client = Arc::new(CanisterVfsClient::new(&args.replica_host, &args.canister_id).await?);
    measure_latency_with_client(client, args).await
}

async fn measure_latency_with_client<C>(
    client: Arc<C>,
    args: LatencyBenchArgs,
) -> Result<LatencyBenchResult>
where
    C: VfsApi + Send + Sync + 'static,
{
    let mut current_etag = current_latency_etag(&client, &args).await?;
    let started_at = Instant::now();
    let mut metrics = Vec::with_capacity(args.iterations);
    for _ in 0..args.iterations {
        let (metric, next_etag) = run_latency_request(&client, &args, &current_etag).await?;
        metrics.push(metric);
        current_etag = next_etag;
    }
    let total_seconds = started_at.elapsed().as_secs_f64();
    let stats = latency_stats(
        &metrics
            .iter()
            .map(|metric| metric.latency_us)
            .collect::<Vec<_>>(),
        total_seconds,
    );
    let io = io_stats(&metrics);
    Ok(LatencyBenchResult {
        benchmark_name: args.benchmark_name,
        replica_host: args.replica_host,
        canister_id: args.canister_id,
        prefix: args.prefix,
        database_id: args.database_id,
        operation: args.operation,
        measurement_mode: args.measurement_mode,
        payload_size_bytes: args.payload_size_bytes,
        iterations: args.iterations,
        warmup_iterations: args.warmup_iterations,
        request_count: stats.request_count,
        total_seconds: stats.total_seconds,
        avg_latency_us: stats.avg_latency_us,
        p50_latency_us: stats.p50_latency_us,
        p95_latency_us: stats.p95_latency_us,
        p99_latency_us: stats.p99_latency_us,
        total_request_payload_bytes: io.total_request_payload_bytes,
        total_response_payload_bytes: io.total_response_payload_bytes,
        avg_request_payload_bytes: io.avg_request_payload_bytes,
        avg_response_payload_bytes: io.avg_response_payload_bytes,
    })
}

async fn seed_latency_base_node<C>(client: &Arc<C>, args: &LatencyBenchArgs) -> Result<()>
where
    C: VfsApi + Send + Sync + 'static,
{
    let database_id = args.database_id.clone();
    ensure_parent_folders(client, &database_id, &latency_path(args)).await?;
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: latency_path(args),
            kind: NodeKind::File,
            content: seed_payload(args).to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .await?;
    Ok(())
}

async fn ensure_parent_folders<C>(client: &Arc<C>, database_id: &str, path: &str) -> Result<()>
where
    C: VfsApi + Send + Sync + 'static,
{
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

async fn current_latency_etag<C>(client: &Arc<C>, args: &LatencyBenchArgs) -> Result<String>
where
    C: VfsApi + Send + Sync + 'static,
{
    let database_id = args.database_id.clone();
    client
        .read_node(&database_id, &latency_path(args))
        .await?
        .map(|node| node.etag)
        .ok_or_else(|| anyhow!("missing seeded node for {}", args.benchmark_name))
}

async fn run_latency_request<C>(
    client: &Arc<C>,
    args: &LatencyBenchArgs,
    current_etag: &str,
) -> Result<(CallMetric, String)>
where
    C: VfsApi + Send + Sync + 'static,
{
    let started_at = Instant::now();
    let payload = make_payload(args.payload_size_bytes);
    let database_id = args.database_id.clone();
    let (request_bytes, response_bytes, next_etag) = match args.operation {
        LatencyOperation::WriteNode => {
            let request = WriteNodeRequest {
                database_id: database_id.clone(),
                path: latency_path(args),
                kind: NodeKind::File,
                content: payload,
                metadata_json: "{}".to_string(),
                expected_etag: Some(current_etag.to_string()),
            };
            client.write_node(request.clone()).await.map(|result| {
                (
                    encoded_len(&request),
                    encoded_len(&result),
                    result.node.etag,
                )
            })?
        }
        LatencyOperation::AppendNode => {
            let request = AppendNodeRequest {
                database_id: database_id.clone(),
                path: latency_path(args),
                content: payload,
                expected_etag: Some(current_etag.to_string()),
                separator: None,
                metadata_json: None,
                kind: None,
            };
            client.append_node(request.clone()).await.map(|result| {
                (
                    encoded_len(&request),
                    encoded_len(&result),
                    result.node.etag,
                )
            })?
        }
    };
    Ok((
        CallMetric {
            latency_us: started_at.elapsed().as_micros() as u64,
            request_payload_bytes: request_bytes,
            response_payload_bytes: response_bytes,
        },
        next_etag,
    ))
}

fn latency_path(args: &LatencyBenchArgs) -> String {
    format!("{}/measure/node.md", args.prefix)
}

fn seed_payload(args: &LatencyBenchArgs) -> &'static str {
    match args.operation {
        LatencyOperation::WriteNode => "",
        LatencyOperation::AppendNode => "seed",
    }
}

fn encoded_len<T: candid::CandidType>(value: &T) -> u64 {
    Encode!(value).expect("encode should succeed").len() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use vfs_client::VfsApi;
    use vfs_types::{
        DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListNodesRequest, MkdirNodeRequest, MkdirNodeResult,
        MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, NodeKind, NodeMutationAck, RecentNodeHit, RecentNodesRequest, SearchNodeHit,
        SearchNodePathsRequest, SearchNodesRequest, Status,
    };

    #[derive(Default)]
    struct MockClient {
        next_etag: Mutex<u64>,
        nodes: Mutex<HashMap<String, Node>>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            unreachable!()
        }
        async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.lock().unwrap().get(path).cloned())
        }
        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            unreachable!()
        }
        async fn list_children(
            &self,
            _request: vfs_types::ListChildrenRequest,
        ) -> Result<Vec<vfs_types::ChildNode>> {
            unreachable!()
        }
        async fn write_node(
            &self,
            request: WriteNodeRequest,
        ) -> Result<vfs_types::WriteNodeResult> {
            let mut next = self.next_etag.lock().unwrap();
            *next += 1;
            let node = Node {
                path: request.path.clone(),
                kind: request.kind,
                content: request.content,
                created_at: 1,
                updated_at: 2,
                etag: format!("etag-{next}"),
                metadata_json: request.metadata_json,
            };
            self.nodes
                .lock()
                .unwrap()
                .insert(request.path, node.clone());
            Ok(vfs_types::WriteNodeResult {
                node: NodeMutationAck {
                    path: node.path,
                    kind: node.kind,
                    updated_at: node.updated_at,
                    etag: node.etag,
                },
                created: true,
            })
        }
        async fn append_node(
            &self,
            request: AppendNodeRequest,
        ) -> Result<vfs_types::WriteNodeResult> {
            let current = self
                .nodes
                .lock()
                .unwrap()
                .get(&request.path)
                .cloned()
                .unwrap();
            self.write_node(WriteNodeRequest {
                database_id: request.database_id.clone(),
                path: request.path,
                kind: NodeKind::File,
                content: format!("{}{}", current.content, request.content),
                metadata_json: current.metadata_json,
                expected_etag: request.expected_etag,
            })
            .await
        }
        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }
        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unreachable!()
        }
        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unreachable!()
        }
        async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            Ok(MkdirNodeResult {
                path: request.path,
                created: true,
            })
        }
        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }
        async fn recent_nodes(&self, _request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            unreachable!()
        }
        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }
        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }
        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unreachable!()
        }
        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unreachable!()
        }
    }

    fn args(operation: LatencyOperation) -> LatencyBenchArgs {
        LatencyBenchArgs {
            database_id: "default".to_string(),
            benchmark_name: "latency".to_string(),
            replica_host: "http://127.0.0.1:8000".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            prefix: "/Wiki/bench".to_string(),
            payload_size_bytes: 1024,
            iterations: 3,
            warmup_iterations: 0,
            operation,
            measurement_mode: MeasurementMode::IsolatedSingleOp,
        }
    }

    #[tokio::test]
    async fn isolated_latency_setup_and_measure_split_cleanly() {
        let client = Arc::new(MockClient::default());
        let workload = args(LatencyOperation::WriteNode);
        seed_latency_base_node(&client, &workload).await.unwrap();
        let result = measure_latency_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        assert_eq!(result.request_count, 3);
        assert!(result.avg_response_payload_bytes > 0);
    }
}
