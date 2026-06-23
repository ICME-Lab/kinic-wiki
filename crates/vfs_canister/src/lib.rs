// Where: crates/vfs_canister/src/lib.rs
// What: ICP canister entrypoints backed by VfsService with an FS-first public API.
// Why: The canister now exposes node-oriented operations directly and keeps the runtime boundary thin.
#[cfg(test)]
use std::cell::Cell;
use std::cell::RefCell;
#[cfg(target_arch = "wasm32")]
use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::create_dir_all;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;
#[cfg(target_arch = "wasm32")]
use std::time::Duration;

#[cfg(any(target_arch = "wasm32", test))]
use candid::utils::decode_args;
use candid::{CandidType, Decode, Deserialize, Nat, Principal, export_service};
#[cfg(not(test))]
use ic_cdk::api::PerformanceCounterType;
#[cfg(not(test))]
use ic_cdk::call::Call;
use ic_cdk::{init, post_upgrade, query, update};
#[cfg(target_arch = "wasm32")]
use ic_cdk_timers::{set_timer, set_timer_interval};
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
#[cfg(target_arch = "wasm32")]
use vfs_runtime::STORAGE_BILLING_INTERVAL_MS;
use vfs_runtime::{
    CyclesPendingLedgerDetailsInput, DatabaseCyclesPurchaseWithLedgerDetails, DatabaseMeta,
    RequiredRole, VfsService, cycles_for_payment_amount_e8s,
};
use vfs_types::{
    AppendNodeRequest, CanisterHealth, CanonicalRole, ChildNode, CreateDatabaseRequest,
    CreateDatabaseResult, CyclesBillingConfig, CyclesBillingConfigUpdate, CyclesPurchaseResult,
    DatabaseArchiveChunk, DatabaseArchiveInfo, DatabaseCycleEntryPage,
    DatabaseCyclesPendingPurchase, DatabaseCyclesPurchaseRequest, DatabaseMember, DatabaseProfile,
    DatabaseRestoreChunkRequest, DatabaseRole, DatabaseSummary, DeleteDatabaseRequest,
    DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult, ExportSnapshotRequest,
    ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse, GlobNodeHit,
    GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest, IncomingLinksRequest,
    IndexSqlJsonQueryResult, KINIC_DECIMALS, KINIC_LEDGER_FEE_E8S, KnowledgeEvidence,
    KnowledgeEvidenceRequest, LinkEdge, ListChildrenRequest, ListNodesRequest,
    MarketCreateListingRequest, MarketEntitlementPage, MarketListing, MarketListingDetail,
    MarketListingPage, MarketOrder, MarketOrderPage, MarketPurchasePreview, MarketPurchaseRequest,
    MarketUpdateListingRequest, MemoryRecall, MemoryRecallRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult,
    Node, NodeContext, NodeContextRequest, NodeEntry, OpsAnswerSessionCheckRequest,
    OpsAnswerSessionCheckResult, OpsAnswerSessionRequest, OutgoingLinksRequest,
    RenameDatabaseRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    SourceRunSessionCheckRequest, Status, StorageBillingBatchRequest, StorageBillingBatchResult,
    StoreCapability, StoreManifest, StoreManifestRequest, StoreRoot,
    UrlIngestTriggerSessionCheckRequest, UrlIngestTriggerSessionRequest, WikiMetrics,
    WikiMetricsPoint, WriteNodeRequest, WriteNodeResult, WriteNodesRequest,
    WriteSourceForGenerationRequest, WriteSourceForGenerationResult, kinic_base_units_per_token,
};

#[cfg(not(target_arch = "wasm32"))]
const INDEX_DB_PATH: &str = "./DB/index.sqlite3";
#[cfg(not(target_arch = "wasm32"))]
const DATABASES_DIR: &str = "./DB/databases";
const II_ALTERNATIVE_ORIGINS_PATH: &str = "/.well-known/ii-alternative-origins";
const II_PRODUCTION_ALTERNATIVE_ORIGINS_BODY: &str = r#"{"alternativeOrigins":["https://wiki.kinic.xyz","https://kinic.xyz","chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj","chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci","chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"]}"#;
const II_LOCAL_DEV_ALTERNATIVE_ORIGINS_BODY: &str = r#"{"alternativeOrigins":["https://wiki.kinic.xyz","https://kinic.xyz","chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj","chrome-extension://hbnicbmdodpmihmcnfgejcdgbfmemoci","chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi","http://localhost:3000","http://127.0.0.1:3010","http://localhost:3010","http://127.0.0.1:3100","http://localhost:3100"]}"#;
const ICP_CLI_LOGIN_DISCOVERY_PATH: &str = "/.well-known/ic-cli-login";
const ICP_CLI_LOGIN_PATH: &str = "/login";
const ICP_CLI_LOGIN_HTML: &str = include_str!("icp_cli_login.html");
const UPDATE_EXECUTION_BASE_CYCLES: u128 = 5_000_000;
const UPDATE_ACCOUNTING_OVERHEAD_CYCLES: u128 = 15_000_000;
const DB_PAYMENT_RECIPIENT_PRINCIPAL: &str =
    "isz6c-6c4pl-oba7w-ikjex-472yu-rf3fe-valdh-lfazm-5f3ep-v474i-qae";
#[cfg(target_arch = "wasm32")]
const STORAGE_BILLING_TIMER_BATCHES_PER_MESSAGE: u32 = 6;
#[cfg(target_arch = "wasm32")]
const STORAGE_BILLING_CONTINUATION_DELAY_MS: u64 = 1;
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
    static CYCLES_TOP_UP_RUNTIME_STATE: RefCell<CyclesTopUpRuntimeState> =
        const { RefCell::new(CyclesTopUpRuntimeState::new()) };
    #[cfg(target_arch = "wasm32")]
    static DATABASE_HANDLES: RefCell<BTreeMap<u16, DbHandle>> = const { RefCell::new(BTreeMap::new()) };
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CyclesTopUpRuntimeState {
    in_progress: bool,
    last_attempt_ns: Option<u64>,
    last_success_ns: Option<u64>,
}

impl CyclesTopUpRuntimeState {
    const fn new() -> Self {
        Self {
            in_progress: false,
            last_attempt_ns: None,
            last_success_ns: None,
        }
    }
}

#[derive(Clone, Debug)]
enum LedgerTransferFromOutcome {
    Completed(u64),
    BadFee { expected_fee_e8s: u64 },
    LedgerErr(String),
    Ambiguous(String),
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
enum CyclesTopUpLauncherError {
    Unauthorized,
    TooSoon,
    LauncherBalanceTooLow,
    TopUpFailed(String),
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
enum CyclesTopUpLauncherResult {
    Ok,
    Err(CyclesTopUpLauncherError),
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
enum CyclesTopUpCheckStatus {
    SkippedDisabled,
    SkippedAboveThreshold,
    SkippedInProgress,
    LauncherOk,
    LauncherErr,
    CallErr,
}

#[derive(Clone, Debug, CandidType, Deserialize, PartialEq, Eq)]
struct CyclesTopUpCheckResult {
    balance_cycles_before: Nat,
    balance_cycles_after: Option<Nat>,
    threshold_cycles: Nat,
    called_launcher: bool,
    status: CyclesTopUpCheckStatus,
    launcher_result: Option<CyclesTopUpLauncherResult>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, CandidType, Deserialize)]
struct IcrcAccount {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
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
struct Icrc21ConsentMessageRequest {
    arg: Vec<u8>,
    method: String,
    user_preferences: Icrc21ConsentMessageSpec,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc21ConsentMessageSpec {
    metadata: Icrc21ConsentMessageMetadata,
    device_spec: Option<Icrc21DeviceSpec>,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc21ConsentMessageMetadata {
    utc_offset_minutes: Option<i16>,
    language: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum Icrc21DeviceSpec {
    GenericDisplay,
    FieldsDisplay,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum Icrc21ConsentMessage {
    GenericDisplayMessage(String),
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc21ConsentInfo {
    metadata: Icrc21ConsentMessageMetadata,
    consent_message: Icrc21ConsentMessage,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc21ErrorInfo {
    description: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc21GenericError {
    description: String,
    error_code: Nat,
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum Icrc21Error {
    GenericError(Icrc21GenericError),
    InsufficientPayment(Icrc21ErrorInfo),
    UnsupportedCanisterCall(Icrc21ErrorInfo),
    ConsentMessageUnavailable(Icrc21ErrorInfo),
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
enum Icrc21ConsentMessageResponse {
    Ok(Icrc21ConsentInfo),
    Err(Icrc21Error),
}

#[allow(dead_code)]
#[derive(Clone, Debug, CandidType, Deserialize)]
struct Icrc10SupportedStandard {
    name: String,
    url: String,
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

#[cfg(not(feature = "canbench-rs"))]
#[init]
fn init_hook(config: CyclesBillingConfig) {
    initialize_or_trap(Some(config));
    certify_http_responses();
    schedule_storage_billing_timer();
}

#[cfg(feature = "canbench-rs")]
#[init]
fn init_hook() {
    initialize_or_trap(None);
    certify_http_responses();
    schedule_storage_billing_timer();
}

#[post_upgrade]
fn post_upgrade_hook() {
    let config =
        post_upgrade_cycles_billing_config_arg().unwrap_or_else(|error| ic_cdk::trap(&error));
    initialize_upgrade_or_trap(config);
    certify_http_responses();
    schedule_storage_billing_timer();
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
fn store_manifest(request: StoreManifestRequest) -> Result<StoreManifest, String> {
    let profile =
        with_service(|service| service.database_profile(&request.database_id, &caller_text()))?;
    Ok(store_manifest_for_profile(profile))
}

fn store_manifest_for_profile(profile: DatabaseProfile) -> StoreManifest {
    StoreManifest {
        api_version: "kinic-stores-v1".to_string(),
        profile,
        purpose: store_manifest_purpose(profile).to_string(),
        enabled_stores: store_manifest_enabled_stores(profile),
        roots: store_manifest_roots(profile),
        entry_roots: store_manifest_entry_roots(profile),
        capabilities: store_capabilities(),
        canonical_roles: canonical_roles(),
        write_policy: "store_recall_read_only".to_string(),
        recommended_entrypoint: store_manifest_recommended_entrypoint(profile).to_string(),
        max_depth: 2,
        max_query_limit: 100,
        budget_unit: "approx_chars_from_tokens".to_string(),
    }
}

fn store_manifest_purpose(profile: DatabaseProfile) -> &'static str {
    match profile {
        DatabaseProfile::Workspace => {
            "Canister-backed memory, knowledge, skill, and session stores for agents"
        }
        DatabaseProfile::Knowledge => "Long-term wiki and digital garden knowledge store",
        DatabaseProfile::Memory => "Agent memory and recall store with evidence links",
        DatabaseProfile::Skill => "Skill registry store with run evidence",
        DatabaseProfile::Session => "Agent session audit and replay source store",
    }
}

fn store_manifest_enabled_stores(profile: DatabaseProfile) -> Vec<String> {
    let stores: &[&str] = match profile {
        DatabaseProfile::Workspace => &["memory", "knowledge", "skill", "session"],
        DatabaseProfile::Knowledge => &["knowledge"],
        DatabaseProfile::Memory => &["memory", "knowledge"],
        DatabaseProfile::Skill => &["skill", "knowledge"],
        DatabaseProfile::Session => &["session"],
    };
    stores.iter().map(|store| (*store).to_string()).collect()
}

fn store_manifest_roots(profile: DatabaseProfile) -> Vec<StoreRoot> {
    match profile {
        DatabaseProfile::Workspace => vec![
            store_root("/Memory", "memory"),
            store_root("/Wiki", "knowledge"),
            store_root("/Wiki/skills", "skill"),
            store_root("/Sessions", "session"),
            store_root("/Sources/raw", "knowledge_evidence"),
        ],
        DatabaseProfile::Knowledge => vec![store_root("/Wiki", "knowledge")],
        DatabaseProfile::Memory => vec![
            store_root("/Memory", "memory"),
            store_root("/Wiki", "knowledge"),
            store_root("/Sources/raw", "knowledge_evidence"),
        ],
        DatabaseProfile::Skill => vec![
            store_root("/Wiki/skills", "skill"),
            store_root("/Sources/skill-runs", "skill_run_evidence"),
        ],
        DatabaseProfile::Session => vec![
            store_root("/Sessions", "session"),
            store_root("/Sources/raw", "session_audit_sources"),
        ],
    }
}

fn store_manifest_entry_roots(profile: DatabaseProfile) -> Vec<StoreRoot> {
    match profile {
        DatabaseProfile::Workspace => vec![
            store_root("/Memory", "memory"),
            store_root("/Wiki", "knowledge"),
            store_root("/Wiki/skills", "skill"),
            store_root("/Sessions", "session"),
        ],
        DatabaseProfile::Knowledge => vec![store_root("/Wiki", "knowledge")],
        DatabaseProfile::Memory => vec![store_root("/Memory", "memory")],
        DatabaseProfile::Skill => vec![store_root("/Wiki/skills", "skill")],
        DatabaseProfile::Session => vec![store_root("/Sessions", "session")],
    }
}

fn store_manifest_recommended_entrypoint(profile: DatabaseProfile) -> &'static str {
    match profile {
        DatabaseProfile::Workspace | DatabaseProfile::Memory => "memory_recall",
        DatabaseProfile::Knowledge => "read_node_context:/Wiki/index.md",
        DatabaseProfile::Skill => "skill inspect",
        DatabaseProfile::Session => "list_nodes:/Sessions",
    }
}

fn store_root(path: &str, kind: &str) -> StoreRoot {
    StoreRoot {
        path: path.to_string(),
        kind: kind.to_string(),
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
    with_unmetered_update("create_database", None, |service, caller, now| {
        let meta = service.reserve_pending_generated_database_with_profile(
            &request.name,
            request.profile,
            caller,
            now,
        )?;
        Ok(CreateDatabaseResult {
            database_id: meta.database_id,
            name: meta.name,
            profile: meta.profile,
        })
    })
}

#[update]
fn rename_database(request: RenameDatabaseRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_role_unmetered_update(
        "rename_database",
        Some(database_id),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "grant_database_access",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_unmetered_update(
        "revoke_database_access",
        Some(database_id.clone()),
        RequiredRole::Owner,
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

#[query]
fn icrc10_supported_standards() -> Vec<Icrc10SupportedStandard> {
    vec![Icrc10SupportedStandard {
        name: "ICRC-21".to_string(),
        url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-21/ICRC-21.md".to_string(),
    }]
}

#[update]
fn icrc21_canister_call_consent_message(
    request: Icrc21ConsentMessageRequest,
) -> Icrc21ConsentMessageResponse {
    let language = if request.user_preferences.metadata.language.trim().is_empty() {
        "en".to_string()
    } else {
        request.user_preferences.metadata.language
    };
    let metadata = Icrc21ConsentMessageMetadata {
        language,
        utc_offset_minutes: request.user_preferences.metadata.utc_offset_minutes,
    };
    match request.method.as_str() {
        "purchase_database_cycles" => {
            let purchase = match Decode!(&request.arg, DatabaseCyclesPurchaseRequest) {
                Ok(decoded) => decoded,
                Err(error) => {
                    return icrc21_unavailable(format!(
                        "purchase_database_cycles argument decode failed: {error}"
                    ));
                }
            };
            let cycles = match with_service(|service| {
                let config = service.cycles_billing_config()?;
                let cycles = cycles_for_payment_amount_e8s(purchase.payment_amount_e8s, &config)?;
                service.validate_database_cycles_purchase_with_minimum(
                    &purchase.database_id,
                    purchase.payment_amount_e8s,
                    purchase.min_expected_cycles,
                )?;
                Ok(cycles)
            }) {
                Ok(cycles) => cycles,
                Err(error) => return icrc21_unsupported(error),
            };
            Icrc21ConsentMessageResponse::Ok(Icrc21ConsentInfo {
                metadata,
                consent_message: Icrc21ConsentMessage::GenericDisplayMessage(format!(
                    "# Purchase Kinic database cycles\n\nDatabase: `{database_id}`\n\nCycles: `{cycles}`\n\nPayment: `{payment}` KINIC\n\nLedger transfer fee in allowance: `{fee}` KINIC\n\nSpender canister: `{spender}`",
                    database_id = purchase.database_id,
                    cycles = format_cycles(cycles),
                    payment = format_e8s(purchase.payment_amount_e8s),
                    fee = format_e8s(KINIC_LEDGER_FEE_E8S),
                    spender = canister_principal().to_text()
                )),
            })
        }
        "market_purchase_access" => {
            let purchase = match Decode!(&request.arg, MarketPurchaseRequest) {
                Ok(decoded) => decoded,
                Err(error) => {
                    return icrc21_unavailable(format!(
                        "market_purchase_access argument decode failed: {error}"
                    ));
                }
            };
            let payer = caller_text();
            let validation = match with_service(|service| {
                service.validate_market_purchase_for_consent(&payer, &purchase)
            }) {
                Ok(validation) => validation,
                Err(error) => return icrc21_unsupported(error),
            };
            let listing = validation.listing;
            let access_principal = validation.request.access_principal;
            Icrc21ConsentMessageResponse::Ok(Icrc21ConsentInfo {
                metadata,
                consent_message: Icrc21ConsentMessage::GenericDisplayMessage(format!(
                    "# Purchase marketplace database access\n\nListing: `{listing_title}`\n\nDatabase: `{database_id}`\n\nPayment: `{payment}` KINIC\n\nLedger transfer fee in allowance: `{fee}` KINIC\n\nSeller principal: `{seller}`\n\nSeller payout principal: `{payout}`\n\nPayer wallet principal: `{payer}`\n\nAccess principal: `{access}`\n\nGranted access: read-only marketplace entitlement",
                    listing_title = listing.title,
                    database_id = listing.database_id,
                    payment = format_e8s(purchase.price_e8s),
                    fee = format_e8s(KINIC_LEDGER_FEE_E8S),
                    seller = listing.seller_principal,
                    payout = listing.payout_principal,
                    payer = payer,
                    access = access_principal,
                )),
            })
        }
        method => icrc21_unsupported(format!("unsupported canister call: {method}")),
    }
}

#[update]
async fn purchase_database_cycles(
    request: DatabaseCyclesPurchaseRequest,
) -> Result<CyclesPurchaseResult, String> {
    require_authenticated_caller()?;
    let caller = caller_text();
    let now = now_millis();
    let config = with_service(|service| service.cycles_billing_config())?;
    let ledger = Principal::from_text(&config.kinic_ledger_canister_id)
        .map_err(|error| format!("invalid KINIC ledger canister id: {error}"))?;
    let ledger_fee_e8s = KINIC_LEDGER_FEE_E8S;
    let payment_amount_e8s = request.payment_amount_e8s;
    let ledger_created_at_time_ns = now_nanos();
    let payment_recipient = Principal::from_text(DB_PAYMENT_RECIPIENT_PRINCIPAL)
        .map_err(|error| format!("invalid database payment recipient principal: {error}"))?;
    let payment_recipient_text = payment_recipient.to_text();
    let purchase_start = match with_service(|service| {
        service.begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id: &request.database_id,
                caller: &caller,
                payment_amount_e8s: request.payment_amount_e8s,
                min_expected_cycles: request.min_expected_cycles,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: &caller,
                    from_subaccount: None,
                    to_owner: &payment_recipient_text,
                    to_subaccount: None,
                    ledger_fee_e8s,
                    ledger_created_at_time_ns,
                },
                now,
            },
        )
    }) {
        Ok(purchase_start) => purchase_start,
        Err(error) => return Err(error),
    };
    let operation_id = purchase_start.operation_id;
    let amount_cycles = purchase_start.amount_cycles;
    run_transfer_from_saga(
        TransferFromSaga {
            operation_id,
            ledger,
            from: IcrcAccount {
                owner: caller_principal(),
                subaccount: None,
            },
            to: IcrcAccount {
                owner: payment_recipient,
                subaccount: None,
            },
            amount_e8s: payment_amount_e8s,
            ledger_fee_e8s,
            memo: cycles_purchase_memo(operation_id),
            created_at_time_ns: ledger_created_at_time_ns,
            ambiguous_review_label: "billing authority review required",
        },
        |block_index| {
            with_service(|service| {
                service.complete_database_cycles_purchase_ledger_transfer(
                    operation_id,
                    &request.database_id,
                    &caller,
                    amount_cycles,
                    block_index,
                )
            })?;
            activate_pending_database_after_cycles_purchase_ledger_success(
                &request.database_id,
                now,
            )?;
            #[cfg(test)]
            if TEST_DATABASE_CYCLES_PURCHASE_APPLY_FAIL_ONCE.with(|flag| flag.replace(false)) {
                return Err("test cycle purchase apply failure".to_string());
            }
            let balance = with_service(|service| {
                service.apply_database_cycles_purchase(
                    operation_id,
                    &request.database_id,
                    &caller,
                    amount_cycles,
                    block_index,
                    now,
                )
            })?;
            Ok(CyclesPurchaseResult {
                block_index,
                amount_cycles,
                balance_cycles: balance,
            })
        },
        || {
            with_service(|service| {
                service.cancel_database_cycles_purchase(
                    operation_id,
                    &request.database_id,
                    &caller,
                    amount_cycles,
                )
            })
        },
        || {
            with_service(|service| {
                service.mark_database_cycles_purchase_ambiguous(
                    operation_id,
                    &request.database_id,
                    &caller,
                    amount_cycles,
                )
            })
        },
        cycles_purchase_local_apply_error,
    )
    .await
}

#[query]
fn list_database_cycle_entries(
    database_id: String,
    cursor: Option<u64>,
    limit: u32,
) -> Result<DatabaseCycleEntryPage, String> {
    with_service(|service| {
        service.list_database_cycle_entries(&database_id, &caller_text(), cursor, limit)
    })
}

#[query]
fn query_index_sql_json(sql: String, limit: u32) -> Result<IndexSqlJsonQueryResult, String> {
    require_controller_caller()?;
    with_service(|service| service.query_index_sql_json(&sql, limit))
}

#[query]
fn query_database_sql_json(
    database_id: String,
    sql: String,
    limit: u32,
) -> Result<IndexSqlJsonQueryResult, String> {
    with_service(|service| {
        service.query_database_sql_json(&database_id, &caller_text(), &sql, limit)
    })
}

#[query]
fn wiki_metrics() -> Result<WikiMetrics, String> {
    with_service(|service| service.wiki_metrics(now_millis()))
}

#[query]
fn wiki_metrics_series(days: u32) -> Result<Vec<WikiMetricsPoint>, String> {
    with_service(|service| service.wiki_metrics_series(now_millis(), days))
}

#[update]
fn settle_database_storage_charges_batch(
    request: StorageBillingBatchRequest,
) -> Result<StorageBillingBatchResult, String> {
    require_controller_caller()?;
    with_service(|service| {
        service.settle_database_storage_charges_batch(
            &canister_principal().to_text(),
            request,
            now_millis(),
        )
    })
}

#[update]
async fn check_cycles_top_up() -> Result<CyclesTopUpCheckResult, String> {
    require_controller_caller()?;
    run_cycles_top_up_check().await
}

fn activate_pending_database_after_cycles_purchase_ledger_success(
    database_id: &str,
    now: i64,
) -> Result<(), String> {
    let activation =
        with_service(|service| service.prepare_pending_database_activation(database_id, now))?;
    if let Some(meta) = &activation
        && let Err(error) = mount_database_file(meta)
    {
        return Err(database_create_error(error, None));
    }
    Ok(())
}

struct TransferFromSaga {
    operation_id: u64,
    ledger: Principal,
    from: IcrcAccount,
    to: IcrcAccount,
    amount_e8s: u64,
    ledger_fee_e8s: u64,
    memo: Vec<u8>,
    created_at_time_ns: u64,
    ambiguous_review_label: &'static str,
}

async fn run_transfer_from_saga<T, Apply, Cancel, Ambiguous, LocalApplyError>(
    saga: TransferFromSaga,
    apply_after_completed_transfer: Apply,
    cancel_after_no_credit: Cancel,
    mark_ambiguous: Ambiguous,
    local_apply_error: LocalApplyError,
) -> Result<T, String>
where
    Apply: FnOnce(u64) -> Result<T, String>,
    Cancel: FnOnce() -> Result<(), String>,
    Ambiguous: FnOnce() -> Result<(), String>,
    LocalApplyError: Fn(u64, u64, String) -> String,
{
    match ledger_transfer_from_with_memo(
        saga.ledger,
        saga.from,
        saga.to,
        saga.amount_e8s,
        saga.ledger_fee_e8s,
        saga.memo,
        saga.created_at_time_ns,
    )
    .await
    {
        LedgerTransferFromOutcome::Completed(block_index) => {
            apply_after_completed_transfer(block_index)
                .map_err(|error| local_apply_error(saga.operation_id, block_index, error))
        }
        LedgerTransferFromOutcome::BadFee { expected_fee_e8s } => {
            let _ = cancel_after_no_credit();
            Err(format!(
                "icrc2_transfer_from failed: BadFee expected fee {expected_fee_e8s}; re-approve with the current ledger fee and retry"
            ))
        }
        LedgerTransferFromOutcome::LedgerErr(error) => {
            let _ = cancel_after_no_credit();
            Err(error)
        }
        LedgerTransferFromOutcome::Ambiguous(error) => {
            if let Err(mark_error) = mark_ambiguous() {
                return Err(format!(
                    "icrc2_transfer_from result ambiguous for operation_id {operation_id}; failed to mark operation ambiguous; {review_label}: {mark_error}; original ledger ambiguity: {error}",
                    operation_id = saga.operation_id,
                    review_label = saga.ambiguous_review_label
                ));
            }
            Err(format!(
                "icrc2_transfer_from result ambiguous for operation_id {operation_id}; {review_label}: {error}",
                operation_id = saga.operation_id,
                review_label = saga.ambiguous_review_label
            ))
        }
    }
}

fn cycles_purchase_local_apply_error(operation_id: u64, block_index: u64, cause: String) -> String {
    format!(
        "cycles purchase payment completed at ledger block {block_index} but local cycles application failed; pending operation {operation_id} remains completed for billing authority review: {cause}"
    )
}

#[query]
fn get_cycles_billing_config() -> Result<CyclesBillingConfig, String> {
    with_service(|service| service.cycles_billing_config())
}

#[query]
fn list_database_cycles_pending_purchases(
    database_id: String,
) -> Result<Vec<DatabaseCyclesPendingPurchase>, String> {
    with_service(|service| {
        service.list_database_cycles_pending_purchases(&database_id, &caller_text())
    })
}

#[update]
fn market_create_listing(request: MarketCreateListingRequest) -> Result<MarketListing, String> {
    require_authenticated_caller()?;
    with_unmetered_update(
        "market_create_listing",
        Some(request.database_id.clone()),
        |service, caller, now| service.market_create_listing(caller, request, now),
    )
}

#[update]
fn market_update_listing(request: MarketUpdateListingRequest) -> Result<MarketListing, String> {
    require_authenticated_caller()?;
    with_unmetered_update("market_update_listing", None, |service, caller, now| {
        service.market_update_listing(caller, request, now)
    })
}

#[update]
fn market_publish_listing(listing_id: String) -> Result<MarketListing, String> {
    require_authenticated_caller()?;
    with_unmetered_update("market_publish_listing", None, |service, caller, now| {
        service.market_publish_listing(caller, &listing_id, now)
    })
}

#[update]
fn market_pause_listing(listing_id: String) -> Result<MarketListing, String> {
    require_authenticated_caller()?;
    with_unmetered_update("market_pause_listing", None, |service, caller, now| {
        service.market_pause_listing(caller, &listing_id, now)
    })
}

#[query]
fn market_list_listings(cursor: Option<String>, limit: u32) -> Result<MarketListingPage, String> {
    with_service(|service| service.market_list_listings(cursor, limit))
}

#[query]
fn market_list_seller_listings(
    seller_principal: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<MarketListingPage, String> {
    with_service(|service| service.market_list_seller_listings(&seller_principal, cursor, limit))
}

#[query]
fn market_list_database_listings(database_id: String) -> Result<Vec<MarketListing>, String> {
    with_service(|service| service.market_list_database_listings(&caller_text(), &database_id))
}

#[query]
fn market_list_database_entitlements(
    database_id: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<MarketEntitlementPage, String> {
    with_service(|service| {
        service.market_list_database_entitlements(&caller_text(), &database_id, cursor, limit)
    })
}

#[query]
fn market_get_listing(listing_id: String) -> Result<MarketListingDetail, String> {
    with_service(|service| service.market_get_listing(&caller_text(), &listing_id))
}

#[query]
fn market_preview_purchase(listing_id: String) -> Result<MarketPurchasePreview, String> {
    with_service(|service| service.market_preview_purchase(&caller_text(), &listing_id))
}

#[update]
async fn market_purchase_access(request: MarketPurchaseRequest) -> Result<MarketOrder, String> {
    require_authenticated_caller()?;
    let caller = caller_text();
    let now = now_millis();
    let config = with_service(|service| service.cycles_billing_config())?;
    let ledger = Principal::from_text(&config.kinic_ledger_canister_id)
        .map_err(|error| format!("invalid KINIC ledger canister id: {error}"))?;
    let ledger_fee_e8s = KINIC_LEDGER_FEE_E8S;
    let ledger_created_at_time_ns = now_nanos();
    let purchase_start = with_service(|service| {
        service.begin_market_purchase_with_ledger_details(
            &caller,
            request,
            CyclesPendingLedgerDetailsInput {
                from_owner: &caller,
                from_subaccount: None,
                to_owner: "",
                to_subaccount: None,
                ledger_fee_e8s,
                ledger_created_at_time_ns,
            },
            now,
        )
    })?;
    let payout = Principal::from_text(&purchase_start.payout_principal)
        .map_err(|error| format!("invalid market payout principal: {error}"))?;
    let operation_id = purchase_start.operation_id;
    run_transfer_from_saga(
        TransferFromSaga {
            operation_id,
            ledger,
            from: IcrcAccount {
                owner: caller_principal(),
                subaccount: None,
            },
            to: IcrcAccount {
                owner: payout,
                subaccount: None,
            },
            amount_e8s: purchase_start.price_e8s,
            ledger_fee_e8s,
            memo: market_purchase_memo(operation_id),
            created_at_time_ns: ledger_created_at_time_ns,
            ambiguous_review_label: "review required",
        },
        |block_index| {
            with_service(|service| {
                service.complete_market_purchase_ledger_transfer(
                    operation_id,
                    &purchase_start.access_principal,
                    &purchase_start.listing_id,
                    purchase_start.price_e8s,
                    block_index,
                )
            })?;
            with_service(|service| {
                service.apply_market_purchase(
                    operation_id,
                    &purchase_start.access_principal,
                    &purchase_start.listing_id,
                    purchase_start.price_e8s,
                    now,
                )
            })
        },
        || {
            with_service(|service| {
                service.cancel_market_purchase(
                    operation_id,
                    &purchase_start.access_principal,
                    &purchase_start.listing_id,
                    purchase_start.price_e8s,
                )
            })
        },
        || {
            with_service(|service| {
                service.mark_market_purchase_ambiguous(
                    operation_id,
                    &purchase_start.access_principal,
                    &purchase_start.listing_id,
                    purchase_start.price_e8s,
                )
            })
        },
        market_purchase_local_apply_error,
    )
    .await
}

fn market_purchase_local_apply_error(operation_id: u64, block_index: u64, cause: String) -> String {
    format!(
        "market purchase payment completed at ledger block {block_index} but local entitlement application failed; pending operation {operation_id} remains completed for review: {cause}"
    )
}

fn market_purchase_memo(operation_id: u64) -> Vec<u8> {
    let mut memo = b"kinic:market:".to_vec();
    memo.extend_from_slice(operation_id.to_string().as_bytes());
    memo
}

#[query]
fn market_list_entitlements(
    cursor: Option<String>,
    limit: u32,
) -> Result<MarketEntitlementPage, String> {
    with_service(|service| service.market_list_entitlements(&caller_text(), cursor, limit))
}

#[query]
fn market_list_orders(cursor: Option<String>, limit: u32) -> Result<MarketOrderPage, String> {
    with_service(|service| service.market_list_orders(&caller_text(), cursor, limit))
}

#[query]
fn market_count_active_entitlements(database_id: String) -> Result<u64, String> {
    with_service(|service| service.market_count_active_entitlements(&caller_text(), &database_id))
}

#[update]
fn update_cycles_billing_config(update: CyclesBillingConfigUpdate) -> Result<(), String> {
    require_authenticated_caller()?;
    with_unmetered_update(
        "update_cycles_billing_config",
        None,
        |service, caller, _now| {
            service
                .update_cycles_billing_config(update, caller)
                .map(|_| ())
        },
    )
}

#[update]
fn delete_database(request: DeleteDatabaseRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_role_unmetered_update(
        "delete_database",
        Some(database_id.clone()),
        RequiredRole::Owner,
        |service, caller, now| {
            let meta = service
                .list_databases()?
                .into_iter()
                .find(|meta| meta.database_id == database_id);
            service.delete_database(request, caller, now)?;
            if let Some(meta) = meta {
                unmount_database_file(&meta.db_file_name);
            }
            Ok(())
        },
    )
}

#[update]
fn begin_database_archive(database_id: String) -> Result<DatabaseArchiveInfo, String> {
    with_role_metered_update(
        "begin_database_archive",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "finalize_database_archive",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "cancel_database_archive",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "begin_database_restore",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "write_database_restore_chunk",
        Some(database_id),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "finalize_database_restore",
        Some(database_id.clone()),
        RequiredRole::Owner,
        |service, caller, now| {
            let meta = service.finalize_database_restore(&database_id, caller, now)?;
            mount_database_file(&meta)
        },
    )
}

#[update]
fn cancel_database_restore(database_id: String) -> Result<(), String> {
    with_role_metered_update(
        "cancel_database_restore",
        Some(database_id.clone()),
        RequiredRole::Owner,
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
    with_role_metered_update(
        "write_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.write_node(caller, request, now),
    )
}

#[update]
fn write_source_for_generation(
    request: WriteSourceForGenerationRequest,
) -> Result<WriteSourceForGenerationResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "write_source_for_generation",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.write_source_for_generation(caller, request, now),
    )
}

#[update]
fn write_nodes(request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "write_nodes",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.write_nodes(caller, request, now),
    )
}

#[update]
fn authorize_url_ingest_trigger_session(
    request: UrlIngestTriggerSessionRequest,
) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "authorize_url_ingest_trigger_session",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.authorize_url_ingest_trigger_session(caller, request, now),
    )
}

#[query]
fn check_url_ingest_trigger_session(
    request: UrlIngestTriggerSessionCheckRequest,
) -> Result<(), String> {
    with_service(|service| service.check_url_ingest_trigger_session(request, now_millis()))
}

#[query]
fn check_database_write_cycles(database_id: String) -> Result<(), String> {
    with_service(|service| service.check_database_write_cycles(&database_id, &caller_text()))
}

#[update]
fn authorize_ops_answer_session(request: OpsAnswerSessionRequest) -> Result<(), String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "authorize_ops_answer_session",
        Some(database_id),
        RequiredRole::Reader,
        |service, caller, now| service.authorize_ops_answer_session(caller, request, now),
    )
}

#[query]
fn check_ops_answer_session(
    request: OpsAnswerSessionCheckRequest,
) -> Result<OpsAnswerSessionCheckResult, String> {
    with_service(|service| service.check_ops_answer_session(request, now_millis()))
}

#[query]
fn check_source_run_session(request: SourceRunSessionCheckRequest) -> Result<(), String> {
    with_service(|service| service.check_source_run_session(request, now_millis()))
}

#[update]
fn append_node(request: AppendNodeRequest) -> Result<WriteNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "append_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.append_node(caller, request, now),
    )
}

#[update]
fn edit_node(request: EditNodeRequest) -> Result<EditNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "edit_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.edit_node(caller, request, now),
    )
}

#[update]
fn delete_node(request: DeleteNodeRequest) -> Result<DeleteNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "delete_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.delete_node(caller, request, now),
    )
}

#[update]
fn move_node(request: MoveNodeRequest) -> Result<MoveNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "move_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.move_node(caller, request, now),
    )
}

#[update]
fn mkdir_node(request: MkdirNodeRequest) -> Result<MkdirNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "mkdir_node",
        Some(database_id),
        RequiredRole::Writer,
        |service, caller, now| service.mkdir_node(caller, request, now),
    )
}

#[query]
fn glob_nodes(request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>, String> {
    with_service(|service| service.glob_nodes(&caller_text(), request))
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
fn memory_recall(request: MemoryRecallRequest) -> Result<MemoryRecall, String> {
    with_service(|service| service.memory_recall(&caller_text(), request))
}

#[query]
fn knowledge_evidence(request: KnowledgeEvidenceRequest) -> Result<KnowledgeEvidence, String> {
    with_service(|service| service.knowledge_evidence(&caller_text(), request))
}

#[update]
fn multi_edit_node(request: MultiEditNodeRequest) -> Result<MultiEditNodeResult, String> {
    let database_id = request.database_id.clone();
    with_role_metered_update(
        "multi_edit_node",
        Some(database_id),
        RequiredRole::Writer,
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

fn initialize_or_trap(config: Option<CyclesBillingConfig>) {
    initialize_service_with_config(config).unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn initialize_upgrade_or_trap(config: Option<CyclesBillingConfig>) {
    initialize_service_for_upgrade(config).unwrap_or_else(|error| ic_cdk::trap(&error));
}

fn schedule_storage_billing_timer() {
    #[cfg(target_arch = "wasm32")]
    {
        let interval_ms = u64::try_from(STORAGE_BILLING_INTERVAL_MS).unwrap_or(24 * 60 * 60 * 1000);
        set_timer(Duration::ZERO, async {
            run_cycles_top_up_check_from_timer().await;
        });
        set_timer_interval(Duration::from_millis(interval_ms), || async {
            run_cycles_top_up_check_from_timer().await;
            run_storage_billing_timer_batches();
        });
    }
}

#[cfg(target_arch = "wasm32")]
async fn run_cycles_top_up_check_from_timer() {
    match run_cycles_top_up_check().await {
        Ok(result) => {
            if result.called_launcher
                || matches!(
                    result.status,
                    CyclesTopUpCheckStatus::LauncherErr | CyclesTopUpCheckStatus::SkippedInProgress
                )
            {
                ic_cdk::println!(
                    "cycles top-up check status {:?}, balance before {:?}, threshold {:?}, launcher {:?}",
                    result.status,
                    result.balance_cycles_before,
                    result.threshold_cycles,
                    result.launcher_result
                );
            }
        }
        Err(error) => {
            ic_cdk::println!("cycles top-up check failed with status CallErr: {error}");
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn run_storage_billing_timer_batches() {
    let mut should_continue = false;
    for _ in 0..STORAGE_BILLING_TIMER_BATCHES_PER_MESSAGE {
        match with_service(|service| {
            service.settle_database_storage_charges_timer_batch(
                &canister_principal().to_text(),
                now_millis(),
            )
        }) {
            Ok(result) => {
                should_continue = result.next_cursor_mount_id.is_some();
                if !should_continue {
                    break;
                }
            }
            Err(error) => {
                ic_cdk::println!("storage billing settle failed: {error}");
                return;
            }
        }
    }
    if should_continue {
        set_timer(
            Duration::from_millis(STORAGE_BILLING_CONTINUATION_DELAY_MS),
            async {
                run_storage_billing_timer_batches();
            },
        );
    }
}

fn initialize_service_with_config(config: Option<CyclesBillingConfig>) -> Result<(), String> {
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

fn initialize_service_for_upgrade(config: Option<CyclesBillingConfig>) -> Result<(), String> {
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
fn parse_upgrade_cycles_billing_config_arg(
    bytes: &[u8],
) -> Result<Option<CyclesBillingConfig>, String> {
    if bytes.is_empty() || bytes == b"DIDL\0\0" {
        return Ok(None);
    }
    if let Ok((config,)) = decode_args::<(CyclesBillingConfig,)>(bytes) {
        return Ok(Some(config));
    }
    if let Ok((config,)) = decode_args::<(Option<CyclesBillingConfig>,)>(bytes) {
        return Ok(config);
    }
    Err(
        "post_upgrade cycles config arg must be empty, CyclesBillingConfig, or opt CyclesBillingConfig"
            .to_string(),
    )
}

fn post_upgrade_cycles_billing_config_arg() -> Result<Option<CyclesBillingConfig>, String> {
    #[cfg(target_arch = "wasm32")]
    {
        parse_upgrade_cycles_billing_config_arg(&ic_cdk::api::msg_arg_data())
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
    static TEST_LEDGER_TRANSFER_FROM_OUTCOMES: RefCell<Vec<LedgerTransferFromOutcome>> = const { RefCell::new(Vec::new()) };
    static TEST_LEDGER_TRANSFER_FEES: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    static TEST_LAST_LEDGER_MEMO: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static TEST_LAST_LEDGER_FROM: RefCell<Option<IcrcAccount>> = const { RefCell::new(None) };
    static TEST_LAST_LEDGER_TO: RefCell<Option<IcrcAccount>> = const { RefCell::new(None) };
    static TEST_CALLER_PRINCIPAL: RefCell<Option<Principal>> = const { RefCell::new(None) };
    static TEST_DATABASE_CYCLES_PURCHASE_APPLY_FAIL_ONCE: RefCell<bool> = const { RefCell::new(false) };
    static TEST_UPDATE_CHARGE_UNITS: RefCell<Vec<u128>> = const { RefCell::new(Vec::new()) };
    static TEST_CYCLES_BALANCE: Cell<Option<u128>> = const { Cell::new(None) };
    static TEST_CYCLES_TOP_UP_LAUNCHER_RESULTS: RefCell<Vec<Result<CyclesTopUpLauncherResult, String>>> = const { RefCell::new(Vec::new()) };
    static TEST_CYCLES_TOP_UP_LAUNCHER_CALL_COUNT: Cell<u64> = const { Cell::new(0) };
}

#[cfg(test)]
fn fail_next_mount_database_file_for_test() {
    TEST_MOUNT_DATABASE_FILE_FAIL_ONCE.with(|flag| flag.replace(true));
}

#[cfg(test)]
fn fail_next_apply_database_cycles_purchase_apply_for_test() {
    TEST_DATABASE_CYCLES_PURCHASE_APPLY_FAIL_ONCE.with(|flag| flag.replace(true));
}

#[cfg(test)]
fn set_next_ledger_transfer_from_outcome_for_test(outcome: LedgerTransferFromOutcome) {
    TEST_LEDGER_TRANSFER_FROM_OUTCOMES.with(|slot| {
        slot.replace(vec![outcome]);
    });
}

#[cfg(test)]
fn set_update_charge_units_for_test(units: Vec<u128>) {
    TEST_UPDATE_CHARGE_UNITS.with(|slot| {
        slot.replace(units);
    });
}

#[cfg(test)]
fn clear_ledger_transactions_for_test() {
    TEST_LEDGER_TRANSFER_FROM_OUTCOMES.with(|slot| {
        slot.borrow_mut().clear();
    });
    TEST_LEDGER_TRANSFER_FEES.with(|slot| {
        slot.borrow_mut().clear();
    });
    TEST_UPDATE_CHARGE_UNITS.with(|slot| {
        slot.borrow_mut().clear();
    });
}

#[cfg(test)]
fn set_cycles_balance_for_test(balance: u128) {
    TEST_CYCLES_BALANCE.with(|slot| {
        slot.set(Some(balance));
    });
}

#[cfg(test)]
fn clear_cycles_top_up_state_for_test() {
    TEST_CYCLES_BALANCE.with(|slot| {
        slot.set(None);
    });
    TEST_CYCLES_TOP_UP_LAUNCHER_RESULTS.with(|slot| {
        slot.borrow_mut().clear();
    });
    TEST_CYCLES_TOP_UP_LAUNCHER_CALL_COUNT.with(|slot| {
        slot.set(0);
    });
    CYCLES_TOP_UP_RUNTIME_STATE.with(|slot| {
        *slot.borrow_mut() = CyclesTopUpRuntimeState::new();
    });
}

#[cfg(test)]
fn set_cycles_top_up_in_progress_for_test() {
    CYCLES_TOP_UP_RUNTIME_STATE.with(|slot| {
        slot.borrow_mut().in_progress = true;
    });
}

#[cfg(test)]
fn set_next_cycles_top_up_launcher_result_for_test(
    result: Result<CyclesTopUpLauncherResult, String>,
) {
    TEST_CYCLES_TOP_UP_LAUNCHER_RESULTS.with(|slot| {
        slot.borrow_mut().push(result);
    });
}

#[cfg(test)]
fn cycles_top_up_launcher_call_count_for_test() -> u64 {
    TEST_CYCLES_TOP_UP_LAUNCHER_CALL_COUNT.with(Cell::get)
}

#[cfg(test)]
fn set_test_caller_principal_for_test(principal: Principal) {
    TEST_CALLER_PRINCIPAL.with(|slot| {
        slot.replace(Some(principal));
    });
}

#[cfg(test)]
fn record_test_ledger_memo(memo: &[u8]) {
    TEST_LAST_LEDGER_MEMO.with(|slot| {
        slot.replace(Some(memo.to_vec()));
    });
}

#[cfg(test)]
fn record_test_ledger_from(from: &IcrcAccount) {
    TEST_LAST_LEDGER_FROM.with(|slot| {
        slot.replace(Some(from.clone()));
    });
}

#[cfg(test)]
fn record_test_ledger_to(to: &IcrcAccount) {
    TEST_LAST_LEDGER_TO.with(|slot| {
        slot.replace(Some(to.clone()));
    });
}

#[cfg(test)]
fn last_ledger_memo_for_test() -> Option<Vec<u8>> {
    TEST_LAST_LEDGER_MEMO.with(|slot| slot.borrow().clone())
}

#[cfg(test)]
fn last_ledger_from_for_test() -> Option<IcrcAccount> {
    TEST_LAST_LEDGER_FROM.with(|slot| slot.borrow().clone())
}

#[cfg(test)]
fn last_ledger_to_for_test() -> Option<IcrcAccount> {
    TEST_LAST_LEDGER_TO.with(|slot| slot.borrow().clone())
}

#[cfg(test)]
fn ledger_transfer_fees_for_test() -> Vec<u64> {
    TEST_LEDGER_TRANSFER_FEES.with(|slot| slot.borrow().clone())
}

#[cfg(test)]
fn clear_last_ledger_memo_for_test() {
    TEST_LAST_LEDGER_MEMO.with(|slot| {
        slot.replace(None);
    });
    TEST_LAST_LEDGER_FROM.with(|slot| {
        slot.replace(None);
    });
    TEST_LAST_LEDGER_TO.with(|slot| {
        slot.replace(None);
    });
}

fn database_create_error(error: String, cleanup_error: Option<String>) -> String {
    match cleanup_error {
        Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
        None => error,
    }
}

fn icrc21_unsupported(description: String) -> Icrc21ConsentMessageResponse {
    Icrc21ConsentMessageResponse::Err(Icrc21Error::UnsupportedCanisterCall(Icrc21ErrorInfo {
        description,
    }))
}

fn icrc21_unavailable(description: String) -> Icrc21ConsentMessageResponse {
    Icrc21ConsentMessageResponse::Err(Icrc21Error::ConsentMessageUnavailable(Icrc21ErrorInfo {
        description,
    }))
}

fn format_e8s(amount_e8s: u64) -> String {
    let units_per_token = kinic_base_units_per_token();
    let whole = amount_e8s / units_per_token;
    let fractional = amount_e8s % units_per_token;
    if fractional == 0 {
        return whole.to_string();
    }
    let mut fraction = format!("{fractional:0width$}", width = usize::from(KINIC_DECIMALS));
    while fraction.ends_with('0') {
        fraction.pop();
    }
    format!("{whole}.{fraction}")
}

fn format_cycles(cycles: u64) -> String {
    cycles.to_string()
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

fn require_controller_caller() -> Result<(), String> {
    let caller = caller_principal();
    #[cfg(test)]
    {
        if caller == Principal::management_canister() {
            return Ok(());
        }
    }
    #[cfg(not(test))]
    {
        if ic_cdk::api::is_controller(&caller) {
            return Ok(());
        }
    }
    Err("caller is not a canister controller".to_string())
}

async fn run_cycles_top_up_check() -> Result<CyclesTopUpCheckResult, String> {
    let config = with_service(|service| service.cycles_billing_config())?.top_up;
    let balance = canister_balance_cycles();
    if !config.enabled {
        return Ok(CyclesTopUpCheckResult {
            balance_cycles_before: Nat::from(balance),
            balance_cycles_after: None,
            threshold_cycles: Nat::from(config.threshold_cycles),
            called_launcher: false,
            status: CyclesTopUpCheckStatus::SkippedDisabled,
            launcher_result: None,
        });
    }
    if balance > config.threshold_cycles {
        return Ok(CyclesTopUpCheckResult {
            balance_cycles_before: Nat::from(balance),
            balance_cycles_after: None,
            threshold_cycles: Nat::from(config.threshold_cycles),
            called_launcher: false,
            status: CyclesTopUpCheckStatus::SkippedAboveThreshold,
            launcher_result: None,
        });
    }
    if !try_begin_cycles_top_up_request() {
        return Ok(CyclesTopUpCheckResult {
            balance_cycles_before: Nat::from(balance),
            balance_cycles_after: None,
            threshold_cycles: Nat::from(config.threshold_cycles),
            called_launcher: false,
            status: CyclesTopUpCheckStatus::SkippedInProgress,
            launcher_result: None,
        });
    }
    let launcher_result = request_cycles_from_launcher(&config.launcher_principal).await;
    finish_cycles_top_up_request(matches!(launcher_result, Ok(CyclesTopUpLauncherResult::Ok)));
    let launcher_result = launcher_result?;
    let balance_after = canister_balance_cycles();
    let status = match launcher_result {
        CyclesTopUpLauncherResult::Ok => CyclesTopUpCheckStatus::LauncherOk,
        CyclesTopUpLauncherResult::Err(_) => CyclesTopUpCheckStatus::LauncherErr,
    };
    Ok(CyclesTopUpCheckResult {
        balance_cycles_before: Nat::from(balance),
        balance_cycles_after: Some(Nat::from(balance_after)),
        threshold_cycles: Nat::from(config.threshold_cycles),
        called_launcher: true,
        status,
        launcher_result: Some(launcher_result),
    })
}

fn try_begin_cycles_top_up_request() -> bool {
    CYCLES_TOP_UP_RUNTIME_STATE.with(|slot| {
        let mut state = slot.borrow_mut();
        if state.in_progress {
            return false;
        }
        state.in_progress = true;
        state.last_attempt_ns = Some(now_nanos());
        true
    })
}

fn finish_cycles_top_up_request(succeeded: bool) {
    CYCLES_TOP_UP_RUNTIME_STATE.with(|slot| {
        let mut state = slot.borrow_mut();
        state.in_progress = false;
        if succeeded {
            state.last_success_ns = Some(now_nanos());
        }
    });
}

fn canister_balance_cycles() -> u128 {
    #[cfg(test)]
    if let Some(balance) = TEST_CYCLES_BALANCE.with(Cell::get) {
        return balance;
    }
    #[cfg(target_arch = "wasm32")]
    {
        ic_cdk::api::canister_cycle_balance()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        u128::MAX
    }
}

#[cfg(test)]
fn request_cycles_from_launcher_for_test() -> Result<CyclesTopUpLauncherResult, String> {
    TEST_CYCLES_TOP_UP_LAUNCHER_CALL_COUNT.with(|slot| {
        slot.set(slot.get() + 1);
    });
    TEST_CYCLES_TOP_UP_LAUNCHER_RESULTS.with(|slot| {
        slot.borrow_mut()
            .pop()
            .unwrap_or(Ok(CyclesTopUpLauncherResult::Ok))
    })
}

async fn request_cycles_from_launcher(
    launcher_principal: &str,
) -> Result<CyclesTopUpLauncherResult, String> {
    #[cfg(target_arch = "wasm32")]
    {
        let launcher = Principal::from_text(launcher_principal)
            .map_err(|error| format!("invalid cycles launcher principal: {error}"))?;
        let response = Call::bounded_wait(launcher, "request_cycles")
            .await
            .map_err(|error| format!("request_cycles call failed: {error:?}"))?;
        response
            .candid()
            .map_err(|error| format!("request_cycles decode failed: {error}"))
    }
    #[cfg(all(not(target_arch = "wasm32"), test))]
    {
        let _ = launcher_principal;
        request_cycles_from_launcher_for_test()
    }
    #[cfg(all(not(target_arch = "wasm32"), not(test)))]
    {
        let _ = launcher_principal;
        Ok(CyclesTopUpLauncherResult::Ok)
    }
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

fn update_charge_units() -> u128 {
    #[cfg(test)]
    {
        TEST_UPDATE_CHARGE_UNITS.with(|slot| {
            let mut units = slot.borrow_mut();
            if units.is_empty() { 0 } else { units.remove(0) }
        })
    }
    #[cfg(not(test))]
    {
        u128::from(ic_cdk::api::performance_counter(
            PerformanceCounterType::InstructionCounter,
        ))
    }
}

fn update_charge_cycles(before: u128, after: u128) -> Result<u128, String> {
    let instruction_delta = after
        .checked_sub(before)
        .ok_or_else(|| "instruction counter decreased during update".to_string())?;
    UPDATE_EXECUTION_BASE_CYCLES
        .checked_add(UPDATE_ACCOUNTING_OVERHEAD_CYCLES)
        .and_then(|base| base.checked_add(instruction_delta))
        .ok_or_else(|| "cycle charge overflow".to_string())
}

fn now_nanos() -> u64 {
    #[cfg(test)]
    {
        1_700_000_000_000_000_000
    }
    #[cfg(not(test))]
    {
        ic_cdk::api::time()
    }
}

async fn ledger_transfer_from_with_memo(
    ledger: Principal,
    from: IcrcAccount,
    to: IcrcAccount,
    amount_e8s: u64,
    ledger_fee_e8s: u64,
    memo: Vec<u8>,
    created_at_time_ns: u64,
) -> LedgerTransferFromOutcome {
    #[cfg(test)]
    {
        record_test_ledger_from(&from);
        record_test_ledger_to(&to);
        let _ = (ledger, to, amount_e8s, created_at_time_ns);
        record_test_ledger_memo(&memo);
        TEST_LEDGER_TRANSFER_FEES.with(|fees| {
            fees.borrow_mut().push(ledger_fee_e8s);
        });
        TEST_LEDGER_TRANSFER_FROM_OUTCOMES.with(|outcomes| {
            let mut outcomes = outcomes.borrow_mut();
            if outcomes.is_empty() {
                LedgerTransferFromOutcome::Completed(1)
            } else {
                outcomes.remove(0)
            }
        })
    }
    #[cfg(not(test))]
    {
        let arg = TransferFromArg {
            spender_subaccount: None,
            from,
            to,
            amount: Nat::from(amount_e8s),
            fee: Some(Nat::from(ledger_fee_e8s)),
            memo: Some(memo),
            created_at_time: Some(created_at_time_ns),
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

fn transfer_from_error_outcome(error: TransferFromError) -> LedgerTransferFromOutcome {
    match error {
        TransferFromError::BadFee { expected_fee } => match nat_to_u64(&expected_fee) {
            Ok(expected_fee_e8s) => LedgerTransferFromOutcome::BadFee { expected_fee_e8s },
            Err(error) => LedgerTransferFromOutcome::Ambiguous(error),
        },
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

fn cycles_purchase_memo(operation_id: u64) -> Vec<u8> {
    format!("kvfs:cp:{operation_id}").into_bytes()
}

fn with_unmetered_update<T, F>(method: &str, database_id: Option<String>, f: F) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let _ = (method, database_id);
    let caller = caller_text();
    let now = now_millis();
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        f(service, &caller, now)
    })
}

fn with_role_metered_update<T, F>(
    method: &str,
    database_id: Option<String>,
    required_role: RequiredRole,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let authorization_database_id = database_id.clone();
    with_authorized_metered_update(
        method,
        database_id,
        |service, caller| {
            let database_id = authorization_database_id
                .as_deref()
                .ok_or_else(|| "database_id is required for role metering".to_string())?;
            service.prepare_metered_update(database_id, caller, required_role)
        },
        f,
    )
}

fn with_role_unmetered_update<T, F>(
    method: &str,
    database_id: Option<String>,
    required_role: RequiredRole,
    f: F,
) -> Result<T, String>
where
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let authorization_database_id = database_id.clone();
    with_unmetered_update(method, database_id, |service, caller, now| {
        let database_id = authorization_database_id
            .as_deref()
            .ok_or_else(|| "database_id is required for role check".to_string())?;
        service.require_database_role(database_id, caller, required_role)?;
        f(service, caller, now)
    })
}

fn with_authorized_metered_update<T, A, F>(
    method: &str,
    database_id: Option<String>,
    authorize: A,
    f: F,
) -> Result<T, String>
where
    A: FnOnce(&VfsService, &str) -> Result<CyclesBillingConfig, String>,
    F: FnOnce(&VfsService, &str, i64) -> Result<T, String>,
{
    let caller = caller_text();
    let now = now_millis();
    let before_charge_units = update_charge_units();
    SERVICE.with(|slot| {
        let borrowed = slot.borrow();
        let service = borrowed
            .as_ref()
            .ok_or_else(|| "wiki service is not initialized".to_string())?;
        let cycles_billing_config = authorize(service, &caller)?;
        let result = f(service, &caller, now);
        let after_charge_units = update_charge_units();
        if result.is_ok()
            && let Some(database_id) = database_id.as_deref()
        {
            let charge_result = update_charge_cycles(before_charge_units, after_charge_units)
                .and_then(|cycles_delta| {
                    service.charge_database_update(
                        &cycles_billing_config,
                        database_id,
                        &caller,
                        method,
                        cycles_delta,
                        now,
                    )
                });
            if let Err(error) = charge_result {
                ic_cdk::trap(format!("cycles charge failed after update: {error}"));
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

fn store_capabilities() -> Vec<StoreCapability> {
    [
        (
            "store_manifest",
            "Discover the four-store API shape, limits, and policy",
        ),
        (
            "memory_recall",
            "Primary memory-store entrypoint for task-scoped recall",
        ),
        (
            "knowledge_evidence",
            "Read source-path evidence for one knowledge node",
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
    ]
    .into_iter()
    .map(|(name, description)| StoreCapability {
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
        ("facts", "facts.md", "Settled stable facts and attributes"),
        ("events", "events.md", "Completed dated events"),
        (
            "plans",
            "plans.md",
            "Future, pending, and next-action items",
        ),
        (
            "preferences",
            "preferences.md",
            "Decision criteria, preferences, and choices",
        ),
        (
            "open_questions",
            "open_questions.md",
            "Unresolved questions, conflicts, and verification gaps",
        ),
        ("summary", "summary.md", "Human-facing recap, not evidence"),
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
            ii_alternative_origins_body().as_bytes().to_vec(),
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

fn ii_alternative_origins_body() -> &'static str {
    match option_env!("KINIC_VFS_LOCAL_II_ORIGINS") {
        Some("1") => II_LOCAL_DEV_ALTERNATIVE_ORIGINS_BODY,
        _ => II_PRODUCTION_ALTERNATIVE_ORIGINS_BODY,
    }
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
