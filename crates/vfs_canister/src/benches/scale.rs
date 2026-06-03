// Where: crates/vfs_canister/src/benches/scale.rs
// What: Shared setup and measured bodies for scale-oriented canbench entrypoints.
// Why: Keeping seed shape and metadata emission centralized makes benchmark tables comparable.
use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::hint::black_box;

use canbench_rs::{BenchResult, bench_fn, bench_scope};
use serde_json::to_vec;
use vfs_runtime::{
    CyclesPendingLedgerDetailsInput, DatabaseCyclesPurchaseWithLedgerDetails,
    STORAGE_BILLING_INTERVAL_MS,
};
use vfs_types::{
    AppendNodeRequest, DeleteDatabaseRequest, ExportSnapshotRequest, ExportSnapshotResponse,
    FetchUpdatesRequest, MkdirNodeRequest, MoveNodeRequest, NodeKind, SearchNodesRequest,
    SearchPreviewMode, StorageBillingBatchRequest, WriteNodeRequest,
};

use crate::{
    SERVICE, append_node, caller_text, export_snapshot, fetch_updates,
    initialize_service_with_config, move_node, now_millis, read_node, search_nodes, with_service,
    write_node,
};

const BENCH_DATABASE_ID: &str = "canbench";
const TREE_DEPTH: usize = 4;
const CONTENT_SIZE: usize = 256;
const SEARCH_TOP_K: u32 = 20;
const SEARCH_HIT_INTERVAL: usize = 5;
const BENCH_QUERY: &str = "bench-needle";
const SHAPE_ID: &str = "uniform_depth4_content256_hits20pct";
const CERTIFICATION_STATUS: &str = "not_implemented";
const STORAGE_BILLING_DATABASE_PREFIX: &str = "storage-billing-";
const STORAGE_BILLING_PAYMENT_E8S: u64 = 10_000;

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
        initialize_service_with_config(None).expect("bench service should initialize");
    }
    with_service(|service| {
        let exists = service
            .list_databases()?
            .iter()
            .any(|meta| meta.database_id == BENCH_DATABASE_ID);
        if !exists {
            let caller = caller_text();
            service.create_database(BENCH_DATABASE_ID, &caller, now_millis())?;
        }
        Ok(())
    })
    .expect("bench database should exist");
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
    read_node(BENCH_DATABASE_ID.to_string(), path.to_string())
        .expect("bench read should succeed")
        .map(|node| node.etag)
}

fn write_seed(path: &str, content: &str, expected_etag: Option<String>, now: i64) -> String {
    with_service(|service| {
        let caller = caller_text();
        service.write_node(
            &caller,
            WriteNodeRequest {
                database_id: BENCH_DATABASE_ID.to_string(),
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

fn ensure_seed_parent_folders(parent_paths: &BTreeSet<String>, now: i64) {
    for parent_path in parent_paths {
        with_service(|service| {
            let caller = caller_text();
            service.mkdir_node(
                &caller,
                MkdirNodeRequest {
                    database_id: BENCH_DATABASE_ID.to_string(),
                    path: parent_path.clone(),
                },
                now,
            )
        })
        .expect("bench seed parent folder should exist or be created");
    }
}

fn ensure_seed_parent_folders_for_path(path: &str, now: i64) {
    let parent_paths = parent_folder_paths(path).into_iter().collect();
    ensure_seed_parent_folders(&parent_paths, now);
}

fn parent_folder_paths(path: &str) -> Vec<String> {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    let mut parents = Vec::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        parents.push(current.clone());
    }
    parents
}

fn seed_dataset(case: BenchCase, prefix: &str) {
    ensure_bench_service();
    let mut parent_paths = BTreeSet::new();
    for index in 0..case.n {
        let path = node_path(prefix, index);
        parent_paths.extend(parent_folder_paths(&path));
    }
    ensure_seed_parent_folders(&parent_paths, 9_000);
    for index in 0..case.n {
        let path = node_path(prefix, index);
        let content = node_content(index, index % SEARCH_HIT_INTERVAL == 0);
        write_seed(&path, &content, None, 10_000 + index as i64);
    }
}

fn snapshot_metrics(prefix: &str) -> SnapshotMetrics {
    let snapshot = export_snapshot(ExportSnapshotRequest {
        database_id: BENCH_DATABASE_ID.to_string(),
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
            SearchPreviewMode::ContentStart => "content_start",
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

fn emit_storage_billing_metadata(case: BenchCase) {
    let batch_limit = case.n.min(1_000);
    ic_cdk::eprintln!(
        "CANBENCH_META {{\"bench_name\":\"{}\",\"operation\":\"{}\",\"preview_mode\":\"none\",\"n\":{},\"node_count\":{},\"depth\":0,\"content_size\":{},\"updated_count\":0,\"snapshot_node_count\":0,\"snapshot_bytes\":0,\"shape\":\"storage_billing_batch_limit{}_active_dbs\",\"certificate_generation\":\"{}\",\"stable_memory_touch_bytes\":null}}",
        case.bench_name,
        case.operation,
        case.n,
        case.n,
        CONTENT_SIZE,
        batch_limit,
        CERTIFICATION_STATUS
    );
}

fn storage_billing_database_id(case: BenchCase, index: usize) -> String {
    format!("{STORAGE_BILLING_DATABASE_PREFIX}{:06}-{index:06}", case.n)
}

fn is_storage_billing_bench_database(database_id: &str) -> bool {
    database_id == BENCH_DATABASE_ID || database_id.starts_with(STORAGE_BILLING_DATABASE_PREFIX)
}

fn ensure_storage_billing_service() {
    let initialized = SERVICE.with(|slot| slot.borrow().is_some());
    if !initialized {
        initialize_service_with_config(None).expect("bench service should initialize");
    }
}

fn delete_existing_storage_billing_bench_databases(caller: &str) {
    with_service(|service| {
        let database_ids = service
            .list_databases()?
            .into_iter()
            .map(|meta| meta.database_id)
            .filter(|database_id| is_storage_billing_bench_database(database_id))
            .collect::<Vec<_>>();
        for (index, database_id) in database_ids.into_iter().enumerate() {
            service.delete_database(
                DeleteDatabaseRequest { database_id },
                caller,
                1_000 + i64::try_from(index).unwrap_or(i64::MAX),
            )?;
        }
        Ok(())
    })
    .expect("bench storage billing databases should reset");
}

fn fund_database_for_storage_billing(database_id: &str, caller: &str, now: i64) {
    with_service(|service| {
        let start = service.begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id,
                caller,
                payment_amount_e8s: STORAGE_BILLING_PAYMENT_E8S,
                min_expected_cycles: 0,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: caller,
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: 0,
                    ledger_created_at_time_ns: 1_000_000,
                },
                now,
            },
        )?;
        service.complete_database_cycles_purchase_ledger_transfer(
            start.operation_id,
            database_id,
            caller,
            start.amount_cycles,
            start.operation_id,
        )?;
        service.apply_database_cycles_purchase(
            start.operation_id,
            database_id,
            caller,
            start.amount_cycles,
            start.operation_id,
            now + 1,
        )?;
        Ok(())
    })
    .expect("bench database should be funded");
}

fn seed_storage_billing_databases(case: BenchCase) {
    ensure_storage_billing_service();
    let caller = caller_text();
    delete_existing_storage_billing_bench_databases(&caller);
    for index in 0..case.n {
        let database_id = storage_billing_database_id(case, index);
        with_service(|service| {
            service.create_database(
                &database_id,
                &caller,
                10_000 + i64::try_from(index).unwrap_or(i64::MAX),
            )?;
            service.write_node(
                &caller,
                WriteNodeRequest {
                    database_id: database_id.clone(),
                    path: "/Wiki/storage-billing.md".to_string(),
                    kind: NodeKind::File,
                    content: node_content(index, true),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                20_000 + i64::try_from(index).unwrap_or(i64::MAX),
            )?;
            Ok(())
        })
        .expect("bench storage billing database should seed");
        fund_database_for_storage_billing(
            &database_id,
            &caller,
            30_000 + i64::try_from(index).unwrap_or(i64::MAX),
        );
    }
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
                database_id: BENCH_DATABASE_ID.to_string(),
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
                database_id: BENCH_DATABASE_ID.to_string(),
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
    ensure_seed_parent_folders_for_path(&to_path, 19_000);
    let metrics = snapshot_metrics(&prefix);
    emit_metadata(case, &metrics);
    let expected_etag = current_etag(&from_path);
    bench_fn(|| {
        let _scope = bench_scope("move_call");
        black_box(
            move_node(MoveNodeRequest {
                database_id: BENCH_DATABASE_ID.to_string(),
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
                database_id: BENCH_DATABASE_ID.to_string(),
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
                database_id: BENCH_DATABASE_ID.to_string(),
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
        database_id: BENCH_DATABASE_ID.to_string(),
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
                database_id: BENCH_DATABASE_ID.to_string(),
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

pub(super) fn run_storage_billing(case: BenchCase) -> BenchResult {
    seed_storage_billing_databases(case);
    emit_storage_billing_metadata(case);
    let batch_limit = case.n.min(1_000) as u32;
    bench_fn(|| {
        let _scope = bench_scope("storage_billing_call");
        with_service(|service| {
            service.settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: Some(batch_limit),
                },
                30_000 + STORAGE_BILLING_INTERVAL_MS,
            )
        })
        .expect("bench storage billing should settle");
        black_box(());
    })
}

#[cfg(test)]
mod tests {
    use super::{
        BenchCase, is_storage_billing_bench_database, parent_folder_paths, snapshot_json_bytes,
        storage_billing_database_id,
    };
    use vfs_types::{ExportSnapshotResponse, Node, NodeKind};

    #[test]
    fn parent_folder_paths_returns_ordered_ancestors_without_leaf() {
        assert_eq!(
            parent_folder_paths("/Wiki/canbench/write/n-001000/l1-00/node.md"),
            vec![
                "/Wiki",
                "/Wiki/canbench",
                "/Wiki/canbench/write",
                "/Wiki/canbench/write/n-001000",
                "/Wiki/canbench/write/n-001000/l1-00"
            ]
        );
    }

    #[test]
    fn snapshot_json_bytes_matches_serialized_response_size() {
        let snapshot = ExportSnapshotResponse {
            snapshot_revision: "snap-1".to_string(),
            snapshot_session_id: None,
            nodes: vec![Node {
                path: "/Wiki/bench/node.md".to_string(),
                kind: NodeKind::File,
                content: "hello 😀".to_string(),
                created_at: 1,
                updated_at: 2,
                etag: "etag-1".to_string(),
                metadata_json: "{\"k\":\"v\"}".to_string(),
            }],
            next_cursor: None,
        };
        assert_eq!(
            snapshot_json_bytes(&snapshot),
            serde_json::to_vec(&snapshot)
                .expect("snapshot should serialize")
                .len()
        );
    }

    #[test]
    fn storage_billing_database_id_marks_only_bench_databases() {
        let database_id = storage_billing_database_id(
            BenchCase {
                bench_name: "storage_billing_batch_n10",
                operation: "storage_billing",
                n: 10,
                updated_count: 0,
                preview_mode: vfs_types::SearchPreviewMode::None,
            },
            3,
        );
        assert_eq!(database_id, "storage-billing-000010-000003");
        assert!(is_storage_billing_bench_database(&database_id));
        assert!(is_storage_billing_bench_database("canbench"));
        assert!(!is_storage_billing_bench_database("user-db"));
    }
}
