// Where: crates/vfs_canister/src/lib.rs
// What: ICP canister entrypoints backed by VfsService with an FS-first public API.
// Why: The canister now exposes node-oriented operations directly and keeps the runtime boundary thin.
use std::cell::RefCell;
use std::fs::create_dir_all;
use std::ops::Range;
#[cfg(not(test))]
use std::path::Path;
use std::path::PathBuf;

use candid::{CandidType, Decode, Deserialize, Nat, Principal, export_service};
#[cfg(not(test))]
use ic_cdk::call::Call;
use ic_cdk::{init, post_upgrade, query, update};
use ic_stable_structures::DefaultMemoryImpl;
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use vfs_runtime::{DatabaseMeta, UsageEvent, VfsService};
use vfs_types::{
    AppendNodeRequest, BillingAccount, BillingConfig, BillingConfigUpdate, BillingTransferResult,
    CanisterHealth, CanonicalRole, ChildNode, DatabaseArchiveChunk, DatabaseArchiveInfo,
    DatabaseBillingEntryPage, DatabaseMember, DatabaseRestoreChunkRequest, DatabaseRole,
    DatabaseSummary, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest,
    IncomingLinksRequest, LinkEdge, ListChildrenRequest, ListNodesRequest, MemoryCapability,
    MemoryManifest, MemoryRoot, MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult,
    MultiEditNodeRequest, MultiEditNodeResult, Node, NodeContext, NodeContextRequest, NodeEntry,
    OutgoingLinksRequest, PrincipalBillingEntryPage, PrincipalBillingSummary, QueryContext,
    QueryContextRequest, RecentNodeHit, RecentNodesRequest, SearchNodeHit, SearchNodePathsRequest,
    SearchNodesRequest, SourceEvidence, SourceEvidenceRequest, Status, WriteNodeRequest,
    WriteNodeResult,
};

const INDEX_DB_PATH: &str = "./DB/index.sqlite3";
const DATABASES_DIR: &str = "./DB/databases";
// WASI filesystem memory is for tmp files and directory metadata, not DB slots.
// SQLite DB files are mounted separately with dedicated MemoryId values.
const WASI_FS_MEMORY_RANGE: Range<u16> = 0..10;
const INDEX_DB_MEMORY_ID: u16 = 10;

thread_local! {
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static SERVICE: RefCell<Option<VfsService>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug)]
enum LedgerTransferOutcome {
    Completed(u64),
    LedgerErr(String),
    Ambiguous(String),
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct IcrcAccount {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType)]
struct TransferArg {
    from_subaccount: Option<Vec<u8>>,
    to: IcrcAccount,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType)]
struct TransferFromArg {
    spender_subaccount: Option<Vec<u8>>,
    from: IcrcAccount,
    to: IcrcAccount,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum TransferError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum TransferFromError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}

#[init]
fn init_hook(config: BillingConfig) {
    initialize_or_trap(Some(config));
}

#[post_upgrade]
fn post_upgrade_hook() {
    initialize_or_trap(None);
}

#[query]
fn status(database_id: String) -> Status {
    with_service(|service| service.status(&database_id, &caller_text()))
        .unwrap_or_else(|error| ic_cdk::trap(&error))
}

#[query]
fn canister_health() -> CanisterHealth {
    CanisterHealth {
        cycles_balance: ic_cdk::api::canister_cycle_balance(),
    }
}

#[query]
fn memory_manifest() -> MemoryManifest {
    MemoryManifest {
        api_version: "agent-memory-v1".to_string(),
        purpose: "Canister-backed long-term wiki memory for agents".to_string(),
        roots: vec![
            MemoryRoot {
                path: "/Wiki".to_string(),
                kind: "wiki".to_string(),
            },
            MemoryRoot {
                path: "/Sources".to_string(),
                kind: "raw_sources".to_string(),
            },
        ],
        capabilities: memory_capabilities(),
        canonical_roles: canonical_roles(),
        write_policy: "agent_memory_read_only".to_string(),
        recommended_entrypoint: "query_context".to_string(),
        max_depth: 2,
        max_query_limit: 100,
        budget_unit: "approx_chars_from_tokens".to_string(),
    }
}

#[query]
fn read_node(database_id: String, path: String) -> Result<Option<Node>, String> {
    with_service(|service| service.read_node(&database_id, &caller_text(), &path))
}

#[query]
fn list_nodes(request: ListNodesRequest) -> Result<Vec<NodeEntry>, String> {
    with_service(|service| service.list_nodes(&caller_text(), request))
}

#[query]
fn list_children(request: ListChildrenRequest) -> Result<Vec<ChildNode>, String> {
    with_service(|service| service.list_children(&caller_text(), request))
}

#[update]
fn create_database(display_name: String, initial_deposit_e8s: u64) -> Result<String, String> {
    require_authenticated_caller()?;
    with_unmetered_update("create_database", None, |service, caller, now| {
        let meta = service.create_generated_database_with_initial_deposit(
            &display_name,
            caller,
            initial_deposit_e8s,
            now,
        )?;
        if let Err(error) = mount_database_file(&meta) {
            let amount = i64::try_from(initial_deposit_e8s).unwrap_or(i64::MAX);
            let cleanup_error = service
                .reverse_failed_database_create(&meta.database_id, caller, amount, now)
                .err();
            return Err(database_create_error(error, cleanup_error));
        }
        if let Err(error) = service.run_database_migrations(&meta.database_id) {
            unmount_database_file(&meta.db_file_name);
            let amount = i64::try_from(initial_deposit_e8s).unwrap_or(i64::MAX);
            let cleanup_error = service
                .reverse_failed_database_create(&meta.database_id, caller, amount, now)
                .err();
            return Err(database_create_error(error, cleanup_error));
        }
        Ok(meta.database_id)
    })
}

#[update]
fn rename_database(database_id: String, display_name: String) -> Result<(), String> {
    require_authenticated_caller()?;
    with_metered_update(
        "rename_database",
        Some(database_id.clone()),
        |service, caller, now| service.rename_database(&database_id, &display_name, caller, now),
    )
}

#[update]
fn grant_database_access(
    database_id: String,
    principal: String,
    role: DatabaseRole,
) -> Result<(), String> {
    with_metered_update(
        "grant_database_access",
        Some(database_id.clone()),
        |service, caller, now| {
            let principal = Principal::from_text(&principal)
                .map_err(|error| format!("invalid principal: {error}"))?
                .to_text();
            service.grant_database_access(&database_id, caller, &principal, role, now)
        },
    )
}

#[update]
fn revoke_database_access(database_id: String, principal: String) -> Result<(), String> {
    with_metered_update(
        "revoke_database_access",
        Some(database_id.clone()),
        |service, caller, _now| {
            let principal = Principal::from_text(&principal)
                .map_err(|error| format!("invalid principal: {error}"))?
                .to_text();
            service.revoke_database_access(&database_id, caller, &principal)
        },
    )
}

#[query]
fn list_database_members(database_id: String) -> Result<Vec<DatabaseMember>, String> {
    with_service(|service| service.list_database_members(&database_id, &caller_text()))
}

#[query]
fn list_databases() -> Result<Vec<DatabaseSummary>, String> {
    with_service(|service| service.list_database_summaries_for_caller(&caller_text()))
}

#[update]
async fn top_up_principal_balance(amount_e8s: u64) -> Result<BillingTransferResult, String> {
    require_authenticated_caller()?;
    let caller = caller_text();
    let now = now_millis();
    let config = with_service(|service| service.billing_config())?;
    let ledger = Principal::from_text(&config.kinic_ledger_canister_id)
        .map_err(|error| format!("invalid KINIC ledger canister id: {error}"))?;
    let block_index = ledger_transfer_from(ledger, caller_principal(), amount_e8s).await?;
    let balance = with_service(|service| {
        service.credit_principal_top_up(&caller, amount_e8s, block_index, now)
    })?;
    Ok(BillingTransferResult {
        block_index,
        balance_e8s: balance,
    })
}

#[update]
async fn withdraw_principal_balance(
    amount_e8s: u64,
    to: BillingAccount,
) -> Result<BillingTransferResult, String> {
    require_authenticated_caller()?;
    let caller = caller_text();
    let now = now_millis();
    let config = with_service(|service| service.billing_config())?;
    let ledger = Principal::from_text(&config.kinic_ledger_canister_id)
        .map_err(|error| format!("invalid KINIC ledger canister id: {error}"))?;
    let fee_e8s = ledger_fee(ledger).await?;
    with_service(|service| service.begin_principal_withdraw(&caller, amount_e8s, fee_e8s, now))?;
    match ledger_transfer(ledger, to, amount_e8s, fee_e8s).await {
        LedgerTransferOutcome::Completed(block_index) => {
            let balance = with_service(|service| {
                service.complete_principal_withdraw(&caller, block_index, now)
            })?;
            Ok(BillingTransferResult {
                block_index,
                balance_e8s: balance,
            })
        }
        LedgerTransferOutcome::LedgerErr(error) => {
            let _ = with_service(|service| {
                service.reverse_principal_withdraw(&caller, amount_e8s, fee_e8s, now)
            });
            Err(error)
        }
        LedgerTransferOutcome::Ambiguous(error) => {
            let _ = with_service(|service| service.mark_principal_withdraw_ambiguous(&caller, now));
            Err(format!("withdraw pending; manual repair required: {error}"))
        }
    }
}

#[query]
fn principal_billing_summary() -> Result<PrincipalBillingSummary, String> {
    require_authenticated_caller()?;
    with_service(|service| service.principal_billing_summary(&caller_text()))
}

#[query]
fn list_principal_billing_entries(
    cursor: Option<u64>,
    limit: u32,
) -> Result<PrincipalBillingEntryPage, String> {
    require_authenticated_caller()?;
    with_service(|service| service.list_principal_billing_entries(&caller_text(), cursor, limit))
}

#[update]
fn top_up_database(database_id: String, amount_e8s: u64) -> Result<(), String> {
    require_authenticated_caller()?;
    with_unmetered_update(
        "top_up_database",
        Some(database_id.clone()),
        |service, caller, now| service.top_up_database(&database_id, caller, amount_e8s, now),
    )
}

#[update]
fn withdraw_database_balance(database_id: String, amount_e8s: u64) -> Result<(), String> {
    require_authenticated_caller()?;
    with_unmetered_update(
        "withdraw_database_balance",
        Some(database_id.clone()),
        |service, caller, now| {
            service.withdraw_database_balance(&database_id, caller, amount_e8s, now)
        },
    )
}

#[query]
fn list_database_billing_entries(
    database_id: String,
    cursor: Option<u64>,
    limit: u32,
) -> Result<DatabaseBillingEntryPage, String> {
    with_service(|service| {
        service.list_database_billing_entries(&database_id, &caller_text(), cursor, limit)
    })
}

#[query]
fn get_billing_config() -> Result<BillingConfig, String> {
    with_service(|service| service.billing_config())
}

#[update]
fn validate_update_billing_config(payload: Vec<u8>) -> Result<(), String> {
    require_authenticated_caller()?;
    let update = Decode!(&payload, BillingConfigUpdate)
        .map_err(|error| format!("invalid billing config payload: {error}"))?;
    with_service(|service| service.validate_billing_config_update(&update))
}

#[update]
fn update_billing_config(payload: Vec<u8>) -> Result<(), String> {
    require_authenticated_caller()?;
    let update = Decode!(&payload, BillingConfigUpdate)
        .map_err(|error| format!("invalid billing config payload: {error}"))?;
    with_unmetered_update("update_billing_config", None, |service, caller, _now| {
        service.update_billing_config(update, caller).map(|_| ())
    })
}

#[update]
fn delete_database(database_id: String) -> Result<(), String> {
    with_metered_update(
        "delete_database",
        Some(database_id.clone()),
        |service, caller, now| {
            let meta = service.list_databases().and_then(|databases| {
                databases
                    .into_iter()
                    .find(|meta| meta.database_id == database_id)
                    .ok_or_else(|| format!("database not found: {database_id}"))
            })?;
            service.delete_database(&database_id, caller, now)?;
            unmount_database_file(&meta.db_file_name);
            Ok(())
        },
    )
}

#[update]
fn begin_database_archive(database_id: String) -> Result<DatabaseArchiveInfo, String> {
    with_metered_update(
        "begin_database_archive",
        Some(database_id.clone()),
        |service, caller, now| service.begin_database_archive(&database_id, caller, now),
    )
}

#[query]
fn read_database_archive_chunk(
    database_id: String,
    offset: u64,
    max_bytes: u32,
) -> Result<DatabaseArchiveChunk, String> {
    with_service(|service| {
        service
            .read_database_archive_chunk(&database_id, &caller_text(), offset, max_bytes)
            .map(|bytes| DatabaseArchiveChunk { bytes })
    })
}

#[update]
fn finalize_database_archive(database_id: String, snapshot_hash: Vec<u8>) -> Result<(), String> {
    with_metered_update(
        "finalize_database_archive",
        Some(database_id.clone()),
        |service, caller, now| {
            let meta =
                service.finalize_database_archive(&database_id, caller, snapshot_hash, now)?;
            unmount_database_file(&meta.db_file_name);
            Ok(())
        },
    )
}

#[update]
fn cancel_database_archive(database_id: String) -> Result<(), String> {
    with_metered_update(
        "cancel_database_archive",
        Some(database_id.clone()),
        |service, caller, now| {
            service.cancel_database_archive(&database_id, caller, now)?;
            Ok(())
        },
    )
}

#[update]
fn begin_database_restore(
    database_id: String,
    snapshot_hash: Vec<u8>,
    size_bytes: u64,
) -> Result<(), String> {
    with_metered_update(
        "begin_database_restore",
        Some(database_id.clone()),
        |service, caller, now| {
            let restore = service.begin_database_restore_session(
                &database_id,
                caller,
                snapshot_hash,
                size_bytes,
                now,
            )?;
            if let Err(error) = mount_database_file(&restore.meta) {
                service
                    .rollback_database_restore_begin(restore.rollback, now)
                    .map_err(|rollback_error| {
                        format!("{error}; restore rollback failed: {rollback_error}")
                    })?;
                return Err(error);
            }
            Ok(())
        },
    )
}

#[update]
fn write_database_restore_chunk(request: DatabaseRestoreChunkRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_metered_update(
        "write_database_restore_chunk",
        Some(database_id),
        |service, caller, _now| {
            service.write_database_restore_chunk(
                &request.database_id,
                caller,
                request.offset,
                &request.bytes,
            )
        },
    )
}

#[update]
fn finalize_database_restore(database_id: String) -> Result<(), String> {
    with_metered_update(
        "finalize_database_restore",
        Some(database_id.clone()),
        |service, caller, now| {
            let meta = service.finalize_database_restore(&database_id, caller, now)?;
            mount_database_file(&meta)
        },
    )
}

#[update]
fn write_node(request: WriteNodeRequest) -> Result<WriteNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("write_node", Some(database_id), |service, caller, now| {
        service.write_node(caller, request, now)
    })
}

#[update]
fn append_node(request: AppendNodeRequest) -> Result<WriteNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("append_node", Some(database_id), |service, caller, now| {
        service.append_node(caller, request, now)
    })
}

#[update]
fn edit_node(request: EditNodeRequest) -> Result<EditNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("edit_node", Some(database_id), |service, caller, now| {
        service.edit_node(caller, request, now)
    })
}

#[update]
fn delete_node(request: DeleteNodeRequest) -> Result<DeleteNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("delete_node", Some(database_id), |service, caller, now| {
        service.delete_node(caller, request, now)
    })
}

#[update]
fn move_node(request: MoveNodeRequest) -> Result<MoveNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("move_node", Some(database_id), |service, caller, now| {
        service.move_node(caller, request, now)
    })
}

#[update]
fn mkdir_node(request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update("mkdir_node", Some(database_id), |service, caller, _now| {
        service.mkdir_node(caller, request)
    })
}

#[query]
fn glob_nodes(request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>, String> {
    with_service(|service| service.glob_nodes(&caller_text(), request))
}

#[query]
fn recent_nodes(request: RecentNodesRequest) -> Result<Vec<RecentNodeHit>, String> {
    with_service(|service| service.recent_nodes(&caller_text(), request))
}

#[query]
fn incoming_links(request: IncomingLinksRequest) -> Result<Vec<LinkEdge>, String> {
    with_service(|service| service.incoming_links(&caller_text(), request))
}

#[query]
fn outgoing_links(request: OutgoingLinksRequest) -> Result<Vec<LinkEdge>, String> {
    with_service(|service| service.outgoing_links(&caller_text(), request))
}

#[query]
fn graph_links(request: GraphLinksRequest) -> Result<Vec<LinkEdge>, String> {
    with_service(|service| service.graph_links(&caller_text(), request))
}

#[query]
fn graph_neighborhood(request: GraphNeighborhoodRequest) -> Result<Vec<LinkEdge>, String> {
    with_service(|service| service.graph_neighborhood(&caller_text(), request))
}

#[query]
fn read_node_context(request: NodeContextRequest) -> Result<Option<NodeContext>, String> {
    with_service(|service| service.read_node_context(&caller_text(), request))
}

#[query]
fn query_context(request: QueryContextRequest) -> Result<QueryContext, String> {
    with_service(|service| service.query_context(&caller_text(), request))
}

#[query]
fn source_evidence(request: SourceEvidenceRequest) -> Result<SourceEvidence, String> {
    with_service(|service| service.source_evidence(&caller_text(), request))
}

#[update]
fn multi_edit_node(request: MultiEditNodeRequest) -> Result<MultiEditNodeResult, String> {
    let database_id = request.database_id.clone();
    with_metered_update(
        "multi_edit_node",
        Some(database_id),
        |service, caller, now| service.multi_edit_node(caller, request, now),
    )
}

#[query]
fn search_nodes(request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>, String> {
    with_service(|service| service.search_nodes(&caller_text(), request))
}

#[query]
fn search_node_paths(request: SearchNodePathsRequest) -> Result<Vec<SearchNodeHit>, String> {
    with_service(|service| service.search_node_paths(&caller_text(), request))
}

#[query]
fn export_snapshot(request: ExportSnapshotRequest) -> Result<ExportSnapshotResponse, String> {
    with_service(|service| service.export_fs_snapshot(&caller_text(), request))
}

#[query]
fn fetch_updates(request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse, String> {
    with_service(|service| service.fetch_fs_updates(&caller_text(), request))
}

fn initialize_or_trap(config: Option<BillingConfig>) {
    initialize_service(config).unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_service(config: Option<BillingConfig>) -> Result<(), String> {
    initialize_wasi_storage()?;
    let service = VfsService::new(PathBuf::from(INDEX_DB_PATH), PathBuf::from(DATABASES_DIR));
    if let Some(config) = config {
        service.run_index_migrations_with_config(config)?;
    } else {
        service.run_index_migrations()?;
    }
    for meta in service.list_databases()? {
        mount_database_file(&meta)?;
    }
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
    Ok(())
}

fn initialize_wasi_storage() -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        ic_wasi_polyfill::init_with_memory_manager(
            &[0u8; 32],
            &[("SQLITE_TMPDIR", "tmp")],
            &manager,
            WASI_FS_MEMORY_RANGE.clone(),
        );

        create_dir_all("tmp").map_err(|error| error.to_string())?;
        create_dir_all(DATABASES_DIR).map_err(|error| error.to_string())?;

        ic_wasi_polyfill::unmount_memory_file(INDEX_DB_PATH);
        let memory = manager.get(MemoryId::new(INDEX_DB_MEMORY_ID));
        let mount_result = ic_wasi_polyfill::mount_memory_file(
            INDEX_DB_PATH,
            Box::new(memory),
            ic_wasi_polyfill::MountedFileSizePolicy::MemoryPages,
        );
        if mount_result > 0 {
            return Err(format!(
                "failed to mount index database file: {mount_result}"
            ));
        }
        Ok(())
    })
}

#[cfg(not(test))]
fn mount_database_file(meta: &DatabaseMeta) -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        ic_wasi_polyfill::unmount_memory_file(&meta.db_file_name);
        let memory = manager.get(MemoryId::new(meta.mount_id));
        let mount_result = ic_wasi_polyfill::mount_memory_file(
            &meta.db_file_name,
            Box::new(memory),
            ic_wasi_polyfill::MountedFileSizePolicy::MemoryPages,
        );
        if mount_result > 0 {
            return Err(format!(
                "failed to mount database file {}: {}",
                meta.database_id, mount_result
            ));
        }
        Ok(())
    })
}

#[cfg(test)]
fn mount_database_file(_meta: &DatabaseMeta) -> Result<(), String> {
    if TEST_MOUNT_DATABASE_FILE_FAIL_ONCE.with(|flag| flag.replace(false)) {
        return Err("test mount failure".to_string());
    }
    Ok(())
}

#[cfg(not(test))]
fn unmount_database_file(db_file_name: &str) {
    ic_wasi_polyfill::unmount_memory_file(db_file_name);
}

#[cfg(test)]
fn unmount_database_file(_db_file_name: &str) {}

#[cfg(test)]
thread_local! {
    static TEST_MOUNT_DATABASE_FILE_FAIL_ONCE: RefCell<bool> = const { RefCell::new(false) };
    static TEST_LEDGER_TRANSFER_OUTCOME: RefCell<Option<LedgerTransferOutcome>> = const { RefCell::new(None) };
    static TEST_CALLER_PRINCIPAL: RefCell<Option<Principal>> = const { RefCell::new(None) };
}

#[cfg(test)]
fn fail_next_mount_database_file_for_test() {
    TEST_MOUNT_DATABASE_FILE_FAIL_ONCE.with(|flag| flag.replace(true));
}

#[cfg(test)]
fn set_next_ledger_transfer_outcome_for_test(outcome: LedgerTransferOutcome) {
    TEST_LEDGER_TRANSFER_OUTCOME.with(|slot| {
        slot.replace(Some(outcome));
    });
}

#[cfg(test)]
fn set_test_caller_principal_for_test(principal: Principal) {
    TEST_CALLER_PRINCIPAL.with(|slot| {
        slot.replace(Some(principal));
    });
}

fn database_create_error(error: String, cleanup_error: Option<String>) -> String {
    match cleanup_error {
        Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
        None => error,
    }
}

fn caller_text() -> String {
    #[cfg(test)]
    {
        test_caller_principal().to_text()
    }
    #[cfg(not(test))]
    {
        ic_cdk::api::msg_caller().to_text()
    }
}

fn caller_principal() -> Principal {
    #[cfg(test)]
    {
        test_caller_principal()
    }
    #[cfg(not(test))]
    {
        ic_cdk::api::msg_caller()
    }
}

#[cfg(test)]
fn test_caller_principal() -> Principal {
    TEST_CALLER_PRINCIPAL.with(|slot| {
        slot.borrow()
            .as_ref()
            .copied()
            .unwrap_or_else(Principal::management_canister)
    })
}

fn require_authenticated_caller() -> Result<(), String> {
    if caller_principal() == Principal::anonymous() {
        return Err("anonymous caller not allowed".to_string());
    }
    Ok(())
}

#[allow(dead_code)]
fn canister_principal() -> Principal {
    #[cfg(test)]
    {
        Principal::anonymous()
    }
    #[cfg(not(test))]
    {
        ic_cdk::api::canister_self()
    }
}

fn now_millis() -> i64 {
    #[cfg(test)]
    {
        1_700_000_000_000
    }
    #[cfg(not(test))]
    {
        (ic_cdk::api::time() / 1_000_000) as i64
    }
}

fn cycle_balance() -> u128 {
    #[cfg(test)]
    {
        1_000_000_000_000
    }
    #[cfg(not(test))]
    {
        ic_cdk::api::canister_cycle_balance()
    }
}

async fn ledger_fee(ledger: Principal) -> Result<u64, String> {
    #[cfg(test)]
    {
        let _ = ledger;
        Ok(10)
    }
    #[cfg(not(test))]
    {
        let fee: Nat = Call::bounded_wait(ledger, "icrc1_fee")
            .await
            .map_err(|error| format!("icrc1_fee call failed: {error:?}"))?
            .candid()
            .map_err(|error| format!("icrc1_fee decode failed: {error}"))?;
        nat_to_u64(&fee)
    }
}

async fn ledger_transfer_from(
    ledger: Principal,
    from_owner: Principal,
    amount_e8s: u64,
) -> Result<u64, String> {
    #[cfg(test)]
    {
        let _ = (ledger, from_owner, amount_e8s);
        Ok(1)
    }
    #[cfg(not(test))]
    {
        let fee = ledger_fee(ledger).await?;
        let arg = TransferFromArg {
            spender_subaccount: None,
            from: IcrcAccount {
                owner: from_owner,
                subaccount: None,
            },
            to: IcrcAccount {
                owner: canister_principal(),
                subaccount: None,
            },
            amount: Nat::from(amount_e8s),
            fee: Some(Nat::from(fee)),
            memo: None,
            created_at_time: Some(ic_cdk::api::time()),
        };
        let result: Result<Nat, TransferFromError> =
            Call::bounded_wait(ledger, "icrc2_transfer_from")
                .with_arg(arg)
                .await
                .map_err(|error| format!("icrc2_transfer_from call failed: {error:?}"))?
                .candid()
                .map_err(|error| format!("icrc2_transfer_from decode failed: {error}"))?;
        match result {
            Ok(block_index) => nat_to_u64(&block_index),
            Err(error) => Err(format!("icrc2_transfer_from failed: {error:?}")),
        }
    }
}

async fn ledger_transfer(
    ledger: Principal,
    to: BillingAccount,
    amount_e8s: u64,
    fee_e8s: u64,
) -> LedgerTransferOutcome {
    #[cfg(test)]
    {
        let _ = (ledger, to, amount_e8s, fee_e8s);
        TEST_LEDGER_TRANSFER_OUTCOME.with(|outcome| {
            outcome
                .borrow_mut()
                .take()
                .unwrap_or(LedgerTransferOutcome::Completed(2))
        })
    }
    #[cfg(not(test))]
    {
        let arg = TransferArg {
            from_subaccount: None,
            to: IcrcAccount {
                owner: to.owner,
                subaccount: to.subaccount,
            },
            amount: Nat::from(amount_e8s),
            fee: Some(Nat::from(fee_e8s)),
            memo: None,
            created_at_time: Some(ic_cdk::api::time()),
        };
        let response = Call::bounded_wait(ledger, "icrc1_transfer")
            .with_arg(arg)
            .await
            .map_err(|error| {
                LedgerTransferOutcome::Ambiguous(format!("icrc1_transfer call failed: {error:?}"))
            });
        let response = match response {
            Ok(response) => response,
            Err(outcome) => return outcome,
        };
        let result: Result<Nat, TransferError> = match response.candid().map_err(|error| {
            LedgerTransferOutcome::Ambiguous(format!("icrc1_transfer decode failed: {error}"))
        }) {
            Ok(result) => result,
            Err(outcome) => return outcome,
        };
        match result {
            Ok(block_index) => match nat_to_u64(&block_index) {
                Ok(block_index) => LedgerTransferOutcome::Completed(block_index),
                Err(error) => LedgerTransferOutcome::Ambiguous(error),
            },
            Err(error) => transfer_error_outcome(error),
        }
    }
}

fn transfer_error_outcome(error: TransferError) -> LedgerTransferOutcome {
    match error {
        TransferError::Duplicate { duplicate_of } => match nat_to_u64(&duplicate_of) {
            Ok(block_index) => LedgerTransferOutcome::Completed(block_index),
            Err(error) => LedgerTransferOutcome::Ambiguous(error),
        },
        error => LedgerTransferOutcome::LedgerErr(format!("icrc1_transfer failed: {error:?}")),
    }
}

fn nat_to_u64(value: &Nat) -> Result<u64, String> {
    value
        .0
        .to_string()
        .parse::<u64>()
        .map_err(|_| "nat exceeds u64".to_string())
}

fn with_unmetered_update<T, F>(method: &str, database_id: Option<String>, f: F) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let caller = caller_text();
    let now = now_millis();
    let before_cycles = cycle_balance();
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        let result = f(service, &caller, now);
        let after_cycles = cycle_balance();
        let cycles_delta = before_cycles.saturating_sub(after_cycles);
        let error = result.as_ref().err().map(String::as_str);
        let _ = service.record_usage_event(UsageEvent {
            method,
            database_id: database_id.as_deref(),
            caller: &caller,
            success: result.is_ok(),
            cycles_delta,
            error,
            now,
        });
        result
    })
}

fn with_metered_update<T, F>(method: &str, database_id: Option<String>, f: F) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let caller = caller_text();
    let now = now_millis();
    let before_cycles = cycle_balance();
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        if let Some(database_id) = database_id.as_deref() {
            service.require_database_billable(database_id)?;
        }
        let result = f(service, &caller, now);
        let after_cycles = cycle_balance();
        let cycles_delta = before_cycles.saturating_sub(after_cycles);
        let error = result.as_ref().err().map(String::as_str);
        let usage_event_id = service
            .record_usage_event(UsageEvent {
                method,
                database_id: database_id.as_deref(),
                caller: &caller,
                success: result.is_ok(),
                cycles_delta,
                error,
                now,
            })
            .ok();
        if result.is_ok()
            && let Some(database_id) = database_id.as_deref()
        {
            if let Err(error) = service.charge_database_update(
                database_id,
                &caller,
                method,
                cycles_delta,
                usage_event_id,
                now,
            ) {
                ic_cdk::trap(&format!("billing charge failed after update: {error}"));
            }
        }
        result
    })
}

fn with_service<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&VfsService) -> Result<T, String>,
{
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        f(service)
    })
}

fn memory_capabilities() -> Vec<MemoryCapability> {
    [
        (
            "query_context",
            "Primary agent-memory entrypoint for task-scoped context bundles",
        ),
        ("source_evidence", "Read source-path evidence for one node"),
        (
            "memory_manifest",
            "Discover memory API shape, limits, and policy",
        ),
        (
            "read_node_context",
            "Auxiliary node read with incoming and outgoing links",
        ),
        ("search_nodes", "Auxiliary search with lightweight previews"),
        (
            "graph_neighborhood",
            "Auxiliary local link graph around one node",
        ),
        ("recent_nodes", "Auxiliary recent live-node listing"),
    ]
    .into_iter()
    .map(|(name, description)| MemoryCapability {
        name: name.to_string(),
        description: description.to_string(),
    })
    .collect()
}

fn canonical_roles() -> Vec<CanonicalRole> {
    [
        (
            "index",
            "index.md",
            "Content-oriented catalog of pages in a scope",
        ),
        (
            "overview",
            "overview.md",
            "Corpus-level synthesis maintained by agents",
        ),
        ("log", "log.md", "Append-only chronological mutation log"),
        (
            "schema",
            "schema.md",
            "Scope-local conventions and write rules",
        ),
        ("topics", "topics/*.md", "Topic-level synthesis pages"),
        (
            "provenance",
            "provenance.md",
            "Source-path provenance for a scope or node",
        ),
    ]
    .into_iter()
    .map(|(name, path_pattern, purpose)| CanonicalRole {
        name: name.to_string(),
        path_pattern: path_pattern.to_string(),
        purpose: purpose.to_string(),
    })
    .collect()
}

export_service!();

pub fn candid_interface() -> String {
    normalize_candid_interface(__export_service())
}

fn normalize_candid_interface(interface: String) -> String {
    let normalized = normalize_candid_method_input(
        &interface,
        "outgoing_links",
        "IncomingLinksRequest",
        "OutgoingLinksRequest",
    );
    ensure_outgoing_links_request(normalized)
}

fn normalize_candid_method_input(
    interface: &str,
    method: &str,
    exported_input: &str,
    public_input: &str,
) -> String {
    let mut normalized = interface
        .lines()
        .map(|line| {
            let prefix = format!("  {method} : ({exported_input}) -> (");
            if line.starts_with(&prefix) && line.ends_with(" query;") {
                line.replacen(
                    &format!("{method} : ({exported_input})"),
                    &format!("{method} : ({public_input})"),
                    1,
                )
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if interface.ends_with('\n') {
        normalized.push('\n');
    }
    normalized
}

fn ensure_outgoing_links_request(interface: String) -> String {
    if interface.contains("type OutgoingLinksRequest = record {") {
        return interface;
    }
    interface.replace(
        "type LinkEdge = record {",
        "type OutgoingLinksRequest = record { path : text; limit : nat32; database_id : text };\ntype LinkEdge = record {",
    )
}

#[cfg(feature = "canbench-rs")]
mod benches;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_sync_contract;
