// Where: crates/vfs_canister/src/lib.rs
// What: ICP canister entrypoints backed by VfsService with an FS-first public API.
// Why: The canister now exposes node-oriented operations directly and keeps the runtime boundary thin.
use std::cell::RefCell;
#[cfg(target_arch = "wasm32")]
use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::create_dir_all;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

#[cfg(any(target_arch = "wasm32", test))]
use candid::utils::decode_args;
use candid::{CandidType, Decode, Deserialize, Nat, Principal, export_service};
#[cfg(not(test))]
use ic_cdk::call::Call;
use ic_cdk::{init, post_upgrade, query, update};
use ic_http_certification::{
    CERTIFICATE_EXPRESSION_HEADER_NAME, DefaultCelBuilder, DefaultResponseCertification,
    HttpCertification, HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    HttpResponse as CertifiedHttpResponse, utils::add_v2_certificate_header,
};
#[cfg(target_arch = "wasm32")]
use ic_sqlite_vfs::{Db, DbHandle};
#[cfg(target_arch = "wasm32")]
use ic_stable_structures::DefaultMemoryImpl;
#[cfg(target_arch = "wasm32")]
use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
use vfs_runtime::{DatabaseMeta, UsageEvent, VfsService};
use vfs_types::{
    AppendNodeRequest, BillingAccount, BillingConfig, BillingConfigUpdate, BillingTransferResult,
    CanisterHealth, CanonicalRole, ChildNode, CreateDatabaseRequest, CreateDatabaseResult,
    DatabaseArchiveChunk, DatabaseArchiveInfo, DatabaseBillingEntryPage, DatabaseMember,
    DatabaseRestoreChunkRequest, DatabaseRole, DatabaseSummary, DeleteNodeRequest,
    DeleteNodeResult, EditNodeRequest, EditNodeResult, ExportSnapshotRequest,
    ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse, GlobNodeHit,
    GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest, LinkEdge,
    ListChildrenRequest, ListNodesRequest, MemoryCapability, MemoryManifest, MemoryRoot,
    MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeContext, NodeContextRequest, NodeEntry,
    OpsAnswerSessionCheckRequest, OpsAnswerSessionCheckResult, OpsAnswerSessionRequest,
    OutgoingLinksRequest, QueryContext, QueryContextRequest, RecentNodeHit, RecentNodesRequest,
    RenameDatabaseRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    SourceEvidence, SourceEvidenceRequest, Status, UrlIngestTriggerSessionCheckRequest,
    UrlIngestTriggerSessionRequest, WriteNodeRequest, WriteNodeResult, WriteNodesRequest,
};

#[cfg(not(target_arch = "wasm32"))]
const INDEX_DB_PATH: &str = "./DB/index.sqlite3";
#[cfg(not(target_arch = "wasm32"))]
const DATABASES_DIR: &str = "./DB/databases";
const II_ALTERNATIVE_ORIGINS_PATH: &str = "/.well-known/ii-alternative-origins";
const II_ALTERNATIVE_ORIGINS_BODY: &str = r#"{"alternativeOrigins":["https://wiki.kinic.xyz","https://kinic.xyz","chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj","chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci"]}"#;
const ICP_CLI_LOGIN_DISCOVERY_PATH: &str = "/.well-known/ic-cli-login";
const ICP_CLI_LOGIN_PATH: &str = "/login";
const ICP_CLI_LOGIN_HTML: &str = include_str!("icp_cli_login.html");
#[cfg(target_arch = "wasm32")]
const INDEX_DB_MEMORY_ID: u16 = 10;

#[derive(Clone, Debug, CandidType, Deserialize)]
struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    certificate_version: Option<u16>,
}

#[derive(Clone, Debug, CandidType, Deserialize)]
struct HttpResponse {
    status_code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    upgrade: Option<bool>,
}

thread_local! {
    #[cfg(target_arch = "wasm32")]
    static MEMORY_MANAGER: RefCell<MemoryManager<DefaultMemoryImpl>> =
        RefCell::new(MemoryManager::init(DefaultMemoryImpl::default()));
    static SERVICE: RefCell<Option<VfsService>> = const { RefCell::new(None) };
    #[cfg(target_arch = "wasm32")]
    static DATABASE_HANDLES: RefCell<BTreeMap<u16, DbHandle>> = const { RefCell::new(BTreeMap::new()) };
}

#[derive(Clone, Debug)]
enum LedgerTransferOutcome {
    Completed(u64),
    LedgerErr(String),
    Ambiguous(String),
}

#[derive(Clone, Debug)]
enum LedgerTransferFromOutcome {
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
    certify_http_responses();
}

#[post_upgrade]
fn post_upgrade_hook() {
    let config = post_upgrade_billing_config_arg().unwrap_or_else(|error| ic_cdk::trap(&error));
    initialize_upgrade_or_trap(config);
    certify_http_responses();
}

#[query]
fn http_request(request: HttpRequest) -> HttpResponse {
    if request.method != "GET" {
        return HttpResponse {
            status_code: 405,
            headers: text_headers(),
            body: b"Method not allowed".to_vec(),
            upgrade: Some(false),
        };
    }
    let request_path = request_path(&request.url);
    let Some((path, entry, tree, mut response)) = certified_static_response(request_path) else {
        return HttpResponse {
            status_code: 404,
            headers: text_headers(),
            body: b"Not found".to_vec(),
            upgrade: Some(false),
        };
    };
    if let Some(certificate) = data_certificate() {
        let witness = tree.witness(&entry, request_path).unwrap_or_else(|error| {
            ic_cdk::trap(format!("HTTP certification witness failed: {error}"))
        });
        add_v2_certificate_header(&certificate, &mut response, &witness, &path.to_expr_path());
    }
    http_response_from_certified(response)
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
fn create_database(request: CreateDatabaseRequest) -> Result<CreateDatabaseResult, String> {
    require_authenticated_caller()?;
    with_usage_derived_database_id(
        "create_database",
        None,
        |service, caller, now| {
            let meta = service.reserve_generated_database_for_mount(&request.name, caller, now)?;
            if let Err(error) = mount_database_file(&meta) {
                let cleanup_error = service
                    .discard_database_reservation(&meta.database_id)
                    .err();
                return Err(database_create_error(error, cleanup_error));
            }
            if let Err(error) = service.run_database_migrations(&meta.database_id) {
                unmount_database_file(&meta.db_file_name);
                let cleanup_error = service
                    .discard_database_reservation(&meta.database_id)
                    .err();
                return Err(database_create_error(error, cleanup_error));
            }
            Ok(CreateDatabaseResult {
                database_id: meta.database_id,
                name: meta.name,
            })
        },
        |result| Some(result.database_id.clone()),
    )
}

#[update]
fn rename_database(request: RenameDatabaseRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_metered_update(
        "rename_database",
        Some(database_id),
        |service, caller, now| {
            service.rename_database(&request.database_id, caller, &request.name, now)
        },
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
async fn top_up_database(
    database_id: String,
    amount_e8s: u64,
) -> Result<BillingTransferResult, String> {
    require_authenticated_caller()?;
    let caller = caller_text();
    let now = now_millis();
    let config = with_service(|service| service.billing_config())?;
    let operation_id = with_service(|service| {
        service.begin_database_top_up(&database_id, &caller, amount_e8s, now)
    })?;
    let ledger = Principal::from_text(&config.kinic_ledger_canister_id)
        .map_err(|error| format!("invalid KINIC ledger canister id: {error}"))?;
    match ledger_transfer_from(ledger, caller_principal(), amount_e8s).await {
        LedgerTransferFromOutcome::Completed(block_index) => {
            let balance = with_service(|service| {
                service.credit_database_top_up(
                    operation_id,
                    &database_id,
                    &caller,
                    amount_e8s,
                    block_index,
                    now,
                )
            })?;
            Ok(BillingTransferResult {
                block_index,
                balance_e8s: balance,
            })
        }
        LedgerTransferFromOutcome::LedgerErr(error) => {
            let _ = with_service(|service| {
                service.cancel_database_top_up(operation_id, &database_id, &caller, amount_e8s)
            });
            Err(error)
        }
        LedgerTransferFromOutcome::Ambiguous(error) => {
            let _ = with_service(|service| {
                service.mark_database_top_up_ambiguous(
                    operation_id,
                    &database_id,
                    &caller,
                    amount_e8s,
                    now,
                )
            });
            Err(format!("top-up pending; manual repair required: {error}"))
        }
    }
}

#[update]
async fn withdraw_database_balance(
    database_id: String,
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
    let operation_id = with_service(|service| {
        service.begin_database_withdraw(&database_id, &caller, amount_e8s, fee_e8s, now)
    })?;
    match ledger_transfer(ledger, to, amount_e8s, fee_e8s).await {
        LedgerTransferOutcome::Completed(block_index) => {
            let balance = with_service(|service| {
                service.complete_database_withdraw(
                    operation_id,
                    &database_id,
                    &caller,
                    block_index,
                    now,
                )
            })?;
            Ok(BillingTransferResult {
                block_index,
                balance_e8s: balance,
            })
        }
        LedgerTransferOutcome::LedgerErr(error) => {
            let _ = with_service(|service| {
                service.reverse_database_withdraw(
                    operation_id,
                    &database_id,
                    &caller,
                    amount_e8s,
                    fee_e8s,
                    now,
                )
            });
            Err(error)
        }
        LedgerTransferOutcome::Ambiguous(error) => {
            let _ = with_service(|service| {
                service.mark_database_withdraw_ambiguous(operation_id, &database_id, &caller, now)
            });
            Err(format!("withdraw pending; manual repair required: {error}"))
        }
    }
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
fn cancel_database_restore(database_id: String) -> Result<(), String> {
    with_metered_update(
        "cancel_database_restore",
        Some(database_id.clone()),
        |service, caller, now| {
            let meta = service.cancel_database_restore(&database_id, caller, now)?;
            unmount_database_file(&meta.db_file_name);
            Ok(())
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
fn write_nodes(request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>, String> {
    let database_id = request.database_id.clone();
    with_metered_update("write_nodes", Some(database_id), |service, caller, now| {
        service.write_nodes(caller, request, now)
    })
}

#[update]
fn authorize_url_ingest_trigger_session(
    request: UrlIngestTriggerSessionRequest,
) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_metered_update(
        "authorize_url_ingest_trigger_session",
        Some(database_id),
        |service, caller, now| service.authorize_url_ingest_trigger_session(caller, request, now),
    )
}

#[query]
fn check_url_ingest_trigger_session(
    request: UrlIngestTriggerSessionCheckRequest,
) -> Result<(), String> {
    with_service(|service| service.check_url_ingest_trigger_session(request, now_millis()))
}

#[update]
fn authorize_ops_answer_session(request: OpsAnswerSessionRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_metered_update(
        "authorize_ops_answer_session",
        Some(database_id),
        |service, caller, now| service.authorize_ops_answer_session(caller, request, now),
    )
}

#[query]
fn check_ops_answer_session(
    request: OpsAnswerSessionCheckRequest,
) -> Result<OpsAnswerSessionCheckResult, String> {
    with_service(|service| service.check_ops_answer_session(request, now_millis()))
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
    with_metered_update("mkdir_node", Some(database_id), |service, caller, now| {
        service.mkdir_node(caller, request, now)
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
    initialize_service_with_config(config).unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_upgrade_or_trap(config: Option<BillingConfig>) {
    initialize_service_for_upgrade(config).unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_service_with_config(config: Option<BillingConfig>) -> Result<(), String> {
    initialize_sqlite_storage()?;
    #[cfg(not(target_arch = "wasm32"))]
    let service = VfsService::new(PathBuf::from(INDEX_DB_PATH), PathBuf::from(DATABASES_DIR));
    #[cfg(target_arch = "wasm32")]
    let service = VfsService::stable(database_handle);
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

fn initialize_service_for_upgrade(config: Option<BillingConfig>) -> Result<(), String> {
    initialize_sqlite_storage()?;
    #[cfg(not(target_arch = "wasm32"))]
    let service = VfsService::new(PathBuf::from(INDEX_DB_PATH), PathBuf::from(DATABASES_DIR));
    #[cfg(target_arch = "wasm32")]
    let service = VfsService::stable(database_handle);
    service.run_index_migrations_for_upgrade(config)?;
    for meta in service.list_databases()? {
        mount_database_file(&meta)?;
    }
    SERVICE.with(|slot| *slot.borrow_mut() = Some(service));
    Ok(())
}

#[cfg(any(target_arch = "wasm32", test))]
fn parse_upgrade_billing_config_arg(bytes: &[u8]) -> Result<Option<BillingConfig>, String> {
    if bytes.is_empty() || bytes == b"DIDL\0\0" {
        return Ok(None);
    }
    if let Ok((config,)) = decode_args::<(BillingConfig,)>(bytes) {
        return Ok(Some(config));
    }
    if let Ok((config,)) = decode_args::<(Option<BillingConfig>,)>(bytes) {
        return Ok(config);
    }
    Err(
        "post_upgrade billing config arg must be empty, BillingConfig, or opt BillingConfig"
            .to_string(),
    )
}

fn post_upgrade_billing_config_arg() -> Result<Option<BillingConfig>, String> {
    #[cfg(target_arch = "wasm32")]
    {
        parse_upgrade_billing_config_arg(&ic_cdk::api::msg_arg_data())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Ok(None)
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn initialize_sqlite_storage() -> Result<(), String> {
    create_dir_all(DATABASES_DIR).map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn initialize_sqlite_storage() -> Result<(), String> {
    MEMORY_MANAGER.with(|manager| {
        let manager = manager.borrow();
        let memory = manager.get(MemoryId::new(INDEX_DB_MEMORY_ID));
        Db::init(memory).map_err(|error| error.to_string())
    })
}

#[cfg(target_arch = "wasm32")]
fn database_handle(mount_id: u16) -> Result<DbHandle, String> {
    DATABASE_HANDLES.with(|handles| {
        if let Some(handle) = handles.borrow().get(&mount_id).copied() {
            return Ok(handle);
        }
        let handle = MEMORY_MANAGER.with(|manager| {
            let memory = manager.borrow().get(MemoryId::new(mount_id));
            DbHandle::init(memory).map_err(|error| error.to_string())
        })?;
        handles.borrow_mut().insert(mount_id, handle);
        Ok(handle)
    })
}

#[cfg(target_arch = "wasm32")]
fn mount_database_file(meta: &DatabaseMeta) -> Result<(), String> {
    database_handle(meta.mount_id).map(|_| ())
}

#[cfg(not(target_arch = "wasm32"))]
fn mount_database_file(_meta: &DatabaseMeta) -> Result<(), String> {
    #[cfg(test)]
    if TEST_MOUNT_DATABASE_FILE_FAIL_ONCE.with(|flag| flag.replace(false)) {
        return Err("test mount failure".to_string());
    }
    Ok(())
}

fn unmount_database_file(_db_file_name: &str) {}

#[cfg(test)]
thread_local! {
    static TEST_MOUNT_DATABASE_FILE_FAIL_ONCE: RefCell<bool> = const { RefCell::new(false) };
    static TEST_LEDGER_TRANSFER_OUTCOME: RefCell<Option<LedgerTransferOutcome>> = const { RefCell::new(None) };
    static TEST_LEDGER_TRANSFER_FROM_OUTCOME: RefCell<Option<LedgerTransferFromOutcome>> = const { RefCell::new(None) };
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
fn set_next_ledger_transfer_from_outcome_for_test(outcome: LedgerTransferFromOutcome) {
    TEST_LEDGER_TRANSFER_FROM_OUTCOME.with(|slot| {
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
            .unwrap_or_else(Principal::anonymous)
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
) -> LedgerTransferFromOutcome {
    #[cfg(test)]
    {
        let _ = (ledger, from_owner, amount_e8s);
        TEST_LEDGER_TRANSFER_FROM_OUTCOME.with(|outcome| {
            outcome
                .borrow_mut()
                .take()
                .unwrap_or(LedgerTransferFromOutcome::Completed(1))
        })
    }
    #[cfg(not(test))]
    {
        let fee = match ledger_fee(ledger).await {
            Ok(fee) => fee,
            Err(error) => return LedgerTransferFromOutcome::LedgerErr(error),
        };
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
        let response = Call::bounded_wait(ledger, "icrc2_transfer_from")
            .with_arg(arg)
            .await
            .map_err(|error| {
                LedgerTransferFromOutcome::Ambiguous(format!(
                    "icrc2_transfer_from call failed: {error:?}"
                ))
            });
        let response = match response {
            Ok(response) => response,
            Err(outcome) => return outcome,
        };
        let result: Result<Nat, TransferFromError> = match response.candid().map_err(|error| {
            LedgerTransferFromOutcome::Ambiguous(format!(
                "icrc2_transfer_from decode failed: {error}"
            ))
        }) {
            Ok(result) => result,
            Err(outcome) => return outcome,
        };
        match result {
            Ok(block_index) => match nat_to_u64(&block_index) {
                Ok(block_index) => LedgerTransferFromOutcome::Completed(block_index),
                Err(error) => LedgerTransferFromOutcome::Ambiguous(error),
            },
            Err(error) => transfer_from_error_outcome(error),
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

fn transfer_from_error_outcome(error: TransferFromError) -> LedgerTransferFromOutcome {
    match error {
        TransferFromError::Duplicate { duplicate_of } => match nat_to_u64(&duplicate_of) {
            Ok(block_index) => LedgerTransferFromOutcome::Completed(block_index),
            Err(error) => LedgerTransferFromOutcome::Ambiguous(error),
        },
        error => {
            LedgerTransferFromOutcome::LedgerErr(format!("icrc2_transfer_from failed: {error:?}"))
        }
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
    with_usage_derived_database_id(method, database_id, f, |_| None)
}

fn with_usage_derived_database_id<T, F, D>(
    method: &str,
    database_id: Option<String>,
    f: F,
    database_id_from_success: D,
) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
    D: FnOnce(&T) -> Option<String>,
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
        let derived_database_id = result.as_ref().ok().and_then(database_id_from_success);
        let usage_database_id = database_id.as_deref().or(derived_database_id.as_deref());
        let _ = service.record_usage_event(UsageEvent {
            method,
            database_id: usage_database_id,
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
            && let Err(error) = service.charge_database_update(
                database_id,
                &caller,
                method,
                cycles_delta,
                usage_event_id,
                now,
            )
        {
            ic_cdk::trap(format!("billing charge failed after update: {error}"));
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

fn certify_http_responses() {
    let tree = certified_static_tree();
    set_certified_data(tree.root_hash());
}

fn certified_static_response(
    request_path: &str,
) -> Option<(
    HttpCertificationPath<'static>,
    HttpCertificationTreeEntry<'static>,
    HttpCertificationTree,
    CertifiedHttpResponse<'static>,
)> {
    let responses = certified_static_responses();
    let tree = certified_static_tree_from_entries(
        responses
            .iter()
            .map(|(_, entry, _)| entry.clone())
            .collect::<Vec<_>>(),
    );
    responses
        .into_iter()
        .find(|(path, _, _)| *path == request_path)
        .map(|(path, entry, response)| (HttpCertificationPath::exact(path), entry, tree, response))
}

fn certified_static_tree() -> HttpCertificationTree {
    certified_static_tree_from_entries(
        certified_static_responses()
            .into_iter()
            .map(|(_, entry, _)| entry)
            .collect::<Vec<_>>(),
    )
}

fn certified_static_tree_from_entries(
    entries: Vec<HttpCertificationTreeEntry<'static>>,
) -> HttpCertificationTree {
    let mut tree = HttpCertificationTree::default();
    for entry in entries {
        tree.insert(&entry);
    }
    tree
}

fn certified_static_responses() -> Vec<(
    &'static str,
    HttpCertificationTreeEntry<'static>,
    CertifiedHttpResponse<'static>,
)> {
    vec![
        certified_static_response_entry(
            II_ALTERNATIVE_ORIGINS_PATH,
            II_ALTERNATIVE_ORIGINS_BODY.as_bytes().to_vec(),
            "application/json; charset=utf-8",
            true,
        ),
        certified_static_response_entry(
            ICP_CLI_LOGIN_DISCOVERY_PATH,
            ICP_CLI_LOGIN_PATH.as_bytes().to_vec(),
            "text/plain; charset=utf-8",
            true,
        ),
        certified_static_response_entry(
            ICP_CLI_LOGIN_PATH,
            ICP_CLI_LOGIN_HTML.as_bytes().to_vec(),
            "text/html; charset=utf-8",
            false,
        ),
    ]
}

fn certified_static_response_entry(
    path: &'static str,
    body: Vec<u8>,
    content_type: &'static str,
    cors: bool,
) -> (
    &'static str,
    HttpCertificationTreeEntry<'static>,
    CertifiedHttpResponse<'static>,
) {
    let cel_expr = DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            vec![
                "Content-Type",
                "Cache-Control",
                "Access-Control-Allow-Origin",
            ],
        ))
        .build();
    let response = static_response(body, content_type, cors, cel_expr.to_string());
    let certification = HttpCertification::response_only(&cel_expr, &response, None)
        .unwrap_or_else(|error| ic_cdk::trap(format!("HTTP certification failed: {error}")));
    let entry = HttpCertificationTreeEntry::new(HttpCertificationPath::exact(path), certification);
    (path, entry, response)
}

fn static_response(
    body: Vec<u8>,
    content_type: &str,
    cors: bool,
    certificate_expression: String,
) -> CertifiedHttpResponse<'static> {
    let mut headers = vec![
        ("Content-Type".to_string(), content_type.to_string()),
        (
            "Cache-Control".to_string(),
            "public, max-age=300".to_string(),
        ),
        (
            CERTIFICATE_EXPRESSION_HEADER_NAME.to_string(),
            certificate_expression,
        ),
    ];
    if cors {
        headers.push(("Access-Control-Allow-Origin".to_string(), "*".to_string()));
    }
    CertifiedHttpResponse::ok(body, headers)
        .with_upgrade(false)
        .build()
}

fn http_response_from_certified(response: CertifiedHttpResponse<'static>) -> HttpResponse {
    HttpResponse {
        status_code: response.status_code().as_u16(),
        headers: response.headers().to_vec(),
        body: response.body().to_vec(),
        upgrade: response.upgrade(),
    }
}

fn request_path(url: &str) -> &str {
    url.split_once('?').map_or(url, |(path, _)| path)
}

fn text_headers() -> Vec<(String, String)> {
    vec![(
        "Content-Type".to_string(),
        "text/plain; charset=utf-8".to_string(),
    )]
}

#[cfg(target_arch = "wasm32")]
fn set_certified_data(data: impl AsRef<[u8]>) {
    ic_cdk::api::certified_data_set(data);
}

#[cfg(not(target_arch = "wasm32"))]
fn set_certified_data(_data: impl AsRef<[u8]>) {}

#[cfg(target_arch = "wasm32")]
fn data_certificate() -> Option<Vec<u8>> {
    ic_cdk::api::data_certificate()
}

#[cfg(not(target_arch = "wasm32"))]
fn data_certificate() -> Option<Vec<u8>> {
    None
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
    let normalized = normalize_candid_method_input(
        &normalized,
        "rename_database",
        "CreateDatabaseResult",
        "RenameDatabaseRequest",
    );
    let normalized = normalize_candid_method_input(
        &normalized,
        "authorize_url_ingest_trigger_session",
        "OpsAnswerSessionRequest",
        "UrlIngestTriggerSessionRequest",
    );
    ensure_url_ingest_trigger_session_request(ensure_rename_database_request(
        ensure_outgoing_links_request(normalized),
    ))
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
            if line.starts_with(&prefix) {
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

fn ensure_rename_database_request(interface: String) -> String {
    if interface.contains("type RenameDatabaseRequest = record {") {
        return interface;
    }
    interface.replace(
        "type DatabaseArchiveChunk = record {",
        "type RenameDatabaseRequest = record { name : text; database_id : text };\ntype DatabaseArchiveChunk = record {",
    )
}

fn ensure_url_ingest_trigger_session_request(interface: String) -> String {
    if interface.contains("type UrlIngestTriggerSessionRequest = record {") {
        return interface;
    }
    interface.replace(
        "type WriteNodeItem = record {",
        "type UrlIngestTriggerSessionRequest = record {\n  session_nonce : text;\n  database_id : text;\n};\ntype WriteNodeItem = record {",
    )
}

#[cfg(feature = "canbench-rs")]
mod benches;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_sync_contract;
