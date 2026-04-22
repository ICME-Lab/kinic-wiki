// Where: crates/wiki_cli/src/bin/vfs_bench/workload.rs
// What: Run API-centric deployed-canister benchmark scenarios over the real wiki methods.
// Why: The benchmark must honor the configured file set, concurrency, and warmup requests.
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Result, anyhow, ensure};
use candid::Encode;
use serde::Serialize;
use tokio::sync::Mutex;
use tokio::task::JoinSet;
use wiki_cli::client::{CanisterWikiClient, WikiApi};
use wiki_types::{
    AppendNodeRequest, DeleteNodeRequest, EditNodeRequest, GlobNodeType, GlobNodesRequest,
    ListNodesRequest, MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeKind,
    RecentNodesRequest, SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

use crate::vfs_bench::common::{
    CallMetric, DirectoryShape, MeasurementMode, SetupStats, WorkloadOperation,
    cross_dir_renamed_path, file_path, glob_pattern, io_stats, latency_stats, list_prefix,
    make_editable_payload, make_multi_editable_payload, make_payload, make_searchable_payload,
    openai_tool_for_workload, same_dir_renamed_path,
};

#[derive(Clone, Debug)]
pub struct WorkloadBenchArgs {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub prefix: String,
    pub payload_size_bytes: usize,
    pub file_count: usize,
    pub directory_shape: DirectoryShape,
    pub concurrent_clients: usize,
    pub iterations: usize,
    pub warmup_iterations: usize,
    pub operation: WorkloadOperation,
    pub measurement_mode: MeasurementMode,
    pub preview_mode: SearchPreviewMode,
}

#[derive(Debug, Serialize)]
pub struct WorkloadBenchResult {
    pub benchmark_name: String,
    pub replica_host: String,
    pub canister_id: String,
    pub prefix: String,
    pub operation: WorkloadOperation,
    /// OpenAI-compatible tool name (see `agent_tools::tool_names_slice`).
    pub openai_tool: String,
    /// Sub-variant when one tool maps to multiple workload operations (e.g. `write` + `create`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_tool_variant: Option<String>,
    pub measurement_mode: MeasurementMode,
    pub directory_shape: DirectoryShape,
    pub payload_size_bytes: usize,
    pub file_count: usize,
    pub concurrent_clients: usize,
    pub iterations: usize,
    pub warmup_iterations: usize,
    pub preview_mode: SearchPreviewMode,
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

fn openai_tool_fields(op: WorkloadOperation) -> (String, Option<String>) {
    let (tool, variant) = openai_tool_for_workload(op);
    (tool.to_string(), variant.map(String::from))
}

pub async fn run_workload_bench(args: WorkloadBenchArgs) -> Result<WorkloadBenchResult> {
    let client = Arc::new(CanisterWikiClient::new(&args.replica_host, &args.canister_id).await?);
    run_workload_bench_with_client(client, args).await
}

pub async fn setup_workload_bench(args: WorkloadBenchArgs) -> Result<SetupStats> {
    let client = Arc::new(CanisterWikiClient::new(&args.replica_host, &args.canister_id).await?);
    setup_workload_with_client(client, &args).await
}

pub async fn measure_workload_bench(args: WorkloadBenchArgs) -> Result<WorkloadBenchResult> {
    let client = Arc::new(CanisterWikiClient::new(&args.replica_host, &args.canister_id).await?);
    measure_workload_with_client(client, args).await
}

async fn run_workload_bench_with_client<C>(
    client: Arc<C>,
    args: WorkloadBenchArgs,
) -> Result<WorkloadBenchResult>
where
    C: WikiApi + Send + Sync + 'static,
{
    if args.warmup_iterations > 0 {
        let warmup_args = phase_args(
            &args,
            format!("{}/__warmup", args.prefix),
            args.warmup_iterations,
        );
        let _ = run_operation(&client, &warmup_args).await?;
    }
    let started_at = Instant::now();
    let metrics = run_operation(&client, &args).await?;
    let total_seconds = started_at.elapsed().as_secs_f64();
    let latency = latency_stats(
        &metrics
            .iter()
            .map(|metric| metric.latency_us)
            .collect::<Vec<_>>(),
        total_seconds,
    );
    let io = io_stats(&metrics);
    let (openai_tool, openai_tool_variant) = openai_tool_fields(args.operation);
    Ok(WorkloadBenchResult {
        benchmark_name: args.benchmark_name,
        replica_host: args.replica_host,
        canister_id: args.canister_id,
        prefix: args.prefix,
        operation: args.operation,
        openai_tool,
        openai_tool_variant,
        measurement_mode: args.measurement_mode,
        directory_shape: args.directory_shape,
        payload_size_bytes: args.payload_size_bytes,
        file_count: args.file_count,
        concurrent_clients: args.concurrent_clients,
        iterations: args.iterations,
        warmup_iterations: args.warmup_iterations,
        preview_mode: args.preview_mode,
        request_count: latency.request_count,
        total_seconds: latency.total_seconds,
        avg_latency_us: latency.avg_latency_us,
        p50_latency_us: latency.p50_latency_us,
        p95_latency_us: latency.p95_latency_us,
        p99_latency_us: latency.p99_latency_us,
        total_request_payload_bytes: io.total_request_payload_bytes,
        total_response_payload_bytes: io.total_response_payload_bytes,
        avg_request_payload_bytes: io.avg_request_payload_bytes,
        avg_response_payload_bytes: io.avg_response_payload_bytes,
    })
}

async fn setup_workload_with_client<C>(
    client: Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<SetupStats>
where
    C: WikiApi + Send + Sync + 'static,
{
    let request_count = match args.operation {
        WorkloadOperation::Create => 0,
        WorkloadOperation::Update => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::Append => seed_nodes(&client, args, "seed", node_count(args)?)
            .await?
            .len(),
        WorkloadOperation::Edit => seed_nodes(
            &client,
            args,
            &make_editable_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::MoveSameDir | WorkloadOperation::MoveCrossDir => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::Delete => {
            let count = delete_seed_count(args)?;
            seed_nodes(&client, args, &make_payload(args.payload_size_bytes), count)
                .await?
                .len()
        }
        WorkloadOperation::Read => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::List => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::Search => {
            seed_search_nodes(&client, args, node_count(args)?).await?;
            node_count(args)?
        }
        WorkloadOperation::Mkdir => 0,
        WorkloadOperation::Glob => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::Recent => seed_nodes(
            &client,
            args,
            &make_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
        WorkloadOperation::MultiEdit => seed_nodes(
            &client,
            args,
            &make_multi_editable_payload(args.payload_size_bytes),
            node_count(args)?,
        )
        .await?
        .len(),
    };
    Ok(SetupStats { request_count })
}

async fn measure_workload_with_client<C>(
    client: Arc<C>,
    args: WorkloadBenchArgs,
) -> Result<WorkloadBenchResult>
where
    C: WikiApi + Send + Sync + 'static,
{
    let started_at = Instant::now();
    let metrics = run_isolated_operation(&client, &args).await?;
    let total_seconds = started_at.elapsed().as_secs_f64();
    let latency = latency_stats(
        &metrics
            .iter()
            .map(|metric| metric.latency_us)
            .collect::<Vec<_>>(),
        total_seconds,
    );
    let io = io_stats(&metrics);
    let (openai_tool, openai_tool_variant) = openai_tool_fields(args.operation);
    Ok(WorkloadBenchResult {
        benchmark_name: args.benchmark_name,
        replica_host: args.replica_host,
        canister_id: args.canister_id,
        prefix: args.prefix,
        operation: args.operation,
        openai_tool,
        openai_tool_variant,
        measurement_mode: args.measurement_mode,
        directory_shape: args.directory_shape,
        payload_size_bytes: args.payload_size_bytes,
        file_count: args.file_count,
        concurrent_clients: args.concurrent_clients,
        iterations: args.iterations,
        preview_mode: args.preview_mode,
        warmup_iterations: args.warmup_iterations,
        request_count: latency.request_count,
        total_seconds: latency.total_seconds,
        avg_latency_us: latency.avg_latency_us,
        p50_latency_us: latency.p50_latency_us,
        p95_latency_us: latency.p95_latency_us,
        p99_latency_us: latency.p99_latency_us,
        total_request_payload_bytes: io.total_request_payload_bytes,
        total_response_payload_bytes: io.total_response_payload_bytes,
        avg_request_payload_bytes: io.avg_request_payload_bytes,
        avg_response_payload_bytes: io.avg_response_payload_bytes,
    })
}

fn phase_args(args: &WorkloadBenchArgs, prefix: String, iterations: usize) -> WorkloadBenchArgs {
    let mut clone = args.clone();
    clone.prefix = prefix;
    clone.iterations = iterations;
    clone.warmup_iterations = 0;
    clone
}

async fn run_operation<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    match args.operation {
        WorkloadOperation::Create => run_create(client, args).await,
        WorkloadOperation::Update => run_update(client, args).await,
        WorkloadOperation::Append => run_append(client, args).await,
        WorkloadOperation::Edit => run_edit(client, args).await,
        WorkloadOperation::MoveSameDir => run_move(client, args, false).await,
        WorkloadOperation::MoveCrossDir => run_move(client, args, true).await,
        WorkloadOperation::Delete => run_delete(client, args).await,
        WorkloadOperation::Read => run_read(client, args).await,
        WorkloadOperation::List => run_list(client, args).await,
        WorkloadOperation::Search => run_search(client, args).await,
        WorkloadOperation::Mkdir => run_mkdir(client, args).await,
        WorkloadOperation::Glob => run_glob(client, args).await,
        WorkloadOperation::Recent => run_recent(client, args).await,
        WorkloadOperation::MultiEdit => run_multi_edit(client, args).await,
    }
}

async fn run_isolated_operation<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    match args.operation {
        WorkloadOperation::Create => run_create(client, args).await,
        WorkloadOperation::Update => run_update_from_seed(client, args).await,
        WorkloadOperation::Append => run_append_from_seed(client, args).await,
        WorkloadOperation::Edit => run_edit_from_seed(client, args).await,
        WorkloadOperation::MoveSameDir => run_move_from_seed(client, args, false).await,
        WorkloadOperation::MoveCrossDir => run_move_from_seed(client, args, true).await,
        WorkloadOperation::Delete => run_delete_from_seed(client, args).await,
        WorkloadOperation::Read => run_read_from_seed(client, args).await,
        WorkloadOperation::List => run_list_from_seed(client, args).await,
        WorkloadOperation::Search => run_search_from_seed(client, args).await,
        WorkloadOperation::Mkdir => run_mkdir_from_seed(client, args).await,
        WorkloadOperation::Glob => run_glob_from_seed(client, args).await,
        WorkloadOperation::Recent => run_recent_from_seed(client, args).await,
        WorkloadOperation::MultiEdit => run_multi_edit_from_seed(client, args).await,
    }
}

async fn run_create<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let payload = make_payload(args.payload_size_bytes);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let prefix = prefix.clone();
        let payload = payload.clone();
        async move {
            let request = WriteNodeRequest {
                path: format!("{prefix}/create-{index:06}.md"),
                kind: NodeKind::File,
                content: payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            };
            let started_at = Instant::now();
            let result = client.write_node(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_update<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let base = make_payload(args.payload_size_bytes);
    let updated = updated_payload(&base);
    let states = Arc::new(seed_states(client, args, &base, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let base = base.clone();
        let updated = updated.clone();
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let content = if state.toggle {
                updated.clone()
            } else {
                base.clone()
            };
            let request = WriteNodeRequest {
                path,
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let result = client.write_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_append<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let base = "seed".to_string();
    let append = make_payload(args.payload_size_bytes);
    let states = Arc::new(seed_states(client, args, &base, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let append = append.clone();
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let request = AppendNodeRequest {
                path,
                content: append,
                expected_etag: Some(state.etag.clone()),
                separator: None,
                metadata_json: None,
                kind: None,
            };
            let started_at = Instant::now();
            let result = client.append_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_edit<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let base = make_editable_payload(args.payload_size_bytes);
    let states = Arc::new(seed_states(client, args, &base, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let (old_text, new_text) = if state.toggle {
                ("BENCH_TOKEN_NEW".to_string(), "BENCH_TOKEN_OLD".to_string())
            } else {
                ("BENCH_TOKEN_OLD".to_string(), "BENCH_TOKEN_NEW".to_string())
            };
            let request = EditNodeRequest {
                path,
                old_text,
                new_text,
                expected_etag: Some(state.etag.clone()),
                replace_all: true,
            };
            let started_at = Instant::now();
            let result = client.edit_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_move<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    cross_dir: bool,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    let etags = seed_nodes(client, args, &payload, node_count).await?;
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    let states = Arc::new(
        etags
            .into_iter()
            .enumerate()
            .map(|(index, etag)| {
                let primary_path = file_path(&prefix, shape, index);
                let alternate_path = if cross_dir {
                    cross_dir_renamed_path(&prefix, shape, index)
                } else {
                    same_dir_renamed_path(&prefix, shape, index)
                };
                Mutex::new(MoveState {
                    etag,
                    current_path: primary_path.clone(),
                    primary_path,
                    alternate_path,
                })
            })
            .collect::<Vec<_>>(),
    );
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        async move {
            let mut state = states[index % node_count].lock().await;
            let to_path = if state.current_path == state.primary_path {
                state.alternate_path.clone()
            } else {
                state.primary_path.clone()
            };
            let request = MoveNodeRequest {
                from_path: state.current_path.clone(),
                to_path,
                expected_etag: Some(state.etag.clone()),
                overwrite: false,
            };
            let started_at = Instant::now();
            let result = client.move_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.current_path = result.node.path.clone();
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_delete<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    let states = Arc::new(seed_states(client, args, &payload, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let payload = payload.clone();
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let delete_request = DeleteNodeRequest {
                path: path.clone(),
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let delete_result = client.delete_node(delete_request.clone()).await?;
            let delete_metric = metric(started_at, &delete_request, &delete_result)?;
            let seed_request = WriteNodeRequest {
                path,
                kind: NodeKind::File,
                content: payload,
                metadata_json: "{}".to_string(),
                expected_etag: None,
            };
            let seed_result = client.write_node(seed_request).await?;
            state.etag = seed_result.node.etag;
            Ok(delete_metric)
        }
    })
    .await
}

async fn run_update_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let base = make_payload(args.payload_size_bytes);
    let updated = updated_payload(&base);
    let states = Arc::new(load_toggle_states(client, args, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let base = base.clone();
        let updated = updated.clone();
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let content = if state.toggle {
                updated.clone()
            } else {
                base.clone()
            };
            let request = WriteNodeRequest {
                path,
                kind: NodeKind::File,
                content,
                metadata_json: "{}".to_string(),
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let result = client.write_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_append_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let append = make_payload(args.payload_size_bytes);
    let states = Arc::new(load_toggle_states(client, args, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let append = append.clone();
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let request = AppendNodeRequest {
                path,
                content: append,
                expected_etag: Some(state.etag.clone()),
                separator: None,
                metadata_json: None,
                kind: None,
            };
            let started_at = Instant::now();
            let result = client.append_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_edit_from_seed<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let states = Arc::new(load_toggle_states(client, args, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let (old_text, new_text) = if state.toggle {
                ("BENCH_TOKEN_NEW".to_string(), "BENCH_TOKEN_OLD".to_string())
            } else {
                ("BENCH_TOKEN_OLD".to_string(), "BENCH_TOKEN_NEW".to_string())
            };
            let request = EditNodeRequest {
                path,
                old_text,
                new_text,
                expected_etag: Some(state.etag.clone()),
                replace_all: true,
            };
            let started_at = Instant::now();
            let result = client.edit_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_move_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    cross_dir: bool,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let states = Arc::new(load_move_states(client, args, node_count, cross_dir).await?);
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        async move {
            let mut state = states[index % node_count].lock().await;
            let to_path = if state.current_path == state.primary_path {
                state.alternate_path.clone()
            } else {
                state.primary_path.clone()
            };
            let request = MoveNodeRequest {
                from_path: state.current_path.clone(),
                to_path,
                expected_etag: Some(state.etag.clone()),
                overwrite: false,
            };
            let started_at = Instant::now();
            let result = client.move_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.current_path = result.node.path.clone();
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_delete_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let seed_count = delete_seed_count(args)?;
    let states = Arc::new(load_delete_etags(client, args, seed_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let path = file_path(&prefix, shape, index);
        async move {
            let state = states[index].lock().await;
            let request = DeleteNodeRequest {
                path,
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let result = client.delete_node(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_read<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    seed_nodes(client, args, &payload, node_count).await?;
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let started_at = Instant::now();
            let result = client.read_node(&path).await?;
            metric(started_at, &path, &result)
        }
    })
    .await
}

async fn run_read_from_seed<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let started_at = Instant::now();
            let result = client.read_node(&path).await?;
            metric(started_at, &path, &result)
        }
    })
    .await
}

async fn run_list<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    seed_nodes(client, args, &payload, node_count).await?;
    let request = ListNodesRequest {
        prefix: list_prefix(&args.prefix, args.directory_shape),
        recursive: false,
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.list_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_list_from_seed<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let request = ListNodesRequest {
        prefix: list_prefix(&args.prefix, args.directory_shape),
        recursive: false,
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.list_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_search<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    for index in 0..node_count {
        let request = WriteNodeRequest {
            path: file_path(&args.prefix, args.directory_shape, index),
            kind: NodeKind::File,
            content: make_searchable_payload(args.payload_size_bytes, index),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        };
        client.write_node(request).await?;
    }
    let request = SearchNodesRequest {
        query_text: "shared-bench-search".to_string(),
        prefix: Some(args.prefix.clone()),
        top_k: 10,
        preview_mode: Some(args.preview_mode),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.search_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_search_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let request = SearchNodesRequest {
        query_text: "shared-bench-search".to_string(),
        prefix: Some(args.prefix.clone()),
        top_k: 10,
        preview_mode: Some(args.preview_mode),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.search_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_mkdir<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let prefix = prefix.clone();
        async move {
            let request = MkdirNodeRequest {
                path: format!("{prefix}/mkdir-bench-{index:06}"),
            };
            let started_at = Instant::now();
            let result = client.mkdir_node(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_mkdir_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    run_mkdir(client, args).await
}

async fn run_glob<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    seed_nodes(client, args, &payload, node_count).await?;
    let request = GlobNodesRequest {
        pattern: glob_pattern(args.directory_shape).to_string(),
        path: Some(args.prefix.clone()),
        node_type: Some(GlobNodeType::File),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.glob_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_glob_from_seed<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let request = GlobNodesRequest {
        pattern: glob_pattern(args.directory_shape).to_string(),
        path: Some(args.prefix.clone()),
        node_type: Some(GlobNodeType::File),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.glob_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_recent<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let payload = make_payload(args.payload_size_bytes);
    seed_nodes(client, args, &payload, node_count).await?;
    let limit = (node_count as u32).clamp(1, 10);
    let request = RecentNodesRequest {
        limit,
        path: Some(args.prefix.clone()),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.recent_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_recent_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let limit = (node_count as u32).clamp(1, 10);
    let request = RecentNodesRequest {
        limit,
        path: Some(args.prefix.clone()),
    };
    let client = Arc::clone(client);
    run_parallel(args.iterations, args.concurrent_clients, move |_| {
        let client = Arc::clone(&client);
        let request = request.clone();
        async move {
            let started_at = Instant::now();
            let result = client.recent_nodes(request.clone()).await?;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_multi_edit<C>(client: &Arc<C>, args: &WorkloadBenchArgs) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let base = make_multi_editable_payload(args.payload_size_bytes);
    let states = Arc::new(seed_states(client, args, &base, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let edits = if state.toggle {
                vec![
                    MultiEdit {
                        old_text: "BENCH_MULTI_A1".to_string(),
                        new_text: "BENCH_MULTI_A0".to_string(),
                    },
                    MultiEdit {
                        old_text: "BENCH_MULTI_B1".to_string(),
                        new_text: "BENCH_MULTI_B0".to_string(),
                    },
                ]
            } else {
                vec![
                    MultiEdit {
                        old_text: "BENCH_MULTI_A0".to_string(),
                        new_text: "BENCH_MULTI_A1".to_string(),
                    },
                    MultiEdit {
                        old_text: "BENCH_MULTI_B0".to_string(),
                        new_text: "BENCH_MULTI_B1".to_string(),
                    },
                ]
            };
            let request = MultiEditNodeRequest {
                path,
                edits,
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let result = client.multi_edit_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

async fn run_multi_edit_from_seed<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
) -> Result<Vec<CallMetric>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let node_count = node_count(args)?;
    let states = Arc::new(load_toggle_states(client, args, node_count).await?);
    let client = Arc::clone(client);
    let prefix = args.prefix.clone();
    let shape = args.directory_shape;
    run_parallel(args.iterations, args.concurrent_clients, move |index| {
        let client = Arc::clone(&client);
        let states = Arc::clone(&states);
        let path = file_path(&prefix, shape, index % node_count);
        async move {
            let mut state = states[index % node_count].lock().await;
            let edits = if state.toggle {
                vec![
                    MultiEdit {
                        old_text: "BENCH_MULTI_A1".to_string(),
                        new_text: "BENCH_MULTI_A0".to_string(),
                    },
                    MultiEdit {
                        old_text: "BENCH_MULTI_B1".to_string(),
                        new_text: "BENCH_MULTI_B0".to_string(),
                    },
                ]
            } else {
                vec![
                    MultiEdit {
                        old_text: "BENCH_MULTI_A0".to_string(),
                        new_text: "BENCH_MULTI_A1".to_string(),
                    },
                    MultiEdit {
                        old_text: "BENCH_MULTI_B0".to_string(),
                        new_text: "BENCH_MULTI_B1".to_string(),
                    },
                ]
            };
            let request = MultiEditNodeRequest {
                path,
                edits,
                expected_etag: Some(state.etag.clone()),
            };
            let started_at = Instant::now();
            let result = client.multi_edit_node(request.clone()).await?;
            state.etag = result.node.etag.clone();
            state.toggle = !state.toggle;
            metric(started_at, &request, &result)
        }
    })
    .await
}

fn node_count(args: &WorkloadBenchArgs) -> Result<usize> {
    ensure!(
        args.file_count > 0 || args.iterations == 0,
        "file_count must be greater than zero when iterations are requested"
    );
    Ok(args.file_count)
}

fn delete_seed_count(args: &WorkloadBenchArgs) -> Result<usize> {
    Ok(node_count(args)?.max(args.iterations))
}

fn updated_payload(base: &str) -> String {
    if base.is_empty() {
        "u".to_string()
    } else {
        format!("u{}", &base[1..])
    }
}

async fn seed_states<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    payload: &str,
    count: usize,
) -> Result<Vec<Mutex<ToggleState>>>
where
    C: WikiApi + Send + Sync + 'static,
{
    Ok(seed_nodes(client, args, payload, count)
        .await?
        .into_iter()
        .map(|etag| {
            Mutex::new(ToggleState {
                etag,
                toggle: false,
            })
        })
        .collect())
}

async fn load_toggle_states<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    count: usize,
) -> Result<Vec<Mutex<ToggleState>>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let mut states = Vec::with_capacity(count);
    for index in 0..count {
        let node = client
            .read_node(&file_path(&args.prefix, args.directory_shape, index))
            .await?
            .ok_or_else(|| anyhow!("missing seeded node {}", args.benchmark_name))?;
        states.push(Mutex::new(ToggleState {
            etag: node.etag,
            toggle: false,
        }));
    }
    Ok(states)
}

async fn load_move_states<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    count: usize,
    cross_dir: bool,
) -> Result<Vec<Mutex<MoveState>>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let mut states = Vec::with_capacity(count);
    for index in 0..count {
        let primary_path = file_path(&args.prefix, args.directory_shape, index);
        let node = client
            .read_node(&primary_path)
            .await?
            .ok_or_else(|| anyhow!("missing seeded move node {}", args.benchmark_name))?;
        let alternate_path = if cross_dir {
            cross_dir_renamed_path(&args.prefix, args.directory_shape, index)
        } else {
            same_dir_renamed_path(&args.prefix, args.directory_shape, index)
        };
        states.push(Mutex::new(MoveState {
            etag: node.etag,
            current_path: primary_path.clone(),
            primary_path,
            alternate_path,
        }));
    }
    Ok(states)
}

async fn load_delete_etags<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    count: usize,
) -> Result<Vec<Mutex<ToggleState>>>
where
    C: WikiApi + Send + Sync + 'static,
{
    load_toggle_states(client, args, count).await
}

async fn seed_nodes<C>(
    client: &Arc<C>,
    args: &WorkloadBenchArgs,
    payload: &str,
    count: usize,
) -> Result<Vec<String>>
where
    C: WikiApi + Send + Sync + 'static,
{
    let mut etags = Vec::with_capacity(count);
    for index in 0..count {
        let request = WriteNodeRequest {
            path: file_path(&args.prefix, args.directory_shape, index),
            kind: NodeKind::File,
            content: payload.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        };
        let result = client.write_node(request).await?;
        etags.push(result.node.etag);
    }
    Ok(etags)
}

async fn seed_search_nodes<C>(client: &Arc<C>, args: &WorkloadBenchArgs, count: usize) -> Result<()>
where
    C: WikiApi + Send + Sync + 'static,
{
    for index in 0..count {
        client
            .write_node(WriteNodeRequest {
                path: file_path(&args.prefix, args.directory_shape, index),
                kind: NodeKind::File,
                content: make_searchable_payload(args.payload_size_bytes, index),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            })
            .await?;
    }
    Ok(())
}

async fn run_parallel<F, Fut>(
    total: usize,
    concurrent_clients: usize,
    build: F,
) -> Result<Vec<CallMetric>>
where
    F: Fn(usize) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CallMetric>> + Send + 'static,
{
    if total == 0 {
        return Ok(Vec::new());
    }
    let shard_count = concurrent_clients.max(1).min(total);
    let build = Arc::new(build);
    let mut tasks = JoinSet::new();
    for shard_index in 0..shard_count {
        let build = Arc::clone(&build);
        tasks.spawn(async move {
            let mut metrics = Vec::new();
            let mut index = shard_index;
            while index < total {
                metrics.push(build(index).await?);
                index += shard_count;
            }
            Ok::<Vec<CallMetric>, anyhow::Error>(metrics)
        });
    }
    let mut metrics = Vec::with_capacity(total);
    while let Some(task) = tasks.join_next().await {
        metrics.extend(task.map_err(|error| anyhow!("workload task failed: {error}"))??);
    }
    Ok(metrics)
}

fn metric<Arg, Out>(started_at: Instant, argument: &Arg, output: &Out) -> Result<CallMetric>
where
    Arg: candid::CandidType,
    Out: candid::CandidType,
{
    Ok(CallMetric {
        latency_us: started_at.elapsed().as_micros() as u64,
        request_payload_bytes: Encode!(argument)?.len() as u64,
        response_payload_bytes: Encode!(output)?.len() as u64,
    })
}

struct ToggleState {
    etag: String,
    toggle: bool,
}

struct MoveState {
    etag: String,
    current_path: String,
    primary_path: String,
    alternate_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use wiki_types::{
        DeleteNodeResult, EditNodeResult, GlobNodeHit, GlobNodesRequest, MkdirNodeRequest,
        MkdirNodeResult, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node,
        NodeEntry, NodeMutationAck, RecentNodeHit, RecentNodesRequest, SearchNodeHit,
        SearchNodePathsRequest, Status, WriteNodeResult,
    };

    #[derive(Default)]
    struct MockClient {
        next_etag: Mutex<u64>,
        nodes: Mutex<HashMap<String, Node>>,
        ops: Mutex<Vec<String>>,
    }

    impl MockClient {
        fn take_ops(&self) -> Vec<String> {
            std::mem::take(&mut *self.ops.lock().unwrap())
        }
    }

    #[async_trait]
    impl WikiApi for MockClient {
        async fn status(&self) -> Result<Status> {
            Ok(Status {
                file_count: 0,
                source_count: 0,
            })
        }
        async fn read_node(&self, path: &str) -> Result<Option<Node>> {
            self.ops.lock().unwrap().push(format!("read:{path}"));
            Ok(self.nodes.lock().unwrap().get(path).cloned())
        }
        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("list:{}", request.prefix));
            Ok(Vec::new())
        }
        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("write:{}", request.path));
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
            Ok(WriteNodeResult {
                node: NodeMutationAck {
                    path: node.path,
                    kind: node.kind,
                    updated_at: node.updated_at,
                    etag: node.etag,
                },
                created: true,
            })
        }
        async fn append_node(&self, request: AppendNodeRequest) -> Result<WriteNodeResult> {
            let current = self
                .nodes
                .lock()
                .unwrap()
                .get(&request.path)
                .cloned()
                .unwrap();
            self.write_node(WriteNodeRequest {
                path: request.path,
                kind: NodeKind::File,
                content: format!("{}{}", current.content, request.content),
                metadata_json: current.metadata_json,
                expected_etag: request.expected_etag,
            })
            .await
        }
        async fn edit_node(&self, request: EditNodeRequest) -> Result<EditNodeResult> {
            let current = self
                .nodes
                .lock()
                .unwrap()
                .get(&request.path)
                .cloned()
                .unwrap();
            let replaced = current
                .content
                .replace(&request.old_text, &request.new_text);
            let result = self
                .write_node(WriteNodeRequest {
                    path: request.path,
                    kind: NodeKind::File,
                    content: replaced,
                    metadata_json: current.metadata_json,
                    expected_etag: request.expected_etag,
                })
                .await?;
            Ok(EditNodeResult {
                node: result.node,
                replacement_count: 1,
            })
        }
        async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("delete:{}", request.path));
            self.nodes.lock().unwrap().remove(&request.path).unwrap();
            Ok(DeleteNodeResult { path: request.path })
        }
        async fn move_node(&self, request: MoveNodeRequest) -> Result<MoveNodeResult> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("move:{}->{}", request.from_path, request.to_path));
            let mut node = self
                .nodes
                .lock()
                .unwrap()
                .remove(&request.from_path)
                .unwrap();
            node.path = request.to_path.clone();
            self.nodes
                .lock()
                .unwrap()
                .insert(request.to_path.clone(), node.clone());
            Ok(MoveNodeResult {
                node: NodeMutationAck {
                    path: node.path,
                    kind: node.kind,
                    updated_at: node.updated_at,
                    etag: node.etag,
                },
                from_path: request.from_path,
                overwrote: false,
            })
        }
        async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("mkdir:{}", request.path));
            Ok(MkdirNodeResult {
                path: request.path,
                created: true,
            })
        }
        async fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("glob:{}", request.pattern));
            Ok(Vec::new())
        }
        async fn recent_nodes(&self, request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("recent:{}", request.limit));
            Ok(Vec::new())
        }
        async fn multi_edit_node(
            &self,
            request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("multi_edit:{}", request.path));
            let current = self
                .nodes
                .lock()
                .unwrap()
                .get(&request.path)
                .cloned()
                .unwrap();
            let mut content = current.content;
            for edit in &request.edits {
                content = content.replace(&edit.old_text, &edit.new_text);
            }
            let result = self
                .write_node(WriteNodeRequest {
                    path: request.path.clone(),
                    kind: NodeKind::File,
                    content,
                    metadata_json: current.metadata_json,
                    expected_etag: request.expected_etag,
                })
                .await?;
            Ok(MultiEditNodeResult {
                node: result.node,
                replacement_count: request.edits.len() as u32,
            })
        }
        async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("search:{}", request.query_text));
            Ok(vec![SearchNodeHit {
                path: "/Wiki/bench/node-000000.md".to_string(),
                kind: NodeKind::File,
                snippet: Some(request.query_text),
                preview: None,
                score: 1.0,
                match_reasons: vec!["text".to_string()],
            }])
        }
        async fn search_node_paths(
            &self,
            request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            self.ops
                .lock()
                .unwrap()
                .push(format!("search_paths:{}", request.query_text));
            Ok(vec![SearchNodeHit {
                path: "/Wiki/bench/node-000000.md".to_string(),
                kind: NodeKind::File,
                snippet: Some("/Wiki/bench/node-000000.md".to_string()),
                preview: None,
                score: 1.0,
                match_reasons: vec!["path_substring".to_string()],
            }])
        }
        async fn export_snapshot(
            &self,
            _request: wiki_types::ExportSnapshotRequest,
        ) -> Result<wiki_types::ExportSnapshotResponse> {
            unreachable!()
        }
        async fn fetch_updates(
            &self,
            _request: wiki_types::FetchUpdatesRequest,
        ) -> Result<wiki_types::FetchUpdatesResponse> {
            unreachable!()
        }
    }

    fn args(operation: WorkloadOperation) -> WorkloadBenchArgs {
        WorkloadBenchArgs {
            benchmark_name: "bench".to_string(),
            replica_host: "http://127.0.0.1:8000".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            prefix: "/Wiki/bench".to_string(),
            payload_size_bytes: 1024,
            file_count: 4,
            directory_shape: DirectoryShape::Flat,
            concurrent_clients: 1,
            iterations: 4,
            warmup_iterations: 0,
            operation,
            measurement_mode: MeasurementMode::ScenarioTotal,
            preview_mode: SearchPreviewMode::None,
        }
    }

    #[tokio::test]
    async fn update_overwrite_records_request_bytes() {
        let client = Arc::new(MockClient::default());
        let result = super::run_create(&client, &args(WorkloadOperation::Create))
            .await
            .unwrap();
        assert_eq!(result.len(), 4);
        let update = super::run_update(&client, &args(WorkloadOperation::Update))
            .await
            .unwrap();
        assert!(update.iter().all(|item| item.request_payload_bytes > 0));
    }

    #[tokio::test]
    async fn move_variants_use_distinct_paths() {
        let client = Arc::new(MockClient::default());
        super::run_move(&client, &args(WorkloadOperation::MoveSameDir), false)
            .await
            .unwrap();
        super::run_move(&client, &args(WorkloadOperation::MoveCrossDir), true)
            .await
            .unwrap();
        let ops = client.ops.lock().unwrap().clone();
        assert!(ops.iter().any(|entry| entry.contains(".renamed.md")));
        assert!(ops.iter().any(|entry| entry.contains("/moved/")));
    }

    #[tokio::test]
    async fn search_returns_hits_and_io_stats() {
        let client = Arc::new(MockClient::default());
        let result = run_workload_bench_with_client(client, args(WorkloadOperation::Search))
            .await
            .unwrap();
        assert_eq!(result.request_count, 4);
        assert!(result.avg_request_payload_bytes > 0);
        assert!(result.avg_response_payload_bytes > 0);
    }

    #[tokio::test]
    async fn mutating_workloads_reuse_seeded_file_set() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Update);
        workload.file_count = 2;
        workload.iterations = 5;
        let result = run_workload_bench_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        assert_eq!(result.request_count, 5);
        assert_eq!(client.nodes.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn concurrent_clients_execute_all_measured_requests() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Read);
        workload.concurrent_clients = 3;
        workload.iterations = 7;
        let result = run_workload_bench_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let reads = client
            .ops
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| entry.starts_with("read:"))
            .count();
        assert_eq!(result.request_count, 7);
        assert_eq!(reads, 7);
    }

    #[tokio::test]
    async fn warmup_requests_do_not_change_measured_count() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Read);
        workload.iterations = 4;
        workload.warmup_iterations = 2;
        let result = run_workload_bench_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.ops.lock().unwrap().clone();
        let warmup_reads = ops
            .iter()
            .filter(|entry| entry.starts_with("read:/Wiki/bench/__warmup/"))
            .count();
        let measured_reads = ops
            .iter()
            .filter(|entry| entry.starts_with("read:/Wiki/bench/node-"))
            .count();
        assert_eq!(result.request_count, 4);
        assert_eq!(warmup_reads, 2);
        assert_eq!(measured_reads, 4);
    }

    #[tokio::test]
    async fn zero_byte_update_does_not_panic() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Update);
        workload.payload_size_bytes = 0;
        let result = super::run_update(&client, &workload).await.unwrap();
        assert_eq!(result.len(), 4);
    }

    #[tokio::test]
    async fn isolated_setup_and_measure_split_seed_from_update_requests() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Update);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        let setup = super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        assert_eq!(setup.request_count, 4);
        assert_eq!(result.request_count, 4);
        assert_eq!(client.nodes.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn isolated_delete_setup_seeds_per_iteration() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Delete);
        workload.file_count = 2;
        workload.iterations = 5;
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        let setup = super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        assert_eq!(setup.request_count, 5);
        assert_eq!(result.request_count, 5);
    }

    #[tokio::test]
    async fn isolated_read_measurement_does_not_reseed() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Read);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry.starts_with("read:/Wiki/bench/node-"))
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn isolated_list_measurement_does_not_reseed() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::List);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry == &&"list:/Wiki/bench".to_string())
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn isolated_search_measurement_does_not_reseed() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Search);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry == &&"search:shared-bench-search".to_string())
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn isolated_glob_measurement_does_not_reseed() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Glob);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        let expected_pattern =
            crate::vfs_bench::common::glob_pattern(workload.directory_shape).to_string();
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry == &&format!("glob:{expected_pattern}"))
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn fanout_glob_measurement_uses_recursive_pattern() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Glob);
        workload.directory_shape = DirectoryShape::Fanout100x100;
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry == &&"glob:**/node-*.md".to_string())
                .count(),
            4
        );
    }

    #[tokio::test]
    async fn isolated_recent_measurement_does_not_reseed() {
        let client = Arc::new(MockClient::default());
        let mut workload = args(WorkloadOperation::Recent);
        workload.measurement_mode = MeasurementMode::IsolatedSingleOp;
        super::setup_workload_with_client(Arc::clone(&client), &workload)
            .await
            .unwrap();
        client.take_ops();

        let result = super::measure_workload_with_client(Arc::clone(&client), workload)
            .await
            .unwrap();
        let ops = client.take_ops();

        assert_eq!(result.request_count, 4);
        assert!(ops.iter().all(|entry| !entry.starts_with("write:")));
        assert_eq!(
            ops.iter()
                .filter(|entry| entry == &&"recent:4".to_string())
                .count(),
            4
        );
    }
}
