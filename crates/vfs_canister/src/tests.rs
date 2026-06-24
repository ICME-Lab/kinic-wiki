// Where: crates/vfs_canister/src/tests.rs
// What: Entry-point level tests for the FS-first canister surface.
// Why: Phase 3 replaces the public canister contract, so tests must assert the wrapper behavior directly.
use std::future::Future;
use std::task::{Context, Poll, Waker};

use candid::{Encode, Nat, Principal};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use vfs_runtime::{
    DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL, DEFAULT_CYCLES_TOP_UP_THRESHOLD,
    DEFAULT_LLM_WRITER_PRINCIPAL, VfsService,
};
use vfs_types::{
    AppendNodeRequest, CreateDatabaseRequest, CyclesBillingConfig, CyclesBillingConfigUpdate,
    CyclesTopUpConfig, DatabaseCyclesPurchaseRequest, DatabaseRestoreChunkRequest, DatabaseRole,
    DatabaseStatus, DeleteDatabaseRequest, DeleteNodeRequest, EditNodeRequest,
    ExportSnapshotRequest, FetchUpdatesRequest, GlobNodeType, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, KINIC_LEDGER_FEE_E8S, KnowledgeEvidenceRequest,
    ListChildrenRequest, ListNodesRequest, MarketCreateListingRequest, MarketListingStatus,
    MarketPurchaseRequest, MarketUpdateListingRequest, MemoryRecallRequest, MkdirNodeRequest,
    MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeContextRequest, NodeEntryKind, NodeKind,
    OutgoingLinksRequest, RenameDatabaseRequest, SearchNodePathsRequest, SearchNodesRequest,
    SearchPreviewMode, StorageBillingBatchRequest, StoreManifestRequest, WriteNodeItem,
    WriteNodeRequest, WriteNodesRequest,
};

use super::{
    CyclesTopUpCheckStatus, CyclesTopUpLauncherError, CyclesTopUpLauncherResult,
    Icrc21ConsentMessage, Icrc21ConsentMessageMetadata, Icrc21ConsentMessageRequest,
    Icrc21ConsentMessageResponse, Icrc21ConsentMessageSpec, IcrcAccount, LedgerTransferFromOutcome,
    SERVICE, TransferFromError, append_node, begin_database_archive, begin_database_restore,
    cancel_database_archive, check_cycles_top_up, check_database_write_cycles,
    clear_cycles_top_up_state_for_test, clear_last_ledger_memo_for_test,
    clear_ledger_transactions_for_test, create_database,
    cycles_top_up_launcher_call_count_for_test, delete_node, edit_node, export_snapshot,
    fail_next_apply_database_cycles_purchase_apply_for_test,
    fail_next_mount_database_file_for_test, fetch_updates, finalize_database_archive,
    finalize_database_restore, get_cycles_billing_config, glob_nodes, grant_database_access,
    graph_links, graph_neighborhood, icrc21_canister_call_consent_message, incoming_links,
    knowledge_evidence, last_ledger_from_for_test, last_ledger_memo_for_test,
    last_ledger_to_for_test, ledger_transfer_fees_for_test, list_children,
    list_database_cycle_entries, list_database_cycles_pending_purchases, list_database_members,
    list_databases, list_nodes, market_create_listing, market_get_listing,
    market_list_seller_listings, market_pause_listing, market_purchase_access,
    market_update_listing, memory_recall, mkdir_node, move_node, multi_edit_node, outgoing_links,
    parse_upgrade_cycles_billing_config_arg, purchase_database_cycles, query_database_sql_json,
    query_index_sql_json, read_database_archive_chunk, read_node, read_node_context,
    rename_database, revoke_database_access, search_node_paths, search_nodes,
    set_cycles_balance_for_test, set_cycles_top_up_in_progress_for_test,
    set_next_cycles_top_up_launcher_result_for_test,
    set_next_ledger_transfer_from_outcome_for_test, set_test_caller_principal_for_test,
    set_update_charge_units_for_test, settle_database_storage_charges_batch, status,
    store_manifest, transfer_from_error_outcome, update_charge_cycles,
    update_cycles_billing_config, wiki_metrics, wiki_metrics_series, write_database_restore_chunk,
    write_node, write_nodes,
};

fn install_test_service() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    clear_ledger_transactions_for_test();
    service
        .create_database("default", "2vxsx-fae", 1_700_000_000_000)
        .expect("default database should create");
    service
        .begin_database_cycles_purchase("default", "2vxsx-fae", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            let cycles = cycles_for_test_payment(&service, 1_000_000);
            service.complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
            )?;
            service.apply_database_cycles_purchase(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
                1_700_000_000_001,
            )
        })
        .expect("default database should have write cycles available");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

fn delete_database_request(database_id: &str) -> DeleteDatabaseRequest {
    DeleteDatabaseRequest {
        database_id: database_id.to_string(),
    }
}

fn database_status_and_mount(database_id: &str) -> (DatabaseStatus, Option<u16>) {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .list_database_infos()
            .expect("database infos should load")
            .into_iter()
            .find(|info| info.database_id == database_id)
            .map(|info| (info.status, info.mount_id))
            .expect("database info should exist")
    })
}

fn database_exists(database_id: &str) -> bool {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .list_database_infos()
            .expect("database infos should load")
            .into_iter()
            .any(|info| info.database_id == database_id)
    })
}

fn pending_cycle_purchase_state(database_id: &str) -> String {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .query_index_sql_json(
                &format!(
                    "SELECT json_object('status', operation_status, 'block', ledger_block_index) FROM database_cycle_pending_operations WHERE database_id = '{}' AND kind = 'cycles_purchase' LIMIT 1",
                    database_id
                ),
                1,
            )
            .expect("pending operation should query")
            .rows
            .into_iter()
            .next()
            .expect("pending operation should exist")
    })
}

fn pending_database_activation_state(database_id: &str) -> String {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .query_index_sql_json(
                &format!(
                    "SELECT json_object('status', status, 'mount_id', mount_id, 'active_mount_id', active_mount_id, 'has_db_file_name', db_file_name <> '') FROM databases WHERE database_id = '{}' LIMIT 1",
                    database_id
                ),
                1,
            )
            .expect("database activation state should query")
            .rows
            .into_iter()
            .next()
            .expect("database row should exist")
    })
}

fn cycles_for_test_payment(service: &VfsService, payment_amount_e8s: u64) -> u64 {
    super::cycles_for_payment_amount_e8s(
        payment_amount_e8s,
        &service
            .cycles_billing_config()
            .expect("cycles config should load"),
    )
    .expect("cycles amount should compute")
}

fn install_empty_test_service() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    clear_ledger_transactions_for_test();
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

fn block_on_ready<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    match future.as_mut().poll(&mut context) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("test future unexpectedly pending"),
    }
}

fn cycles_purchase_request(
    database_id: &str,
    payment_amount_e8s: u64,
) -> DatabaseCyclesPurchaseRequest {
    DatabaseCyclesPurchaseRequest {
        database_id: database_id.to_string(),
        payment_amount_e8s,
        min_expected_cycles: 1,
    }
}

fn market_listing_request(database_id: &str, price_e8s: u64) -> MarketCreateListingRequest {
    MarketCreateListingRequest {
        database_id: database_id.to_string(),
        payout_principal: Principal::management_canister().to_text(),
        title: "Private market DB".to_string(),
        description: "Paid reader access".to_string(),
        llm_summary: None,
        tags_json: "[]".to_string(),
        price_e8s,
    }
}

fn market_purchase_request(
    listing_id: &str,
    price_e8s: u64,
    access_principal: Principal,
) -> MarketPurchaseRequest {
    MarketPurchaseRequest {
        listing_id: listing_id.to_string(),
        price_e8s,
        access_principal: access_principal.to_text(),
    }
}

fn consent_request(method: &str, arg: Vec<u8>) -> Icrc21ConsentMessageRequest {
    Icrc21ConsentMessageRequest {
        arg,
        method: method.to_string(),
        user_preferences: Icrc21ConsentMessageSpec {
            metadata: Icrc21ConsentMessageMetadata {
                language: "en".to_string(),
                utc_offset_minutes: None,
            },
            device_spec: None,
        },
    }
}

fn explicit_cycles_billing_config() -> CyclesBillingConfig {
    CyclesBillingConfig {
        kinic_ledger_canister_id: "aaaaa-aa".to_string(),
        billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
        cycles_per_kinic: 1_000,
        min_update_cycles: 1_000_000,
        top_up: test_cycles_top_up_config(true, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
    }
}

fn test_cycles_top_up_config(enabled: bool, threshold_cycles: u128) -> CyclesTopUpConfig {
    CyclesTopUpConfig {
        enabled,
        launcher_principal: DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL.to_string(),
        threshold_cycles,
    }
}

#[test]
fn cycles_billing_config_rejects_anonymous_principals() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    let mut config = explicit_cycles_billing_config();
    config.billing_authority_id = Principal::anonymous().to_text();

    let error = service
        .run_index_migrations_with_config(config)
        .expect_err("anonymous billing authority should reject");

    assert!(error.contains("principal must not be anonymous"));
}

#[test]
fn controller_can_query_index_sql_json() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    let result = query_index_sql_json(
        "SELECT json_object('cycles_purchase_cycles', COALESCE(SUM(amount_cycles), 0)) FROM database_cycle_ledger WHERE kind = 'cycles_purchase' LIMIT 1".to_string(),
        10,
    )
    .expect("controller should query index SQL");

    assert_eq!(result.limit, 10);
    assert_eq!(result.row_count, 1);
    assert_eq!(
        result.rows,
        vec![r#"{"cycles_purchase_cycles":2345000000}"#.to_string()]
    );
}

#[test]
fn non_controller_can_query_public_wiki_metrics() {
    install_empty_test_service();
    let non_controller = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("valid non-controller principal");
    set_test_caller_principal_for_test(non_controller);

    let metrics = wiki_metrics().expect("public metrics should not require controller");

    assert_eq!(metrics.users_total, 0);
    assert_eq!(metrics.databases_total, 0);
}

#[test]
fn non_controller_can_query_public_wiki_metrics_series_clamped_to_seven_days() {
    install_empty_test_service();
    let non_controller = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("valid non-controller principal");
    set_test_caller_principal_for_test(non_controller);

    let series = wiki_metrics_series(30)
        .expect("public metrics series should not require controller and should clamp to max 7");

    assert_eq!(series.len(), 7);
    assert_eq!(series[0].metrics.users_total, 0);
    assert_eq!(series[0].metrics.databases_total, 0);
}

#[test]
fn reader_can_query_database_sql_json_without_controller_role() {
    install_test_service();
    let reader =
        Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").expect("valid reader principal");
    SERVICE.with(|slot| {
        let service = slot.borrow();
        let service = service.as_ref().expect("service should be installed");
        service
            .write_node(
                "2vxsx-fae",
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: "/Wiki/sql.md".to_string(),
                    kind: NodeKind::File,
                    content: "database sql".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_700_000_000_002,
            )
            .expect("node should write");
        service
            .grant_database_access(
                "default",
                "2vxsx-fae",
                &reader.to_text(),
                DatabaseRole::Reader,
                1_700_000_000_003,
            )
            .expect("reader grant should succeed");
    });
    set_test_caller_principal_for_test(reader);

    let result = query_database_sql_json(
        "default".to_string(),
        "SELECT json_object('path', path, 'content', content) FROM fs_nodes WHERE path = '/Wiki/sql.md' LIMIT 1".to_string(),
        10,
    )
    .expect("reader should query database SQL");

    assert_eq!(result.row_count, 1);
    assert_eq!(
        result.rows,
        vec![r#"{"path":"/Wiki/sql.md","content":"database sql"}"#]
    );
}

#[test]
fn database_sql_json_rejects_non_readers_at_entrypoint() {
    install_test_service();
    let non_reader =
        Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").expect("valid non-reader principal");
    set_test_caller_principal_for_test(non_reader);

    let error = query_database_sql_json(
        "default".to_string(),
        "SELECT json_object('ok', 1) LIMIT 1".to_string(),
        10,
    )
    .expect_err("non-reader should reject");

    assert!(error.contains("principal has no access"));
}

#[test]
fn database_sql_json_rejects_invalid_json_at_entrypoint() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::anonymous());

    let error = query_database_sql_json(
        "default".to_string(),
        "SELECT 'not-json' FROM fs_nodes LIMIT 1".to_string(),
        10,
    )
    .expect_err("invalid JSON should reject");

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
}

#[test]
fn database_sql_json_rejects_extra_result_columns_at_entrypoint() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::anonymous());

    let error = query_database_sql_json(
        "default".to_string(),
        "SELECT json_object('ok', 1), path FROM fs_nodes LIMIT 1".to_string(),
        10,
    )
    .expect_err("extra result columns should reject");

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
}

#[test]
fn controller_can_check_cycles_top_up() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD + 1);

    let result = block_on_ready(check_cycles_top_up()).expect("controller should check top-up");

    assert_eq!(result.status, CyclesTopUpCheckStatus::SkippedAboveThreshold);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 0);
}

#[test]
fn cycles_top_up_skips_when_disabled() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(1);
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .update_cycles_billing_config(
                CyclesBillingConfigUpdate {
                    cycles_per_kinic: 1_000,
                    min_update_cycles: 1,
                    top_up: test_cycles_top_up_config(false, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
                },
                &test_billing_authority_principal().to_text(),
            )
            .expect("top-up config should update");
    });

    let result = block_on_ready(check_cycles_top_up()).expect("disabled check should succeed");

    assert_eq!(result.status, CyclesTopUpCheckStatus::SkippedDisabled);
    assert!(!result.called_launcher);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 0);
}

#[test]
fn cycles_top_up_skips_above_threshold() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD + 1);

    let result = block_on_ready(check_cycles_top_up()).expect("top-up check should succeed");

    assert_eq!(result.status, CyclesTopUpCheckStatus::SkippedAboveThreshold);
    assert!(!result.called_launcher);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 0);
}

#[test]
fn cycles_top_up_calls_launcher_at_threshold() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD);

    let result = block_on_ready(check_cycles_top_up()).expect("top-up check should succeed");

    assert_eq!(result.status, CyclesTopUpCheckStatus::LauncherOk);
    assert!(result.called_launcher);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 1);
}

#[test]
fn cycles_top_up_calls_launcher_once_below_threshold() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD - 1);

    let result = block_on_ready(check_cycles_top_up()).expect("top-up check should succeed");

    assert_eq!(result.status, CyclesTopUpCheckStatus::LauncherOk);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 1);
}

#[test]
fn cycles_top_up_skips_when_request_in_progress() {
    install_empty_test_service();
    clear_cycles_top_up_state_for_test();
    set_test_caller_principal_for_test(Principal::management_canister());
    set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD - 1);
    set_cycles_top_up_in_progress_for_test();

    let result = block_on_ready(check_cycles_top_up()).expect("top-up check should succeed");

    assert_eq!(result.status, CyclesTopUpCheckStatus::SkippedInProgress);
    assert!(!result.called_launcher);
    assert_eq!(cycles_top_up_launcher_call_count_for_test(), 0);
}

#[test]
fn cycles_top_up_launcher_error_stays_outer_ok() {
    for error in [
        CyclesTopUpLauncherError::TooSoon,
        CyclesTopUpLauncherError::Unauthorized,
        CyclesTopUpLauncherError::LauncherBalanceTooLow,
        CyclesTopUpLauncherError::TopUpFailed("rejected".to_string()),
    ] {
        install_empty_test_service();
        clear_cycles_top_up_state_for_test();
        set_test_caller_principal_for_test(Principal::management_canister());
        set_cycles_balance_for_test(DEFAULT_CYCLES_TOP_UP_THRESHOLD - 1);
        set_next_cycles_top_up_launcher_result_for_test(Ok(CyclesTopUpLauncherResult::Err(
            error.clone(),
        )));

        let result =
            block_on_ready(check_cycles_top_up()).expect("launcher Err should stay outer Ok");

        assert_eq!(result.status, CyclesTopUpCheckStatus::LauncherErr);
        assert_eq!(
            result.launcher_result,
            Some(CyclesTopUpLauncherResult::Err(error))
        );
        assert_eq!(cycles_top_up_launcher_call_count_for_test(), 1);
    }
}

#[test]
fn controller_can_settle_database_storage_charges_batch() {
    install_test_service();
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should install")
            .write_node(
                "2vxsx-fae",
                WriteNodeRequest {
                    database_id: "default".to_string(),
                    path: "/Wiki/storage.md".to_string(),
                    kind: NodeKind::File,
                    content: "storage billing".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1_700_000_000_002,
            )
            .expect("storage node should write");
    });
    set_test_caller_principal_for_test(Principal::management_canister());

    let result = settle_database_storage_charges_batch(StorageBillingBatchRequest {
        cursor_mount_id: None,
        limit: Some(100),
    })
    .expect("controller should settle storage billing batch");

    assert_eq!(result.processed_databases, 1);
}

#[test]
fn index_sql_json_rejects_non_controller_callers() {
    install_test_service();
    let non_controller = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("valid non-controller principal");
    set_test_caller_principal_for_test(non_controller);

    let error = query_index_sql_json("SELECT json_object('ok', 1) LIMIT 1".to_string(), 10)
        .expect_err("non-controller should reject");

    assert!(error.contains("caller is not a canister controller"));
}

#[test]
fn settle_database_storage_charges_batch_rejects_non_controller_callers() {
    install_test_service();
    let non_controller = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("valid non-controller principal");
    set_test_caller_principal_for_test(non_controller);

    let error = settle_database_storage_charges_batch(StorageBillingBatchRequest {
        cursor_mount_id: None,
        limit: None,
    })
    .expect_err("non-controller should reject");

    assert!(error.contains("caller is not a canister controller"));
}

#[test]
fn index_sql_json_rejects_anonymous_callers() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::anonymous());

    let error = query_index_sql_json("SELECT json_object('ok', 1) LIMIT 1".to_string(), 10)
        .expect_err("anonymous should reject");

    assert!(error.contains("caller is not a canister controller"));
}

#[test]
fn index_sql_json_rejects_mutating_and_multi_statement_sql() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    for sql in [
        "UPDATE database_cycle_accounts SET balance_cycles = 0",
        "DELETE FROM database_cycle_ledger",
        "INSERT INTO database_cycle_ledger (database_id) VALUES ('x')",
        "CREATE TABLE x (id INTEGER)",
        "DROP TABLE database_cycle_ledger",
        "PRAGMA table_info(database_cycle_ledger)",
        "ATTACH DATABASE 'x' AS x",
        "SELECT json_object('ok', 1); SELECT json_object('ok', 2)",
    ] {
        let error = query_index_sql_json(sql.to_string(), 10).expect_err("SQL should reject");
        assert!(
            error.contains("index SQL must") || error.contains("index SQL token is not allowed"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn index_sql_json_requires_text_json_first_column() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    let error = query_index_sql_json("SELECT 1 LIMIT 1".to_string(), 10)
        .expect_err("non-text first column should reject");

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
}

#[test]
fn index_sql_json_requires_json_object_at_entrypoint() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    for sql in [
        "SELECT 'not-json' LIMIT 1",
        "SELECT json_array(1, 2) LIMIT 1",
        "SELECT json('null') LIMIT 1",
    ] {
        let error =
            query_index_sql_json(sql.to_string(), 10).expect_err("non-object JSON should reject");
        assert!(
            error.contains("exactly one non-null valid JSON object TEXT column"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn index_sql_json_rejects_oversized_row_at_entrypoint() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    let error = query_index_sql_json(
        "SELECT json_object('content', printf('%70000s', 'x')) LIMIT 1".to_string(),
        1,
    )
    .expect_err("oversized index SQL row should reject");

    assert!(error.contains("row JSON exceeds"));
}

#[test]
fn index_sql_json_rejects_extra_result_columns() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    let error = query_index_sql_json("SELECT json_object('ok', 1), 1 LIMIT 1".to_string(), 10)
        .expect_err("extra result columns should reject");

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
}

fn fund_database(database_id: &str, payment_amount_e8s: u64, ledger_block_index: u64) {
    let principal = Principal::management_canister().to_text();
    SERVICE.with(|slot| {
        let service = slot.borrow();
        let service = service.as_ref().expect("service should be installed");
        let operation_id = service
            .begin_database_cycles_purchase(
                database_id,
                &principal,
                payment_amount_e8s,
                1_700_000_000_000,
            )
            .expect("database cycle purchase should begin");
        service
            .prepare_pending_database_activation(database_id, 1_700_000_000_000)
            .expect("pending database activation should prepare");
        let cycles = super::cycles_for_payment_amount_e8s(
            payment_amount_e8s,
            &service
                .cycles_billing_config()
                .expect("cycles config should load"),
        )
        .expect("cycles amount should compute");
        service
            .complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                database_id,
                &principal,
                cycles,
                ledger_block_index,
            )
            .expect("ledger transfer should be marked complete");
        service
            .apply_database_cycles_purchase(
                operation_id,
                database_id,
                &principal,
                cycles,
                ledger_block_index,
                1_700_000_000_000,
            )
            .expect("database should be funded");
    });
}

fn test_billing_authority_principal() -> Principal {
    Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("billing authority principal should parse")
}

struct AuthenticatedCallerGuard;

impl AuthenticatedCallerGuard {
    fn install() -> Self {
        set_test_caller_principal_for_test(Principal::management_canister());
        Self
    }

    fn install_principal(principal: Principal) -> Self {
        set_test_caller_principal_for_test(principal);
        Self
    }
}

impl Drop for AuthenticatedCallerGuard {
    fn drop(&mut self) {
        set_test_caller_principal_for_test(Principal::anonymous());
    }
}

#[test]
fn update_cycles_billing_config_accepts_record_argument() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install_principal(test_billing_authority_principal());

    update_cycles_billing_config(CyclesBillingConfigUpdate {
        cycles_per_kinic: 469_000_000_000,
        min_update_cycles: 2_000_000,
        top_up: test_cycles_top_up_config(true, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
    })
    .expect("cycles config update should accept record argument");

    let config = get_cycles_billing_config().expect("cycles config should load");
    assert_eq!(config.cycles_per_kinic, 469_000_000_000);
    assert_eq!(config.min_update_cycles, 2_000_000);
}

#[test]
fn post_upgrade_cycles_billing_config_arg_accepts_no_arg() {
    let bytes = Encode!().expect("empty candid args should encode");

    let parsed = parse_upgrade_cycles_billing_config_arg(&bytes)
        .expect("empty post-upgrade arg should parse");

    assert_eq!(parsed, None);
}

#[test]
fn post_upgrade_cycles_billing_config_arg_accepts_bare_config() {
    let config = explicit_cycles_billing_config();
    let bytes = Encode!(&config).expect("cycles config should encode");

    let parsed = parse_upgrade_cycles_billing_config_arg(&bytes)
        .expect("bare post-upgrade config should parse");

    assert_eq!(parsed, Some(config));
}

#[test]
fn post_upgrade_cycles_billing_config_arg_accepts_optional_config() {
    let config = explicit_cycles_billing_config();
    let bytes = Encode!(&Some(config.clone())).expect("optional cycles config should encode");

    let parsed = parse_upgrade_cycles_billing_config_arg(&bytes)
        .expect("optional post-upgrade config should parse");

    assert_eq!(parsed, Some(config));
}

#[test]
fn transfer_from_duplicate_outcome_is_completed() {
    let outcome = transfer_from_error_outcome(TransferFromError::Duplicate {
        duplicate_of: Nat::from(77_u64),
    });

    match outcome {
        LedgerTransferFromOutcome::Completed(block_index) => assert_eq!(block_index, 77),
        other => panic!("duplicate should complete, got {other:?}"),
    }
}

#[test]
fn transfer_from_bad_fee_outcome_is_typed() {
    let outcome = transfer_from_error_outcome(TransferFromError::BadFee {
        expected_fee: Nat::from(99_u64),
    });

    match outcome {
        LedgerTransferFromOutcome::BadFee { expected_fee_e8s } => {
            assert_eq!(expected_fee_e8s, 99);
        }
        other => panic!("bad fee should be typed, got {other:?}"),
    }
}

#[test]
fn purchase_database_cycles_cycles_completed_transfer_from() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Funded".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let result = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect("completed transfer-from should cycle database");

    assert_eq!(result.block_index, 42);
    assert_eq!(result.amount_cycles, 1_172_500);
    assert_eq!(result.balance_cycles, 1_172_500);
    assert_eq!(
        last_ledger_to_for_test()
            .expect("ledger recipient should record")
            .owner
            .to_text(),
        "isz6c-6c4pl-oba7w-ikjex-472yu-rf3fe-valdh-lfazm-5f3ep-v474i-qae"
    );
    assert_eq!(
        database_status_and_mount(&database.database_id).0,
        DatabaseStatus::Active
    );
    let entries = list_database_cycle_entries(database.database_id.clone(), None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind.as_str(), "cycles_purchase");
    assert_eq!(entries[0].ledger_block_index, Some(42));
}

#[test]
fn purchase_database_cycles_rejects_anonymous_before_ledger_call() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Anonymous purchase".to_string(),
    })
    .expect("database should create");
    drop(_caller);
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("anonymous caller should reject before ledger transfer");

    assert!(error.contains("anonymous caller not allowed"));
    assert_eq!(last_ledger_memo_for_test(), None);
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
}

#[test]
fn purchase_database_cycles_treats_duplicate_as_completed_transfer() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Duplicate ledger".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(transfer_from_error_outcome(
        TransferFromError::Duplicate {
            duplicate_of: Nat::from(77_u64),
        },
    ));

    let result = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect("duplicate transfer-from should cycle database");

    assert_eq!(result.block_index, 77);
    assert_eq!(
        database_status_and_mount(&database.database_id).0,
        DatabaseStatus::Active
    );
    let entries = list_database_cycle_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "cycles_purchase");
    assert_eq!(entries[0].ledger_block_index, Some(77));
}

#[test]
fn list_database_cycle_entries_paginates_with_clamped_limits() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Cycle history pages".to_string(),
    })
    .expect("database should create");
    for index in 0..105 {
        fund_database(&database.database_id, 500, index + 1);
    }

    let minimum_page = list_database_cycle_entries(database.database_id.clone(), None, 0)
        .expect("minimum page should load");
    assert_eq!(minimum_page.entries.len(), 1);
    assert_eq!(minimum_page.entries[0].entry_id, 1);
    assert_eq!(minimum_page.next_cursor, Some(1));

    let first_page = list_database_cycle_entries(database.database_id.clone(), None, 200)
        .expect("first clamped page should load");
    assert_eq!(first_page.entries.len(), 100);
    assert_eq!(first_page.entries[0].entry_id, 1);
    assert_eq!(first_page.entries[99].entry_id, 100);
    assert_eq!(first_page.next_cursor, Some(100));

    let second_page =
        list_database_cycle_entries(database.database_id, first_page.next_cursor, 200)
            .expect("second clamped page should load");
    assert_eq!(second_page.entries.len(), 5);
    assert_eq!(second_page.entries[0].entry_id, 101);
    assert_eq!(second_page.entries[4].entry_id, 105);
    assert_eq!(second_page.next_cursor, None);
}

#[test]
fn purchase_database_cycles_rejects_bad_fee_without_credit() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Bad fee".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::BadFee {
        expected_fee_e8s: KINIC_LEDGER_FEE_E8S + 1,
    });

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("BadFee should reject and leave no credit");

    assert!(error.contains("BadFee expected fee"));
    assert!(error.contains("re-approve with the current ledger fee"));
    assert_eq!(ledger_transfer_fees_for_test(), vec![KINIC_LEDGER_FEE_E8S]);
    assert!(
        list_database_cycle_entries(database.database_id.clone(), None, 10)
            .expect("ledger should load")
            .entries
            .is_empty()
    );
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
}

#[test]
fn purchase_database_cycles_rejects_invalid_target_before_ledger_call() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Purchase validation".to_string(),
    })
    .expect("database should create");

    clear_last_ledger_memo_for_test();
    let zero = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        0,
    )))
    .expect_err("zero amount should reject");
    assert!(zero.contains("cycles purchase payment amount must be positive"));

    let overflow = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        i64::MAX as u64,
    )))
    .expect_err("payment amount overflow should reject before approve");
    assert!(overflow.contains("cycles purchase amount exceeds u64"));

    let missing = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        "missing", 500,
    )))
    .expect_err("missing database should reject");
    assert!(missing.contains("database not found"));
    assert_eq!(last_ledger_memo_for_test(), None);
}

#[test]
fn purchase_database_cycles_rejects_archive_restore_statuses() {
    install_test_service();
    let _owner = AuthenticatedCallerGuard::install_principal(Principal::anonymous());

    let archive = begin_database_archive("default".to_string()).expect("archive should begin");
    clear_last_ledger_memo_for_test();
    let archiving = {
        let _caller = AuthenticatedCallerGuard::install();
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            "default", 500,
        )))
        .expect_err("archiving database should reject purchase")
    };
    assert!(archiving.contains("database is archiving"));
    assert_eq!(last_ledger_memo_for_test(), None);

    let bytes = read_database_archive_chunk(
        "default".to_string(),
        0,
        archive
            .size_bytes
            .try_into()
            .expect("test archive should fit in one chunk"),
    )
    .expect("archive chunk should read")
    .bytes;
    let snapshot_hash = sha256_bytes(&bytes);
    finalize_database_archive("default".to_string(), snapshot_hash.clone())
        .expect("archive should finalize");
    let archived = {
        let _caller = AuthenticatedCallerGuard::install();
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            "default", 500,
        )))
        .expect_err("archived database should reject purchase")
    };
    assert!(archived.contains("database is archived"));

    begin_database_restore("default".to_string(), snapshot_hash, archive.size_bytes)
        .expect("restore should begin");
    let restoring = {
        let _caller = AuthenticatedCallerGuard::install();
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            "default", 500,
        )))
        .expect_err("restoring database should reject purchase")
    };
    assert!(restoring.contains("database is restoring"));
}

#[test]
fn begin_database_archive_rejects_pending_cycle_purchase() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Pending lifecycle".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000_000, 41);
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .begin_database_cycles_purchase(
                &database.database_id,
                &Principal::management_canister().to_text(),
                500,
                1_700_000_000_001,
            )
            .expect("cycle purchase should begin")
    });

    let error = begin_database_archive(database.database_id)
        .expect_err("archive should reject pending cycle operation");

    assert!(error.contains("pending cycle operation"));
}

#[test]
fn purchase_database_cycles_rejects_balance_overflow_before_ledger_call() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Overflow".to_string(),
    })
    .expect("database should create");
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .update_cycles_billing_config(
                CyclesBillingConfigUpdate {
                    cycles_per_kinic: 100_000_000,
                    min_update_cycles: 1,
                    top_up: test_cycles_top_up_config(true, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
                },
                &test_billing_authority_principal().to_text(),
            )
            .expect("cycles config should update");
    });
    fund_database(&database.database_id, i64::MAX as u64, 41);
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let error = block_on_ready(purchase_database_cycles(DatabaseCyclesPurchaseRequest {
        database_id: database.database_id,
        payment_amount_e8s: 1,
        min_expected_cycles: 1,
    }))
    .expect_err("overflow should reject before ledger");

    assert!(error.contains("balance overflow"));
    assert_eq!(last_ledger_memo_for_test(), None);
}

#[test]
fn purchase_database_cycles_uses_current_config_amount() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Current config".to_string(),
    })
    .expect("database should create");
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .update_cycles_billing_config(
                CyclesBillingConfigUpdate {
                    cycles_per_kinic: 234_500_000_000,
                    min_update_cycles: 2,
                    top_up: test_cycles_top_up_config(true, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
                },
                &test_billing_authority_principal().to_text(),
            )
            .expect("cycles config should update");
    });
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let result = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect("purchase should use current config");

    assert_eq!(result.amount_cycles, 1_172_500);
    assert_eq!(result.balance_cycles, 1_172_500);
    let entries = list_database_cycle_entries(database.database_id, None, 10)
        .expect("cycles history should load")
        .entries;
    assert_eq!(entries[0].amount_cycles, 1_172_500);
}

#[test]
fn purchase_database_cycles_leaves_balance_on_ledger_reject() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Rejected".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::LedgerErr(
        "icrc2_transfer_from failed: InsufficientAllowance".to_string(),
    ));

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("ledger reject should not cycle database");

    assert!(error.contains("InsufficientAllowance"));
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
    let entries = list_database_cycle_entries(database.database_id.clone(), None, 10)
        .expect("database ledger should load")
        .entries;
    assert!(entries.is_empty());
}

#[test]
fn purchase_database_cycles_keeps_ambiguous_transfer_from_for_review() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Ambiguous".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
        "icrc2_transfer_from decode failed".to_string(),
    ));

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("ambiguous transfer-from should require review");

    assert!(error.contains("result ambiguous"));
    assert!(error.contains("operation_id 1"));
    assert!(error.contains("billing authority review required"));
    assert_eq!(
        pending_cycle_purchase_state(&database.database_id),
        r#"{"status":"ambiguous","block":null}"#
    );
    assert!(database_exists(&database.database_id));
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
    let duplicate = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("ambiguous pending operation should block duplicate purchase");
    assert!(
        duplicate.contains("database activation is pending")
            || duplicate.contains("cycles purchase already pending")
    );
}

#[test]
fn list_database_cycles_pending_purchases_allows_owner_authority_and_payer() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let payer = Principal::from_text(DEFAULT_LLM_WRITER_PRINCIPAL).expect("payer should parse");
    let stranger =
        Principal::from_text("bkyz2-fmaaa-aaaaa-qaaaq-cai").expect("stranger should parse");
    let database = {
        let _owner = AuthenticatedCallerGuard::install_principal(owner);
        create_database(CreateDatabaseRequest {
            name: "Pending".to_string(),
        })
        .expect("database should create")
    };

    let payer_guard = AuthenticatedCallerGuard::install_principal(payer);
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
        "timeout".to_string(),
    ));
    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        50_000_000,
    )))
    .expect_err("ambiguous transfer should keep pending operation");
    assert!(error.contains("billing authority review required"));

    let payer_view = list_database_cycles_pending_purchases(database.database_id.clone())
        .expect("payer should view own pending purchase");
    assert_eq!(payer_view.len(), 1);
    assert_eq!(payer_view[0].status, "ambiguous");
    assert_eq!(payer_view[0].required_action, "billing_authority_review");

    drop(payer_guard);
    let owner_guard = AuthenticatedCallerGuard::install_principal(owner);
    let owner_view = list_database_cycles_pending_purchases(database.database_id.clone())
        .expect("owner should view pending purchase");
    assert_eq!(owner_view, payer_view);

    drop(owner_guard);
    let authority_guard =
        AuthenticatedCallerGuard::install_principal(test_billing_authority_principal());
    let authority_view = list_database_cycles_pending_purchases(database.database_id.clone())
        .expect("billing authority should view pending purchase");
    assert_eq!(authority_view, payer_view);

    drop(authority_guard);
    let _stranger = AuthenticatedCallerGuard::install_principal(stranger);
    let error = list_database_cycles_pending_purchases(database.database_id)
        .expect_err("unrelated caller should reject");
    assert!(error.contains("cannot view pending cycle purchases"));
}

#[test]
fn purchase_database_cycles_mount_failure_keeps_completed_pending_operation() {
    install_empty_test_service();
    let _owner = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Mount review".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));
    fail_next_mount_database_file_for_test();

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        500,
    )))
    .expect_err("mount failure after ledger success should not credit");

    assert!(error.contains("test mount failure"));
    assert!(error.contains("remains completed for billing authority review"));
    assert_eq!(
        pending_cycle_purchase_state(&database.database_id),
        r#"{"status":"completed","block":42}"#
    );
    assert!(database_exists(&database.database_id));
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
    assert_eq!(
        pending_database_activation_state(&database.database_id),
        r#"{"status":"pending","mount_id":11,"active_mount_id":null,"has_db_file_name":1}"#
    );
    assert!(
        list_database_cycle_entries(database.database_id.clone(), None, 10)
            .expect("database ledger should load")
            .entries
            .is_empty()
    );
    assert_eq!(
        list_database_cycles_pending_purchases(database.database_id)
            .expect("owner should view completed pending purchase")[0]
            .required_action,
        "billing_authority_review"
    );
}

#[test]
fn purchase_database_cycles_apply_failure_keeps_completed_pending_for_review() {
    install_empty_test_service();
    let _owner = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Apply review".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(44));
    fail_next_apply_database_cycles_purchase_apply_for_test();

    let error = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        600,
    )))
    .expect_err("cycle apply failure after activation should not credit");

    assert!(error.contains("test cycle purchase apply failure"));
    assert!(error.contains("remains completed for billing authority review"));
    assert_eq!(
        pending_cycle_purchase_state(&database.database_id),
        r#"{"status":"completed","block":44}"#
    );
    assert!(database_exists(&database.database_id));
    assert_eq!(
        database_status_and_mount(&database.database_id),
        (DatabaseStatus::Pending, None)
    );
    assert_eq!(
        pending_database_activation_state(&database.database_id),
        r#"{"status":"pending","mount_id":11,"active_mount_id":null,"has_db_file_name":1}"#
    );
    assert!(
        list_database_cycle_entries(database.database_id.clone(), None, 10)
            .expect("database ledger should load")
            .entries
            .is_empty()
    );
    let duplicate = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        600,
    )))
    .expect_err("completed pending operation should block duplicate purchase");
    assert!(duplicate.contains("database activation is pending"));

    assert_eq!(
        list_database_cycles_pending_purchases(database.database_id)
            .expect("owner should view completed pending purchase")[0]
            .required_action,
        "billing_authority_review"
    );
}

#[test]
fn purchase_database_cycles_allows_non_owner_payer() {
    install_empty_test_service();
    let database_id = {
        let _owner = AuthenticatedCallerGuard::install();
        create_database(CreateDatabaseRequest {
            name: "Public funding".to_string(),
        })
        .expect("database should create")
        .database_id
    };
    let payer = Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai")
        .expect("test payer principal should parse");
    let _payer = AuthenticatedCallerGuard::install_principal(payer);
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(43));

    let result = block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database_id,
        700,
    )))
    .expect("non-owner payer should fund DB");

    assert_eq!(result.block_index, 43);
    assert_eq!(result.amount_cycles, 1_641_500);
    assert_eq!(result.balance_cycles, 1_641_500);
    assert_eq!(
        last_ledger_from_for_test().expect("ledger from should be recorded"),
        IcrcAccount {
            owner: payer,
            subaccount: None,
        }
    );
}

#[test]
fn icrc21_purchase_database_cycles_returns_consent_message() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Consent".to_string(),
    })
    .expect("database should create");
    let request = cycles_purchase_request(&database.database_id, 50_000);
    let arg = Encode!(&request).expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("purchase_database_cycles", arg));

    let message = match response {
        Icrc21ConsentMessageResponse::Ok(info) => match info.consent_message {
            Icrc21ConsentMessage::GenericDisplayMessage(message) => message,
        },
        Icrc21ConsentMessageResponse::Err(error) => {
            panic!("consent message should succeed: {error:?}");
        }
    };
    assert!(message.contains(&database.database_id));
    assert!(message.contains("Cycles: `117250000`"));
    assert!(message.contains("Payment: `0.0005` KINIC"));
    assert!(message.contains("Ledger transfer fee in allowance: `0.001` KINIC"));
    assert!(message.contains("Spender canister:"));
}

#[test]
fn icrc21_purchase_database_cycles_rejects_missing_database() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let request = cycles_purchase_request("missing", 500);
    let arg = Encode!(&request).expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("purchase_database_cycles", arg));

    match response {
        Icrc21ConsentMessageResponse::Err(super::Icrc21Error::UnsupportedCanisterCall(info)) => {
            assert!(info.description.contains("database not found"));
        }
        other => panic!("missing database consent should reject: {other:?}"),
    }
}

#[test]
fn icrc21_rejects_unsupported_cycle_consent_method() {
    install_empty_test_service();
    let response = icrc21_canister_call_consent_message(consent_request("write_node", Vec::new()));

    assert!(matches!(
        response,
        Icrc21ConsentMessageResponse::Err(super::Icrc21Error::UnsupportedCanisterCall(_))
    ));
}

#[test]
fn icrc21_rejects_malformed_cycle_consent_arg() {
    install_empty_test_service();
    let response = icrc21_canister_call_consent_message(consent_request(
        "purchase_database_cycles",
        Vec::new(),
    ));

    assert!(matches!(
        response,
        Icrc21ConsentMessageResponse::Err(super::Icrc21Error::ConsentMessageUnavailable(_))
    ));
}

#[test]
fn icrc21_market_purchase_access_returns_consent_message() {
    install_empty_test_service();
    let seller = test_billing_authority_principal();
    let payer = Principal::management_canister();
    let access =
        Principal::from_text("r7inp-6aaaa-aaaaa-aaabq-cai").expect("access principal should parse");
    let listing = {
        let _seller = AuthenticatedCallerGuard::install_principal(seller);
        let database = create_database(CreateDatabaseRequest {
            name: "Market consent".to_string(),
        })
        .expect("database should create");
        fund_database(&database.database_id, 1_000_000, 301);
        market_create_listing(market_listing_request(&database.database_id, 250_000_000))
            .expect("listing should create")
    };
    let _payer = AuthenticatedCallerGuard::install_principal(payer);
    let arg = Encode!(&market_purchase_request(
        &listing.listing_id,
        listing.price_e8s,
        access,
    ))
    .expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("market_purchase_access", arg));

    let message = match response {
        Icrc21ConsentMessageResponse::Ok(info) => match info.consent_message {
            Icrc21ConsentMessage::GenericDisplayMessage(message) => message,
        },
        Icrc21ConsentMessageResponse::Err(error) => {
            panic!("market purchase consent should succeed: {error:?}");
        }
    };
    assert!(message.contains("Purchase marketplace database access"));
    assert!(message.contains("Listing: `Private market DB`"));
    assert!(message.contains("Payment: `2.5` KINIC"));
    assert!(message.contains("Ledger transfer fee in allowance: `0.001` KINIC"));
    assert!(message.contains(&format!("Seller principal: `{}`", seller.to_text())));
    assert!(message.contains(&format!(
        "Seller payout principal: `{}`",
        Principal::management_canister().to_text()
    )));
    assert!(message.contains(&format!("Payer wallet principal: `{}`", payer.to_text())));
    assert!(message.contains(&format!("Access principal: `{}`", access.to_text())));
    assert!(message.contains("read-only marketplace entitlement"));
}

#[test]
fn icrc21_market_purchase_access_canonicalizes_access_principal() {
    install_empty_test_service();
    let seller = test_billing_authority_principal();
    let payer = Principal::management_canister();
    let access =
        Principal::from_text("r7inp-6aaaa-aaaaa-aaabq-cai").expect("access principal should parse");
    let listing = {
        let _seller = AuthenticatedCallerGuard::install_principal(seller);
        let database = create_database(CreateDatabaseRequest {
            name: "Market canonical consent".to_string(),
        })
        .expect("database should create");
        fund_database(&database.database_id, 1_000_000, 301);
        market_create_listing(market_listing_request(&database.database_id, 250_000_000))
            .expect("listing should create")
    };
    let _payer = AuthenticatedCallerGuard::install_principal(payer);
    let arg = Encode!(&MarketPurchaseRequest {
        listing_id: listing.listing_id.clone(),
        price_e8s: listing.price_e8s,
        access_principal: access.to_text().to_ascii_uppercase(),
    })
    .expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("market_purchase_access", arg));

    let message = match response {
        Icrc21ConsentMessageResponse::Ok(info) => match info.consent_message {
            Icrc21ConsentMessage::GenericDisplayMessage(message) => message,
        },
        Icrc21ConsentMessageResponse::Err(error) => {
            panic!("market purchase consent should succeed: {error:?}");
        }
    };
    assert!(message.contains(&format!("Access principal: `{}`", access.to_text())));
    assert!(!message.contains(&format!(
        "Access principal: `{}`",
        access.to_text().to_ascii_uppercase()
    )));
}

#[test]
fn icrc21_market_purchase_access_rejects_price_mismatch() {
    install_empty_test_service();
    let seller = test_billing_authority_principal();
    let payer = Principal::management_canister();
    let access =
        Principal::from_text("r7inp-6aaaa-aaaaa-aaabq-cai").expect("access principal should parse");
    let listing = {
        let _seller = AuthenticatedCallerGuard::install_principal(seller);
        let database = create_database(CreateDatabaseRequest {
            name: "Price mismatch".to_string(),
        })
        .expect("database should create");
        fund_database(&database.database_id, 1_000_000, 302);
        market_create_listing(market_listing_request(&database.database_id, 250_000_000))
            .expect("listing should create")
    };
    let _payer = AuthenticatedCallerGuard::install_principal(payer);
    let arg = Encode!(&market_purchase_request(
        &listing.listing_id,
        listing.price_e8s + 1,
        access,
    ))
    .expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("market_purchase_access", arg));

    match response {
        Icrc21ConsentMessageResponse::Err(super::Icrc21Error::UnsupportedCanisterCall(info)) => {
            assert!(info.description.contains("market listing price mismatch"));
        }
        other => panic!("price mismatch consent should reject: {other:?}"),
    }
}

#[test]
fn icrc21_market_purchase_access_rejects_inactive_listing() {
    install_empty_test_service();
    let seller = test_billing_authority_principal();
    let payer = Principal::management_canister();
    let access =
        Principal::from_text("r7inp-6aaaa-aaaaa-aaabq-cai").expect("access principal should parse");
    let listing = {
        let _seller = AuthenticatedCallerGuard::install_principal(seller);
        let database = create_database(CreateDatabaseRequest {
            name: "Inactive listing".to_string(),
        })
        .expect("database should create");
        fund_database(&database.database_id, 1_000_000, 303);
        let listing = market_create_listing(market_listing_request(&database.database_id, 250))
            .expect("listing should create");
        market_pause_listing(listing.listing_id.clone()).expect("listing should pause");
        listing
    };
    let _payer = AuthenticatedCallerGuard::install_principal(payer);
    let arg = Encode!(&market_purchase_request(
        &listing.listing_id,
        listing.price_e8s,
        access,
    ))
    .expect("arg should encode");

    let response =
        icrc21_canister_call_consent_message(consent_request("market_purchase_access", arg));

    match response {
        Icrc21ConsentMessageResponse::Err(super::Icrc21Error::UnsupportedCanisterCall(info)) => {
            assert!(info.description.contains("market listing is not active"));
        }
        other => panic!("inactive listing consent should reject: {other:?}"),
    }
}

#[test]
fn market_list_seller_listings_filters_by_seller_and_pages() {
    install_empty_test_service();
    let seller_a = test_billing_authority_principal();
    let seller_b = Principal::management_canister();
    {
        let _seller = AuthenticatedCallerGuard::install_principal(seller_a);
        let first = create_database(CreateDatabaseRequest {
            name: "Seller A first".to_string(),
        })
        .expect("first database should create");
        fund_database(&first.database_id, 1_000_000, 304);
        market_create_listing(market_listing_request(&first.database_id, 100))
            .expect("first listing should create");
        let second = create_database(CreateDatabaseRequest {
            name: "Seller A second".to_string(),
        })
        .expect("second database should create");
        fund_database(&second.database_id, 1_000_000, 305);
        market_create_listing(market_listing_request(&second.database_id, 200))
            .expect("second listing should create");
    }
    {
        let _seller = AuthenticatedCallerGuard::install_principal(seller_b);
        let other = create_database(CreateDatabaseRequest {
            name: "Seller B listing".to_string(),
        })
        .expect("other database should create");
        fund_database(&other.database_id, 1_000_000, 306);
        market_create_listing(market_listing_request(&other.database_id, 300))
            .expect("other listing should create");
    }

    let first_page = market_list_seller_listings(seller_a.to_text(), None, 1)
        .expect("first seller page should load");
    assert_eq!(first_page.listings.len(), 1);
    assert_eq!(first_page.listings[0].seller_principal, seller_a.to_text());
    assert!(first_page.next_cursor.is_some());

    let second_page = market_list_seller_listings(seller_a.to_text(), first_page.next_cursor, 10)
        .expect("second seller page should load");
    assert_eq!(second_page.listings.len(), 1);
    assert_eq!(second_page.listings[0].seller_principal, seller_a.to_text());
    assert!(second_page.next_cursor.is_none());
}

#[test]
fn purchase_database_cycles_sends_operation_memo_to_ledger() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Memo".to_string(),
    })
    .expect("database should create");
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(43));

    block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &database.database_id,
        700,
    )))
    .expect("cycle purchase should succeed");

    let memo = String::from_utf8(last_ledger_memo_for_test().expect("memo should be recorded"))
        .expect("memo should be utf8");
    let operation_id = memo
        .strip_prefix("kvfs:cp:")
        .expect("memo should use compact cycles purchase prefix")
        .parse::<u64>()
        .expect("memo should end with decimal operation id");
    assert!(operation_id > 0);
}

#[test]
fn purchase_database_cycles_rejects_unknown_and_deleted_database() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();

    let missing = block_on_ready(purchase_database_cycles(DatabaseCyclesPurchaseRequest {
        database_id: "missing".to_string(),
        payment_amount_e8s: 50_000_000,
        min_expected_cycles: 1,
    }))
    .expect_err("unknown database should reject");
    assert!(missing.contains("database not found"));

    let database = create_database(CreateDatabaseRequest {
        name: "Deleted".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000_000, 44);
    super::delete_database(delete_database_request(&database.database_id))
        .expect("owner should delete");

    let deleted = block_on_ready(purchase_database_cycles(DatabaseCyclesPurchaseRequest {
        database_id: database.database_id,
        payment_amount_e8s: 50_000_000,
        min_expected_cycles: 1,
    }))
    .expect_err("deleted database should reject");
    assert!(deleted.contains("database not found"));
}

fn database_charge_methods(database_id: &str) -> Vec<String> {
    list_database_cycle_entries(database_id.to_string(), None, 100)
        .expect("database cycles ledger should load")
        .entries
        .into_iter()
        .filter(|entry| entry.kind == "charge")
        .map(|entry| entry.method.expect("charge should record method"))
        .collect()
}

fn install_unfunded_default_service() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("default", "2vxsx-fae", 1_700_000_000_000)
        .expect("default database should create");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

fn install_suspended_default_service() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("default", "2vxsx-fae", 1_700_000_000_000)
        .expect("default database should create");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

fn install_low_balance_default_service() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("default", "2vxsx-fae", 1_700_000_000_000)
        .expect("default database should create");
    service
        .begin_database_cycles_purchase("default", "2vxsx-fae", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            let cycles = cycles_for_test_payment(&service, 1_000_000);
            service.complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
            )?;
            service.apply_database_cycles_purchase(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
                1_700_000_000_001,
            )
        })
        .expect("default database should start funded");
    service
        .grant_database_access(
            "default",
            "2vxsx-fae",
            &test_billing_authority_principal().to_text(),
            DatabaseRole::Writer,
            1_700_000_000_002,
        )
        .expect("writer should be granted before low-balance config");
    service
        .update_cycles_billing_config(
            CyclesBillingConfigUpdate {
                cycles_per_kinic: 1_000,
                min_update_cycles: 3_000_000_000,
                top_up: test_cycles_top_up_config(true, DEFAULT_CYCLES_TOP_UP_THRESHOLD),
            },
            &test_billing_authority_principal().to_text(),
        )
        .expect("minimum balance should update");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
}

fn sha256_bytes(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn ensure_parent_folders(path: &str) {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        mkdir_node(MkdirNodeRequest {
            database_id: "default".to_string(),
            path: current.clone(),
        })
        .expect("parent folder should exist or be created");
    }
}

#[test]
fn empty_index_does_not_create_default_database() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");

    let databases = service
        .list_databases()
        .expect("empty index should be readable");
    assert!(databases.is_empty());
}

#[test]
fn existing_database_index_is_loaded_without_implicit_default() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("alpha", "owner", 1)
        .expect("existing database should create");

    let databases = service
        .list_databases()
        .expect("existing index should load");

    assert_eq!(databases.len(), 1);
    assert_eq!(databases[0].database_id, "alpha");
}

#[test]
fn canister_list_databases_returns_caller_membership_summaries() {
    install_test_service();

    let summaries = list_databases().expect("database summaries should load");

    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].database_id, "default");
    assert_eq!(summaries[0].role, DatabaseRole::Owner);
    assert_eq!(summaries[0].status, DatabaseStatus::Active);
}

#[test]
fn canister_list_databases_hides_deleted_databases() {
    install_test_service();

    super::delete_database(delete_database_request("default")).expect("owner should delete");
    let summaries = list_databases().expect("database summaries should load");

    assert!(summaries.is_empty());
}

#[test]
fn market_listing_description_allows_newlines() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let database_id;

    {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        let database = create_database(CreateDatabaseRequest {
            name: "Multiline market".to_string(),
        })
        .expect("market database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(220));
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            &database_id,
            1_000_000,
        )))
        .expect("market database should activate");

        let mut create = market_listing_request(&database_id, 500);
        create.description = "Line one\nLine two\r\n\tIndented".to_string();
        create.llm_summary = Some("Summary one\nSummary two".to_string());
        let listing = market_create_listing(create).expect("multiline description should create");
        assert_eq!(listing.description, "Line one\nLine two\r\n\tIndented");
        assert_eq!(
            listing.llm_summary,
            Some("Summary one\nSummary two".to_string())
        );

        let updated = market_update_listing(MarketUpdateListingRequest {
            listing_id: listing.listing_id,
            expected_revision: listing.revision,
            payout_principal: Principal::management_canister().to_text(),
            title: "Updated market DB".to_string(),
            description: "Updated one\nUpdated two".to_string(),
            llm_summary: Some("Updated summary\nSecond line".to_string()),
            tags_json: "[]".to_string(),
            price_e8s: 600,
        })
        .expect("multiline description should update");
        assert_eq!(updated.description, "Updated one\nUpdated two");
        assert_eq!(
            updated.llm_summary,
            Some("Updated summary\nSecond line".to_string())
        );
    }
}

#[test]
fn market_listing_description_rejects_non_whitespace_control_characters() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let database_id;

    {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        let database = create_database(CreateDatabaseRequest {
            name: "Control market".to_string(),
        })
        .expect("market database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(221));
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            &database_id,
            1_000_000,
        )))
        .expect("market database should activate");

        let mut bad_description = market_listing_request(&database_id, 500);
        bad_description.description = "bad\0description".to_string();
        let description_error = market_create_listing(bad_description)
            .expect_err("NUL in description should be rejected");
        assert!(
            description_error
                .contains("market listing description may not contain control characters")
        );

        let mut bad_title = market_listing_request(&database_id, 500);
        bad_title.title = "bad\ntitle".to_string();
        let title_error =
            market_create_listing(bad_title).expect_err("title newline should be rejected");
        assert!(title_error.contains("market listing title may not contain control characters"));

        let mut bad_tags = market_listing_request(&database_id, 500);
        bad_tags.tags_json = "[\"bad\ntag\"]".to_string();
        let tags_error =
            market_create_listing(bad_tags).expect_err("tags newline should be rejected");
        assert!(tags_error.contains("market listing tags may not contain control characters"));
    }
}

#[test]
fn canister_list_databases_includes_market_entitlements_as_reader_access() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let buyer = Principal::self_authenticating(b"market buyer");
    let wallet = Principal::self_authenticating(b"market wallet payer");
    let payout = Principal::self_authenticating(b"market seller payout");
    let database_id;
    let listing_id;

    {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        let database = create_database(CreateDatabaseRequest {
            name: "Private market".to_string(),
        })
        .expect("market database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(201));
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            &database_id,
            1_000_000,
        )))
        .expect("market database should activate");
        write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: "/Wiki/paid.md".to_string(),
            kind: NodeKind::File,
            content: "# Paid\n\nPrivate body".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("market database content should write");
        let mut request = market_listing_request(&database_id, 500);
        request.payout_principal = payout.to_text();
        let listing = market_create_listing(request).expect("listing should create");
        assert!(!listing.listing_id.starts_with("listing_"));
        assert_eq!(listing.status, MarketListingStatus::Active);
        listing_id = listing.listing_id;
    }

    {
        let _caller = AuthenticatedCallerGuard::install_principal(wallet);
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(202));
        let order = block_on_ready(market_purchase_access(market_purchase_request(
            &listing_id,
            500,
            buyer,
        )))
        .expect("wallet should pay for buyer access");
        assert_eq!(order.buyer_principal, buyer.to_text());
        assert_eq!(order.payout_principal, payout.to_text());
        assert_eq!(order.ledger_block_index, 202);
        assert_eq!(
            last_ledger_from_for_test()
                .expect("market payer should record")
                .owner,
            wallet
        );
        assert_eq!(
            last_ledger_to_for_test()
                .expect("market recipient should record")
                .owner,
            payout
        );
    }

    {
        let _caller = AuthenticatedCallerGuard::install_principal(buyer);
        let summaries = list_databases().expect("buyer database summaries should load");
        let summary = summaries
            .iter()
            .find(|summary| summary.database_id == database_id)
            .expect("entitled database should appear in authenticated list");
        assert_eq!(summary.role, DatabaseRole::Reader);

        let node = read_node(database_id.clone(), "/Wiki/paid.md".to_string())
            .expect("entitled buyer read should succeed")
            .expect("paid node should exist");
        assert_eq!(node.content, "# Paid\n\nPrivate body");
        let children = list_children(ListChildrenRequest {
            database_id: database_id.clone(),
            path: "/Wiki".to_string(),
        })
        .expect("entitled buyer should list children");
        assert!(children.iter().any(|child| child.path == "/Wiki/paid.md"));
    }

    let anonymous_summaries = list_databases().expect("anonymous summaries should load");
    assert!(
        anonymous_summaries
            .iter()
            .all(|summary| summary.database_id != database_id)
    );

    {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        grant_database_access(database_id.clone(), buyer.to_text(), DatabaseRole::Writer)
            .expect("owner should grant writer access");
    }
    {
        let _caller = AuthenticatedCallerGuard::install_principal(buyer);
        let summaries = list_databases().expect("buyer database summaries should load");
        let matching = summaries
            .iter()
            .filter(|summary| summary.database_id == database_id)
            .collect::<Vec<_>>();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].role, DatabaseRole::Writer);
    }
}

#[test]
fn marketplace_listing_detail_includes_wiki_node_character_counts() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let database_id;
    let listing_id;
    let japanese_content = "# 日本語\n\nabc";

    {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        let database = create_database(CreateDatabaseRequest {
            name: "Market character counts".to_string(),
        })
        .expect("market database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(211));
        block_on_ready(purchase_database_cycles(cycles_purchase_request(
            &database_id,
            1_000_000,
        )))
        .expect("market database should activate");
        write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: "/Wiki/japanese.md".to_string(),
            kind: NodeKind::File,
            content: japanese_content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("wiki node should write");
        mkdir_node(MkdirNodeRequest {
            database_id: database_id.clone(),
            path: "/Sources/test".to_string(),
        })
        .expect("source parent folder should create");
        write_node(WriteNodeRequest {
            database_id: database_id.clone(),
            path: "/Sources/test/source.md".to_string(),
            kind: NodeKind::Source,
            content: "source text should not appear in marketplace node sizes".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("source node should write");
        let listing = market_create_listing(market_listing_request(&database_id, 500))
            .expect("listing should create");
        assert_eq!(listing.status, MarketListingStatus::Active);
        listing_id = listing.listing_id;
    }

    let detail = market_get_listing(listing_id).expect("listing detail should load");
    let excerpt = detail
        .preview
        .excerpts
        .iter()
        .find(|excerpt| excerpt.path == "/Wiki/japanese.md")
        .expect("wiki file should appear in marketplace node size details");
    assert_eq!(
        excerpt.content_chars,
        japanese_content.chars().count() as u64
    );
    assert_eq!(excerpt.excerpt, japanese_content);
    assert!(
        detail
            .preview
            .excerpts
            .iter()
            .all(|excerpt| !excerpt.path.starts_with("/Sources/"))
    );
}

#[test]
fn update_charge_cycles_checks_counter_order_and_overflow() {
    assert_eq!(
        update_charge_cycles(10, 11).expect("charge should compute"),
        20_000_001
    );
    assert_eq!(
        update_charge_cycles(11, 10).expect_err("decreased counter should fail"),
        "instruction counter decreased during update"
    );
    assert_eq!(
        update_charge_cycles(0, u128::MAX).expect_err("overflow should fail"),
        "cycle charge overflow"
    );
}

#[test]
fn write_nodes_records_instruction_charge_and_writes_nodes() {
    install_test_service();
    set_update_charge_units_for_test(vec![10_000, 10_321]);

    let results = write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![
            WriteNodeItem {
                path: "/Wiki/batch-a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            WriteNodeItem {
                path: "/Wiki/batch-b.md".to_string(),
                kind: NodeKind::File,
                content: "beta".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
        ],
    })
    .expect("batch write should succeed");

    assert_eq!(results.len(), 2);
    let entries = list_database_cycle_entries("default".to_string(), None, 20)
        .expect("database cycles ledger should load")
        .entries;
    let charge = entries
        .iter()
        .find(|entry| entry.kind == "charge")
        .expect("charge entry should exist");
    assert_eq!(charge.amount_cycles, -20_000_321);
    assert_eq!(charge.cycles_delta, Some(20_000_321));
    assert_eq!(charge.method.as_deref(), Some("write_nodes"));
    assert!(
        read_node("default".to_string(), "/Wiki/batch-a.md".to_string())
            .expect("read should succeed")
            .is_some()
    );
}

#[test]
fn write_node_and_write_nodes_record_instruction_charges() {
    install_test_service();
    set_update_charge_units_for_test(vec![7, 11, 13, 19]);

    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/single.md".to_string(),
        kind: NodeKind::File,
        content: "single".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("single write should succeed");
    write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Wiki/batch.md".to_string(),
            kind: NodeKind::File,
            content: "batch".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect("batch write should succeed");

    let entries = list_database_cycle_entries("default".to_string(), None, 20)
        .expect("database cycles ledger should load")
        .entries;
    let charges = entries
        .iter()
        .filter(|entry| entry.kind == "charge")
        .collect::<Vec<_>>();
    assert_eq!(charges.len(), 2);
    assert_eq!(charges[0].method.as_deref(), Some("write_node"));
    assert_eq!(charges[0].cycles_delta, Some(20_000_004));
    assert_eq!(charges[1].method.as_deref(), Some("write_nodes"));
    assert_eq!(charges[1].cycles_delta, Some(20_000_006));
}

#[test]
fn write_node_overdrawn_charge_consumes_balance_and_suspends_database() {
    install_test_service();
    let before_balance = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|database| database.database_id == "default")
        .and_then(|database| database.cycles_balance)
        .expect("default database should have cycles balance");

    set_update_charge_units_for_test(vec![0, 1_000_000_000_000]);
    let written = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/overdrawn.md".to_string(),
        kind: NodeKind::File,
        content: "overdrawn charge still writes".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("overdrawn post-charge should not trap");

    assert_eq!(written.node.path, "/Wiki/overdrawn.md");
    assert!(
        read_node("default".to_string(), "/Wiki/overdrawn.md".to_string())
            .expect("written node should read")
            .is_some()
    );
    let summary = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|database| database.database_id == "default")
        .expect("default database summary should exist");
    assert_eq!(summary.cycles_balance, Some(0));
    assert_eq!(summary.cycles_suspended_at_ms, Some(1_700_000_000_000));

    let entries = list_database_cycle_entries("default".to_string(), None, 20)
        .expect("database cycles ledger should load")
        .entries;
    let charge = entries
        .iter()
        .find(|entry| entry.kind == "charge")
        .expect("charge entry should exist");
    assert_eq!(charge.amount_cycles, -(before_balance as i64));
    assert_eq!(charge.balance_after_cycles, 0);
    assert_eq!(charge.cycles_delta, Some(1_000_020_000_000));
    assert_eq!(charge.method.as_deref(), Some("write_node"));
}

#[test]
fn failed_update_keeps_original_error_when_instruction_counter_decreases() {
    install_test_service();
    set_update_charge_units_for_test(vec![20, 10]);

    let error = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/stale.md".to_string(),
        kind: NodeKind::File,
        content: "stale write".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: Some("stale".to_string()),
    })
    .expect_err("stale etag write should fail");

    assert!(error.contains("etag"));
    let entries = list_database_cycle_entries("default".to_string(), None, 20)
        .expect("database cycles ledger should load")
        .entries;
    assert!(entries.iter().all(|entry| entry.kind != "charge"));
}

#[test]
fn write_nodes_rejects_low_database_cycles_balance() {
    install_unfunded_default_service();

    let single = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/no-balance-single.md".to_string(),
        kind: NodeKind::File,
        content: "no balance single".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect_err("low balance database should reject single write");
    let error = write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Wiki/no-balance.md".to_string(),
            kind: NodeKind::File,
            content: "no balance".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect_err("low balance database should reject batch write");

    assert!(single.contains("database cycles are suspended"));
    assert!(error.contains("database cycles are suspended"));
    assert!(
        read_node(
            "default".to_string(),
            "/Wiki/no-balance-single.md".to_string()
        )
        .expect("single path read should succeed")
        .is_none()
    );
    assert!(
        read_node("default".to_string(), "/Wiki/no-balance.md".to_string())
            .expect("batch path read should succeed")
            .is_none()
    );
}

#[test]
fn suspended_database_rejects_metered_mutations() {
    install_suspended_default_service();

    let batch = write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Wiki/suspended.md".to_string(),
            kind: NodeKind::File,
            content: "suspended".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect_err("suspended database should reject batch write");
    let mkdir = mkdir_node(MkdirNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/suspended-folder".to_string(),
    })
    .expect_err("suspended database should reject mkdir");
    let cancel = super::cancel_database_restore("default".to_string())
        .expect_err("suspended database should reject restore cancel before runtime mutation");

    assert!(batch.contains("database cycles are suspended"));
    assert!(mkdir.contains("database cycles are suspended"));
    assert!(cancel.contains("database cycles are suspended"));
}

#[test]
fn suspended_database_rejects_grant_but_allows_unmetered_owner_management_operations() {
    install_suspended_default_service();

    let grant = grant_database_access(
        "default".to_string(),
        "aaaaa-aa".to_string(),
        DatabaseRole::Reader,
    )
    .expect_err("suspended database should reject metered grant");
    assert!(grant.contains("database cycles are suspended"));

    rename_database(RenameDatabaseRequest {
        database_id: "default".to_string(),
        name: "Suspended rename".to_string(),
    })
    .expect("suspended database owner should rename");
    super::delete_database(delete_database_request("default"))
        .expect("suspended database owner should delete");
}

#[test]
fn low_balance_database_rejects_grant_but_allows_revoke_and_delete() {
    install_low_balance_default_service();

    let grant = grant_database_access(
        "default".to_string(),
        "aaaaa-aa".to_string(),
        DatabaseRole::Reader,
    )
    .expect_err("low-balance database should reject metered grant");
    assert!(grant.contains("database cycles balance is too low"));

    revoke_database_access(
        "default".to_string(),
        test_billing_authority_principal().to_text(),
    )
    .expect("low-balance database owner should revoke");
    super::delete_database(delete_database_request("default"))
        .expect("low-balance database owner should delete");
}

#[test]
fn metered_update_checks_access_before_cycles_state() {
    install_suspended_default_service();
    let _caller = AuthenticatedCallerGuard::install();

    let error = write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Wiki/no-access.md".to_string(),
            kind: NodeKind::File,
            content: "no access".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect_err("non-member should fail before cycles state");

    assert!(error.contains("principal has no access"));
    assert!(!error.contains("database cycles are suspended"));
}

#[test]
fn check_database_write_cycles_requires_authenticated_writer() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let reader =
        Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").expect("reader principal should parse");
    let database_id = {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        create_database(CreateDatabaseRequest {
            name: "Write cycles check".to_string(),
        })
        .expect("database should create")
        .database_id
    };

    let anonymous =
        check_database_write_cycles(database_id.clone()).expect_err("anonymous caller should fail");
    assert!(anonymous.contains("anonymous caller not allowed"));

    let suspended = {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        check_database_write_cycles(database_id.clone())
            .expect_err("suspended database should fail")
    };
    assert!(suspended.contains("database cycles are suspended"));

    fund_database(&database_id, 1_000_000, 91);
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .grant_database_access(
                &database_id,
                &owner.to_text(),
                &reader.to_text(),
                DatabaseRole::Reader,
                2,
            )
            .expect("reader should grant");
    });

    let reader_error = {
        let _caller = AuthenticatedCallerGuard::install_principal(reader);
        check_database_write_cycles(database_id.clone()).expect_err("reader should fail")
    };
    assert!(reader_error.contains("principal lacks required database role"));

    let _caller = AuthenticatedCallerGuard::install_principal(owner);
    check_database_write_cycles(database_id).expect("owner should pass write cycles check");
}

#[test]
fn write_nodes_rejects_reader_role() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("public", "owner", 1)
        .expect("database should create");
    service
        .begin_database_cycles_purchase("public", "owner", 1_000_000, 2)
        .and_then(|operation_id| {
            let cycles = cycles_for_test_payment(&service, 1_000_000);
            service.complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                "public",
                "owner",
                cycles,
                1,
            )?;
            service.apply_database_cycles_purchase(operation_id, "public", "owner", cycles, 1, 2)
        })
        .expect("database should have write cycles available");
    service
        .grant_database_access("public", "owner", "2vxsx-fae", DatabaseRole::Reader, 3)
        .expect("anonymous reader should grant");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));

    let error = write_nodes(WriteNodesRequest {
        database_id: "public".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Wiki/nope.md".to_string(),
            kind: NodeKind::File,
            content: "nope".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect_err("reader should not write");

    assert!(error.contains("principal lacks required database role"));
}

#[test]
fn write_nodes_rejects_invalid_source_path() {
    install_test_service();

    let error = write_nodes(WriteNodesRequest {
        database_id: "default".to_string(),
        nodes: vec![WriteNodeItem {
            path: "/Sources/not-raw.md".to_string(),
            kind: NodeKind::Source,
            content: "invalid source path".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        }],
    })
    .expect_err("invalid source path should fail");

    assert!(error.contains("source path"));
    assert!(database_charge_methods("default").is_empty());
}

#[test]
fn create_database_returns_result() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let result = create_database(CreateDatabaseRequest {
        name: " Team skills ".to_string(),
    })
    .expect("database should create");
    assert!(result.database_id.starts_with("db_"));
    assert_eq!(result.database_id.len(), 15);
    assert_eq!(result.name, "Team skills");

    let summaries = list_databases().expect("database summaries should load");
    let summary = summaries
        .iter()
        .find(|summary| summary.database_id == result.database_id)
        .expect("created database summary should exist");
    assert_eq!(summary.status, DatabaseStatus::Pending);
    let pending_read = list_children(ListChildrenRequest {
        database_id: result.database_id.clone(),
        path: "/Wiki".to_string(),
    })
    .expect_err("pending DB should reject reads");
    assert!(pending_read.contains("database is pending"));

    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));
    block_on_ready(purchase_database_cycles(cycles_purchase_request(
        &result.database_id,
        1_000_000,
    )))
    .expect("cycle purchase should activate database");
    let status = status(result.database_id.clone());
    assert_eq!(status.file_count, 0);
    assert_eq!(status.source_count, 0);
    let children = list_children(ListChildrenRequest {
        database_id: result.database_id,
        path: "/Wiki".to_string(),
    })
    .expect("activated database should list");
    assert!(children.iter().any(|child| {
        child.path == "/Wiki/skills" && child.kind == NodeEntryKind::Folder && !child.is_virtual
    }));
}

#[test]
fn create_database_rejects_pending_database_limit() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();

    for offset in 0..3 {
        create_database(CreateDatabaseRequest {
            name: format!("Pending {offset}"),
        })
        .expect("pending database should create within limit");
    }

    let error = create_database(CreateDatabaseRequest {
        name: "Pending 3".to_string(),
    })
    .expect_err("fourth pending database should reject");
    assert!(error.contains("too many pending databases for caller"));

    let summaries = list_databases().expect("database summaries should load");
    assert_eq!(summaries.len(), 3);
    assert!(
        summaries
            .iter()
            .all(|summary| summary.status == DatabaseStatus::Pending)
    );
}

#[test]
fn canister_rename_database_requires_owner() {
    install_test_service();

    rename_database(RenameDatabaseRequest {
        database_id: "default".to_string(),
        name: "Renamed default".to_string(),
    })
    .expect("owner should rename database");

    let summaries = list_databases().expect("database summaries should load");
    assert_eq!(summaries[0].name, "Renamed default");
}

#[test]
fn grant_database_access_records_instruction_charge_and_grants_role() {
    install_test_service();
    set_update_charge_units_for_test(vec![100, 125]);
    let principal = Principal::self_authenticating([42]).to_text();

    grant_database_access(
        "default".to_string(),
        principal.clone(),
        DatabaseRole::Reader,
    )
    .expect("reader should grant");

    let entries = list_database_cycle_entries("default".to_string(), None, 20)
        .expect("database cycles ledger should load")
        .entries;
    let charge = entries
        .iter()
        .find(|entry| entry.kind == "charge")
        .expect("grant charge should record");
    assert_eq!(charge.method.as_deref(), Some("grant_database_access"));
    assert_eq!(charge.cycles_delta, Some(20_000_025));
    let members =
        list_database_members("default".to_string()).expect("database members should load");
    assert!(
        members
            .iter()
            .any(|member| member.principal == principal && member.role == DatabaseRole::Reader)
    );
}

#[test]
fn grant_database_access_rejects_invalid_principal() {
    install_test_service();

    let error = grant_database_access(
        "default".to_string(),
        "not a principal".to_string(),
        DatabaseRole::Reader,
    )
    .expect_err("invalid principal should fail");

    assert!(error.contains("invalid principal"));
    assert!(database_charge_methods("default").is_empty());
}

#[test]
fn grant_database_access_rejects_non_owner_without_charge() {
    install_test_service();

    {
        let _caller = AuthenticatedCallerGuard::install();
        let error = grant_database_access(
            "default".to_string(),
            "aaaaa-aa".to_string(),
            DatabaseRole::Reader,
        )
        .expect_err("non-owner grant should fail");
        assert!(error.contains("principal has no access"));
    }

    assert!(database_charge_methods("default").is_empty());
}

#[test]
fn grant_database_access_rejects_member_limit() {
    install_test_service();

    for index in 0..30 {
        grant_database_access(
            "default".to_string(),
            Principal::self_authenticating([index as u8]).to_text(),
            DatabaseRole::Reader,
        )
        .expect("member grant should fit limit");
    }

    let error = grant_database_access(
        "default".to_string(),
        Principal::self_authenticating([30]).to_text(),
        DatabaseRole::Reader,
    )
    .expect_err("member cap should reject new member");
    assert!(error.contains("too many database members"));
    assert_eq!(database_charge_methods("default").len(), 30);

    grant_database_access(
        "default".to_string(),
        Principal::self_authenticating([0]).to_text(),
        DatabaseRole::Writer,
    )
    .expect("existing member role update should remain allowed");
}

#[test]
fn revoke_database_access_validates_and_canonicalizes_principal() {
    install_test_service();

    let invalid = revoke_database_access("default".to_string(), "not a principal".to_string())
        .expect_err("invalid principal should fail");
    assert!(invalid.contains("invalid principal"));

    grant_database_access(
        "default".to_string(),
        "aaaaa-aa".to_string(),
        DatabaseRole::Reader,
    )
    .expect("valid principal should grant");
    revoke_database_access("default".to_string(), "aaaaa-aa".to_string())
        .expect("valid principal should revoke");
}

#[test]
fn anonymous_reader_grant_allows_public_read() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("public", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("public", "owner", "2vxsx-fae", DatabaseRole::Reader, 2)
        .expect("anonymous reader should grant");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));

    let node = read_node("public".to_string(), "/Wiki/missing.md".to_string())
        .expect("anonymous reader query should pass role check");

    assert_eq!(node, None);
    let members = list_database_members("public".to_string())
        .expect("anonymous reader should list public database members");
    assert!(
        members
            .iter()
            .any(|member| member.principal == "owner" && member.role == DatabaseRole::Owner)
    );
}

#[test]
fn status_stays_available_after_fs_migrations() {
    install_test_service();

    let current = status("default".to_string());

    assert_eq!(current.file_count, 0);
    assert_eq!(current.source_count, 0);
}

#[test]
fn store_entrypoints_return_four_store_contract() {
    install_test_service();

    let manifest = store_manifest(StoreManifestRequest {
        database_id: "default".to_string(),
    })
    .expect("store manifest should load default database");
    assert_eq!(manifest.api_version, "kinic-stores-v1");
    assert_eq!(manifest.write_policy, "store_recall_read_only");
    assert_eq!(manifest.recommended_entrypoint, "memory_recall");
    assert_eq!(manifest.max_depth, 2);
    assert!(manifest.purpose.contains("knowledge"));
    assert!(manifest.roots.iter().any(|root| root.path == "/Wiki"));
    assert!(
        manifest
            .roots
            .iter()
            .any(|root| root.path == "/Sessions" && root.kind == "session")
    );
    assert!(
        manifest
            .roots
            .iter()
            .any(|root| root.path == "/Wiki/skills" && root.kind == "skill")
    );
    assert!(
        manifest
            .roots
            .iter()
            .any(|root| root.path == "/Sources" && root.kind == "knowledge_evidence")
    );
    assert!(
        manifest
            .roots
            .iter()
            .any(|root| root.path == "/Sources/sessions" && root.kind == "session_evidence")
    );
    assert!(
        manifest
            .roots
            .iter()
            .any(|root| root.path == "/Sources/skill-runs" && root.kind == "skill_run_evidence")
    );
    assert!(
        manifest
            .canonical_roles
            .iter()
            .any(|role| role.name == "facts")
    );
    assert!(
        manifest
            .canonical_roles
            .iter()
            .any(|role| role.name == "open_questions")
    );

    for (path, content) in [
        ("/Wiki/scope/index.md", "# Index\n\n[Overview](overview.md)"),
        (
            "/Wiki/scope/overview.md",
            "# Overview\n\nbeam memory [Raw](/Sources/a/a.md)",
        ),
        ("/Wiki/scope/schema.md", "# Schema\n\nread-only"),
        (
            "/Wiki/scope/provenance.md",
            "# Provenance\n\n[Raw](/Sources/a/a.md)",
        ),
        ("/Sources/a/a.md", "raw source"),
    ] {
        ensure_parent_folders(path);
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: path.to_string(),
            kind: if path.starts_with("/Sources/") {
                NodeKind::Source
            } else {
                NodeKind::File
            },
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("write should succeed");
    }

    let context = memory_recall(MemoryRecallRequest {
        database_id: "default".to_string(),
        task: "beam memory".to_string(),
        entities: Vec::new(),
        namespace: Some("/Wiki/scope".to_string()),
        budget_tokens: 1_000,
        include_evidence: true,
        depth: 1,
    })
    .expect("memory recall should load");
    assert!(
        context
            .nodes
            .iter()
            .any(|node| node.node.path == "/Wiki/scope/overview.md")
    );
    assert!(!context.evidence.is_empty());

    let evidence = knowledge_evidence(KnowledgeEvidenceRequest {
        database_id: "default".to_string(),
        node_path: "/Wiki/scope/overview.md".to_string(),
    })
    .expect("evidence should load");
    assert!(
        evidence
            .refs
            .iter()
            .any(|item| item.source_path == "/Sources/a/a.md")
    );
    let source_ref = evidence
        .refs
        .iter()
        .find(|item| item.source_path == "/Sources/a/a.md")
        .expect("source evidence ref should exist");
    assert!(source_ref.source_etag.is_some());
    assert!(source_ref.source_updated_at.is_some());
}

#[test]
fn store_manifest_roots_are_readable() {
    install_test_service();
    let database_id = "default".to_string();
    let manifest = store_manifest(StoreManifestRequest {
        database_id: database_id.clone(),
    })
    .expect("store manifest should load");
    for root in manifest.roots {
        assert!(
            read_node(database_id.clone(), root.path)
                .expect("root should read")
                .is_some()
        );
    }
}

#[test]
fn fs_entrypoints_cover_crud_search_and_sync() {
    install_test_service();

    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nalpha body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");
    assert!(created.created);

    ensure_parent_folders("/Wiki/nested/bar.md");
    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/nested/bar.md".to_string(),
        kind: NodeKind::File,
        content: "# Bar\n\nbeta body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("nested write should succeed");

    let node = read_node("default".to_string(), "/Wiki/foo.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(node.kind, NodeKind::File);

    let stale_write = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/foo.md".to_string(),
        kind: NodeKind::File,
        content: "# Foo\n\nrewrite".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: Some("stale".to_string()),
    });
    assert!(stale_write.is_err());

    let entries = list_nodes(ListNodesRequest {
        database_id: "default".to_string(),
        prefix: "/Wiki".to_string(),
        recursive: false,
    })
    .expect("list should succeed");
    assert!(
        entries
            .iter()
            .any(|entry| { entry.path == "/Wiki/nested" && entry.kind == NodeEntryKind::Folder })
    );

    let children = list_children(ListChildrenRequest {
        database_id: "default".to_string(),
        path: "/Wiki".to_string(),
    })
    .expect("children should list");
    assert!(children.iter().any(|child| {
        child.path == "/Wiki/nested" && child.kind == NodeEntryKind::Folder && !child.is_virtual
    }));
    assert!(children.iter().any(|child| {
        child.path == "/Wiki/foo.md"
            && child.kind == NodeEntryKind::File
            && child.etag.as_deref() == Some(created.node.etag.as_str())
    }));

    let hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha".to_string(),
        prefix: Some("/Wiki".to_string()),
        top_k: 5,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("search should succeed");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "/Wiki/foo.md");

    let path_hits = search_node_paths(SearchNodePathsRequest {
        database_id: "default".to_string(),
        query_text: "NeStEd".to_string(),
        prefix: Some("/Wiki".to_string()),
        top_k: 5,
        preview_mode: None,
    })
    .expect("path search should succeed");
    assert!(
        path_hits
            .iter()
            .any(|hit| hit.path == "/Wiki/nested/bar.md")
    );

    let snapshot = export_snapshot(ExportSnapshotRequest {
        database_id: "default".to_string(),
        prefix: Some("/Wiki".to_string()),
        limit: 100,
        cursor: None,
        snapshot_revision: None,
        snapshot_session_id: None,
    })
    .expect("snapshot should export");
    assert_eq!(snapshot.nodes.len(), 5);
    assert!(
        snapshot
            .nodes
            .iter()
            .any(|node| { node.path == "/Wiki/skills" && node.kind == NodeKind::Folder })
    );

    let empty_delta = fetch_updates(FetchUpdatesRequest {
        database_id: "default".to_string(),
        known_snapshot_revision: snapshot.snapshot_revision.clone(),
        prefix: Some("/Wiki".to_string()),
        limit: 100,
        cursor: None,
        target_snapshot_revision: None,
    })
    .expect("matching snapshot should produce empty delta");
    assert!(empty_delta.changed_nodes.is_empty());
    assert!(empty_delta.removed_paths.is_empty());

    let invalid_delta = fetch_updates(FetchUpdatesRequest {
        database_id: "default".to_string(),
        known_snapshot_revision: "missing".to_string(),
        prefix: Some("/Wiki".to_string()),
        limit: 100,
        cursor: None,
        target_snapshot_revision: None,
    });
    assert_eq!(
        invalid_delta.expect_err("unknown snapshot should fail"),
        "known_snapshot_revision is invalid"
    );

    let deleted = delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/foo.md".to_string(),
        expected_etag: Some(created.node.etag.clone()),
        expected_folder_index_etag: None,
    })
    .expect("delete should succeed");
    assert_eq!(deleted.path, "/Wiki/foo.md");

    let deleted_read =
        read_node("default".to_string(), "/Wiki/foo.md".to_string()).expect("read should succeed");
    assert!(deleted_read.is_none());

    let stale_delete = delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/nested/bar.md".to_string(),
        expected_etag: Some("stale".to_string()),
        expected_folder_index_etag: None,
    });
    assert!(stale_delete.is_err());
}

#[test]
fn fs_entrypoints_cover_backlink_queries() {
    install_test_service();
    ensure_parent_folders("/Wiki/topic/source.md");

    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/topic/source.md".to_string(),
        kind: NodeKind::File,
        content: "[Target](../target.md) and [[/Wiki/target.md]]".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("source write should succeed");

    let incoming = incoming_links(IncomingLinksRequest {
        database_id: "default".to_string(),
        path: "/Wiki/target.md".to_string(),
        limit: 10,
    })
    .expect("incoming links should load");
    assert_eq!(incoming.len(), 2);
    assert!(
        incoming
            .iter()
            .all(|edge| edge.source_path == "/Wiki/topic/source.md")
    );

    let outgoing = outgoing_links(OutgoingLinksRequest {
        database_id: "default".to_string(),
        path: "/Wiki/topic/source.md".to_string(),
        limit: 10,
    })
    .expect("outgoing links should load");
    assert_eq!(outgoing.len(), 2);

    let graph = graph_links(GraphLinksRequest {
        database_id: "default".to_string(),
        prefix: "/Wiki/topic".to_string(),
        limit: 10,
    })
    .expect("graph links should load");
    assert_eq!(graph.len(), 2);

    let context = read_node_context(NodeContextRequest {
        database_id: "default".to_string(),
        path: "/Wiki/topic/source.md".to_string(),
        link_limit: 10,
    })
    .expect("context should load")
    .expect("node should exist");
    assert_eq!(context.node.path, "/Wiki/topic/source.md");
    assert_eq!(context.outgoing_links.len(), 2);

    let neighborhood = graph_neighborhood(GraphNeighborhoodRequest {
        database_id: "default".to_string(),
        center_path: "/Wiki/target.md".to_string(),
        depth: 1,
        limit: 10,
    })
    .expect("neighborhood should load");
    assert_eq!(neighborhood.len(), 2);
}

#[test]
fn fs_entrypoints_cover_append_edit_and_mkdir() {
    install_test_service();

    let mkdir = mkdir_node(MkdirNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/work".to_string(),
    })
    .expect("mkdir should succeed");
    assert!(mkdir.created);
    assert_eq!(mkdir.path, "/Wiki/work");

    let appended = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/work/log.md".to_string(),
        content: "alpha".to_string(),
        expected_etag: None,
        separator: None,
        metadata_json: None,
        kind: None,
    })
    .expect("append create should succeed");
    assert!(appended.created);

    let appended_again = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/work/log.md".to_string(),
        content: "beta".to_string(),
        expected_etag: Some(appended.node.etag.clone()),
        separator: Some("\n".to_string()),
        metadata_json: None,
        kind: None,
    })
    .expect("append update should succeed");
    let appended_node = read_node("default".to_string(), "/Wiki/work/log.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(appended_node.content, "alpha\nbeta");

    let edited = edit_node(EditNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/work/log.md".to_string(),
        old_text: "beta".to_string(),
        new_text: "gamma".to_string(),
        expected_etag: Some(appended_again.node.etag.clone()),
        replace_all: false,
    })
    .expect("edit should succeed");
    assert_eq!(edited.replacement_count, 1);
    let edited_node = read_node("default".to_string(), "/Wiki/work/log.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(edited_node.content, "alpha\ngamma");
}

#[test]
fn fs_entrypoints_reject_noncanonical_source_paths() {
    install_test_service();

    let write_error = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/source.md".to_string(),
        kind: NodeKind::Source,
        content: "source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect_err("noncanonical source write should fail");
    assert!(write_error.contains("source path must"));

    ensure_parent_folders("/Sources/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/source/source.md".to_string(),
        kind: NodeKind::Source,
        content: "source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("canonical source write should succeed");

    let append_error = append_node(AppendNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/topic.md".to_string(),
        content: "next".to_string(),
        expected_etag: None,
        separator: None,
        metadata_json: None,
        kind: Some(NodeKind::Source),
    })
    .expect_err("noncanonical source append should fail");
    assert!(append_error.contains("source path must"));

    ensure_parent_folders("/Sources/keep/keep.md");
    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/keep/keep.md".to_string(),
        kind: NodeKind::Source,
        content: "keep".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("canonical source write should succeed");

    ensure_parent_folders("/Sources/renamed-/wrong.md");
    let move_error = move_node(MoveNodeRequest {
        database_id: "default".to_string(),
        from_path: "/Sources/keep/keep.md".to_string(),
        to_path: "/Sources/renamed-/wrong.md".to_string(),
        expected_etag: Some(created.node.etag),
        overwrite: false,
    })
    .expect_err("noncanonical source move should fail");
    assert!(move_error.contains("source path must"));
}

#[test]
fn fs_entrypoints_search_large_hits_without_trap() {
    install_test_service();

    let payload = format!("shared-bench-search {}", "x".repeat(1024 * 1024 - 20));
    ensure_parent_folders("/Wiki/large/node-000.md");
    for index in 0..10 {
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: format!("/Wiki/large/node-{index:03}.md"),
            kind: NodeKind::File,
            content: payload.clone(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("large write should succeed");
    }

    let hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "shared-bench-search".to_string(),
        prefix: Some("/Wiki/large".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("large search should succeed");

    assert_eq!(hits.len(), 10);
    for window in hits.windows(2) {
        assert!(window[0].score <= window[1].score);
    }
    for hit in hits {
        assert!(hit.path.starts_with("/Wiki/large/"));
        assert!(hit.snippet.is_none());
        assert!(hit.preview.is_none());
    }
}

#[test]
fn fs_entrypoints_search_cover_fts_recall_cjk_and_delete_sync() {
    install_test_service();
    ensure_parent_folders("/Wiki/search/node-0.md");

    for (path, content) in [
        ("/Wiki/search/node-0.md", "alpha beta gamma"),
        ("/Wiki/search/node-1.md", "alpha beta"),
        ("/Wiki/search/検索改善メモ.md", "検索精度改善の作業メモ"),
    ] {
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: path.to_string(),
            kind: NodeKind::File,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect("write should succeed");
    }

    let multi_term_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha beta missing".to_string(),
        prefix: Some("/Wiki/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("multi-term search should succeed");
    assert!(
        multi_term_hits
            .iter()
            .any(|hit| hit.path == "/Wiki/search/node-0.md")
    );
    assert!(
        multi_term_hits
            .iter()
            .any(|hit| hit.path == "/Wiki/search/node-1.md")
    );

    let cjk_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "検索改善".to_string(),
        prefix: Some("/Wiki/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("CJK search should succeed");
    assert!(
        cjk_hits
            .iter()
            .any(|hit| hit.path == "/Wiki/search/検索改善メモ.md")
    );

    let deleted = read_node("default".to_string(), "/Wiki/search/node-1.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    delete_node(DeleteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/search/node-1.md".to_string(),
        expected_etag: Some(deleted.etag),
        expected_folder_index_etag: None,
    })
    .expect("delete should succeed");

    let after_delete_hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha beta missing".to_string(),
        prefix: Some("/Wiki/search".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("search after delete should succeed");
    assert!(
        after_delete_hits
            .iter()
            .all(|hit| hit.path != "/Wiki/search/node-1.md")
    );
}

#[test]
fn fs_entrypoints_cover_move_glob_and_multi_edit() {
    install_test_service();
    ensure_parent_folders("/Wiki/work/item.md");
    ensure_parent_folders("/Wiki/archive/item.md");

    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/work/item.md".to_string(),
        kind: NodeKind::File,
        content: "alpha beta".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed");

    let moved = move_node(MoveNodeRequest {
        database_id: "default".to_string(),
        from_path: "/Wiki/work/item.md".to_string(),
        to_path: "/Wiki/archive/item.md".to_string(),
        expected_etag: Some(created.node.etag.clone()),
        overwrite: false,
    })
    .expect("move should succeed");
    assert_eq!(moved.from_path, "/Wiki/work/item.md");
    assert_eq!(moved.node.path, "/Wiki/archive/item.md");

    let globbed = glob_nodes(GlobNodesRequest {
        database_id: "default".to_string(),
        pattern: "**".to_string(),
        path: Some("/Wiki".to_string()),
        node_type: Some(GlobNodeType::Directory),
    })
    .expect("glob should succeed");
    assert!(
        globbed
            .iter()
            .any(|hit| hit.path == "/Wiki/archive" && hit.kind == NodeEntryKind::Folder)
    );

    let edited = multi_edit_node(MultiEditNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/archive/item.md".to_string(),
        edits: vec![
            MultiEdit {
                old_text: "alpha".to_string(),
                new_text: "one".to_string(),
            },
            MultiEdit {
                old_text: "beta".to_string(),
                new_text: "two".to_string(),
            },
        ],
        expected_etag: Some(moved.node.etag),
    })
    .expect("multi edit should succeed");
    assert_eq!(edited.replacement_count, 2);
    let edited_node = read_node("default".to_string(), "/Wiki/archive/item.md".to_string())
        .expect("read should succeed")
        .expect("node should exist");
    assert_eq!(edited_node.content, "one two");
}

#[test]
fn database_archive_entrypoints_export_bytes_and_block_normal_reads() {
    install_test_service();

    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/archive-smoke.md".to_string(),
        kind: NodeKind::File,
        content: "# Archive Smoke\n\nalpha body [raw](/Sources/smoke/smoke.md)".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("wiki write should succeed");
    ensure_parent_folders("/Sources/smoke/smoke.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/smoke/smoke.md".to_string(),
        kind: NodeKind::Source,
        content: "raw alpha body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("source write should succeed");

    let outgoing = outgoing_links(OutgoingLinksRequest {
        database_id: "default".to_string(),
        path: "/Wiki/archive-smoke.md".to_string(),
        limit: 10,
    })
    .expect("outgoing should load");
    assert_eq!(outgoing[0].target_path, "/Sources/smoke/smoke.md");

    let archive = begin_database_archive("default".to_string()).expect("archive should begin");
    assert!(archive.size_bytes > 0);
    let mut offset = 0_u64;
    let mut bytes = Vec::new();
    while offset < archive.size_bytes {
        let chunk = read_database_archive_chunk("default".to_string(), offset, 17)
            .expect("archive chunk should read")
            .bytes;
        assert!(!chunk.is_empty());
        offset += chunk.len() as u64;
        bytes.extend(chunk);
    }
    assert_eq!(bytes.len() as u64, archive.size_bytes);

    let snapshot_hash = sha256_bytes(&bytes);
    finalize_database_archive("default".to_string(), snapshot_hash.clone())
        .expect("archive should finalize");
    assert!(
        read_node("default".to_string(), "/Wiki/archive-smoke.md".to_string())
            .expect_err("archived DB should reject normal reads")
            .contains("database is archived")
    );

    let info = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(info.status, DatabaseStatus::Archived);
    assert_eq!(info.role, DatabaseRole::Owner);
}

#[test]
fn database_archive_restore_entrypoints_restore_search_and_links() {
    install_test_service();
    ensure_parent_folders("/Sources/archive/archive.md");

    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/archive/archive.md".to_string(),
        kind: NodeKind::Source,
        content: "raw archive restore evidence".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("source write should succeed");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/archive-restore.md".to_string(),
        kind: NodeKind::File,
        content: "# Archive Restore\n\nalpha restore search [raw](/Sources/archive/archive.md)"
            .to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("wiki write should succeed");

    let archive = begin_database_archive("default".to_string()).expect("archive should begin");
    let mut offset = 0_u64;
    let mut bytes = Vec::new();
    while offset < archive.size_bytes {
        let chunk = read_database_archive_chunk("default".to_string(), offset, 23)
            .expect("archive chunk should read")
            .bytes;
        assert!(!chunk.is_empty());
        offset += chunk.len() as u64;
        bytes.extend(chunk);
    }
    assert_eq!(bytes.len() as u64, archive.size_bytes);

    let snapshot_hash = sha256_bytes(&bytes);
    finalize_database_archive("default".to_string(), snapshot_hash.clone())
        .expect("archive should finalize");
    begin_database_restore(
        "default".to_string(),
        snapshot_hash.clone(),
        archive.size_bytes,
    )
    .expect("restore should begin");

    let split_at = bytes.len() / 2;
    write_database_restore_chunk(DatabaseRestoreChunkRequest {
        database_id: "default".to_string(),
        offset: split_at as u64,
        bytes: bytes[split_at..].to_vec(),
    })
    .expect("second restore chunk should write");
    write_database_restore_chunk(DatabaseRestoreChunkRequest {
        database_id: "default".to_string(),
        offset: 0,
        bytes: bytes[..split_at].to_vec(),
    })
    .expect("first restore chunk should write");
    finalize_database_restore("default".to_string()).expect("restore should finalize");

    let node = read_node(
        "default".to_string(),
        "/Wiki/archive-restore.md".to_string(),
    )
    .expect("read should succeed")
    .expect("restored node should exist");
    assert!(node.content.contains("alpha restore search"));

    let hits = search_nodes(SearchNodesRequest {
        database_id: "default".to_string(),
        query_text: "alpha restore".to_string(),
        prefix: Some("/Wiki".to_string()),
        top_k: 10,
        preview_mode: Some(SearchPreviewMode::None),
    })
    .expect("restored search should succeed");
    assert!(
        hits.iter()
            .any(|hit| hit.path == "/Wiki/archive-restore.md")
    );

    let links = outgoing_links(OutgoingLinksRequest {
        database_id: "default".to_string(),
        path: "/Wiki/archive-restore.md".to_string(),
        limit: 10,
    })
    .expect("restored links should load");
    assert!(
        links
            .iter()
            .any(|edge| edge.target_path == "/Sources/archive/archive.md")
    );

    let info = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(info.status, DatabaseStatus::Active);
    assert_eq!(info.role, DatabaseRole::Owner);
}

#[test]
fn begin_database_restore_rolls_back_when_mount_fails() {
    install_test_service();
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/restore-smoke.md".to_string(),
        kind: NodeKind::File,
        content: "restore body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("wiki write should succeed");

    let archive = begin_database_archive("default".to_string()).expect("archive should begin");
    let bytes = read_database_archive_chunk("default".to_string(), 0, archive.size_bytes as u32)
        .expect("archive chunk should read")
        .bytes;
    let snapshot_hash = sha256_bytes(&bytes);
    finalize_database_archive("default".to_string(), snapshot_hash.clone())
        .expect("archive should finalize");

    fail_next_mount_database_file_for_test();
    let error = begin_database_restore(
        "default".to_string(),
        snapshot_hash.clone(),
        archive.size_bytes,
    )
    .expect_err("mount failure should fail restore begin");
    assert!(error.contains("test mount failure"));
    let rolled_back = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(rolled_back.status, DatabaseStatus::Archived);
    assert_eq!(rolled_back.role, DatabaseRole::Owner);

    begin_database_restore("default".to_string(), snapshot_hash, archive.size_bytes)
        .expect("restore begin should retry after rollback");
    let restoring = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(restoring.status, DatabaseStatus::Restoring);
    assert_eq!(restoring.role, DatabaseRole::Owner);
}

#[test]
fn cancel_database_archive_entrypoint_returns_database_to_active() {
    install_test_service();
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/cancel-smoke.md".to_string(),
        kind: NodeKind::File,
        content: "cancel body".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("wiki write should succeed");

    begin_database_archive("default".to_string()).expect("archive should begin");
    assert!(
        write_node(WriteNodeRequest {
            database_id: "default".to_string(),
            path: "/Wiki/blocked.md".to_string(),
            kind: NodeKind::File,
            content: "blocked".to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: None,
        })
        .expect_err("archiving DB should reject writes")
        .contains("database is archiving")
    );

    cancel_database_archive("default".to_string()).expect("archive cancel should succeed");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Wiki/after-cancel.md".to_string(),
        kind: NodeKind::File,
        content: "after cancel".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("write should succeed after cancel");
    let info = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(info.status, DatabaseStatus::Active);
    assert_eq!(info.role, DatabaseRole::Owner);
}

#[test]
fn cancel_database_archive_entrypoint_rejects_non_owner() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    service
        .create_database("default", "owner", 1_700_000_000_000)
        .expect("default database should create");
    service
        .begin_database_cycles_purchase("default", "owner", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            let cycles = cycles_for_test_payment(&service, 1_000_000);
            service.complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                "default",
                "owner",
                cycles,
                1,
            )?;
            service.apply_database_cycles_purchase(
                operation_id,
                "default",
                "owner",
                cycles,
                1,
                1_700_000_000_001,
            )
        })
        .expect("database should have write cycles available");
    service
        .begin_database_archive("default", "owner", 1_700_000_000_002)
        .expect("archive should begin");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));

    assert!(
        cancel_database_archive("default".to_string())
            .expect_err("non-owner cancel should fail")
            .contains("principal has no access")
    );
}
