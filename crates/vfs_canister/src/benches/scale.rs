// Where: crates/vfs_canister/src/benches/scale.rs
// What: Shared setup and measured bodies for scale-oriented canbench entrypoints.
// Why: Keeping seed shape and metadata emission centralized makes benchmark tables comparable.
use std::fmt::Write as _;
use std::hint::black_box;

use canbench_rs::{BenchResult, bench_fn, bench_scope};
use serde_json::to_vec;
use vfs_types::{
    AppendNodeRequest, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
    MoveNodeRequest, NodeKind, SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
};

use crate::{
    SERVICE, append_node, export_snapshot, fetch_updates, initialize_service, move_node, read_node,
    search_nodes, with_service, write_node,
};

const TREE_DEPTH: usize = 4;
const CONTENT_SIZE: usize = 256;
const SEARCH_TOP_K: u32 = 20;
const SEARCH_HIT_INTERVAL: usize = 5;
const BENCH_QUERY: &str = "bench-needle";
const SHAPE_ID: &str = "uniform_depth4_content256_hits20pct";
const CERTIFICATION_STATUS: &str = "not_implemented";

pub(super) const FETCH_UPDATED_COUNT: usize = 10;

#[derive(Clone, Copy)]
pub(super) struct BenchCase {
    pub(super) bench_name: &'static str,
    pub(super) operation: &'static str,
    pub(super) n: usize,
    pub(super) updated_count: usize,
    pub(super) preview_mode: SearchPreviewMode,
}

struct SnapshotMetrics {
    snapshot_node_count: usize,
    snapshot_bytes: usize,
}

fn ensure_bench_service() {
    let initialized = SERVICE.with(|slot| slot.borrow().is_some());
    if !initialized {
        initialize_service().expect("bench service should initialize");
    }
}

fn bench_prefix(case: BenchCase) -> String {
    format!("/Wiki/canbench/{}/n-{:06}", case.operation, case.n)
}

fn node_path(prefix: &str, index: usize) -> String {
    let mut path = prefix.to_string();
    for level in 0..TREE_DEPTH {
        let bucket = (index / 10usize.pow(level as u32)) % 10;
        let _ = write!(&mut path, "/l{}-{bucket:02}", level + 1);
    }
    let _ = write!(&mut path, "/node-{index:06}.md");
    path
}

fn node_content(index: usize, include_query: bool) -> String {
    let token = if include_query {
        BENCH_QUERY
    } else {
        "bench-filler"
    };
    let mut content = format!("# Bench Node {index}\n\nkeyword:{token}\n\n");
    while content.len() < CONTENT_SIZE {
        let current_len = content.len();
        let _ = writeln!(&mut content, "segment:{index}:{token}:{current_len}");
    }
    content.truncate(CONTENT_SIZE);
    content
}

fn current_etag(path: &str) -> Option<String> {
    read_node(path.to_string())
        .expect("bench read should succeed")
        .map(|node| node.etag)
}

fn write_seed(path: &str, content: &str, expected_etag: Option<String>, now: i64) -> String {
    with_service(|service| {
        service.write_node(
            WriteNodeRequest {
                path: path.to_string(),
                kind: NodeKind::File,
                content: content.to_string(),
                metadata_json: "{}".to_string(),
                expected_etag,
            },
            now,
        )
    })
    .expect("bench seed write should succeed")
    .node
    .etag
}

fn seed_dataset(case: BenchCase, prefix: &str) {
    ensure_bench_service();
    for index in 0..case.n {
        let path = node_path(prefix, index);
        let content = node_content(index, index % SEARCH_HIT_INTERVAL == 0);
        write_seed(&path, &content, None, 10_000 + index as i64);
    }
}

fn snapshot_metrics(prefix: &str) -> SnapshotMetrics {
    let snapshot = export_snapshot(ExportSnapshotRequest {
        prefix: Some(prefix.to_string()),
        limit: 100,
        cursor: None,
        snapshot_revision: None,
        snapshot_session_id: None,
    })
    .expect("bench snapshot export should succeed");
    SnapshotMetrics {
        snapshot_node_count: snapshot.nodes.len(),
        snapshot_bytes: snapshot_json_bytes(&snapshot),
    }
}

fn snapshot_json_bytes(snapshot: &ExportSnapshotResponse) -> usize {
    to_vec(snapshot)
        .expect("snapshot should serialize to JSON bytes")
        .len()
}

fn emit_metadata(case: BenchCase, metrics: &SnapshotMetrics) {
    ic_cdk::eprintln!(
        "CANBENCH_META {{\"bench_name\":\"{}\",\"operation\":\"{}\",\"preview_mode\":\"{}\",\"n\":{},\"node_count\":{},\"depth\":{},\"content_size\":{},\"updated_count\":{},\"snapshot_node_count\":{},\"snapshot_bytes\":{},\"shape\":\"{}\",\"certificate_generation\":\"{}\",\"stable_memory_touch_bytes\":null}}",
        case.bench_name,
        case.operation,
        match case.preview_mode {
            SearchPreviewMode::None => "none",
            SearchPreviewMode::Light => "light",
        },
        case.n,
        case.n,
        TREE_DEPTH,
        CONTENT_SIZE,
        case.updated_count,
        metrics.snapshot_node_count,
        metrics.snapshot_bytes,
        SHAPE_ID,
        CERTIFICATION_STATUS
    );
}

pub(super) fn run_write(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let target = node_path(&prefix, case.n / 2);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    let expected_etag = current_etag(&target);
    let content = node_content(case.n / 2, true).replace("bench-filler", "bench-overwrite");
    bench_fn(|| {
        let _scope = bench_scope("write_call");
        black_box(
            write_node(WriteNodeRequest {
                path: target.clone(),
                kind: NodeKind::File,
                content: content.clone(),
                metadata_json: "{}".to_string(),
                expected_etag: expected_etag.clone(),
            })
            .expect("bench write should succeed"),
        );
    })
}

pub(super) fn run_append(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let target = node_path(&prefix, case.n / 2);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    let expected_etag = current_etag(&target);
    bench_fn(|| {
        let _scope = bench_scope("append_call");
        black_box(
            append_node(AppendNodeRequest {
                path: target.clone(),
                content: "\nappend-benchmark-tail".to_string(),
                expected_etag: expected_etag.clone(),
                separator: None,
                metadata_json: None,
                kind: None,
            })
            .expect("bench append should succeed"),
        );
    })
}

pub(super) fn run_move(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let from_path = node_path(&prefix, case.n / 2);
    let to_path = node_path(&prefix, case.n + 1);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    let expected_etag = current_etag(&from_path);
    bench_fn(|| {
        let _scope = bench_scope("move_call");
        black_box(
            move_node(MoveNodeRequest {
                from_path: from_path.clone(),
                to_path: to_path.clone(),
                expected_etag: expected_etag.clone(),
                overwrite: false,
            })
            .expect("bench move should succeed"),
        );
    })
}

pub(super) fn run_search(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    bench_fn(|| {
        let _scope = bench_scope("search_call");
        black_box(
            search_nodes(SearchNodesRequest {
                query_text: BENCH_QUERY.to_string(),
                prefix: Some(prefix.clone()),
                top_k: SEARCH_TOP_K,
                preview_mode: Some(case.preview_mode),
            })
            .expect("bench search should succeed"),
        );
    })
}

pub(super) fn run_export_snapshot(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    bench_fn(|| {
        let _scope = bench_scope("export_snapshot_call");
        black_box(
            export_snapshot(ExportSnapshotRequest {
                prefix: Some(prefix.clone()),
                limit: 100,
                cursor: None,
                snapshot_revision: None,
                snapshot_session_id: None,
            })
            .expect("bench export_snapshot should succeed"),
        );
    })
}

pub(super) fn run_fetch_updates(case: BenchCase) -> BenchResult {
    let prefix = bench_prefix(case);
    seed_dataset(case, &prefix);
    let baseline = export_snapshot(ExportSnapshotRequest {
        prefix: Some(prefix.clone()),
        limit: 100,
        cursor: None,
        snapshot_revision: None,
        snapshot_session_id: None,
    })
    .expect("bench baseline export should succeed");
    for index in 0..case.updated_count {
        let path = node_path(&prefix, index);
        let expected_etag = current_etag(&path);
        let content = node_content(index, true).replace(BENCH_QUERY, "bench-updated");
        write_seed(&path, &content, expected_etag, 20_000 + index as i64);
    }
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    bench_fn(|| {
        let _scope = bench_scope("fetch_updates_call");
        black_box(
            fetch_updates(FetchUpdatesRequest {
                known_snapshot_revision: baseline.snapshot_revision.clone(),
                prefix: Some(prefix.clone()),
                limit: 100,
                cursor: None,
                target_snapshot_revision: None,
            })
            .expect("bench fetch_updates should succeed"),
        );
    })
}

#[cfg(test)]
mod tests {
    use super::snapshot_json_bytes;
    use vfs_types::{ExportSnapshotResponse, Node, NodeKind};

    #[test]
    fn snapshot_json_bytes_matches_serialized_response_size() {
        let snapshot = ExportSnapshotResponse {
            snapshot_revision: "snap-1".to_string(),
            nodes: vec![Node {
                path: "/Wiki/bench/node.md".to_string(),
                kind: NodeKind::File,
                content: "hello 😀".to_string(),
                created_at: 1,
                updated_at: 2,
                etag: "etag-1".to_string(),
                metadata_json: "{\"k\":\"v\"}".to_string(),
            }],
        };
        assert_eq!(
            snapshot_json_bytes(&snapshot),
            serde_json::to_vec(&snapshot)
                .expect("snapshot should serialize")
                .len()
        );
    }
}
