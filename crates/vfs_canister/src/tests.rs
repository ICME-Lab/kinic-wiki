// Where: crates/vfs_canister/src/tests.rs
// What: Entry-point level tests for the FS-first canister surface.
// Why: Phase 3 replaces the public canister contract, so tests must assert the wrapper behavior directly.
use std::future::Future;
use std::task::{Context, Poll, Waker};

use candid::{Encode, Nat, Principal};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use vfs_runtime::VfsService;
use vfs_types::{
    AppendNodeRequest, BillingAccount, BillingConfig, BillingConfigUpdate, CreateDatabaseRequest,
    DatabaseRestoreChunkRequest, DatabaseRole, DatabaseStatus, DeleteNodeRequest, EditNodeRequest,
    ExportSnapshotRequest, FetchUpdatesRequest, GlobNodeType, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, ListChildrenRequest, ListNodesRequest,
    MkdirNodeRequest, MoveNodeRequest, MultiEdit, MultiEditNodeRequest, NodeContextRequest,
    NodeEntryKind, NodeKind, OutgoingLinksRequest, QueryContextRequest, RecentNodesRequest,
    RenameDatabaseRequest, SearchNodePathsRequest, SearchNodesRequest, SearchPreviewMode,
    SourceEvidenceRequest, WriteNodeItem, WriteNodeRequest, WriteNodesRequest,
};

use super::{
    IcrcAccount, LedgerTransaction, LedgerTransfer, LedgerTransferFromOutcome,
    LedgerTransferOutcome, SERVICE, TransferError, TransferFromError, append_node,
    begin_database_archive, begin_database_restore, cancel_database_archive,
    check_database_billable, clear_last_ledger_memo_for_test, clear_ledger_transactions_for_test,
    create_database, delete_node, edit_node, export_snapshot,
    fail_next_mount_database_file_for_test, fetch_updates, finalize_database_archive,
    finalize_database_restore, glob_nodes, grant_database_access, graph_links, graph_neighborhood,
    incoming_links, last_ledger_memo_for_test, list_children, list_database_billing_entries,
    list_database_billing_pending_operations, list_database_members, list_databases, list_nodes,
    memory_manifest, mkdir_node, move_node, multi_edit_node, outgoing_links,
    parse_upgrade_billing_config_arg, preview_database_top_up, query_context, query_index_sql_json,
    read_database_archive_chunk, read_node, read_node_context, recent_nodes, rename_database,
    repair_database_top_up_cancel, repair_database_top_up_complete, repair_database_top_up_retry,
    repair_database_withdraw_complete, repair_database_withdraw_retry,
    repair_database_withdraw_reverse, revoke_database_access, search_node_paths, search_nodes,
    set_ledger_transaction_for_test, set_next_ledger_transfer_from_outcome_for_test,
    set_next_ledger_transfer_outcome_for_test, set_test_caller_principal_for_test, source_evidence,
    status, top_up_database, transfer_error_outcome, transfer_from_error_outcome,
    withdraw_database_balance, write_database_restore_chunk, write_node, write_nodes,
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
        .begin_database_top_up("default", "2vxsx-fae", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            service.credit_database_top_up(
                operation_id,
                "default",
                "2vxsx-fae",
                1_000_000,
                1,
                1_700_000_000_001,
            )
        })
        .expect("default database should be billable");
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
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

fn ledger_transfer_transaction(
    from: IcrcAccount,
    to: IcrcAccount,
    amount_e8s: u64,
    fee_e8s: u64,
    memo: Vec<u8>,
    created_at_time: u64,
) -> LedgerTransaction {
    LedgerTransaction {
        kind: "transfer".to_string(),
        transfer: Some(LedgerTransfer {
            from,
            to,
            amount: Nat::from(amount_e8s),
            fee: Some(Nat::from(fee_e8s)),
            memo: Some(memo),
            created_at_time: Some(created_at_time),
            spender: None,
        }),
    }
}

fn pending_top_up_transaction(
    operation: &vfs_types::DatabaseBillingPendingOperation,
) -> LedgerTransaction {
    ledger_transfer_transaction(
        IcrcAccount {
            owner: Principal::from_text(operation.from_owner.as_ref().expect("from owner"))
                .expect("from owner should parse"),
            subaccount: operation.from_subaccount.clone(),
        },
        IcrcAccount {
            owner: Principal::from_text(operation.to_owner.as_ref().expect("to owner"))
                .expect("to owner should parse"),
            subaccount: operation.to_subaccount.clone(),
        },
        operation.amount_e8s.try_into().expect("amount should fit"),
        operation
            .ledger_fee_e8s
            .expect("ledger fee")
            .try_into()
            .expect("fee should fit"),
        format!("kinic:vfs:top_up:{}", operation.operation_id).into_bytes(),
        operation
            .ledger_created_at_time_ns
            .expect("ledger created_at")
            .try_into()
            .expect("created_at should fit"),
    )
}

fn pending_withdraw_transaction(
    operation: &vfs_types::DatabaseBillingPendingOperation,
) -> LedgerTransaction {
    ledger_transfer_transaction(
        IcrcAccount {
            owner: Principal::from_text(operation.from_owner.as_ref().expect("from owner"))
                .expect("from owner should parse"),
            subaccount: operation.from_subaccount.clone(),
        },
        IcrcAccount {
            owner: Principal::from_text(operation.to_owner.as_ref().expect("to owner"))
                .expect("to owner should parse"),
            subaccount: operation.to_subaccount.clone(),
        },
        operation.amount_e8s.try_into().expect("amount should fit"),
        operation
            .ledger_fee_e8s
            .expect("ledger fee")
            .try_into()
            .expect("fee should fit"),
        format!("kinic:vfs:withdraw:{}", operation.operation_id).into_bytes(),
        operation
            .ledger_created_at_time_ns
            .expect("ledger created_at")
            .try_into()
            .expect("created_at should fit"),
    )
}

fn explicit_billing_config() -> BillingConfig {
    BillingConfig {
        kinic_ledger_canister_id: "aaaaa-aa".to_string(),
        sns_governance_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
        rate_numerator_e8s: 200,
        rate_denominator_cycles: 1_000_000,
        fixed_update_fee_e8s: 100,
        min_update_balance_e8s: 10_000,
    }
}

#[test]
fn billing_config_rejects_anonymous_principals() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    let mut config = explicit_billing_config();
    config.sns_governance_id = Principal::anonymous().to_text();

    let error = service
        .run_index_migrations_with_config(config)
        .expect_err("anonymous governance should reject");

    assert!(error.contains("principal must not be anonymous"));
}

#[test]
fn controller_can_query_index_sql_json() {
    install_test_service();
    set_test_caller_principal_for_test(Principal::management_canister());

    let result = query_index_sql_json(
        "SELECT json_object('top_up_e8s', COALESCE(SUM(amount_e8s), 0)) FROM database_billing_ledger WHERE kind = 'top_up' LIMIT 1".to_string(),
        10,
    )
    .expect("controller should query index SQL");

    assert_eq!(result.limit, 10);
    assert_eq!(result.row_count, 1);
    assert_eq!(result.rows, vec![r#"{"top_up_e8s":1000000}"#.to_string()]);
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
        "UPDATE database_billing_accounts SET balance_e8s = 0",
        "DELETE FROM database_billing_ledger",
        "INSERT INTO database_billing_ledger (database_id) VALUES ('x')",
        "CREATE TABLE x (id INTEGER)",
        "DROP TABLE database_billing_ledger",
        "PRAGMA table_info(database_billing_ledger)",
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

    assert!(error.contains("one non-null TEXT JSON column"));
}

fn fund_database(database_id: &str, amount_e8s: u64, ledger_block_index: u64) {
    let principal = Principal::management_canister().to_text();
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .begin_database_top_up(database_id, &principal, amount_e8s, 1_700_000_000_000)
            .and_then(|operation_id| {
                slot.borrow()
                    .as_ref()
                    .expect("service should be installed")
                    .credit_database_top_up(
                        operation_id,
                        database_id,
                        &principal,
                        amount_e8s,
                        ledger_block_index,
                        1_700_000_000_000,
                    )
            })
            .expect("database should be funded");
    });
}

fn test_billing_account() -> BillingAccount {
    BillingAccount {
        owner: Principal::management_canister(),
        subaccount: None,
    }
}

fn test_governance_principal() -> Principal {
    Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").expect("governance principal should parse")
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
fn post_upgrade_billing_config_arg_accepts_no_arg() {
    let bytes = Encode!().expect("empty candid args should encode");

    let parsed =
        parse_upgrade_billing_config_arg(&bytes).expect("empty post-upgrade arg should parse");

    assert_eq!(parsed, None);
}

#[test]
fn post_upgrade_billing_config_arg_accepts_bare_config() {
    let config = explicit_billing_config();
    let bytes = Encode!(&config).expect("billing config should encode");

    let parsed =
        parse_upgrade_billing_config_arg(&bytes).expect("bare post-upgrade config should parse");

    assert_eq!(parsed, Some(config));
}

#[test]
fn post_upgrade_billing_config_arg_accepts_optional_config() {
    let config = explicit_billing_config();
    let bytes = Encode!(&Some(config.clone())).expect("optional billing config should encode");

    let parsed = parse_upgrade_billing_config_arg(&bytes)
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
fn transfer_duplicate_outcome_is_completed() {
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
        "test pending".to_string(),
    ));
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::LedgerErr(
        "test reject".to_string(),
    ));
    let outcome = transfer_error_outcome(TransferError::Duplicate {
        duplicate_of: Nat::from(78_u64),
    });

    match outcome {
        LedgerTransferOutcome::Completed(block_index) => assert_eq!(block_index, 78),
        other => panic!("duplicate should complete, got {other:?}"),
    }
}

#[test]
fn top_up_database_credits_completed_transfer_from() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Funded".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let result = block_on_ready(top_up_database(database.database_id.clone(), 500))
        .expect("completed transfer-from should credit database");

    assert_eq!(result.block_index, 42);
    assert_eq!(result.balance_e8s, 500);
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "top_up");
    assert_eq!(entries[0].usage_event_id, None);
    assert_eq!(entries[0].ledger_block_index, Some(42));
}

#[test]
fn preview_database_top_up_rejects_invalid_target_before_approve() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Preview".to_string(),
    })
    .expect("database should create");

    preview_database_top_up(database.database_id.clone(), 500).expect("preview should accept");
    let zero = preview_database_top_up(database.database_id.clone(), 0)
        .expect_err("zero amount should reject");
    assert!(zero.contains("top-up amount must be positive"));
    let missing = preview_database_top_up("missing".to_string(), 500)
        .expect_err("missing database should reject");
    assert!(missing.contains("database not found"));
}

#[test]
fn top_up_database_rejects_balance_overflow_before_ledger_call() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Overflow".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, i64::MAX as u64, 41);
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(42));

    let error = block_on_ready(top_up_database(database.database_id, 1))
        .expect_err("overflow should reject before ledger");

    assert!(error.contains("balance overflow"));
    assert_eq!(last_ledger_memo_for_test(), None);
}

#[test]
fn top_up_database_leaves_balance_on_ledger_reject() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Rejected".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::LedgerErr(
        "icrc2_transfer_from failed: InsufficientAllowance".to_string(),
    ));

    let error = block_on_ready(top_up_database(database.database_id.clone(), 500))
        .expect_err("ledger reject should not credit database");

    assert!(error.contains("InsufficientAllowance"));
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert!(entries.is_empty());
}

#[test]
fn top_up_database_records_ambiguous_transfer_from() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Ambiguous".to_string(),
    })
    .expect("database should create");
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
        "icrc2_transfer_from decode failed".to_string(),
    ));

    let error = block_on_ready(top_up_database(database.database_id.clone(), 500))
        .expect_err("ambiguous transfer-from should return pending error");

    assert!(error.contains("top-up pending; manual repair required"));
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].kind, "top_up_ambiguous");
    assert_eq!(entries[0].amount_e8s, 500);
    assert_eq!(entries[0].balance_after_e8s, 0);
    assert_eq!(entries[0].usage_event_id, None);
    assert_eq!(entries[0].ledger_block_index, None);
}

#[test]
fn governance_can_repair_ambiguous_top_up() {
    install_empty_test_service();
    let database_id;
    let operation_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Repair top-up".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
            "icrc2_transfer_from decode failed".to_string(),
        ));
        let error = block_on_ready(top_up_database(database_id.clone(), 500))
            .expect_err("ambiguous transfer-from should return pending error");
        assert!(error.contains("top-up pending"));

        let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("owner should list pending operations")
            .entries;
        assert_eq!(pending.len(), 1);
        operation_id = pending[0].operation_id;

        let error = block_on_ready(repair_database_top_up_complete(
            database_id.clone(),
            operation_id,
            77,
        ))
        .expect_err("owner repair should reject");
        assert!(error.contains("caller is not SNS governance"));
    }

    {
        let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
        let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("governance should list pending operations")
            .entries;
        assert_eq!(pending.len(), 1);
        set_ledger_transaction_for_test(77, pending_top_up_transaction(&pending[0]));
        let result = block_on_ready(repair_database_top_up_complete(
            database_id.clone(),
            operation_id,
            77,
        ))
        .expect("governance should repair top-up");
        assert_eq!(result.block_index, 77);
        assert_eq!(result.balance_e8s, 500);
    }

    let _owner = AuthenticatedCallerGuard::install();
    let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
        .expect("owner should list pending operations")
        .entries;
    assert!(pending.is_empty());
    let entries = list_database_billing_entries(database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries[0].kind, "top_up_ambiguous");
    assert_eq!(entries[1].kind, "top_up_repair_complete");
    assert_eq!(entries[1].ledger_block_index, Some(77));
}

#[test]
fn repair_top_up_complete_rejects_mismatched_ledger_block() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Repair mismatch".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
            "icrc2_transfer_from decode failed".to_string(),
        ));
        let _ = block_on_ready(top_up_database(database_id.clone(), 500))
            .expect_err("ambiguous top-up should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
        .expect("pending should load")
        .entries;
    let mut transaction = pending_top_up_transaction(&pending[0]);
    transaction.transfer.as_mut().expect("transfer").amount = Nat::from(499_u64);
    set_ledger_transaction_for_test(78, transaction);

    let error = block_on_ready(repair_database_top_up_complete(
        database_id.clone(),
        operation_id,
        78,
    ))
    .expect_err("mismatched block should reject");
    assert!(error.contains("amount mismatch"));
    let pending = list_database_billing_pending_operations(database_id, None, 10)
        .expect("pending should remain")
        .entries;
    assert_eq!(pending.len(), 1);
}

#[test]
fn repair_top_up_retry_uses_original_ledger_args() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Retry top-up".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
            "icrc2_transfer_from decode failed".to_string(),
        ));
        let _ = block_on_ready(top_up_database(database_id.clone(), 500))
            .expect_err("ambiguous top-up should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(79));
    let result = block_on_ready(repair_database_top_up_retry(
        database_id.clone(),
        operation_id,
    ))
    .expect("retry should complete");
    assert_eq!(result.block_index, 79);
    assert_eq!(result.balance_e8s, 500);
    let memo = last_ledger_memo_for_test().expect("retry should send memo");
    assert!(String::from_utf8_lossy(&memo).starts_with("kinic:vfs:top_up:"));
    let pending = list_database_billing_pending_operations(database_id, None, 10)
        .expect("pending should load")
        .entries;
    assert!(pending.is_empty());
}

#[test]
fn repair_top_up_cancel_rejects_ambiguous_operation() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Cancel top-up".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Ambiguous(
            "icrc2_transfer_from call failed".to_string(),
        ));
        let _ = block_on_ready(top_up_database(database_id.clone(), 500))
            .expect_err("ambiguous top-up should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    let error = repair_database_top_up_cancel(database_id.clone(), operation_id)
        .expect_err("ambiguous top-up cancel should reject");
    assert!(error.contains("requires verified complete or retry"));
    let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
        .expect("pending should load")
        .entries;
    assert_eq!(pending.len(), 1);
    let entries = list_database_billing_entries(database_id, None, 10)
        .expect("ledger should load")
        .entries;
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["top_up_ambiguous"]
    );
}

#[test]
fn top_up_database_allows_non_owner_payer() {
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
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(43));

    let result =
        block_on_ready(top_up_database(database_id, 700)).expect("non-owner payer should fund DB");

    assert_eq!(result.block_index, 43);
    assert_eq!(result.balance_e8s, 700);
}

#[test]
fn top_up_database_sends_operation_memo_to_ledger() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Memo".to_string(),
    })
    .expect("database should create");
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_from_outcome_for_test(LedgerTransferFromOutcome::Completed(43));

    block_on_ready(top_up_database(database.database_id, 700)).expect("top-up should succeed");

    let memo = String::from_utf8(last_ledger_memo_for_test().expect("memo should be recorded"))
        .expect("memo should be utf8");
    assert!(memo.starts_with("kinic:vfs:top_up:"));
}

#[test]
fn top_up_database_rejects_unknown_and_deleted_database() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();

    let missing = block_on_ready(top_up_database("missing".to_string(), 500))
        .expect_err("unknown database should reject");
    assert!(missing.contains("database not found"));

    let database = create_database(CreateDatabaseRequest {
        name: "Deleted".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000_000, 44);
    super::delete_database(database.database_id.clone()).expect("owner should delete");

    let deleted = block_on_ready(top_up_database(database.database_id, 500))
        .expect_err("deleted database should reject");
    assert!(deleted.contains("database is deleted"));
}

#[test]
fn withdraw_database_balance_completes_transfer() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Withdraw".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Completed(77));

    let result = block_on_ready(withdraw_database_balance(
        database.database_id.clone(),
        400,
        test_billing_account(),
    ))
    .expect("withdraw should complete");

    assert_eq!(result.block_index, 77);
    assert_eq!(result.balance_e8s, 590);
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries[1].kind, "withdraw_pending");
    assert_eq!(entries[2].kind, "withdraw_fee_pending");
    assert_eq!(entries[3].kind, "withdraw_complete");
    assert_eq!(entries[3].usage_event_id, None);
    assert_eq!(entries[3].ledger_block_index, Some(77));
}

#[test]
fn withdraw_database_balance_rejects_invalid_subaccount_before_ledger_call() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Invalid subaccount".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    clear_last_ledger_memo_for_test();
    let account = BillingAccount {
        owner: Principal::management_canister(),
        subaccount: Some(vec![1]),
    };

    let error = block_on_ready(withdraw_database_balance(
        database.database_id,
        400,
        account,
    ))
    .expect_err("invalid subaccount should reject");

    assert!(error.contains("subaccount must be 32 bytes"));
    assert_eq!(last_ledger_memo_for_test(), None);
}

#[test]
fn withdraw_database_balance_sends_operation_memo_to_ledger() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Withdraw memo".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    clear_last_ledger_memo_for_test();
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Completed(77));

    block_on_ready(withdraw_database_balance(
        database.database_id,
        400,
        test_billing_account(),
    ))
    .expect("withdraw should succeed");

    let memo = String::from_utf8(last_ledger_memo_for_test().expect("memo should be recorded"))
        .expect("memo should be utf8");
    assert!(memo.starts_with("kinic:vfs:withdraw:"));
}

#[test]
fn withdraw_database_balance_reverses_on_ledger_reject() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Withdraw reject".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::LedgerErr(
        "icrc1_transfer failed: InsufficientFunds".to_string(),
    ));

    let error = block_on_ready(withdraw_database_balance(
        database.database_id.clone(),
        400,
        test_billing_account(),
    ))
    .expect_err("ledger reject should reverse withdraw");

    assert!(error.contains("InsufficientFunds"));
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries[1].kind, "withdraw_pending");
    assert_eq!(entries[2].kind, "withdraw_fee_pending");
    assert_eq!(entries[3].kind, "withdraw_reversal");
    assert_eq!(entries[3].balance_after_e8s, 1_000);
}

#[test]
fn withdraw_database_balance_records_ambiguous_transfer() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Withdraw ambiguous".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
        "icrc1_transfer decode failed".to_string(),
    ));

    let error = block_on_ready(withdraw_database_balance(
        database.database_id.clone(),
        400,
        test_billing_account(),
    ))
    .expect_err("ambiguous transfer should return pending error");

    assert!(error.contains("withdraw pending; manual repair required"));
    let entries = list_database_billing_entries(database.database_id, None, 10)
        .expect("database ledger should load")
        .entries;
    assert_eq!(entries[1].kind, "withdraw_pending");
    assert_eq!(entries[2].kind, "withdraw_fee_pending");
    assert_eq!(entries[3].kind, "withdraw_ambiguous");
    assert_eq!(entries[3].balance_after_e8s, 590);
}

#[test]
fn withdraw_ambiguous_persists_destination_for_repair() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Withdraw destination".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000, 43);
    let to = BillingAccount {
        owner: Principal::management_canister(),
        subaccount: Some(vec![7; 32]),
    };
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
        "icrc1_transfer decode failed".to_string(),
    ));

    let _ = block_on_ready(withdraw_database_balance(
        database.database_id.clone(),
        400,
        to.clone(),
    ))
    .expect_err("ambiguous transfer should stay pending");

    let pending = list_database_billing_pending_operations(database.database_id, None, 10)
        .expect("pending should load")
        .entries;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].to_owner, Some(to.owner.to_text()));
    assert_eq!(pending[0].to_subaccount, to.subaccount);
    assert_eq!(pending[0].ledger_fee_e8s, Some(10));
    assert_eq!(
        pending[0].ledger_created_at_time_ns,
        Some(1_700_000_000_000_000_000)
    );
}

#[test]
fn governance_can_repair_ambiguous_withdraw_with_verified_block() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Repair withdraw".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        fund_database(&database_id, 1_000, 43);
        set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
            "icrc1_transfer decode failed".to_string(),
        ));
        let _ = block_on_ready(withdraw_database_balance(
            database_id.clone(),
            400,
            test_billing_account(),
        ))
        .expect_err("ambiguous withdraw should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
        .expect("pending should load")
        .entries;
    set_ledger_transaction_for_test(80, pending_withdraw_transaction(&pending[0]));
    let result = block_on_ready(repair_database_withdraw_complete(
        database_id.clone(),
        operation_id,
        80,
    ))
    .expect("governance should repair withdraw");
    assert_eq!(result.block_index, 80);
    assert_eq!(result.balance_e8s, 590);
    let pending = list_database_billing_pending_operations(database_id, None, 10)
        .expect("pending should load")
        .entries;
    assert!(pending.is_empty());
}

#[test]
fn repair_withdraw_retry_keeps_pending_on_ledger_error() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Retry withdraw".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        fund_database(&database_id, 1_000, 43);
        set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
            "icrc1_transfer decode failed".to_string(),
        ));
        let _ = block_on_ready(withdraw_database_balance(
            database_id.clone(),
            400,
            test_billing_account(),
        ))
        .expect_err("ambiguous withdraw should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::LedgerErr(
        "icrc1_transfer failed: TemporarilyUnavailable".to_string(),
    ));
    let error = block_on_ready(repair_database_withdraw_retry(
        database_id.clone(),
        operation_id,
    ))
    .expect_err("retry error should keep pending");
    assert!(error.contains("withdraw retry still pending"));
    let pending = list_database_billing_pending_operations(database_id, None, 10)
        .expect("pending should load")
        .entries;
    assert_eq!(pending.len(), 1);
}

#[test]
fn repair_withdraw_reverse_rejects_ambiguous_operation() {
    install_empty_test_service();
    let operation_id;
    let database_id;
    {
        let _owner = AuthenticatedCallerGuard::install();
        let database = create_database(CreateDatabaseRequest {
            name: "Reverse withdraw".to_string(),
        })
        .expect("database should create");
        database_id = database.database_id;
        fund_database(&database_id, 1_000, 44);
        set_next_ledger_transfer_outcome_for_test(LedgerTransferOutcome::Ambiguous(
            "icrc1_transfer call failed".to_string(),
        ));
        let _ = block_on_ready(withdraw_database_balance(
            database_id.clone(),
            400,
            test_billing_account(),
        ))
        .expect_err("ambiguous withdraw should stay pending");
        operation_id = list_database_billing_pending_operations(database_id.clone(), None, 10)
            .expect("pending should load")
            .entries[0]
            .operation_id;
    }

    let _governance = AuthenticatedCallerGuard::install_principal(test_governance_principal());
    let error = repair_database_withdraw_reverse(database_id.clone(), operation_id)
        .expect_err("ambiguous withdraw reverse should reject");
    assert!(error.contains("requires verified complete or retry"));
    let pending = list_database_billing_pending_operations(database_id.clone(), None, 10)
        .expect("pending should load")
        .entries;
    assert_eq!(pending.len(), 1);
    let entries = list_database_billing_entries(database_id, None, 10)
        .expect("ledger should load")
        .entries;
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.kind.as_str())
            .collect::<Vec<_>>(),
        vec![
            "top_up",
            "withdraw_pending",
            "withdraw_fee_pending",
            "withdraw_ambiguous"
        ]
    );
}

fn usage_event_count() -> u64 {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .usage_event_count()
            .expect("usage count should load")
    })
}

fn usage_event_database_ids() -> Vec<Option<String>> {
    SERVICE.with(|slot| {
        slot.borrow()
            .as_ref()
            .expect("service should be installed")
            .usage_event_database_ids()
            .expect("usage database ids should load")
    })
}

fn database_charge_methods(database_id: &str) -> Vec<String> {
    list_database_billing_entries(database_id.to_string(), None, 20)
        .expect("database billing ledger should load")
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
    service
        .begin_database_top_up("default", "2vxsx-fae", 1, 1_700_000_000_001)
        .and_then(|operation_id| {
            service.credit_database_top_up(
                operation_id,
                "default",
                "2vxsx-fae",
                1,
                1,
                1_700_000_000_001,
            )
        })
        .expect("default database should become suspended");
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
        .begin_database_top_up("default", "2vxsx-fae", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            service.credit_database_top_up(
                operation_id,
                "default",
                "2vxsx-fae",
                1_000_000,
                1,
                1_700_000_000_001,
            )
        })
        .expect("default database should start funded");
    service
        .grant_database_access(
            "default",
            "2vxsx-fae",
            &test_governance_principal().to_text(),
            DatabaseRole::Writer,
            1_700_000_000_002,
        )
        .expect("writer should be granted before low-balance config");
    service
        .update_billing_config(
            BillingConfigUpdate {
                rate_numerator_e8s: 200,
                rate_denominator_cycles: 1_000_000,
                fixed_update_fee_e8s: 100,
                min_update_balance_e8s: 2_000_000,
            },
            &test_governance_principal().to_text(),
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
    assert_eq!(summaries[0].status, DatabaseStatus::Hot);
}

#[test]
fn update_entrypoints_record_usage_events() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let database = create_database(CreateDatabaseRequest {
        name: "Usage events".to_string(),
    })
    .expect("database should create");
    fund_database(&database.database_id, 1_000_000, 90);
    assert_eq!(usage_event_count(), 1);

    let failed = write_node(WriteNodeRequest {
        database_id: database.database_id,
        path: "/Sources/not-raw.md".to_string(),
        kind: NodeKind::Source,
        content: "invalid source path".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    });
    assert!(failed.is_err());
    assert_eq!(usage_event_count(), 2);
}

#[test]
fn write_nodes_records_one_usage_event_and_writes_nodes() {
    install_test_service();

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
    assert_eq!(usage_event_count(), 1);
    assert_eq!(
        database_charge_methods("default"),
        vec!["write_nodes".to_string()]
    );
    assert!(
        read_node("default".to_string(), "/Wiki/batch-a.md".to_string())
            .expect("read should succeed")
            .is_some()
    );
}

#[test]
fn write_node_and_write_nodes_use_same_billing_path() {
    install_test_service();

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

    assert_eq!(
        database_charge_methods("default"),
        vec!["write_node".to_string(), "write_nodes".to_string()]
    );
}

#[test]
fn write_nodes_rejects_low_database_billing_balance() {
    install_unfunded_default_service();

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

    assert!(error.contains("database billing is suspended"));
    assert_eq!(usage_event_count(), 0);
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

    assert!(batch.contains("database billing is suspended"));
    assert!(mkdir.contains("database billing is suspended"));
    assert!(cancel.contains("database billing is suspended"));
}

#[test]
fn suspended_database_allows_owner_management_operations() {
    install_suspended_default_service();

    rename_database(RenameDatabaseRequest {
        database_id: "default".to_string(),
        name: "Suspended rename".to_string(),
    })
    .expect("suspended database owner should rename");
    super::delete_database("default".to_string()).expect("suspended database owner should delete");
}

#[test]
fn low_balance_database_allows_owner_revoke_and_delete() {
    install_low_balance_default_service();

    revoke_database_access("default".to_string(), test_governance_principal().to_text())
        .expect("low-balance database owner should revoke");
    super::delete_database("default".to_string())
        .expect("low-balance database owner should delete");
}

#[test]
fn metered_update_checks_access_before_billing_state() {
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
    .expect_err("non-member should fail before billing state");

    assert!(error.contains("principal has no access"));
    assert!(!error.contains("database billing is suspended"));
}

#[test]
fn check_database_billable_requires_authenticated_writer() {
    install_empty_test_service();
    let owner = Principal::management_canister();
    let reader =
        Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").expect("reader principal should parse");
    let database_id = {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        create_database(CreateDatabaseRequest {
            name: "Billable check".to_string(),
        })
        .expect("database should create")
        .database_id
    };

    let anonymous =
        check_database_billable(database_id.clone()).expect_err("anonymous caller should fail");
    assert!(anonymous.contains("anonymous caller not allowed"));

    let suspended = {
        let _caller = AuthenticatedCallerGuard::install_principal(owner);
        check_database_billable(database_id.clone()).expect_err("suspended database should fail")
    };
    assert!(suspended.contains("database billing is suspended"));

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
        check_database_billable(database_id.clone()).expect_err("reader should fail")
    };
    assert!(reader_error.contains("principal lacks required database role"));

    let _caller = AuthenticatedCallerGuard::install_principal(owner);
    check_database_billable(database_id).expect("owner should pass billable check");
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
        .begin_database_top_up("public", "owner", 1_000_000, 2)
        .and_then(|operation_id| {
            service.credit_database_top_up(operation_id, "public", "owner", 1_000_000, 1, 2)
        })
        .expect("database should be billable");
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
    assert_eq!(usage_event_count(), 1);
}

#[test]
fn create_database_records_usage_and_returns_result() {
    install_empty_test_service();
    let _caller = AuthenticatedCallerGuard::install();
    let result = create_database(CreateDatabaseRequest {
        name: " Team skills ".to_string(),
    })
    .expect("database should create");
    assert!(result.database_id.starts_with("db_"));
    assert_eq!(result.database_id.len(), 15);
    assert_eq!(result.name, "Team skills");
    assert_eq!(usage_event_count(), 1);
    assert_eq!(
        usage_event_database_ids(),
        vec![Some(result.database_id.clone())]
    );

    let status = status(result.database_id.clone());
    assert_eq!(status.file_count, 0);
    assert_eq!(status.source_count, 0);
    let children = list_children(ListChildrenRequest {
        database_id: result.database_id,
        path: "/Wiki".to_string(),
    })
    .expect("generated database should list");
    assert!(children.is_empty());
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
fn query_entrypoints_do_not_record_usage_events() {
    install_test_service();

    let current = status("default".to_string());
    assert_eq!(current.file_count, 0);
    let snapshot = export_snapshot(ExportSnapshotRequest {
        database_id: "default".to_string(),
        prefix: Some("/Wiki".to_string()),
        limit: 100,
        cursor: None,
        snapshot_revision: None,
        snapshot_session_id: None,
    })
    .expect("snapshot query should succeed");
    assert_eq!(snapshot.snapshot_session_id, None);
    assert_eq!(usage_event_count(), 0);
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
fn memory_entrypoints_return_agent_memory_contract() {
    install_test_service();

    let manifest = memory_manifest();
    assert_eq!(manifest.api_version, "agent-memory-v1");
    assert_eq!(manifest.write_policy, "agent_memory_read_only");
    assert_eq!(manifest.recommended_entrypoint, "query_context");
    assert_eq!(manifest.max_depth, 2);
    assert!(manifest.roots.iter().any(|root| root.path == "/Wiki"));

    for (path, content) in [
        ("/Wiki/scope/index.md", "# Index\n\n[Overview](overview.md)"),
        (
            "/Wiki/scope/overview.md",
            "# Overview\n\nbeam memory [Raw](/Sources/raw/a/a.md)",
        ),
        ("/Wiki/scope/schema.md", "# Schema\n\nread-only"),
        (
            "/Wiki/scope/provenance.md",
            "# Provenance\n\n[Raw](/Sources/raw/a/a.md)",
        ),
        ("/Sources/raw/a/a.md", "raw source"),
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

    let context = query_context(QueryContextRequest {
        database_id: "default".to_string(),
        task: "beam memory".to_string(),
        entities: Vec::new(),
        namespace: Some("/Wiki/scope".to_string()),
        budget_tokens: 1_000,
        include_evidence: true,
        depth: 1,
    })
    .expect("query context should load");
    assert!(
        context
            .nodes
            .iter()
            .any(|node| node.node.path == "/Wiki/scope/overview.md")
    );
    assert!(!context.evidence.is_empty());

    let evidence = source_evidence(SourceEvidenceRequest {
        database_id: "default".to_string(),
        node_path: "/Wiki/scope/overview.md".to_string(),
    })
    .expect("evidence should load");
    assert!(
        evidence
            .refs
            .iter()
            .any(|item| item.source_path == "/Sources/raw/a/a.md")
    );
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
    ensure_parent_folders("/Sources/raw/source/source.md");
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
    assert_eq!(snapshot.nodes.len(), 4);

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

    ensure_parent_folders("/Sources/raw/source/source.md");
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
        path: "/Sources/raw/source.md".to_string(),
        kind: NodeKind::Source,
        content: "source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect_err("noncanonical source write should fail");
    assert!(write_error.contains("source path must"));

    ensure_parent_folders("/Sources/raw/source/source.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/raw/source/source.md".to_string(),
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

    ensure_parent_folders("/Sources/raw/keep/keep.md");
    let created = write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/raw/keep/keep.md".to_string(),
        kind: NodeKind::Source,
        content: "keep".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("canonical source write should succeed");

    ensure_parent_folders("/Sources/raw/renamed-/wrong.md");
    let move_error = move_node(MoveNodeRequest {
        database_id: "default".to_string(),
        from_path: "/Sources/raw/keep/keep.md".to_string(),
        to_path: "/Sources/raw/renamed-/wrong.md".to_string(),
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
fn fs_entrypoints_cover_move_glob_recent_and_multi_edit() {
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

    let recent = recent_nodes(RecentNodesRequest {
        database_id: "default".to_string(),
        limit: 5,
        path: Some("/Wiki".to_string()),
    })
    .expect("recent should succeed");
    assert!(
        recent
            .iter()
            .any(|node| node.path == "/Wiki/archive/item.md")
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
        content: "# Archive Smoke\n\nalpha body [raw](/Sources/raw/smoke/smoke.md)".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
    })
    .expect("wiki write should succeed");
    ensure_parent_folders("/Sources/raw/smoke/smoke.md");
    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/raw/smoke/smoke.md".to_string(),
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
    assert_eq!(outgoing[0].target_path, "/Sources/raw/smoke/smoke.md");

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
    ensure_parent_folders("/Sources/raw/archive/archive.md");

    write_node(WriteNodeRequest {
        database_id: "default".to_string(),
        path: "/Sources/raw/archive/archive.md".to_string(),
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
        content: "# Archive Restore\n\nalpha restore search [raw](/Sources/raw/archive/archive.md)"
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
            .any(|edge| edge.target_path == "/Sources/raw/archive/archive.md")
    );

    let info = list_databases()
        .expect("database summaries should load")
        .into_iter()
        .find(|info| info.database_id == "default")
        .expect("default info should exist");
    assert_eq!(info.status, DatabaseStatus::Hot);
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
fn cancel_database_archive_entrypoint_returns_database_to_hot() {
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
    assert_eq!(info.status, DatabaseStatus::Hot);
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
        .begin_database_top_up("default", "owner", 1_000_000, 1_700_000_000_001)
        .and_then(|operation_id| {
            service.credit_database_top_up(
                operation_id,
                "default",
                "owner",
                1_000_000,
                1,
                1_700_000_000_001,
            )
        })
        .expect("database should be billable");
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
