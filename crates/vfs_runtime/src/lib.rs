// Where: crates/vfs_runtime/src/lib.rs
// What: Service orchestration for multiple SQLite-backed VFS databases.
// Why: One canister can host isolated databases while sharing one VFS store implementation.
mod accounts;
mod billing;
mod cycles;
mod databases;
#[cfg(any(test, debug_assertions))]
pub use databases::generated_database_id_for_test;
pub(crate) use databases::*;
mod index_schema;
pub(crate) use billing::{DatabaseLedgerInsert, insert_database_ledger};
mod market;
mod metrics;
mod publications;
#[cfg(any(test, debug_assertions))]
pub use publications::{
    fail_next_publication_detach_for_test, fail_next_publication_resolution_for_test,
    fail_next_publication_restore_for_test,
};
mod sessions;
pub(crate) use cycles::PendingCyclesLedgerDetails;
mod sqlite;
pub use market::{MarketPurchaseStart, MarketPurchaseValidation};

use std::collections::{BTreeMap, BTreeSet};
#[cfg(not(target_arch = "wasm32"))]
use std::fs::{create_dir_all, remove_file};
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};
#[cfg(any(test, debug_assertions))]
use std::sync::{LazyLock, Mutex};

use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
use candid::Principal;
#[cfg(target_arch = "wasm32")]
use ic_sqlite_vfs::{Db, DbError, DbHandle};
use sha2::{Digest, Sha256};
use vfs_store::{FsStore, validate_sql_json_select};
use vfs_types::{
    AppendNodeRequest, ChildNode, CyclesBillingConfig, CyclesBillingConfigUpdate,
    CyclesTopUpConfig, DatabaseCycleEntry, DatabaseCycleEntryPage, DatabaseCyclesPendingPurchase,
    DatabaseInfo, DatabaseMember, DatabaseMetadata, DatabaseRole, DatabaseStatus, DatabaseSummary,
    DeleteDatabaseRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GitObjectChunk, GitRepositorySnapshot, GlobNodeHit, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, IndexSqlJsonQueryResult,
    InitialFreeDatabaseGrantStatus, LinkEdge, ListChildrenRequest, ListDeletedNodesRequest,
    ListDeletedNodesResponse, ListGitObjectsRequest, ListGitObjectsResponse,
    ListNodeHistoryRequest, ListNodeHistoryResponse, ListNodesRequest, MarketCreateListingRequest,
    MarketEntitlement, MarketEntitlementPage, MarketListing, MarketListingDetail,
    MarketListingPage, MarketListingStatus, MarketListingView, MarketOrder, MarketOrderPage,
    MarketPurchasePreview, MarketPurchaseRequest, MarketUpdateListingRequest, MkdirNodeRequest,
    MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult,
    MutateNodesBatchRequest, Node, NodeContext, NodeContextRequest, NodeEntry, NodeKind,
    NodeMutation, NodeMutationError, NodeMutationResult, NodePublication, NodeVersion,
    OpsAnswerSessionCheckRequest, OpsAnswerSessionCheckResult, OpsAnswerSessionRequest,
    OutgoingLinksRequest, PublicNode, PublishNodeRequest, QueryContext, QueryContextRequest,
    ReadGitObjectChunkRequest, ReadNodeVersionRequest, RestoreNodeVersionRequest, SearchNodeHit,
    SearchNodePathsRequest, SearchNodesRequest, SourceCaptureTriggerSessionCheckRequest,
    SourceCaptureTriggerSessionRequest, SourceEvidence, SourceEvidenceRequest,
    SourceRunSessionCheckRequest, Status, StorageBillingBatchRequest, StorageBillingBatchResult,
    UpdateDatabaseMetadataRequest, WikiMetrics, WikiMetricsPoint, WriteNodeRequest,
    WriteNodeResult, WriteNodesRequest, WriteSourceForGenerationRequest,
    WriteSourceForGenerationResult, kinic_base_units_per_token,
};

const INDEX_SCHEMA_VERSION_INITIAL: &str = "database_index:001_initial";
const INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS: &str = "database_index:002_node_publications";
const INDEX_SCHEMA_VERSION_CURRENT: &str = "database_index:003_publication_mutation_recovery";
const INDEX_SCHEMA_VERSIONS: &[&str] = &[
    INDEX_SCHEMA_VERSION_INITIAL,
    INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS,
    INDEX_SCHEMA_VERSION_CURRENT,
];
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const WIKI_METRICS_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const WIKI_METRICS_SERIES_LIMIT_MAX: u32 = 7;
const SQL_JSON_SQL_BYTES_MAX: usize = 4_096;
const SQL_JSON_ROW_BYTES_MAX: usize = 256 * 1024;
const SQL_JSON_RESPONSE_BYTES_MAX: usize = 1024 * 1024;
const SQL_JSON_PROGRESS_OP_INTERVAL: i32 = 1_000;
const SQL_JSON_PROGRESS_CALLBACK_BUDGET: u32 = 200;
const INDEX_SQL_JSON_EXECUTION_BUDGET_EXCEEDED: &str = "index SQL execution budget exceeded";
const PENDING_DATABASE_MOUNT_ID: u16 = 0;
const DATABASE_SCHEMA_VERSION: &str = "vfs_store:current";
const MIN_DATABASE_MOUNT_ID: u16 = 11;
const MAX_DATABASE_MOUNT_ID: u16 = 32767;
const SOURCE_CAPTURE_TRIGGER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const OPS_ANSWER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const SOURCE_RUN_SESSION_TTL_MS: i64 = SOURCE_CAPTURE_TRIGGER_SESSION_TTL_MS;
const MAX_PENDING_DATABASES_PER_CALLER: i64 = 3;
const PENDING_DATABASE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_DATABASE_MEMBERS_PER_DATABASE: i64 = 32;
const GENERATED_DATABASE_ID_PREFIX: &str = "db_";
const GENERATED_DATABASE_ID_HASH_CHARS: usize = 12;
const FRESH_INDEX_SCHEMA_SQL: &str = include_str!("../migrations/index_db/fresh_index_schema.sql");
pub const DEFAULT_CYCLES_PER_KINIC: u64 = 234_500_000_000;
pub const DEFAULT_MIN_UPDATE_CYCLES: u64 = 1_000_000;
pub const DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL: &str = "xfug4-5qaaa-aaaak-afowa-cai";
pub const DEFAULT_CYCLES_TOP_UP_THRESHOLD: u128 = 2_000_000_000_000;
pub const INITIAL_FREE_DATABASE_GRANT_CYCLES: u64 = 10_000_000_000;
pub const STORAGE_BILLING_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
pub const STORAGE_CYCLES_PER_GIB_SECOND: u128 = 127_000;
const DEFAULT_STORAGE_BILLING_BATCH_LIMIT: u32 = 100;
const MAX_STORAGE_BILLING_BATCH_LIMIT: u32 = 1_000;
const TIMER_STORAGE_BILLING_BATCH_LIMIT: u32 = 1_000;
const STORAGE_BILLING_BULK_MIN_BATCH_LEN: usize = 50;
const GIB_BYTES: u128 = 1024 * 1024 * 1024;
const MAX_DATABASE_NAME_CHARS: usize = 80;
const MAX_DATABASE_DESCRIPTION_CHARS: usize = 4_000;
const MAX_DATABASE_JSON_CHARS: usize = 20_000;
pub const DEFAULT_LLM_WRITER_PRINCIPAL: &str =
    "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe";
const ANONYMOUS_PRINCIPAL: &str = "2vxsx-fae";
const CYCLES_OPERATION_STATUS_IN_FLIGHT: &str = "in_flight";
const CYCLES_OPERATION_STATUS_COMPLETED: &str = "completed";
const CYCLES_OPERATION_STATUS_AMBIGUOUS: &str = "ambiguous";
const MARKET_LISTING_STATUS_ACTIVE: &str = "active";
const MARKET_LISTING_STATUS_PAUSED: &str = "paused";

#[cfg(any(test, debug_assertions))]
static TEST_DATABASE_MIGRATION_FAIL_ONCE: LazyLock<Mutex<BTreeSet<String>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));

#[cfg(any(test, debug_assertions))]
pub fn fail_next_database_migration_for_test(database_id: &str) {
    TEST_DATABASE_MIGRATION_FAIL_ONCE
        .lock()
        .expect("test migration failure lock should not poison")
        .insert(database_id.to_string());
}

#[cfg(any(test, debug_assertions))]
static TEST_DISCARD_DATABASE_RESERVATION_FAIL_ONCE: LazyLock<Mutex<BTreeSet<String>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));

#[cfg(any(test, debug_assertions))]
pub fn fail_next_discard_database_reservation_for_test(database_id: &str) {
    TEST_DISCARD_DATABASE_RESERVATION_FAIL_ONCE
        .lock()
        .expect("test discard failure lock should not poison")
        .insert(database_id.to_string());
}

const MARKET_ENTITLEMENT_STATUS_ACTIVE: &str = "active";
const GENERATED_LISTING_ID_PREFIX: &str = "";
const GENERATED_ORDER_ID_PREFIX: &str = "order_";
const GENERATED_MARKET_ID_HASH_CHARS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseMeta {
    pub database_id: String,
    pub metadata: DatabaseMetadata,
    pub db_file_name: String,
    pub mount_id: u16,
    pub schema_version: String,
    pub logical_size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseCreateOutcome {
    pub meta: DatabaseMeta,
    pub status: DatabaseStatus,
    pub initial_free_grant_applied: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountDeletionOutcome {
    pub deleted_database_file_names: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequiredRole {
    Reader,
    Writer,
    Owner,
}

pub struct CyclesPendingLedgerDetailsInput<'a> {
    pub from_owner: &'a str,
    pub from_subaccount: Option<&'a [u8]>,
    pub to_owner: &'a str,
    pub to_subaccount: Option<&'a [u8]>,
    pub ledger_fee_e8s: u64,
    pub ledger_created_at_time_ns: u64,
}

pub struct DatabaseCyclesPurchaseWithLedgerDetails<'a> {
    pub database_id: &'a str,
    pub caller: &'a str,
    pub payment_amount_e8s: u64,
    pub min_expected_cycles: u64,
    pub ledger: CyclesPendingLedgerDetailsInput<'a>,
    pub now: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DatabaseCyclesPurchaseStart {
    pub operation_id: u64,
    pub amount_cycles: u64,
}

pub struct VfsService {
    #[cfg(not(target_arch = "wasm32"))]
    index_path: PathBuf,
    #[cfg(not(target_arch = "wasm32"))]
    databases_dir: PathBuf,
    #[cfg(target_arch = "wasm32")]
    database_handle: fn(u16) -> Result<DbHandle, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum IndexPostMigrationAction {
    None,
}

impl VfsService {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(index_path: PathBuf, databases_dir: PathBuf) -> Self {
        Self {
            index_path,
            databases_dir,
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn stable(database_handle: fn(u16) -> Result<DbHandle, String>) -> Self {
        Self { database_handle }
    }

    pub fn list_databases(&self) -> Result<Vec<DatabaseMeta>, String> {
        self.read_index(load_databases)
    }

    pub fn list_database_infos(&self) -> Result<Vec<DatabaseInfo>, String> {
        self.read_index(load_database_infos)
    }

    pub fn query_index_sql_json(
        &self,
        sql: &str,
        limit: u32,
    ) -> Result<IndexSqlJsonQueryResult, String> {
        validate_index_select_sql(sql)?;
        let limit = page_limit(limit);
        self.read_index(|conn| {
            let _progress_handler = crate::sqlite::install_progress_handler(
                conn,
                SQL_JSON_PROGRESS_OP_INTERVAL,
                SQL_JSON_PROGRESS_CALLBACK_BUDGET,
            );
            let mut json_object_stmt = conn
                .prepare("SELECT CASE WHEN json_valid(?1) THEN json_type(?1) = 'object' ELSE 0 END")
                .map_err(map_index_sql_json_execution_error)?;
            let mut stmt = conn
                .prepare(sql)
                .map_err(map_index_sql_json_execution_error)?;
            let mut total_bytes = 0_usize;
            let rows = crate::sqlite::query_try_map_limit(
                &mut stmt,
                params![],
                limit as usize,
                |row| -> std::result::Result<String, crate::sqlite::QueryTryMapError<String>> {
                    if crate::sqlite::row_has_column(row, 1)? {
                        return Err(crate::sqlite::invalid_query().into());
                    }
                    let value: Option<String> = crate::sqlite::row_get(row, 0)?;
                    let value = value.ok_or_else(crate::sqlite::invalid_query)?;
                    validate_sql_json_value_bytes("index SQL", &value, &mut total_bytes)
                        .map_err(crate::sqlite::QueryTryMapError::Validation)?;
                    let is_object: i64 = crate::sqlite::query_one(
                        &mut json_object_stmt,
                        params![value.as_str()],
                        |row| crate::sqlite::row_get(row, 0),
                    )?;
                    if is_object == 1 {
                        Ok(value)
                    } else {
                        Err(crate::sqlite::invalid_query().into())
                    }
                },
            )
            .map_err(map_index_sql_json_query_error)?;
            Ok(IndexSqlJsonQueryResult {
                row_count: rows.len() as u32,
                rows,
                limit,
            })
        })
    }

    pub fn query_database_sql_json(
        &self,
        database_id: &str,
        caller: &str,
        sql: &str,
        limit: u32,
    ) -> Result<IndexSqlJsonQueryResult, String> {
        self.with_market_read_database_store(database_id, caller, |store| {
            store.query_sql_json(sql, limit)
        })
    }

    pub fn list_database_summaries_for_caller(
        &self,
        caller: &str,
    ) -> Result<Vec<DatabaseSummary>, String> {
        self.read_index(|conn| load_database_summaries_for_caller(conn, caller))
    }

    pub fn cycles_billing_config(&self) -> Result<CyclesBillingConfig, String> {
        self.read_index(load_cycles_billing_config)
    }

    pub fn update_cycles_billing_config(
        &self,
        update: CyclesBillingConfigUpdate,
        caller: &str,
    ) -> Result<CyclesBillingConfig, String> {
        let current = self.cycles_billing_config()?;
        if caller != current.billing_authority_id {
            return Err("caller is not billing authority".to_string());
        }
        let next = CyclesBillingConfig {
            kinic_ledger_canister_id: current.kinic_ledger_canister_id,
            billing_authority_id: current.billing_authority_id,
            cycles_per_kinic: update.cycles_per_kinic,
            min_update_cycles: update.min_update_cycles,
            top_up: update.top_up,
        };
        validate_cycles_billing_config(&next)?;
        self.write_index(|tx| {
            set_cycles_billing_config_value(tx, "cycles_per_kinic", next.cycles_per_kinic)?;
            set_cycles_billing_config_value(tx, "min_update_cycles", next.min_update_cycles)?;
            set_cycles_top_up_config(tx, &next.top_up)?;
            Ok(())
        })?;
        Ok(next)
    }

    pub fn require_database_write_cycles_available(&self, database_id: &str) -> Result<(), String> {
        self.read_index(|conn| {
            let config = load_cycles_billing_config(conn)?;
            require_database_write_cycles_available_for_conn(conn, database_id, &config)
        })
    }

    pub fn prepare_metered_update(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
    ) -> Result<CyclesBillingConfig, String> {
        self.read_index(|conn| {
            let role = load_database_status(conn, database_id).and_then(|_| {
                load_member_role(conn, database_id, caller)?
                    .ok_or_else(|| format!("principal has no access to database: {database_id}"))
            })?;
            if !role_allows(role, required_role) {
                return Err(format!(
                    "principal lacks required database role: {database_id}"
                ));
            }
            let config = load_cycles_billing_config(conn)?;
            require_database_write_cycles_available_for_conn(conn, database_id, &config)?;
            Ok(config)
        })
    }

    pub fn prepare_node_mutation(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<CyclesBillingConfig, NodeMutationError> {
        self.require_role(database_id, caller, RequiredRole::Writer)
            .map_err(NodeMutationError::forbidden)?;
        let config = self
            .cycles_billing_config()
            .map_err(NodeMutationError::write_unavailable)?;
        self.require_database_write_cycles_available(database_id)
            .map_err(NodeMutationError::write_unavailable)?;
        Ok(config)
    }

    pub fn check_database_write_cycles(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<(), String> {
        if caller == ANONYMOUS_PRINCIPAL {
            return Err("anonymous caller not allowed".to_string());
        }
        self.require_role(database_id, caller, RequiredRole::Writer)?;
        self.require_database_write_cycles_available(database_id)
    }

    pub fn status(&self, database_id: &str, caller: &str) -> Result<Status, String> {
        self.with_database_store(database_id, caller, RequiredRole::Reader, |store| {
            store.status()
        })
    }

    pub fn read_node(
        &self,
        database_id: &str,
        caller: &str,
        path: &str,
    ) -> Result<Option<Node>, String> {
        self.with_market_read_database_store(database_id, caller, |store| store.read_node(path))
    }

    pub fn list_nodes(
        &self,
        caller: &str,
        request: ListNodesRequest,
    ) -> Result<Vec<NodeEntry>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.list_nodes(request)
        })
    }

    pub fn list_children(
        &self,
        caller: &str,
        request: ListChildrenRequest,
    ) -> Result<Vec<ChildNode>, String> {
        let database_id = request.database_id.clone();
        let parent_path = request.path.clone();
        let mut children = self.with_market_read_database_store(&database_id, caller, |store| {
            store.list_children(request)
        })?;
        let published_paths =
            self.member_visible_direct_node_publication_paths(&database_id, caller, &parent_path)?;
        for child in &mut children {
            child.is_published = published_paths.contains(&child.path);
        }
        Ok(children)
    }

    pub fn list_node_history(
        &self,
        caller: &str,
        request: ListNodeHistoryRequest,
    ) -> Result<ListNodeHistoryResponse, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.list_node_history(request)
        })
    }

    pub fn read_node_version(
        &self,
        caller: &str,
        request: ReadNodeVersionRequest,
    ) -> Result<Option<NodeVersion>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.read_node_version(request)
        })
    }

    pub fn list_deleted_nodes(
        &self,
        caller: &str,
        request: ListDeletedNodesRequest,
    ) -> Result<ListDeletedNodesResponse, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.list_deleted_nodes(request)
        })
    }

    pub fn git_repository_snapshot(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<GitRepositorySnapshot, String> {
        self.with_database_store(database_id, caller, RequiredRole::Reader, |store| {
            store.git_repository_snapshot()
        })
    }

    pub fn list_git_objects(
        &self,
        caller: &str,
        request: ListGitObjectsRequest,
    ) -> Result<ListGitObjectsResponse, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.list_git_objects(request)
        })
    }

    pub fn read_git_object_chunk(
        &self,
        caller: &str,
        request: ReadGitObjectChunkRequest,
    ) -> Result<Option<GitObjectChunk>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.read_git_object_chunk(request)
        })
    }

    pub fn restore_node_version(
        &self,
        caller: &str,
        request: RestoreNodeVersionRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        self.require_role(&database_id, caller, RequiredRole::Writer)
            .map_err(NodeMutationError::forbidden)?;
        let meta = self
            .database_meta(&database_id)
            .map_err(NodeMutationError::write_unavailable)?;
        let store = self
            .database_store(&meta)
            .map_err(NodeMutationError::write_unavailable)?;
        let selected_path = store
            .read_node_version(ReadNodeVersionRequest {
                database_id: database_id.clone(),
                page_id: request.page_id,
                version_id: request.version_id,
            })
            .map_err(NodeMutationError::write_unavailable)?
            .map(|value| value.summary.path);
        let live_path = store
            .node_history_live_path(request.page_id)
            .map_err(NodeMutationError::write_unavailable)?;
        let selected_path = selected_path.ok_or_else(|| {
            NodeMutationError::not_found_with_path(
                format!("history version does not exist: {}", request.version_id),
                request.page_id.to_string(),
            )
        })?;
        let mutation_path = live_path.unwrap_or(selected_path);
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &[mutation_path.as_str()],
            |store, operation_id| store.restore_node_version_as(request, now, operation_id, caller),
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn write_node(
        &self,
        caller: &str,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let publication_paths = if request.kind == NodeKind::Source {
            vec![request.path.clone()]
        } else {
            Vec::new()
        };
        let publication_path_refs = publication_paths
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &publication_path_refs,
            |store, operation_id| {
                store.write_node_with_publication_commit_as(request, now, operation_id, caller)
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn write_source_for_generation(
        &self,
        caller: &str,
        request: WriteSourceForGenerationRequest,
        now: i64,
    ) -> Result<WriteSourceForGenerationResult, NodeMutationError> {
        if caller == ANONYMOUS_PRINCIPAL {
            return Err(NodeMutationError::forbidden("anonymous caller not allowed"));
        }
        sessions::validate_source_for_generation_request(&request)
            .map_err(NodeMutationError::invalid_operation)?;
        self.require_role(&request.database_id, caller, RequiredRole::Writer)
            .map_err(NodeMutationError::forbidden)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| {
            NodeMutationError::forbidden(format!(
                "LLM writer principal lacks writer access: {error}"
            ))
        })?;

        let database_id = request.database_id.clone();
        let session_nonce = request.session_nonce.clone();
        let path = request.path.clone();
        let write_request = WriteNodeRequest {
            database_id: request.database_id,
            path: request.path,
            kind: NodeKind::Source,
            content: request.content,
            metadata_json: request.metadata_json,
            expected_etag: request.expected_etag,
        };
        let write = self.with_detached_node_publications(
            &database_id,
            caller,
            &[path.as_str()],
            |store, operation_id| {
                store.write_node_with_publication_commit_as(
                    write_request,
                    now,
                    operation_id,
                    caller,
                )
            },
        )?;
        let _ = self.write_source_run_session(
            &database_id,
            &path,
            &write.node.etag,
            &session_nonce,
            caller,
            now,
        );
        let _ = self.refresh_logical_size(&database_id);
        Ok(WriteSourceForGenerationResult {
            write,
            session_nonce,
        })
    }

    pub fn write_nodes(
        &self,
        caller: &str,
        request: WriteNodesRequest,
        now: i64,
    ) -> Result<Vec<WriteNodeResult>, NodeMutationError> {
        let database_id = request.database_id.clone();
        let publication_paths = request
            .nodes
            .iter()
            .filter(|item| item.kind == NodeKind::Source)
            .map(|item| item.path.clone())
            .collect::<BTreeSet<_>>();
        let publication_path_refs = publication_paths
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &publication_path_refs,
            |store, operation_id| {
                store.write_nodes_with_publication_commit_as(request, now, operation_id, caller)
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn mutate_nodes_batch(
        &self,
        caller: &str,
        request: MutateNodesBatchRequest,
        now: i64,
    ) -> Result<Vec<NodeMutationResult>, NodeMutationError> {
        let database_id = request.database_id.clone();
        let publication_paths = mutation_publication_paths(&request.operations);
        let publication_path_refs = publication_paths
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &publication_path_refs,
            |store, operation_id| {
                store.mutate_nodes_batch_with_publication_commit_as(
                    request,
                    now,
                    operation_id,
                    caller,
                )
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn delete_node(
        &self,
        caller: &str,
        request: DeleteNodeRequest,
        now: i64,
    ) -> Result<DeleteNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let path = request.path.clone();
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &[path.as_str()],
            |store, operation_id| {
                store.delete_node_with_publication_commit_as(request, now, operation_id, caller)
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn append_node(
        &self,
        caller: &str,
        request: AppendNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let result = self.with_node_mutation_store(&database_id, caller, |store| {
            store.append_node_as(request, now, caller)
        });
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn edit_node(
        &self,
        caller: &str,
        request: EditNodeRequest,
        now: i64,
    ) -> Result<EditNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let result = self.with_node_mutation_store(&database_id, caller, |store| {
            store.edit_node_as(request, now, caller)
        });
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn mkdir_node(
        &self,
        caller: &str,
        request: MkdirNodeRequest,
        now: i64,
    ) -> Result<MkdirNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let result = self.with_node_mutation_store(&database_id, caller, |store| {
            store.mkdir_node_as(request, now, caller)
        });
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn move_node(
        &self,
        caller: &str,
        request: MoveNodeRequest,
        now: i64,
    ) -> Result<MoveNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let from_path = request.from_path.clone();
        let to_path = request.to_path.clone();
        let result = self.with_detached_node_publications(
            &database_id,
            caller,
            &[from_path.as_str(), to_path.as_str()],
            |store, operation_id| {
                store.move_node_with_publication_commit_as(request, now, operation_id, caller)
            },
        );
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn glob_nodes(
        &self,
        caller: &str,
        request: GlobNodesRequest,
    ) -> Result<Vec<GlobNodeHit>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.glob_nodes(request)
        })
    }

    pub fn incoming_links(
        &self,
        caller: &str,
        request: IncomingLinksRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.incoming_links(request)
        })
    }

    pub fn outgoing_links(
        &self,
        caller: &str,
        request: OutgoingLinksRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.outgoing_links(request)
        })
    }

    pub fn graph_links(
        &self,
        caller: &str,
        request: GraphLinksRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.graph_links(request)
        })
    }

    pub fn graph_neighborhood(
        &self,
        caller: &str,
        request: GraphNeighborhoodRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.graph_neighborhood(request)
        })
    }

    pub fn read_node_context(
        &self,
        caller: &str,
        request: NodeContextRequest,
    ) -> Result<Option<NodeContext>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.read_node_context(request)
        })
    }

    pub fn query_context(
        &self,
        caller: &str,
        mut request: QueryContextRequest,
    ) -> Result<QueryContext, String> {
        let database_id = request.database_id.clone();
        self.require_role(&database_id, caller, RequiredRole::Reader)?;
        let meta = self.database_meta(&database_id)?;
        if request.namespace.is_none() {
            request.namespace = Some("/Memory".to_string());
        }
        let store = self.database_store(&meta)?;
        store.query_context(request)
    }

    pub fn source_evidence(
        &self,
        caller: &str,
        request: SourceEvidenceRequest,
    ) -> Result<SourceEvidence, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.source_evidence(request)
        })
    }

    pub fn multi_edit_node(
        &self,
        caller: &str,
        request: MultiEditNodeRequest,
        now: i64,
    ) -> Result<MultiEditNodeResult, NodeMutationError> {
        let database_id = request.database_id.clone();
        let result = self.with_node_mutation_store(&database_id, caller, |store| {
            store.multi_edit_node_as(request, now, caller)
        });
        if result.is_ok() {
            let _ = self.refresh_logical_size(&database_id);
        }
        result
    }

    pub fn search_nodes(
        &self,
        caller: &str,
        request: SearchNodesRequest,
    ) -> Result<Vec<SearchNodeHit>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.search_nodes(request)
        })
    }

    pub fn search_node_paths(
        &self,
        caller: &str,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>, String> {
        let database_id = request.database_id.clone();
        self.with_market_read_database_store(&database_id, caller, |store| {
            store.search_node_paths(request)
        })
    }

    pub fn export_fs_snapshot(
        &self,
        caller: &str,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.export_snapshot(request)
        })
    }

    pub fn fetch_fs_updates(
        &self,
        caller: &str,
        request: FetchUpdatesRequest,
    ) -> Result<FetchUpdatesResponse, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.fetch_updates(request)
        })
    }

    fn with_database_store<T>(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
        f: impl FnOnce(&FsStore) -> Result<T, String>,
    ) -> Result<T, String> {
        self.require_role(database_id, caller, required_role)?;
        let meta = self.database_meta(database_id)?;
        let store = self.database_store(&meta)?;
        f(&store)
    }

    fn with_node_mutation_store<T>(
        &self,
        database_id: &str,
        caller: &str,
        f: impl FnOnce(&FsStore) -> Result<T, NodeMutationError>,
    ) -> Result<T, NodeMutationError> {
        self.require_role(database_id, caller, RequiredRole::Writer)
            .map_err(NodeMutationError::forbidden)?;
        let meta = self
            .database_meta(database_id)
            .map_err(NodeMutationError::write_unavailable)?;
        let store = self
            .database_store(&meta)
            .map_err(NodeMutationError::write_unavailable)?;
        f(&store)
    }

    fn with_detached_node_publications<T>(
        &self,
        database_id: &str,
        caller: &str,
        paths: &[&str],
        f: impl FnOnce(&FsStore, Option<i64>) -> Result<T, NodeMutationError>,
    ) -> Result<T, NodeMutationError> {
        self.require_role(database_id, caller, RequiredRole::Writer)
            .map_err(NodeMutationError::forbidden)?;
        let meta = self
            .database_meta(database_id)
            .map_err(NodeMutationError::write_unavailable)?;
        let store = self
            .database_store(&meta)
            .map_err(NodeMutationError::write_unavailable)?;
        self.recover_pending_publication_mutations()
            .map_err(NodeMutationError::write_unavailable)?;
        if paths.is_empty() {
            return f(&store, None);
        }
        let detached = self
            .detach_node_publications_for_paths(database_id, paths)
            .map_err(NodeMutationError::write_unavailable)?;
        match f(&store, detached.operation_id) {
            Ok(value) => {
                if let Err(_error) = self.resolve_detached_node_publications(&detached, false) {
                    #[cfg(target_arch = "wasm32")]
                    panic!(
                        "node mutation committed but publication recovery finalization failed: {_error}"
                    );
                    #[cfg(not(target_arch = "wasm32"))]
                    return Ok(value);
                }
                if let Some(operation_id) = detached.operation_id {
                    let _ = store.clear_publication_mutation_commit(operation_id);
                }
                Ok(value)
            }
            Err(mutation_error) => {
                if let Err(restore_error) = self.resolve_detached_node_publications(&detached, true)
                {
                    #[cfg(target_arch = "wasm32")]
                    panic!(
                        "node mutation failed and publication restore failed: {mutation_error}; {restore_error}"
                    );
                    #[cfg(not(target_arch = "wasm32"))]
                    {
                        let mut error = NodeMutationError::write_unavailable(format!(
                            "{mutation_error}; publication restore is pending durable recovery: {restore_error}"
                        ));
                        error.failed_index = mutation_error.failed_index;
                        error.conflict_path = mutation_error.conflict_path;
                        return Err(error);
                    }
                }
                Err(mutation_error)
            }
        }
    }

    fn with_market_read_database_store<T>(
        &self,
        database_id: &str,
        caller: &str,
        f: impl FnOnce(&FsStore) -> Result<T, String>,
    ) -> Result<T, String> {
        self.require_market_read_access(database_id, caller)?;
        let meta = self.database_meta(database_id)?;
        let store = self.database_store(&meta)?;
        f(&store)
    }

    pub fn require_database_role(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, required_role)
    }

    fn require_role(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
    ) -> Result<(), String> {
        let role = self.read_index(|conn| {
            load_database_status(conn, database_id)?;
            load_member_role(conn, database_id, caller)?
                .ok_or_else(|| format!("principal has no access to database: {database_id}"))
        })?;
        if role_allows(role, required_role) {
            Ok(())
        } else {
            Err(format!(
                "principal lacks required database role: {database_id}"
            ))
        }
    }

    fn require_market_read_access(&self, database_id: &str, caller: &str) -> Result<(), String> {
        self.read_index(|conn| {
            load_database_status(conn, database_id)?;
            if let Some(role) = load_member_role(conn, database_id, caller)?
                && role_allows(role, RequiredRole::Reader)
            {
                return Ok(());
            }
            if market::has_active_market_entitlement(conn, database_id, caller)? {
                return Ok(());
            }
            Err(format!(
                "principal has no access to database: {database_id}"
            ))
        })
    }

    fn database_meta(&self, database_id: &str) -> Result<DatabaseMeta, String> {
        self.database_meta_with_statuses(database_id, &[DatabaseStatus::Active])
    }

    fn database_meta_with_statuses(
        &self,
        database_id: &str,
        statuses: &[DatabaseStatus],
    ) -> Result<DatabaseMeta, String> {
        self.read_index(|conn| {
            load_database_with_statuses(conn, database_id, statuses)?
                .ok_or_else(|| database_meta_error(conn, database_id))
        })
    }

    fn refresh_logical_size(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta(database_id)?;
        self.refresh_logical_size_for_meta(database_id, &meta)
    }

    fn refresh_logical_size_for_meta(
        &self,
        database_id: &str,
        meta: &DatabaseMeta,
    ) -> Result<(), String> {
        let size = self.database_size(meta)?;
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
             SET logical_size_bytes = ?2
             WHERE database_id = ?1",
                params![database_id, i64::try_from(size).unwrap_or(i64::MAX)],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    fn database_store(&self, meta: &DatabaseMeta) -> Result<FsStore, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            Ok(FsStore::new(PathBuf::from(&meta.db_file_name)))
        }
        #[cfg(target_arch = "wasm32")]
        {
            Ok(FsStore::stable((self.database_handle)(meta.mount_id)?))
        }
    }

    fn database_file_name(&self, _database_id: &str, _mount_id: u16) -> Result<String, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            database_file_name(&self.databases_dir, _database_id)
        }
        #[cfg(target_arch = "wasm32")]
        {
            Ok(format!("stable-db-{_mount_id}"))
        }
    }

    fn database_size(&self, meta: &DatabaseMeta) -> Result<u64, String> {
        self.database_store(meta)?.logical_size_bytes()
    }

    fn read_index<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let conn = self.open_index()?;
            f(&conn)
        }
        #[cfg(target_arch = "wasm32")]
        {
            Db::query(|conn| f(conn).map_err(|error| DbError::Sqlite(1, error)))
                .map_err(|error| error.to_string())
        }
    }

    fn write_index<T>(
        &self,
        f: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open_index()?;
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            let value = f(&tx)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(value)
        }
        #[cfg(target_arch = "wasm32")]
        {
            Db::update(|tx| f(tx).map_err(|error| DbError::Sqlite(1, error)))
                .map_err(|error| error.to_string())
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn open_index(&self) -> Result<Connection, String> {
        Connection::open(&self.index_path).map_err(|error| error.to_string())
    }
}

fn mutation_publication_paths(operations: &[NodeMutation]) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    for operation in operations {
        match operation {
            NodeMutation::Write(item) if item.kind == NodeKind::Source => {
                paths.insert(item.path.clone());
            }
            NodeMutation::Move(item) => {
                paths.insert(item.from_path.clone());
                paths.insert(item.to_path.clone());
            }
            NodeMutation::Delete(item) => {
                paths.insert(item.path.clone());
            }
            _ => {}
        }
    }
    paths
}

fn default_cycles_billing_config() -> CyclesBillingConfig {
    CyclesBillingConfig {
        kinic_ledger_canister_id: "aaaaa-aa".to_string(),
        billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
        cycles_per_kinic: DEFAULT_CYCLES_PER_KINIC,
        min_update_cycles: DEFAULT_MIN_UPDATE_CYCLES,
        top_up: default_cycles_top_up_config(),
    }
}

fn validate_cycles_billing_config(config: &CyclesBillingConfig) -> Result<(), String> {
    validate_principal_text(&config.kinic_ledger_canister_id)?;
    validate_principal_text(&config.billing_authority_id)?;
    validate_cycles_top_up_config(&config.top_up)?;
    if config.cycles_per_kinic == 0 {
        return Err("cycles_per_kinic must be positive".to_string());
    }
    if config.min_update_cycles == 0 {
        return Err("min_update_cycles must be positive".to_string());
    }
    amount_to_i64(config.cycles_per_kinic)?;
    amount_to_i64(config.min_update_cycles)?;
    Ok(())
}

fn default_cycles_top_up_config() -> CyclesTopUpConfig {
    CyclesTopUpConfig {
        enabled: true,
        launcher_principal: DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL.to_string(),
        threshold_cycles: DEFAULT_CYCLES_TOP_UP_THRESHOLD,
    }
}

fn validate_cycles_top_up_config(config: &CyclesTopUpConfig) -> Result<(), String> {
    validate_principal_text(&config.launcher_principal)?;
    if config.threshold_cycles == 0 {
        return Err("top_up.threshold_cycles must be positive".to_string());
    }
    Ok(())
}

fn validate_principal_text(value: &str) -> Result<(), String> {
    let principal = Principal::from_text(value)
        .map_err(|error| format!("principal text is invalid: {error}"))?;
    if principal == Principal::anonymous() {
        return Err("principal must not be anonymous".to_string());
    }
    Ok(())
}

fn insert_cycles_billing_config(
    conn: &Transaction<'_>,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cycles_billing_config (key, value) VALUES (?1, ?2)",
        params!["kinic_ledger_canister_id", config.kinic_ledger_canister_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO cycles_billing_config (key, value) VALUES (?1, ?2)",
        params!["billing_authority_id", config.billing_authority_id],
    )
    .map_err(|error| error.to_string())?;
    set_cycles_billing_config_value(conn, "cycles_per_kinic", config.cycles_per_kinic)?;
    set_cycles_billing_config_value(conn, "min_update_cycles", config.min_update_cycles)?;
    set_cycles_top_up_config(conn, &config.top_up)?;
    Ok(())
}

fn set_cycles_top_up_config(
    conn: &Transaction<'_>,
    config: &CyclesTopUpConfig,
) -> Result<(), String> {
    set_cycles_billing_config_bool(conn, "top_up_enabled", config.enabled)?;
    set_cycles_billing_config_text(
        conn,
        "top_up_launcher_principal",
        &config.launcher_principal,
    )?;
    set_cycles_billing_config_u128(conn, "top_up_threshold_cycles", config.threshold_cycles)
}

fn set_cycles_billing_config_text(
    conn: &Transaction<'_>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cycles_billing_config (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn set_cycles_billing_config_bool(
    conn: &Transaction<'_>,
    key: &str,
    value: bool,
) -> Result<(), String> {
    set_cycles_billing_config_text(conn, key, if value { "true" } else { "false" })
}

fn set_cycles_billing_config_u128(
    conn: &Transaction<'_>,
    key: &str,
    value: u128,
) -> Result<(), String> {
    set_cycles_billing_config_text(conn, key, &value.to_string())
}

fn set_cycles_billing_config_value(
    conn: &Transaction<'_>,
    key: &str,
    value: u64,
) -> Result<(), String> {
    set_cycles_billing_config_text(conn, key, &value.to_string())
}

const INDEX_SCHEMA_TABLES: &[&str] = &[
    "databases",
    "database_members",
    "database_mount_history",
    "source_capture_trigger_sessions",
    "ops_answer_sessions",
    "source_run_sessions",
    "database_cycle_accounts",
    "database_cycle_ledger",
    "database_free_cycle_grants",
    "database_cycle_pending_operations",
    "cycles_billing_config",
    "storage_billing_state",
    "market_listings",
    "market_orders",
    "market_purchase_pending_operations",
    "market_entitlements",
    "node_publications",
    "publication_mutation_recovery_batches",
    "publication_mutation_recovery_items",
];

fn load_cycles_billing_config(conn: &Connection) -> Result<CyclesBillingConfig, String> {
    Ok(CyclesBillingConfig {
        kinic_ledger_canister_id: load_cycles_billing_config_text(
            conn,
            "kinic_ledger_canister_id",
        )?,
        billing_authority_id: load_cycles_billing_config_text(conn, "billing_authority_id")?,
        cycles_per_kinic: load_cycles_billing_config_u64(conn, "cycles_per_kinic")?,
        min_update_cycles: load_cycles_billing_config_u64(conn, "min_update_cycles")?,
        top_up: CyclesTopUpConfig {
            enabled: load_cycles_billing_config_bool(conn, "top_up_enabled")?,
            launcher_principal: load_cycles_billing_config_text(conn, "top_up_launcher_principal")?,
            threshold_cycles: load_cycles_billing_config_u128(conn, "top_up_threshold_cycles")?,
        },
    })
}

fn load_cycles_billing_config_text(conn: &Connection, key: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT value FROM cycles_billing_config WHERE key = ?1",
        params![key],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn load_cycles_billing_config_u64(conn: &Connection, key: &str) -> Result<u64, String> {
    let value = load_cycles_billing_config_text(conn, key)?;
    value.parse::<u64>().map_err(|error| error.to_string())
}

fn load_cycles_billing_config_u128(conn: &Connection, key: &str) -> Result<u128, String> {
    let value = load_cycles_billing_config_text(conn, key)?;
    value.parse::<u128>().map_err(|error| error.to_string())
}

fn load_cycles_billing_config_bool(conn: &Connection, key: &str) -> Result<bool, String> {
    let value = load_cycles_billing_config_text(conn, key)?;
    match value.as_str() {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("{key} must be true or false")),
    }
}

fn validate_index_select_sql(sql: &str) -> Result<(), String> {
    if sql.len() > SQL_JSON_SQL_BYTES_MAX {
        return Err(format!(
            "index SQL must be at most {SQL_JSON_SQL_BYTES_MAX} bytes"
        ));
    }
    validate_sql_json_select(sql, "index SQL")
}

fn validate_sql_json_value_bytes(
    label: &str,
    value: &str,
    total: &mut usize,
) -> Result<(), String> {
    if value.len() > SQL_JSON_ROW_BYTES_MAX {
        return Err(format!(
            "{label} row JSON exceeds {SQL_JSON_ROW_BYTES_MAX} bytes"
        ));
    }
    *total = total.saturating_add(value.len());
    if *total > SQL_JSON_RESPONSE_BYTES_MAX {
        return Err(format!(
            "{label} response JSON exceeds {SQL_JSON_RESPONSE_BYTES_MAX} bytes"
        ));
    }
    Ok(())
}

fn map_index_sql_json_execution_error(error: crate::sqlite::Error) -> String {
    if crate::sqlite::is_interrupted(&error) {
        INDEX_SQL_JSON_EXECUTION_BUDGET_EXCEEDED.to_string()
    } else {
        error.to_string()
    }
}

fn map_index_sql_json_query_error(error: crate::sqlite::QueryTryMapError<String>) -> String {
    let error = match error {
        crate::sqlite::QueryTryMapError::Sqlite(error) => error,
        crate::sqlite::QueryTryMapError::Validation(error) => return error,
    };
    if crate::sqlite::is_interrupted(&error) {
        return INDEX_SQL_JSON_EXECUTION_BUDGET_EXCEEDED.to_string();
    }
    format!("index SQL must return exactly one non-null valid JSON object TEXT column: {error}")
}

fn amount_to_i64(amount: u64) -> Result<i64, String> {
    i64::try_from(amount).map_err(|_| "amount exceeds i64 limit".to_string())
}

fn cycles_to_i64(cycles: u64) -> Result<i64, String> {
    let cycles = i64::try_from(cycles).map_err(|_| "cycles exceeds i64 limit".to_string())?;
    if cycles <= 0 {
        return Err("cycles purchase cycles must be positive".to_string());
    }
    Ok(cycles)
}

pub fn cycles_for_payment_amount_e8s(
    payment_amount_e8s: u64,
    config: &CyclesBillingConfig,
) -> Result<u64, String> {
    if payment_amount_e8s == 0 {
        return Err("cycles purchase payment amount must be positive".to_string());
    }
    if config.cycles_per_kinic == 0 {
        return Err("cycles_per_kinic must be positive".to_string());
    }
    let cycles = u128::from(payment_amount_e8s)
        .checked_mul(u128::from(config.cycles_per_kinic))
        .ok_or_else(|| "cycles purchase amount overflow".to_string())?
        / u128::from(kinic_base_units_per_token());
    let cycles =
        u64::try_from(cycles).map_err(|_| "cycles purchase amount exceeds u64".to_string())?;
    if cycles == 0 {
        return Err("cycles purchase amount is too small".to_string());
    }
    Ok(cycles)
}

fn validate_cycles_purchase_minimum(
    amount_cycles: u64,
    min_expected_cycles: u64,
) -> Result<(), String> {
    if amount_cycles < min_expected_cycles {
        return Err(format!(
            "cycles purchase quote changed: amount_cycles {amount_cycles} is below min_expected_cycles {min_expected_cycles}"
        ));
    }
    Ok(())
}

fn millis_to_nanos(value: i64) -> Result<u64, String> {
    let value = u64::try_from(value).map_err(|_| "timestamp must be non-negative".to_string())?;
    value
        .checked_mul(1_000_000)
        .ok_or_else(|| "timestamp overflows nanoseconds".to_string())
}

fn checked_balance_add(balance: i64, amount: i64) -> Result<i64, String> {
    let next = balance
        .checked_add(amount)
        .ok_or_else(|| "balance overflow".to_string())?;
    if next < 0 {
        return Err("balance cannot be negative".to_string());
    }
    Ok(next)
}

fn validate_database_cycles_purchase_for_conn(
    conn: &Connection,
    database_id: &str,
    cycles: i64,
) -> Result<(), String> {
    let status = load_database_status(conn, database_id)?;
    if !matches!(status, DatabaseStatus::Pending | DatabaseStatus::Active) {
        return Err(format!(
            "database is {}: {database_id}",
            status_to_db(status)
        ));
    }
    if !database_has_owner(conn, database_id)? {
        return Err(format!("database has no owner: {database_id}"));
    }
    let balance: i64 = conn
        .query_row(
            "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id = ?1",
            params![database_id],
            |row| crate::sqlite::row_get(row, 0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("database cycles account not found: {database_id}"))?;
    let pending_cycles_purchase: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(cycles), 0)
             FROM database_cycle_pending_operations
             WHERE database_id = ?1 AND kind = 'cycles_purchase'",
            params![database_id],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if status == DatabaseStatus::Pending && pending_cycles_purchase > 0 {
        return Err(format!("database activation is pending: {database_id}"));
    }
    let reserved = checked_balance_add(balance, pending_cycles_purchase)?;
    checked_balance_add(reserved, cycles)?;
    Ok(())
}

fn require_database_write_cycles_available_for_conn(
    conn: &Connection,
    database_id: &str,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    let (balance, suspended_at_ms): (i64, Option<i64>) = conn
        .query_row(
            "SELECT balance_cycles, suspended_at_ms
             FROM database_cycle_accounts
             WHERE database_id = ?1",
            params![database_id],
            |row| {
                Ok((
                    crate::sqlite::row_get(row, 0)?,
                    crate::sqlite::row_get(row, 1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("database cycles account not found: {database_id}"))?;
    if suspended_at_ms.is_some() {
        return Err(format!("database cycles are suspended: {database_id}"));
    }
    if balance < cycles_to_i64(config.min_update_cycles)? {
        return Err(format!("database cycles balance is too low: {database_id}"));
    }
    Ok(())
}

fn update_pending_operation_completed(
    conn: &Transaction<'_>,
    table: &str,
    operation_id: u64,
    ledger_block_index: i64,
) -> Result<(), String> {
    let sql = match table {
        "database_cycle_pending_operations" => {
            "UPDATE database_cycle_pending_operations
             SET operation_status = ?2,
                 ledger_block_index = ?3
             WHERE operation_id = ?1"
        }
        "market_purchase_pending_operations" => {
            "UPDATE market_purchase_pending_operations
             SET operation_status = ?2,
                 ledger_block_index = ?3
             WHERE operation_id = ?1"
        }
        _ => return Err(format!("unsupported pending operation table: {table}")),
    };
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.execute(
        sql,
        params![
            operation_id,
            CYCLES_OPERATION_STATUS_COMPLETED,
            ledger_block_index
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}
fn update_pending_operation_status(
    conn: &Transaction<'_>,
    table: &str,
    operation_id: u64,
    status: &str,
) -> Result<(), String> {
    let sql = match table {
        "database_cycle_pending_operations" => {
            "UPDATE database_cycle_pending_operations
             SET operation_status = ?2
             WHERE operation_id = ?1"
        }
        "market_purchase_pending_operations" => {
            "UPDATE market_purchase_pending_operations
             SET operation_status = ?2
             WHERE operation_id = ?1"
        }
        _ => return Err(format!("unsupported pending operation table: {table}")),
    };
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.execute(sql, params![operation_id, status])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests;
