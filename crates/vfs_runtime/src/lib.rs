// Where: crates/vfs_runtime/src/lib.rs
// What: Service orchestration for multiple SQLite-backed VFS databases.
// Why: One canister can host isolated databases while sharing one VFS store implementation.
mod sqlite;

use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::{File, OpenOptions, create_dir_all, remove_file};
#[cfg(not(target_arch = "wasm32"))]
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(not(target_arch = "wasm32"))]
use std::path::{Path, PathBuf};

use crate::sqlite::{Connection, OptionalExtension, Transaction, params};
use candid::Principal;
#[cfg(target_arch = "wasm32")]
use ic_sqlite_vfs::{Db, DbError, DbHandle};
use sha2::{Digest, Sha256};
use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, ChildNode, CyclesBillingConfig, CyclesBillingConfigUpdate,
    DatabaseArchiveInfo, DatabaseCycleEntry, DatabaseCycleEntryPage, DatabaseCyclesPendingPurchase,
    DatabaseInfo, DatabaseMember, DatabaseRole, DatabaseStatus, DatabaseSummary,
    DeleteDatabaseRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest,
    IncomingLinksRequest, IndexSqlJsonQueryResult, LinkEdge, ListChildrenRequest, ListNodesRequest,
    MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest,
    MultiEditNodeResult, Node, NodeContext, NodeContextRequest, NodeEntry, NodeKind,
    OpsAnswerSessionCheckRequest, OpsAnswerSessionCheckResult, OpsAnswerSessionRequest,
    OutgoingLinksRequest, QueryContext, QueryContextRequest, SearchNodeHit, SearchNodePathsRequest,
    SearchNodesRequest, SourceEvidence, SourceEvidenceRequest, SourceRunSessionCheckRequest,
    Status, StorageBillingBatchRequest, StorageBillingBatchResult,
    UrlIngestTriggerSessionCheckRequest, UrlIngestTriggerSessionRequest, WriteNodeRequest,
    WriteNodeResult, WriteNodesRequest, WriteSourceForGenerationRequest,
    WriteSourceForGenerationResult, kinic_base_units_per_token,
};
use wiki_domain::{RAW_SOURCES_PREFIX, validate_source_path_for_kind};

const INDEX_SCHEMA_VERSION_INITIAL: &str = "database_index:000_initial";
const INDEX_SCHEMA_VERSION_LIFECYCLE: &str = "database_index:001_lifecycle";
const INDEX_SCHEMA_VERSION_RESTORE_SIZE: &str = "database_index:002_restore_size";
const INDEX_SCHEMA_VERSION_RESTORE_CHUNKS: &str = "database_index:003_restore_chunks";
const INDEX_SCHEMA_VERSION_MOUNT_HISTORY: &str = "database_index:005_mount_history";
const INDEX_SCHEMA_VERSION_URL_INGEST_TRIGGER_SESSIONS: &str =
    "database_index:006_url_ingest_trigger_sessions";
const INDEX_SCHEMA_VERSION_OPS_ANSWER_SESSIONS: &str = "database_index:007_ops_answer_sessions";
const INDEX_SCHEMA_VERSION_RESTORE_SESSIONS: &str = "database_index:008_restore_sessions";
const INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES: &str = "database_index:009_restore_chunk_bytes";
const INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING: &str =
    "database_index:010_database_name_breaking";
const INDEX_SCHEMA_VERSION_SOURCE_RUN_SESSIONS: &str = "database_index:011_source_run_sessions";
const INDEX_SCHEMA_VERSION_BILLING_INITIAL: &str = "database_index:012_cycles_initial";
const INDEX_SCHEMA_VERSION_BILLING_PENDING: &str = "database_index:013_cycles_pending";
const INDEX_SCHEMA_VERSION_BILLING_LEDGER_BLOCK_INDEX: &str =
    "database_index:014_cycles_ledger_block_index";
const INDEX_SCHEMA_VERSION_BILLING_PENDING_LEDGER_DETAILS: &str =
    "database_index:015_cycles_pending_ledger_details";
const INDEX_SCHEMA_VERSION_ACTIVE_STATUS: &str = "database_index:016_active_status";
const INDEX_SCHEMA_VERSION_HARD_DELETE_DATABASES: &str = "database_index:017_hard_delete_databases";
const INDEX_SCHEMA_VERSION_CYCLES_LEDGER_ONLY: &str = "database_index:018_cycles_ledger_only";
const INDEX_SCHEMA_VERSION_FIXED_CYCLES_ACCOUNTING: &str =
    "database_index:019_fixed_cycles_accounting";
const INDEX_SCHEMA_VERSION_CYCLES_BILLING_CONFIG_VERSION: &str =
    "database_index:020_cycles_billing_config_version";
const INDEX_SCHEMA_VERSION_CYCLES_PENDING_OPERATION_STATUS: &str =
    "database_index:021_cycles_pending_operation_status";
const INDEX_SCHEMA_VERSION_CYCLES: &str = "database_index:022_cycles";
const INDEX_SCHEMA_VERSION_STORAGE_BILLING: &str = "database_index:023_storage_billing";
const INDEX_SCHEMA_VERSION_DIRECT_CYCLES: &str = concat!("database_index:024_", "direct_cycles");
const INDEX_SCHEMA_VERSION_CYCLES_PENDING_LEDGER_BLOCK_INDEX: &str =
    "database_index:025_cycles_pending_ledger_block_index";
const INDEX_SCHEMA_VERSION_STORAGE_BILLING_BATCH: &str = "database_index:026_storage_billing_batch";
const PENDING_DATABASE_MOUNT_ID: u16 = 0;
const DATABASE_SCHEMA_VERSION: &str = "vfs_store:current";
const MIN_DATABASE_MOUNT_ID: u16 = 11;
const MAX_DATABASE_MOUNT_ID: u16 = 32767;
pub const MAX_ARCHIVE_CHUNK_BYTES: u32 = 1024 * 1024;
pub const MAX_RESTORE_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_DATABASE_SIZE_BYTES: u64 = i64::MAX as u64;
const URL_INGEST_TRIGGER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const OPS_ANSWER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const SOURCE_RUN_SESSION_TTL_MS: i64 = URL_INGEST_TRIGGER_SESSION_TTL_MS;
const MAX_PENDING_DATABASES_PER_CALLER: i64 = 3;
const PENDING_DATABASE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_DATABASE_MEMBERS_PER_DATABASE: i64 = 32;
const SHA256_DIGEST_BYTES: usize = 32;
const GENERATED_DATABASE_ID_PREFIX: &str = "db_";
const GENERATED_DATABASE_ID_HASH_CHARS: usize = 12;
const FRESH_INDEX_SCHEMA_SQL: &str = include_str!("../migrations/index_db/fresh_index_schema.sql");
const INDEX_011_TO_LATEST_SQL: &str = include_str!("../migrations/index_db/011_to_latest.sql");
pub const DEFAULT_CYCLES_PER_KINIC: u64 = 234_500_000_000;
pub const DEFAULT_MIN_UPDATE_CYCLES: u64 = 1_000_000;
pub const STORAGE_BILLING_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
pub const STORAGE_CYCLES_PER_GIB_SECOND: u128 = 127_000;
const DEFAULT_STORAGE_BILLING_BATCH_LIMIT: u32 = 100;
const MAX_STORAGE_BILLING_BATCH_LIMIT: u32 = 1_000;
const TIMER_STORAGE_BILLING_BATCH_LIMIT: u32 = 1_000;
const STORAGE_BILLING_BULK_MIN_BATCH_LEN: usize = 50;
const GIB_BYTES: u128 = 1024 * 1024 * 1024;
const MAX_DATABASE_NAME_CHARS: usize = 80;
const FNV1A64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV1A64_PRIME: u64 = 0x0000_0100_0000_01b3;
pub const DEFAULT_LLM_WRITER_PRINCIPAL: &str =
    "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe";
const ANONYMOUS_PRINCIPAL: &str = "2vxsx-fae";
const CYCLES_OPERATION_STATUS_IN_FLIGHT: &str = "in_flight";
const CYCLES_OPERATION_STATUS_COMPLETED: &str = "completed";
const CYCLES_OPERATION_STATUS_AMBIGUOUS: &str = "ambiguous";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseMeta {
    pub database_id: String,
    pub name: String,
    pub db_file_name: String,
    pub mount_id: u16,
    pub schema_version: String,
    pub logical_size_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseRestoreBegin {
    pub meta: DatabaseMeta,
    pub rollback: DatabaseRestoreRollback,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseRestoreRollback {
    database_id: String,
    status: DatabaseStatus,
    active_mount_id: Option<u16>,
    snapshot_hash: Option<Vec<u8>>,
    archived_at_ms: Option<i64>,
    restore_size_bytes: Option<u64>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct RestoreChunk {
    offset: u64,
    end: u64,
    bytes: Vec<u8>,
}

pub struct VfsService {
    #[cfg(not(target_arch = "wasm32"))]
    index_path: PathBuf,
    #[cfg(not(target_arch = "wasm32"))]
    databases_dir: PathBuf,
    #[cfg(target_arch = "wasm32")]
    database_handle: fn(u16) -> Result<DbHandle, String>,
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

    pub fn run_index_migrations(&self) -> Result<(), String> {
        self.run_index_migrations_with_config(default_cycles_billing_config())
    }

    pub fn run_index_migrations_with_config(
        &self,
        config: CyclesBillingConfig,
    ) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open_index()?;
            run_index_migrations(&mut conn, &config)
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.write_index(|conn| run_index_migrations_in_tx(conn, &config))
        }
    }

    pub fn run_index_migrations_for_upgrade(
        &self,
        config: Option<CyclesBillingConfig>,
    ) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut conn = self.open_index()?;
            run_index_migrations_for_upgrade(&mut conn, config.as_ref())
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.write_index(|conn| run_index_migrations_in_tx_for_upgrade(conn, config.as_ref()))
        }
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
            let mut stmt = conn.prepare(sql).map_err(|error| error.to_string())?;
            let rows = crate::sqlite::query_map_limit(&mut stmt, params![], limit as usize, |row| {
                let value: Option<String> = crate::sqlite::row_get(row, 0)?;
                value.ok_or_else(crate::sqlite::invalid_query)
            })
            .map_err(|error| {
                format!(
                    "index SQL must return one non-null TEXT JSON column as the first column: {error}"
                )
            })?;
            Ok(IndexSqlJsonQueryResult {
                row_count: rows.len() as u32,
                rows,
                limit,
            })
        })
    }

    pub fn settle_database_storage_charges_batch(
        &self,
        caller: &str,
        request: StorageBillingBatchRequest,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let limit = storage_billing_batch_limit(request.limit);
        let cursor = request.cursor_mount_id.unwrap_or(0);
        let batch = self.read_index(|conn| {
            load_active_databases_for_storage_billing_batch(conn, cursor, limit)
        })?;
        self.settle_database_storage_billing_batch(caller, batch, now)
    }

    pub fn settle_database_storage_charges_timer_batch(
        &self,
        caller: &str,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let state = self.write_index(|tx| load_or_create_storage_billing_timer_state(tx, now))?;
        let batch = self.read_index(|conn| {
            load_active_databases_for_storage_billing_batch(
                conn,
                state.cursor_mount_id.unwrap_or(0),
                TIMER_STORAGE_BILLING_BATCH_LIMIT,
            )
        })?;
        let result =
            self.settle_database_storage_billing_batch(caller, batch, state.billing_now_ms)?;
        self.write_index(|tx| {
            if let Some(cursor) = result.next_cursor_mount_id {
                update_storage_billing_timer_state(tx, Some(cursor), state.billing_now_ms, now)?;
            } else {
                clear_storage_billing_timer_state(tx)?;
            }
            Ok(())
        })?;
        Ok(result)
    }

    fn settle_database_storage_billing_batch(
        &self,
        caller: &str,
        batch: StorageBillingDatabaseBatch,
        now: i64,
    ) -> Result<StorageBillingBatchResult, String> {
        let next_cursor_mount_id = batch.next_cursor_mount_id;
        let databases = batch.databases;
        self.write_index(|tx| {
            let config = load_cycles_billing_config(tx)?;
            if databases.len() < STORAGE_BILLING_BULK_MIN_BATCH_LEN {
                settle_database_storage_billing_loop_in_tx(
                    tx,
                    caller,
                    databases,
                    now,
                    &config,
                    next_cursor_mount_id,
                )
            } else {
                settle_database_storage_billing_bulk_in_tx(
                    tx,
                    caller,
                    databases,
                    now,
                    &config,
                    next_cursor_mount_id,
                )
            }
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
        };
        validate_cycles_billing_config(&next)?;
        self.write_index(|tx| {
            set_cycles_billing_config_value(tx, "cycles_per_kinic", next.cycles_per_kinic)?;
            set_cycles_billing_config_value(tx, "min_update_cycles", next.min_update_cycles)?;
            Ok(())
        })?;
        Ok(next)
    }

    pub fn create_database(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_database(database_id, database_id, caller, now)?;
        self.run_database_migrations(database_id)?;
        Ok(meta)
    }

    pub fn create_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_generated_database(name, caller, now)?;
        if let Err(error) = self.run_database_migrations(&meta.database_id) {
            let cleanup_error = self.discard_database_reservation(&meta.database_id).err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
                None => error,
            });
        }
        Ok(meta)
    }

    pub fn reserve_generated_database_for_mount(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.reserve_generated_database(name, caller, now)
    }

    pub fn reserve_pending_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let name = normalize_database_name(name)?;
        self.write_index(|tx| {
            purge_expired_unstarted_pending_databases(tx, caller, now)?;
            let pending_count = pending_database_count_for_caller(tx, caller)?;
            if pending_count >= MAX_PENDING_DATABASES_PER_CALLER {
                return Err("too many pending databases for caller".to_string());
            }
            let mut selected_database_id = None;
            for attempt in 0_u32..100 {
                let database_id =
                    generated_database_id(caller, now, PENDING_DATABASE_MOUNT_ID, attempt);
                if !database_exists(tx, &database_id)? {
                    selected_database_id = Some(database_id);
                    break;
                }
            }
            let database_id = selected_database_id
                .ok_or_else(|| "failed to generate unique database id".to_string())?;
            self.insert_pending_database_reservation(tx, &database_id, &name, caller, now)
        })
    }

    fn reserve_generated_database(
        &self,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let name = normalize_database_name(name)?;
        self.write_index(|tx| {
            let mount_id = allocate_mount_id(tx)?;
            let mut selected_database_id = None;
            for attempt in 0_u32..100 {
                let database_id = generated_database_id(caller, now, mount_id, attempt);
                if !database_exists(tx, &database_id)? {
                    selected_database_id = Some(database_id);
                    break;
                }
            }
            let database_id = selected_database_id
                .ok_or_else(|| "failed to generate unique database id".to_string())?;
            self.insert_database_reservation(tx, &database_id, &name, caller, now, mount_id, 0)
        })
    }

    pub fn reserve_database(
        &self,
        database_id: &str,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        validate_database_id(database_id)?;
        let name = normalize_database_name(name)?;
        self.write_index(|tx| {
            if database_exists(tx, database_id)? {
                return Err(format!("database already exists: {database_id}"));
            }
            let mount_id = allocate_mount_id(tx)?;
            self.insert_database_reservation(tx, database_id, &name, caller, now, mount_id, 0)
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_database_reservation(
        &self,
        tx: &Transaction<'_>,
        database_id: &str,
        name: &str,
        caller: &str,
        now: i64,
        mount_id: u16,
        initial_cycles_balance: i64,
    ) -> Result<DatabaseMeta, String> {
        let db_file_name = self.database_file_name(database_id, mount_id)?;
        tx.execute(
            "INSERT INTO databases
             (database_id, name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, 'active', ?5, 0, ?6, ?6)",
            params![
                database_id,
                name,
                db_file_name,
                i64::from(mount_id),
                DATABASE_SCHEMA_VERSION,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        record_mount_history(tx, database_id, mount_id, "create", now)?;
        insert_initial_database_members(tx, database_id, caller, now)?;
        let suspended_at_ms = if initial_cycles_balance == 0 {
            Some(now)
        } else {
            None
        };
        tx.execute(
            "INSERT INTO database_cycle_accounts
             (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
              created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
            params![
                database_id,
                initial_cycles_balance,
                crate::sqlite::nullable_integer_value(suspended_at_ms),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id: database_id.to_string(),
            name: name.to_string(),
            db_file_name,
            mount_id,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    fn insert_pending_database_reservation(
        &self,
        tx: &Transaction<'_>,
        database_id: &str,
        name: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        tx.execute(
            "INSERT INTO databases
             (database_id, name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, '', ?3, NULL, 'pending', ?4, 0, ?5, ?5)",
            params![
                database_id,
                name,
                i64::from(PENDING_DATABASE_MOUNT_ID),
                DATABASE_SCHEMA_VERSION,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        insert_initial_database_members(tx, database_id, caller, now)?;
        tx.execute(
            "INSERT INTO database_cycle_accounts
             (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
              created_at_ms, updated_at_ms)
             VALUES (?1, 0, ?2, NULL, ?2, ?2)",
            params![database_id, now],
        )
        .map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id: database_id.to_string(),
            name: name.to_string(),
            db_file_name: String::new(),
            mount_id: PENDING_DATABASE_MOUNT_ID,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    pub fn discard_database_reservation(&self, database_id: &str) -> Result<(), String> {
        let db_file_name = self.write_index(|tx| {
            let db_file_name: Option<String> = tx
                .query_row(
                    "SELECT db_file_name
                 FROM databases
                 WHERE database_id = ?1",
                    params![database_id],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_ledger WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_pending_operations WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_cycle_accounts WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_members WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_restore_chunks WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_mount_history WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM databases WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            Ok(db_file_name)
        })?;
        #[cfg(target_arch = "wasm32")]
        let _ = &db_file_name;
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(db_file_name) = db_file_name
            && let Err(error) = remove_file(&db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn activate_pending_database_for_cycles_purchase(
        &self,
        database_id: &str,
        now: i64,
    ) -> Result<Option<DatabaseMeta>, String> {
        self.write_index(|tx| {
            let status = load_database_status(tx, database_id)?;
            if status != DatabaseStatus::Pending {
                return Ok(None);
            }
            let active_mount_id: Option<i64> = tx
                .query_row(
                    "SELECT active_mount_id FROM databases WHERE database_id = ?1",
                    params![database_id],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .map_err(|error| error.to_string())?;
            if active_mount_id.is_some() {
                return load_database_with_statuses(tx, database_id, &[DatabaseStatus::Pending]);
            }
            let mount_id = allocate_mount_id(tx)?;
            let db_file_name = self.database_file_name(database_id, mount_id)?;
            record_mount_history(tx, database_id, mount_id, "activate", now)?;
            tx.execute(
                "UPDATE databases
                 SET db_file_name = ?2,
                     mount_id = ?3,
                     active_mount_id = ?3,
                     updated_at_ms = ?4
                 WHERE database_id = ?1 AND status = 'pending'",
                params![database_id, db_file_name, i64::from(mount_id), now],
            )
            .map_err(|error| error.to_string())?;
            load_database_with_statuses(tx, database_id, &[DatabaseStatus::Pending])
        })
    }

    pub fn validate_database_cycles_purchase(
        &self,
        database_id: &str,
        payment_amount_e8s: u64,
    ) -> Result<(), String> {
        self.validate_database_cycles_purchase_with_minimum(database_id, payment_amount_e8s, 0)
    }

    pub fn validate_database_cycles_purchase_with_minimum(
        &self,
        database_id: &str,
        payment_amount_e8s: u64,
        min_expected_cycles: u64,
    ) -> Result<(), String> {
        amount_to_i64(payment_amount_e8s)?;
        self.read_index(|conn| {
            let config = load_cycles_billing_config(conn)?;
            let cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
            validate_cycles_purchase_minimum(cycles, min_expected_cycles)?;
            let cycles_i64 = cycles_to_i64(cycles)?;
            validate_database_cycles_purchase_for_conn(conn, database_id, cycles_i64)
        })
    }

    pub fn begin_database_cycles_purchase(
        &self,
        database_id: &str,
        caller: &str,
        payment_amount_e8s: u64,
        now: i64,
    ) -> Result<u64, String> {
        self.begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id,
                caller,
                payment_amount_e8s,
                min_expected_cycles: 0,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: caller,
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: 0,
                    ledger_created_at_time_ns: millis_to_nanos(now)?,
                },
                now,
            },
        )
        .map(|start| start.operation_id)
    }

    pub fn begin_database_cycles_purchase_with_ledger_details(
        &self,
        request: DatabaseCyclesPurchaseWithLedgerDetails<'_>,
    ) -> Result<DatabaseCyclesPurchaseStart, String> {
        let payment_amount_e8s = amount_to_i64(request.payment_amount_e8s)?;
        let ledger_fee = amount_to_i64(request.ledger.ledger_fee_e8s)?;
        let ledger_created_at_time = i64::try_from(request.ledger.ledger_created_at_time_ns)
            .map_err(|_| "ledger created_at_time exceeds i64".to_string())?;
        self.write_index(|tx| {
            let config = load_cycles_billing_config(tx)?;
            let cycles_u64 = cycles_for_payment_amount_e8s(request.payment_amount_e8s, &config)?;
            validate_cycles_purchase_minimum(cycles_u64, request.min_expected_cycles)?;
            let cycles = cycles_to_i64(cycles_u64)?;
            validate_database_cycles_purchase_for_conn(tx, request.database_id, cycles)?;
            ensure_no_pending_cycles_purchase_for_caller(tx, request.database_id, request.caller)?;
            let operation_id = insert_pending_cycles_operation(
                tx,
                PendingCyclesOperationInsert {
                    database_id: request.database_id,
                    kind: "cycles_purchase",
                    caller: request.caller,
                    cycles,
                    payment_amount_e8s,
                    ledger: PendingCyclesLedgerDetails {
                        from_owner: request.ledger.from_owner,
                        from_subaccount: request.ledger.from_subaccount,
                        to_owner: request.ledger.to_owner,
                        to_subaccount: request.ledger.to_subaccount,
                        ledger_fee_e8s: ledger_fee,
                        ledger_created_at_time_ns: ledger_created_at_time,
                    },
                    operation_status: CYCLES_OPERATION_STATUS_IN_FLIGHT,
                    now: request.now,
                },
            )?;
            Ok(DatabaseCyclesPurchaseStart {
                operation_id,
                amount_cycles: cycles_u64,
            })
        })
    }

    pub fn apply_database_cycles_purchase(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
        _ledger_block_index: u64,
        now: i64,
    ) -> Result<u64, String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let config = self.cycles_billing_config()?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_COMPLETED],
                "apply cycle purchase",
            )?;
            let ledger_block_index = operation
                .ledger_block_index
                .ok_or_else(|| "completed cycle purchase missing ledger block index".to_string())?;
            load_database_status(tx, database_id)?;
            complete_pending_database_activation(tx, database_id, now)?;
            let db_balance = database_balance_for_update(tx, database_id)?;
            let next_database = checked_balance_add(db_balance, cycles_i64)?;
            update_database_cycles_balance(tx, database_id, next_database, &config, now)?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "cycles_purchase",
                    amount_cycles: cycles_i64,
                    balance_after_cycles: next_database,
                    payment_amount_e8s: Some(operation.payment_amount_e8s),
                    caller,
                    method: Some("purchase_database_cycles"),
                    cycles_delta: None,
                    config: None,
                    ledger_block_index: Some(
                        u64::try_from(ledger_block_index).map_err(|error| error.to_string())?,
                    ),
                    now,
                },
            )?;
            delete_pending_cycles_operation(tx, operation_id)?;
            Ok(next_database as u64)
        })
    }

    pub fn complete_database_cycles_purchase_ledger_transfer(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
        ledger_block_index: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let ledger_block_index = i64::try_from(ledger_block_index)
            .map_err(|_| "ledger block index exceeds i64".to_string())?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "complete cycle purchase ledger transfer",
            )?;
            let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE database_cycle_pending_operations
                 SET operation_status = ?2,
                     ledger_block_index = ?3
                 WHERE operation_id = ?1",
                params![
                    operation_id,
                    CYCLES_OPERATION_STATUS_COMPLETED,
                    ledger_block_index
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn mark_database_cycles_purchase_ambiguous(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "mark cycle purchase ambiguous",
            )?;
            let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE database_cycle_pending_operations
                 SET operation_status = ?2
                 WHERE operation_id = ?1",
                params![operation_id, CYCLES_OPERATION_STATUS_AMBIGUOUS],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn cleanup_database_cycles_purchase_after_no_credit(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        let status = self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "cleanup cycle purchase",
            )?;
            load_database_status(tx, database_id)
        })?;
        if status == DatabaseStatus::Pending {
            self.discard_database_reservation(database_id)
        } else {
            self.cancel_database_cycles_purchase(operation_id, database_id, caller, cycles)
        }
    }

    pub fn cancel_database_cycles_purchase(
        &self,
        operation_id: u64,
        database_id: &str,
        caller: &str,
        cycles: u64,
    ) -> Result<(), String> {
        let cycles_i64 = cycles_to_i64(cycles)?;
        self.write_index(|tx| {
            let operation = load_required_pending_cycles_operation(
                tx,
                PendingCyclesOperationMatch {
                    operation_id,
                    database_id,
                    kind: "cycles_purchase",
                    caller,
                    cycles: cycles_i64,
                },
            )?;
            require_pending_operation_status(
                &operation,
                &[CYCLES_OPERATION_STATUS_IN_FLIGHT],
                "cancel cycle purchase",
            )?;
            delete_pending_cycles_operation(tx, operation_id)
        })
    }

    pub fn list_database_cycle_entries(
        &self,
        database_id: &str,
        caller: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<DatabaseCycleEntryPage, String> {
        let config = self.cycles_billing_config()?;
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        self.read_index(|conn| {
            let _status = load_database_status(conn, database_id)?;
            let show_principal = if caller == config.billing_authority_id {
                true
            } else {
                let role = load_member_role(conn, database_id, caller)?
                    .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
                if !role_allows(role, RequiredRole::Reader) {
                    return Err(format!(
                        "principal lacks required database role: {database_id}"
                    ));
                }
                role == DatabaseRole::Owner
            };
            let mut stmt = conn
                .prepare(
                    "SELECT entry_id, database_id, kind, amount_cycles, balance_after_cycles,
                            payment_amount_e8s, caller, method, cycles_delta, cycles_per_kinic,
                            ledger_block_index, created_at_ms
                     FROM database_cycle_ledger
                     WHERE database_id = ?1 AND entry_id > ?2
                     ORDER BY entry_id ASC
                     LIMIT ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut entries = crate::sqlite::query_map(
                &mut stmt,
                params![database_id, after, i64::from(limit) + 1],
                map_database_cycles_entry,
            )
            .map_err(|error| error.to_string())?;
            if !show_principal {
                for entry in &mut entries {
                    entry.caller = "redacted".to_string();
                }
            }
            let next_cursor = if entries.len() > limit as usize {
                entries.pop();
                entries.last().map(|entry| entry.entry_id)
            } else {
                None
            };
            Ok(DatabaseCycleEntryPage {
                entries,
                next_cursor,
            })
        })
    }

    pub fn list_database_cycles_pending_purchases(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<Vec<DatabaseCyclesPendingPurchase>, String> {
        let config = self.cycles_billing_config()?;
        self.read_index(|conn| {
            load_database_status(conn, database_id)?;
            let role = load_member_role(conn, database_id, caller)?;
            let show_all =
                caller == config.billing_authority_id || role == Some(DatabaseRole::Owner);
            let mut purchases = load_database_cycles_pending_purchase_statuses(conn, database_id)?;
            if !show_all {
                purchases.retain(|purchase| purchase.caller == caller);
                if purchases.is_empty() {
                    return Err(format!(
                        "principal cannot view pending cycle purchases: {database_id}"
                    ));
                }
            }
            purchases
                .into_iter()
                .map(DatabaseCyclesPendingPurchaseRaw::into_public)
                .collect::<Result<Vec<_>, _>>()
        })
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

    pub fn charge_database_update(
        &self,
        config: &CyclesBillingConfig,
        database_id: &str,
        caller: &str,
        method: &str,
        cycles_delta: u128,
        now: i64,
    ) -> Result<(), String> {
        let computed_charge = compute_update_charge(cycles_delta)?;
        if computed_charge == 0 {
            return Ok(());
        }
        self.write_index(|tx| {
            charge_database_update_in_tx(
                tx,
                DatabaseCharge {
                    database_id,
                    caller,
                    method,
                    cycles_delta,
                    now,
                    config,
                    computed_charge,
                },
            )
        })
    }

    pub fn run_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta(database_id)?;
        self.run_database_migrations_for_meta(database_id, &meta)
    }

    pub fn run_pending_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Pending])?;
        self.run_database_migrations_for_meta(database_id, &meta)
    }

    fn run_database_migrations_for_meta(
        &self,
        database_id: &str,
        meta: &DatabaseMeta,
    ) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let result = self.database_store(meta)?.run_fs_migrations();
        if result.is_ok() {
            let _ = self.refresh_logical_size(database_id);
        }
        result
    }

    pub fn delete_database(
        &self,
        request: DeleteDatabaseRequest,
        caller: &str,
        _now: i64,
    ) -> Result<(), String> {
        let database_id = request.database_id.as_str();
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.require_no_pending_cycles_operations(database_id)?;
        let status = self.read_index(|conn| load_database_status(conn, database_id))?;
        if !matches!(status, DatabaseStatus::Pending | DatabaseStatus::Active) {
            return Err(format!(
                "database is {}: {database_id}",
                status_to_db(status)
            ));
        }
        let meta = self.database_meta(database_id).ok();
        #[cfg(target_arch = "wasm32")]
        let _ = &meta;
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(meta) = &meta
            && let Err(error) = remove_file(&meta.db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        self.write_index(|conn| {
            delete_database_index_rows(conn, database_id)?;
            Ok(())
        })
    }

    fn require_no_pending_cycles_operations(&self, database_id: &str) -> Result<(), String> {
        self.read_index(|conn| {
            let pending = first_database_cycles_pending_purchase_status(conn, database_id)?;
            if let Some(pending) = pending {
                return Err(format!(
                    "database has pending cycle operation: {database_id}; operation_id={}; status={}; required_action={}",
                    pending.operation_id,
                    pending.status,
                    pending.required_action
                ));
            }
            Ok(())
        })
    }

    pub fn begin_database_archive(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseArchiveInfo, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.require_no_pending_cycles_operations(database_id)?;
        let meta = self.database_meta(database_id)?;
        let size_bytes = self.database_size(&meta)?;
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
             SET status = 'archiving',
                 updated_at_ms = ?2,
                 logical_size_bytes = ?3
             WHERE database_id = ?1",
                params![
                    database_id,
                    now,
                    i64::try_from(size_bytes).map_err(|error| error.to_string())?
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        Ok(DatabaseArchiveInfo {
            database_id: database_id.to_string(),
            size_bytes,
        })
    }

    pub fn read_database_archive_chunk(
        &self,
        database_id: &str,
        caller: &str,
        offset: u64,
        max_bytes: u32,
    ) -> Result<Vec<u8>, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Archiving])?;
        if max_bytes == 0 {
            return Ok(Vec::new());
        }
        if max_bytes > MAX_ARCHIVE_CHUNK_BYTES {
            return Err(format!(
                "archive chunk size exceeds limit: {max_bytes} > {MAX_ARCHIVE_CHUNK_BYTES}"
            ));
        }
        let size = meta.logical_size_bytes;
        if offset >= size {
            return Ok(Vec::new());
        }
        let remaining = size.saturating_sub(offset);
        let chunk_len = remaining.min(u64::from(max_bytes));
        self.database_export_chunk(&meta, offset, chunk_len)
    }

    pub fn finalize_database_archive(
        &self,
        database_id: &str,
        caller: &str,
        snapshot_hash: Vec<u8>,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Archiving])?;
        validate_snapshot_hash(&snapshot_hash)?;
        let actual_hash = self.database_sha256(&meta, meta.logical_size_bytes)?;
        if actual_hash != snapshot_hash {
            return Err("snapshot_hash does not match archived database bytes".to_string());
        }
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
             SET status = 'archived',
                 snapshot_hash = ?2,
                 restore_size_bytes = NULL,
                 archived_at_ms = ?3,
                 updated_at_ms = ?3
             WHERE database_id = ?1",
                params![database_id, snapshot_hash, now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        Ok(meta)
    }

    pub fn cancel_database_archive(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Archiving])?;
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
             SET status = 'active',
                 updated_at_ms = ?2
             WHERE database_id = ?1",
                params![database_id, now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        Ok(meta)
    }

    pub fn begin_database_restore(
        &self,
        database_id: &str,
        caller: &str,
        snapshot_hash: Vec<u8>,
        size_bytes: u64,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.begin_database_restore_session(database_id, caller, snapshot_hash, size_bytes, now)
            .map(|restore| restore.meta)
    }

    pub fn begin_database_restore_session(
        &self,
        database_id: &str,
        caller: &str,
        snapshot_hash: Vec<u8>,
        size_bytes: u64,
        now: i64,
    ) -> Result<DatabaseRestoreBegin, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        validate_snapshot_hash(&snapshot_hash)?;
        if size_bytes > MAX_DATABASE_SIZE_BYTES {
            return Err(format!(
                "database size exceeds limit: {size_bytes} > {MAX_DATABASE_SIZE_BYTES}"
            ));
        }
        self.require_no_pending_cycles_operations(database_id)?;
        let rollback = self.database_restore_rollback(database_id)?;
        if rollback.status != DatabaseStatus::Archived {
            return Err("database restore can only begin from archived status".to_string());
        }
        let mount_id = rollback
            .active_mount_id
            .ok_or_else(|| format!("archived database has no mount: {database_id}"))?;
        self.write_index(|tx| {
            record_database_restore_session(tx, &rollback, now)?;
            tx.execute(
                "DELETE FROM database_restore_chunks WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE databases
	             SET status = 'restoring',
	                 active_mount_id = ?2,
	                 snapshot_hash = ?3,
	                 archived_at_ms = NULL,
	                 restore_size_bytes = ?4,
	                 updated_at_ms = ?5
             WHERE database_id = ?1",
                params![
                    database_id,
                    i64::from(mount_id),
                    snapshot_hash,
                    i64::try_from(size_bytes).map_err(|error| error.to_string())?,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        let meta = self.database_meta_allowing_restoring(database_id)?;
        #[cfg(not(target_arch = "wasm32"))]
        let _ = remove_file(&meta.db_file_name);
        Ok(DatabaseRestoreBegin { meta, rollback })
    }

    pub fn rollback_database_restore_begin(
        &self,
        rollback: DatabaseRestoreRollback,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|tx| {
            let current_status = load_database_status(tx, &rollback.database_id)?;
            if current_status != DatabaseStatus::Restoring {
                return Err(format!(
                    "database restore rollback requires restoring status: {}",
                    rollback.database_id
                ));
            }
            tx.execute(
                "DELETE FROM database_restore_chunks WHERE database_id = ?1",
                params![rollback.database_id],
            )
            .map_err(|error| error.to_string())?;
            restore_database_state(tx, &rollback, now)?;
            Ok(())
        })
    }

    pub fn cancel_database_restore(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Restoring])?;
        let rollback = self.database_restore_session(database_id)?;
        #[cfg(not(target_arch = "wasm32"))]
        if let Err(error) = remove_file(&meta.db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        self.write_index(|tx| {
            tx.execute(
                "DELETE FROM database_restore_chunks WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            restore_database_state(tx, &rollback, now)?;
            Ok(())
        })?;
        Ok(meta)
    }

    pub fn write_database_restore_chunk(
        &self,
        database_id: &str,
        caller: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        if bytes.len() > MAX_RESTORE_CHUNK_BYTES {
            return Err(format!(
                "restore chunk size exceeds limit: {} > {MAX_RESTORE_CHUNK_BYTES}",
                bytes.len()
            ));
        }
        let _meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Restoring])?;
        let expected_size = self.restore_size_bytes(database_id)?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "restore chunk range overflows u64".to_string())?;
        if end > expected_size {
            return Err(format!(
                "restore chunk exceeds expected size: end {end} > {expected_size}"
            ));
        }
        self.write_index(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO database_restore_chunks
             (database_id, offset_bytes, end_bytes, bytes)
             VALUES (?1, ?2, ?3, ?4)",
                params![
                    database_id,
                    i64::try_from(offset).map_err(|error| error.to_string())?,
                    i64::try_from(end).map_err(|error| error.to_string())?,
                    bytes.to_vec()
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn finalize_database_restore(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Restoring])?;
        let expected_size = self.restore_size_bytes(database_id)?;
        let chunks = self.read_index(|conn| load_restore_chunks(conn, database_id))?;
        if !restore_chunks_cover_expected_size(&chunks, expected_size)? {
            return Err(format!(
                "restore chunks are incomplete for expected size {expected_size} bytes"
            ));
        }
        let expected_hash = self.restore_snapshot_hash(database_id)?;
        let mut hasher = Sha256::new();
        let mut checksum = FNV1A64_OFFSET;
        for chunk in &chunks {
            hasher.update(&chunk.bytes);
            checksum = fnv1a64_update(checksum, &chunk.bytes);
        }
        let actual_hash = hasher.finalize().to_vec();
        if actual_hash != expected_hash {
            return Err("snapshot_hash does not match restored database bytes".to_string());
        }
        self.import_database_bytes(&meta, expected_size, checksum, &chunks)?;
        self.database_store(&meta)?.run_fs_migrations()?;
        self.write_index(|tx| {
            tx.execute(
                "DELETE FROM database_restore_chunks WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_restore_sessions WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE databases
             SET status = 'active',
                 logical_size_bytes = ?2,
                 restore_size_bytes = NULL,
                 updated_at_ms = ?3
             WHERE database_id = ?1",
                params![
                    database_id,
                    i64::try_from(expected_size).map_err(|error| error.to_string())?,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })?;
        self.database_meta(database_id)
    }

    pub fn grant_database_access(
        &self,
        database_id: &str,
        caller: &str,
        principal: &str,
        role: DatabaseRole,
        now: i64,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        if caller == principal && role != DatabaseRole::Owner {
            return Err("owner cannot downgrade own access".to_string());
        }
        self.write_index(|conn| {
            if !database_member_exists(conn, database_id, principal)? {
                let member_count = database_member_count_for_conn(conn, database_id)?;
                if member_count >= MAX_DATABASE_MEMBERS_PER_DATABASE {
                    return Err("too many database members".to_string());
                }
            }
            conn.execute(
                "INSERT INTO database_members (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(database_id, principal)
             DO UPDATE SET role = excluded.role",
                params![database_id, principal, role_to_db(role), now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn rename_database(
        &self,
        database_id: &str,
        caller: &str,
        name: &str,
        now: i64,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.database_meta(database_id)?;
        let name = normalize_database_name(name)?;
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
                 SET name = ?2,
                     updated_at_ms = ?3
                 WHERE database_id = ?1",
                params![database_id, name, now],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn revoke_database_access(
        &self,
        database_id: &str,
        caller: &str,
        principal: &str,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.database_meta(database_id)?;
        if caller == principal {
            return Err("owner cannot revoke own access".to_string());
        }
        self.write_index(|conn| {
            conn.execute(
                "DELETE FROM database_members WHERE database_id = ?1 AND principal = ?2",
                params![database_id, principal],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn list_database_members(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<Vec<DatabaseMember>, String> {
        self.database_meta(database_id)?;
        self.read_index(|conn| {
            let caller_role = load_member_role(conn, database_id, caller)?
                .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
            if caller_role != DatabaseRole::Owner
                && !(caller == ANONYMOUS_PRINCIPAL
                    && role_allows(caller_role, RequiredRole::Reader))
            {
                return Err(format!(
                    "principal lacks required database role: {database_id}"
                ));
            }
            let mut stmt = conn
                .prepare(
                    "SELECT database_id, principal, role, created_at_ms
             FROM database_members
             WHERE database_id = ?1
             ORDER BY principal ASC",
                )
                .map_err(|error| error.to_string())?;
            crate::sqlite::query_map(&mut stmt, params![database_id], |row| {
                Ok(DatabaseMember {
                    database_id: crate::sqlite::row_get(row, 0)?,
                    principal: crate::sqlite::row_get(row, 1)?,
                    role: role_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
                    created_at_ms: crate::sqlite::row_get(row, 3)?,
                })
            })
            .map_err(|error| error.to_string())
        })
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
        self.with_database_store(database_id, caller, RequiredRole::Reader, |store| {
            store.read_node(path)
        })
    }

    pub fn authorize_url_ingest_trigger_session(
        &self,
        caller: &str,
        request: UrlIngestTriggerSessionRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_url_ingest_trigger_session_request(&request)?;
        if caller == "2vxsx-fae" {
            return Err("anonymous caller not allowed".to_string());
        }
        self.require_role(&request.database_id, caller, RequiredRole::Writer)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        self.write_index(|conn| {
            purge_expired_url_ingest_trigger_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO url_ingest_trigger_sessions
             (database_id, session_nonce, principal, expires_at_ms, created_at_ms,
              refreshed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(database_id, session_nonce) DO UPDATE SET
               principal = excluded.principal,
               expires_at_ms = excluded.expires_at_ms,
               refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    request.database_id,
                    request.session_nonce,
                    caller,
                    now + URL_INGEST_TRIGGER_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn check_url_ingest_trigger_session(
        &self,
        request: UrlIngestTriggerSessionCheckRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_url_ingest_trigger_session_check_request(&request)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM url_ingest_trigger_sessions
                 WHERE database_id = ?1
                   AND session_nonce = ?2
                   AND expires_at_ms >= ?3",
                params![request.database_id, request.session_nonce, now],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "url ingest trigger session is missing or expired".to_string())
        })?;
        let node = self
            .read_node(&request.database_id, &principal, &request.request_path)?
            .ok_or_else(|| format!("url ingest request not found: {}", request.request_path))?;
        validate_url_ingest_request_node(&node, &principal)?;
        self.require_database_write_cycles_available(&request.database_id)
    }

    pub fn authorize_ops_answer_session(
        &self,
        caller: &str,
        request: OpsAnswerSessionRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_ops_answer_session_request(&request)?;
        if caller == "2vxsx-fae" {
            return Err("anonymous caller not allowed".to_string());
        }
        self.require_role(&request.database_id, caller, RequiredRole::Reader)?;
        self.write_index(|conn| {
            purge_expired_ops_answer_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO ops_answer_sessions
             (database_id, session_nonce, principal, expires_at_ms, created_at_ms,
              refreshed_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(database_id, session_nonce) DO UPDATE SET
               principal = excluded.principal,
               expires_at_ms = excluded.expires_at_ms,
               refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    request.database_id,
                    request.session_nonce,
                    caller,
                    now + OPS_ANSWER_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn check_ops_answer_session(
        &self,
        request: OpsAnswerSessionCheckRequest,
        now: i64,
    ) -> Result<OpsAnswerSessionCheckResult, String> {
        validate_ops_answer_session_check_request(&request)?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM ops_answer_sessions
                 WHERE database_id = ?1
                   AND session_nonce = ?2
                   AND expires_at_ms >= ?3",
                params![request.database_id, request.session_nonce, now],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "ops answer session is missing or expired".to_string())
        })?;
        self.require_role(&request.database_id, &principal, RequiredRole::Reader)?;
        self.require_database_write_cycles_available(&request.database_id)?;
        Ok(OpsAnswerSessionCheckResult { principal })
    }

    pub fn check_source_run_session(
        &self,
        request: SourceRunSessionCheckRequest,
        now: i64,
    ) -> Result<(), String> {
        validate_source_run_session_check_request(&request)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;
        let principal: String = self.read_index(|conn| {
            conn.query_row(
                "SELECT principal FROM source_run_sessions
                 WHERE database_id = ?1
                   AND source_path = ?2
                   AND source_etag = ?3
                   AND session_nonce = ?4
                   AND expires_at_ms >= ?5",
                params![
                    request.database_id,
                    request.source_path,
                    request.source_etag,
                    request.session_nonce,
                    now
                ],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "source run session is missing or expired".to_string())
        })?;
        self.require_role(&request.database_id, &principal, RequiredRole::Writer)?;
        let source = self
            .read_node(&request.database_id, &principal, &request.source_path)?
            .ok_or_else(|| format!("source node not found: {}", request.source_path))?;
        if source.kind != NodeKind::Source {
            return Err("source run session target is not a source node".to_string());
        }
        if source.etag != request.source_etag {
            return Err("source run session source etag is stale".to_string());
        }
        self.require_database_write_cycles_available(&request.database_id)?;
        Ok(())
    }

    pub fn list_nodes(
        &self,
        caller: &str,
        request: ListNodesRequest,
    ) -> Result<Vec<NodeEntry>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.list_nodes(request)
        })
    }

    pub fn list_children(
        &self,
        caller: &str,
        request: ListChildrenRequest,
    ) -> Result<Vec<ChildNode>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.list_children(request)
        })
    }

    pub fn write_node(
        &self,
        caller: &str,
        request: WriteNodeRequest,
        now: i64,
    ) -> Result<WriteNodeResult, String> {
        validate_source_path_for_kind(&request.path, &request.kind)?;
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.write_node(request, now)
            });
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
    ) -> Result<WriteSourceForGenerationResult, String> {
        if caller == ANONYMOUS_PRINCIPAL {
            return Err("anonymous caller not allowed".to_string());
        }
        validate_source_for_generation_request(&request)?;
        self.require_role(&request.database_id, caller, RequiredRole::Writer)?;
        self.require_role(
            &request.database_id,
            DEFAULT_LLM_WRITER_PRINCIPAL,
            RequiredRole::Writer,
        )
        .map_err(|error| format!("LLM writer principal lacks writer access: {error}"))?;

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
        let write =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.write_node(write_request, now)
            })?;
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
    ) -> Result<Vec<WriteNodeResult>, String> {
        for node in &request.nodes {
            validate_source_path_for_kind(&node.path, &node.kind)?;
        }
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.write_nodes(request, now)
            });
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
    ) -> Result<DeleteNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.delete_node(request, now)
            });
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
    ) -> Result<WriteNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                let kind = store
                    .read_node(&request.path)?
                    .map(|node| node.kind)
                    .or_else(|| request.kind.clone())
                    .unwrap_or(NodeKind::File);
                validate_source_path_for_kind(&request.path, &kind)?;
                store.append_node(request, now)
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
    ) -> Result<EditNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.edit_node(request, now)
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
    ) -> Result<MkdirNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.mkdir_node(request, now)
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
    ) -> Result<MoveNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                if let Some(node) = store.read_node(&request.from_path)? {
                    validate_source_path_for_kind(&request.to_path, &node.kind)?;
                }
                store.move_node(request, now)
            });
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
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.incoming_links(request)
        })
    }

    pub fn outgoing_links(
        &self,
        caller: &str,
        request: OutgoingLinksRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.outgoing_links(request)
        })
    }

    pub fn graph_links(
        &self,
        caller: &str,
        request: GraphLinksRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.graph_links(request)
        })
    }

    pub fn graph_neighborhood(
        &self,
        caller: &str,
        request: GraphNeighborhoodRequest,
    ) -> Result<Vec<LinkEdge>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.graph_neighborhood(request)
        })
    }

    pub fn read_node_context(
        &self,
        caller: &str,
        request: NodeContextRequest,
    ) -> Result<Option<NodeContext>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.read_node_context(request)
        })
    }

    pub fn query_context(
        &self,
        caller: &str,
        request: QueryContextRequest,
    ) -> Result<QueryContext, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.query_context(request)
        })
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
    ) -> Result<MultiEditNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.multi_edit_node(request, now)
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
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.search_nodes(request)
        })
    }

    pub fn search_node_paths(
        &self,
        caller: &str,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
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

    fn database_meta(&self, database_id: &str) -> Result<DatabaseMeta, String> {
        self.read_index(|conn| {
            load_database(conn, database_id)?.ok_or_else(|| database_meta_error(conn, database_id))
        })
    }

    fn database_meta_allowing_restoring(&self, database_id: &str) -> Result<DatabaseMeta, String> {
        self.database_meta_with_statuses(
            database_id,
            &[
                DatabaseStatus::Pending,
                DatabaseStatus::Active,
                DatabaseStatus::Restoring,
            ],
        )
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

    fn database_restore_rollback(
        &self,
        database_id: &str,
    ) -> Result<DatabaseRestoreRollback, String> {
        self.read_index(|conn| {
            conn.query_row(
                "SELECT database_id, status, active_mount_id, snapshot_hash, archived_at_ms,
                    restore_size_bytes
	             FROM databases
	             WHERE database_id = ?1",
                params![database_id],
                |row| {
                    let active_mount_id: Option<i64> = crate::sqlite::row_get(row, 2)?;
                    let restore_size_bytes: Option<i64> = crate::sqlite::row_get(row, 5)?;
                    Ok(DatabaseRestoreRollback {
                        database_id: crate::sqlite::row_get(row, 0)?,
                        status: status_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
                        active_mount_id: active_mount_id.map(mount_id_from_db).transpose()?,
                        snapshot_hash: crate::sqlite::row_get(row, 3)?,
                        archived_at_ms: crate::sqlite::row_get(row, 4)?,
                        restore_size_bytes: restore_size_bytes.map(|size| size.max(0) as u64),
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database not found: {database_id}"))
        })
    }

    fn database_restore_session(
        &self,
        database_id: &str,
    ) -> Result<DatabaseRestoreRollback, String> {
        self.read_index(|conn| {
            conn.query_row(
                "SELECT database_id, status, active_mount_id, snapshot_hash, archived_at_ms,
                    restore_size_bytes
	             FROM database_restore_sessions
	             WHERE database_id = ?1",
                params![database_id],
                |row| {
                    let active_mount_id: Option<i64> = crate::sqlite::row_get(row, 2)?;
                    let restore_size_bytes: Option<i64> = crate::sqlite::row_get(row, 5)?;
                    Ok(DatabaseRestoreRollback {
                        database_id: crate::sqlite::row_get(row, 0)?,
                        status: status_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
                        active_mount_id: active_mount_id.map(mount_id_from_db).transpose()?,
                        snapshot_hash: crate::sqlite::row_get(row, 3)?,
                        archived_at_ms: crate::sqlite::row_get(row, 4)?,
                        restore_size_bytes: restore_size_bytes.map(|size| size.max(0) as u64),
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database restore session not found: {database_id}"))
        })
    }

    fn restore_size_bytes(&self, database_id: &str) -> Result<u64, String> {
        let size: Option<i64> = self.read_index(|conn| {
            conn.query_row(
                "SELECT restore_size_bytes FROM databases WHERE database_id = ?1",
                params![database_id],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database not found: {database_id}"))
        })?;
        size.map(|size| size.max(0) as u64)
            .ok_or_else(|| format!("restore size is missing: {database_id}"))
    }

    fn restore_snapshot_hash(&self, database_id: &str) -> Result<Vec<u8>, String> {
        let hash: Option<Vec<u8>> = self.read_index(|conn| {
            conn.query_row(
                "SELECT snapshot_hash FROM databases WHERE database_id = ?1",
                params![database_id],
                |row| crate::sqlite::row_get(row, 0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database not found: {database_id}"))
        })?;
        hash.ok_or_else(|| format!("snapshot_hash is missing: {database_id}"))
    }

    fn refresh_logical_size(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta_allowing_restoring(database_id)?;
        let size = self.database_size(&meta)?;
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

    fn database_export_chunk(
        &self,
        meta: &DatabaseMeta,
        offset: u64,
        len: u64,
    ) -> Result<Vec<u8>, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut file = File::open(&meta.db_file_name).map_err(|error| error.to_string())?;
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| error.to_string())?;
            let mut bytes = Vec::with_capacity(len as usize);
            file.take(len)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok(bytes)
        }
        #[cfg(target_arch = "wasm32")]
        {
            (self.database_handle)(meta.mount_id)?
                .export_chunk(offset, len)
                .map_err(|error| error.to_string())
        }
    }

    fn database_sha256(&self, meta: &DatabaseMeta, _size: u64) -> Result<Vec<u8>, String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            file_sha256(&meta.db_file_name)
        }
        #[cfg(target_arch = "wasm32")]
        {
            let mut hasher = Sha256::new();
            let mut offset = 0_u64;
            while offset < _size {
                let len = (_size - offset).min(u64::from(MAX_ARCHIVE_CHUNK_BYTES));
                hasher.update(self.database_export_chunk(meta, offset, len)?);
                offset += len;
            }
            Ok(hasher.finalize().to_vec())
        }
    }

    fn import_database_bytes(
        &self,
        meta: &DatabaseMeta,
        expected_size: u64,
        _checksum: u64,
        chunks: &[RestoreChunk],
    ) -> Result<(), String> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            if let Some(parent) = Path::new(&meta.db_file_name).parent() {
                create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&meta.db_file_name)
                .map_err(|error| error.to_string())?;
            for chunk in chunks {
                file.write_all(&chunk.bytes)
                    .map_err(|error| error.to_string())?;
            }
            file.set_len(expected_size)
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        #[cfg(target_arch = "wasm32")]
        {
            let handle = (self.database_handle)(meta.mount_id)?;
            handle
                .begin_import(expected_size, _checksum)
                .map_err(|error| error.to_string())?;
            for chunk in chunks {
                if let Err(error) = handle.import_chunk(chunk.offset, &chunk.bytes) {
                    let _ = handle.cancel_import();
                    return Err(error.to_string());
                }
            }
            handle.finish_import().map_err(|error| error.to_string())
        }
    }

    fn write_source_run_session(
        &self,
        database_id: &str,
        source_path: &str,
        source_etag: &str,
        session_nonce: &str,
        principal: &str,
        now: i64,
    ) -> Result<(), String> {
        self.write_index(|conn| {
            purge_expired_source_run_sessions(conn, now)?;
            conn.execute(
                "INSERT INTO source_run_sessions
                 (database_id, source_path, source_etag, session_nonce, principal,
                  expires_at_ms, created_at_ms, refreshed_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(database_id, session_nonce) DO UPDATE SET
                   source_path = excluded.source_path,
                   source_etag = excluded.source_etag,
                   principal = excluded.principal,
                   expires_at_ms = excluded.expires_at_ms,
                   refreshed_at_ms = excluded.refreshed_at_ms",
                params![
                    database_id,
                    source_path,
                    source_etag,
                    session_nonce,
                    principal,
                    now + SOURCE_RUN_SESSION_TTL_MS,
                    now
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
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

#[cfg(not(target_arch = "wasm32"))]
fn run_index_migrations(conn: &mut Connection, config: &CyclesBillingConfig) -> Result<(), String> {
    if sqlite_master_entry_exists(conn, "table", "schema_migrations")? {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        ensure_existing_index_schema_is_latest(&tx, Some(config))?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }
    for table in INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS {
        if sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without supported schema_migrations; recreate the index database"
            ));
        }
    }
    if let Some(table) = legacy_credit_index_table_name(conn)? {
        return Err(format!(
            "unsupported index schema: {table} exists without supported schema_migrations; recreate the index database"
        ));
    }
    validate_cycles_billing_config(config)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    create_schema_migrations(&tx)?;
    create_fresh_index_schema(&tx)?;
    insert_cycles_billing_config(&tx, config)?;
    for &version in INDEX_SCHEMA_VERSIONS {
        insert_schema_migration_now(&tx, version)?;
    }
    tx.commit().map_err(|error| error.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn run_index_migrations_for_upgrade(
    conn: &mut Connection,
    config: Option<&CyclesBillingConfig>,
) -> Result<(), String> {
    if sqlite_master_entry_exists(conn, "table", "schema_migrations")? {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        ensure_existing_index_schema_is_latest(&tx, config)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let config =
        config.ok_or_else(|| "cycles config required for fresh index upgrade".to_string())?;
    run_index_migrations(conn, config)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx(
    conn: &Transaction<'_>,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    if wasm_index_table_exists(conn, "schema_migrations")? {
        ensure_existing_index_schema_is_latest(conn, Some(config))?;
        return Ok(());
    }
    for table in INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS {
        if wasm_index_table_exists(conn, table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without schema_migrations"
            ));
        }
    }
    if let Some(table) = legacy_credit_index_table_name_tx(conn)? {
        return Err(format!(
            "unsupported index schema: {table} exists without schema_migrations"
        ));
    }
    validate_cycles_billing_config(config)?;
    create_schema_migrations(conn)?;
    create_fresh_index_schema(conn)?;
    insert_cycles_billing_config(conn, config)?;
    for &version in INDEX_SCHEMA_VERSIONS {
        insert_schema_migration_zero(conn, version)?;
    }
    validate_index_schema(conn)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx_for_upgrade(
    conn: &Transaction<'_>,
    config: Option<&CyclesBillingConfig>,
) -> Result<(), String> {
    if wasm_index_table_exists(conn, "schema_migrations")? {
        ensure_existing_index_schema_is_latest(conn, config)?;
        return Ok(());
    }
    let config =
        config.ok_or_else(|| "cycles config required for fresh index upgrade".to_string())?;
    run_index_migrations_in_tx(conn, config)
}

enum IndexSchemaState {
    Latest,
    StorageBillingBatchUpgrade,
    Mainnet011,
}

fn ensure_existing_index_schema_is_latest(
    conn: &Transaction<'_>,
    config: Option<&CyclesBillingConfig>,
) -> Result<(), String> {
    match classify_existing_index_schema_state(conn)? {
        IndexSchemaState::Latest => validate_index_schema(conn),
        IndexSchemaState::StorageBillingBatchUpgrade => {
            apply_storage_billing_batch_index_migration(conn)?;
            validate_index_schema(conn)
        }
        IndexSchemaState::Mainnet011 => {
            let config = config
                .ok_or_else(|| "cycles config required for first cycles upgrade".to_string())?;
            validate_cycles_billing_config(config)?;
            validate_pre_billing_index_schema(conn)?;
            apply_mainnet_011_to_latest_index_migration(conn, config)?;
            validate_index_schema(conn)
        }
    }
}

fn classify_existing_index_schema_state(
    conn: &Transaction<'_>,
) -> Result<IndexSchemaState, String> {
    let legacy_billing_marker: Option<String> = conn
        .query_row(
            "SELECT version
             FROM schema_migrations
             WHERE version LIKE '%credit%'
             ORDER BY version
             LIMIT 1",
            params![],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(version) = legacy_billing_marker {
        return Err(format!(
            "unsupported partial billing index schema: migration {version} is already applied"
        ));
    }
    if let Some(table) = legacy_credit_index_table_name_tx(conn)? {
        return Err(format!(
            "unsupported partial billing index schema: table {table} already exists"
        ));
    }
    if migration_applied_tx(conn, INDEX_SCHEMA_VERSION_STORAGE_BILLING_BATCH)? {
        return Ok(IndexSchemaState::Latest);
    }
    if migration_applied_tx(conn, INDEX_SCHEMA_VERSION_CYCLES_PENDING_LEDGER_BLOCK_INDEX)? {
        return Ok(IndexSchemaState::StorageBillingBatchUpgrade);
    }
    if !migration_applied_tx(conn, INDEX_SCHEMA_VERSION_SOURCE_RUN_SESSIONS)? {
        return Err(format!(
            "unsupported index schema: missing migration {INDEX_SCHEMA_VERSION_SOURCE_RUN_SESSIONS}"
        ));
    }
    for &version in POST_011_INDEX_SCHEMA_VERSIONS {
        if migration_applied_tx(conn, version)? {
            return Err(format!(
                "unsupported partial billing index schema: migration {version} is already applied"
            ));
        }
    }
    for table in POST_011_INDEX_SCHEMA_TABLES {
        if tx_sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!(
                "unsupported partial billing index schema: table {table} already exists"
            ));
        }
    }
    Ok(IndexSchemaState::Mainnet011)
}

fn apply_mainnet_011_to_latest_index_migration(
    conn: &Transaction<'_>,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    conn.execute_batch(INDEX_011_TO_LATEST_SQL)
        .map_err(|error| error.to_string())?;
    insert_cycles_billing_config(conn, config)?;
    for &version in POST_011_INDEX_SCHEMA_VERSIONS {
        insert_schema_migration_now(conn, version)?;
    }
    Ok(())
}

fn apply_storage_billing_batch_index_migration(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE storage_billing_state (
           key TEXT PRIMARY KEY,
           cursor_mount_id INTEGER,
           billing_now_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL,
           CHECK (key = 'timer')
         )",
        params![],
    )
    .map_err(|error| error.to_string())?;
    insert_schema_migration_now(conn, INDEX_SCHEMA_VERSION_STORAGE_BILLING_BATCH)?;
    Ok(())
}

fn create_schema_migrations(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_schema_migration_now(conn: &Transaction<'_>, version: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
        params![version],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn insert_schema_migration_zero(conn: &Transaction<'_>, version: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params![version],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_fresh_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute_batch(FRESH_INDEX_SCHEMA_SQL)
        .map_err(|error| error.to_string())
}

fn default_cycles_billing_config() -> CyclesBillingConfig {
    CyclesBillingConfig {
        kinic_ledger_canister_id: "aaaaa-aa".to_string(),
        billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
        cycles_per_kinic: DEFAULT_CYCLES_PER_KINIC,
        min_update_cycles: DEFAULT_MIN_UPDATE_CYCLES,
    }
}

fn validate_cycles_billing_config(config: &CyclesBillingConfig) -> Result<(), String> {
    validate_principal_text(&config.kinic_ledger_canister_id)?;
    validate_principal_text(&config.billing_authority_id)?;
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
    Ok(())
}

fn set_cycles_billing_config_value(
    conn: &Transaction<'_>,
    key: &str,
    value: u64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cycles_billing_config (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

const INDEX_SCHEMA_VERSIONS: &[&str] = &[
    INDEX_SCHEMA_VERSION_INITIAL,
    INDEX_SCHEMA_VERSION_LIFECYCLE,
    INDEX_SCHEMA_VERSION_RESTORE_SIZE,
    INDEX_SCHEMA_VERSION_RESTORE_CHUNKS,
    INDEX_SCHEMA_VERSION_MOUNT_HISTORY,
    INDEX_SCHEMA_VERSION_URL_INGEST_TRIGGER_SESSIONS,
    INDEX_SCHEMA_VERSION_OPS_ANSWER_SESSIONS,
    INDEX_SCHEMA_VERSION_RESTORE_SESSIONS,
    INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES,
    INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING,
    INDEX_SCHEMA_VERSION_SOURCE_RUN_SESSIONS,
    INDEX_SCHEMA_VERSION_BILLING_INITIAL,
    INDEX_SCHEMA_VERSION_BILLING_PENDING,
    INDEX_SCHEMA_VERSION_BILLING_LEDGER_BLOCK_INDEX,
    INDEX_SCHEMA_VERSION_BILLING_PENDING_LEDGER_DETAILS,
    INDEX_SCHEMA_VERSION_ACTIVE_STATUS,
    INDEX_SCHEMA_VERSION_HARD_DELETE_DATABASES,
    INDEX_SCHEMA_VERSION_CYCLES_LEDGER_ONLY,
    INDEX_SCHEMA_VERSION_FIXED_CYCLES_ACCOUNTING,
    INDEX_SCHEMA_VERSION_CYCLES_BILLING_CONFIG_VERSION,
    INDEX_SCHEMA_VERSION_CYCLES_PENDING_OPERATION_STATUS,
    INDEX_SCHEMA_VERSION_CYCLES,
    INDEX_SCHEMA_VERSION_STORAGE_BILLING,
    INDEX_SCHEMA_VERSION_DIRECT_CYCLES,
    INDEX_SCHEMA_VERSION_CYCLES_PENDING_LEDGER_BLOCK_INDEX,
    INDEX_SCHEMA_VERSION_STORAGE_BILLING_BATCH,
];

const INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS: &[&str] = &[
    "databases",
    "database_members",
    "database_restore_chunks",
    "database_mount_history",
    "url_ingest_trigger_sessions",
    "ops_answer_sessions",
    "source_run_sessions",
    "database_restore_sessions",
    "database_cycle_accounts",
    "database_cycle_ledger",
    "database_cycle_pending_operations",
    "cycles_billing_config",
    "storage_billing_state",
];

const POST_011_INDEX_SCHEMA_VERSIONS: &[&str] = &[
    INDEX_SCHEMA_VERSION_BILLING_INITIAL,
    INDEX_SCHEMA_VERSION_BILLING_PENDING,
    INDEX_SCHEMA_VERSION_BILLING_LEDGER_BLOCK_INDEX,
    INDEX_SCHEMA_VERSION_BILLING_PENDING_LEDGER_DETAILS,
    INDEX_SCHEMA_VERSION_ACTIVE_STATUS,
    INDEX_SCHEMA_VERSION_HARD_DELETE_DATABASES,
    INDEX_SCHEMA_VERSION_CYCLES_LEDGER_ONLY,
    INDEX_SCHEMA_VERSION_FIXED_CYCLES_ACCOUNTING,
    INDEX_SCHEMA_VERSION_CYCLES_BILLING_CONFIG_VERSION,
    INDEX_SCHEMA_VERSION_CYCLES_PENDING_OPERATION_STATUS,
    INDEX_SCHEMA_VERSION_CYCLES,
    INDEX_SCHEMA_VERSION_STORAGE_BILLING,
    INDEX_SCHEMA_VERSION_DIRECT_CYCLES,
    INDEX_SCHEMA_VERSION_CYCLES_PENDING_LEDGER_BLOCK_INDEX,
    INDEX_SCHEMA_VERSION_STORAGE_BILLING_BATCH,
];

const POST_011_INDEX_SCHEMA_TABLES: &[&str] = &[
    "database_cycle_accounts",
    "database_cycle_ledger",
    "database_cycle_pending_operations",
    "cycles_billing_config",
    "storage_billing_state",
];

fn validate_pre_billing_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    for table in [
        "schema_migrations",
        "databases",
        "database_members",
        "database_restore_chunks",
        "database_mount_history",
        "url_ingest_trigger_sessions",
        "ops_answer_sessions",
        "source_run_sessions",
        "database_restore_sessions",
    ] {
        if !tx_sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!("unsupported index schema: missing table {table}"));
        }
    }
    for (table, columns) in [
        ("schema_migrations", &["version", "applied_at"][..]),
        (
            "databases",
            &[
                "database_id",
                "name",
                "db_file_name",
                "mount_id",
                "active_mount_id",
                "status",
                "schema_version",
                "logical_size_bytes",
                "snapshot_hash",
                "archived_at_ms",
                "deleted_at_ms",
                "restore_size_bytes",
                "created_at_ms",
                "updated_at_ms",
            ][..],
        ),
        (
            "database_members",
            &["database_id", "principal", "role", "created_at_ms"][..],
        ),
        (
            "database_restore_chunks",
            &["database_id", "offset_bytes", "end_bytes", "bytes"][..],
        ),
        (
            "database_mount_history",
            &["database_id", "mount_id", "reason", "created_at_ms"][..],
        ),
        (
            "url_ingest_trigger_sessions",
            &[
                "database_id",
                "session_nonce",
                "principal",
                "expires_at_ms",
                "created_at_ms",
                "refreshed_at_ms",
            ][..],
        ),
        (
            "ops_answer_sessions",
            &[
                "database_id",
                "session_nonce",
                "principal",
                "expires_at_ms",
                "created_at_ms",
                "refreshed_at_ms",
            ][..],
        ),
        (
            "source_run_sessions",
            &[
                "database_id",
                "source_path",
                "source_etag",
                "session_nonce",
                "principal",
                "expires_at_ms",
                "created_at_ms",
                "refreshed_at_ms",
            ][..],
        ),
        (
            "database_restore_sessions",
            &[
                "database_id",
                "status",
                "active_mount_id",
                "snapshot_hash",
                "archived_at_ms",
                "deleted_at_ms",
                "restore_size_bytes",
                "created_at_ms",
            ][..],
        ),
    ] {
        for column in columns {
            if !index_column_exists(conn, table, column)? {
                return Err(format!(
                    "unsupported index schema: missing column {table}.{column}"
                ));
            }
        }
    }
    for index in [
        "databases_active_mount_id_idx",
        "database_restore_chunks_database_id_idx",
        "url_ingest_trigger_sessions_expiry_idx",
        "ops_answer_sessions_expiry_idx",
        "source_run_sessions_expiry_idx",
    ] {
        if !tx_sqlite_master_entry_exists(conn, "index", index)? {
            return Err(format!("unsupported index schema: missing index {index}"));
        }
    }
    Ok(())
}

fn validate_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    for table in [
        "schema_migrations",
        "databases",
        "database_restore_chunks",
        "database_restore_sessions",
        "database_cycle_accounts",
        "database_cycle_ledger",
        "database_cycle_pending_operations",
        "cycles_billing_config",
        "storage_billing_state",
    ] {
        if !tx_sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!("unsupported index schema: missing table {table}"));
        }
    }
    for (table, columns) in [
        ("schema_migrations", &["version", "applied_at"][..]),
        (
            "databases",
            &[
                "database_id",
                "name",
                "db_file_name",
                "mount_id",
                "active_mount_id",
                "status",
                "schema_version",
                "logical_size_bytes",
                "snapshot_hash",
                "archived_at_ms",
                "deleted_at_ms",
                "restore_size_bytes",
                "created_at_ms",
                "updated_at_ms",
            ][..],
        ),
        (
            "database_restore_chunks",
            &["database_id", "offset_bytes", "end_bytes", "bytes"][..],
        ),
        (
            "database_cycle_accounts",
            &[
                "database_id",
                "balance_cycles",
                "suspended_at_ms",
                "storage_charged_at_ms",
            ][..],
        ),
        (
            "database_cycle_ledger",
            &[
                "entry_id",
                "database_id",
                "kind",
                "amount_cycles",
                "balance_after_cycles",
                "payment_amount_e8s",
                "caller",
                "method",
                "cycles_delta",
                "cycles_per_kinic",
                "ledger_block_index",
                "created_at_ms",
            ][..],
        ),
        (
            "database_cycle_pending_operations",
            &[
                "operation_id",
                "database_id",
                "kind",
                "caller",
                "cycles",
                "payment_amount_e8s",
                "from_owner",
                "from_subaccount",
                "to_owner",
                "to_subaccount",
                "ledger_fee_e8s",
                "ledger_created_at_time_ns",
                "operation_status",
                "ledger_block_index",
                "created_at_ms",
            ][..],
        ),
        (
            "storage_billing_state",
            &["key", "cursor_mount_id", "billing_now_ms", "updated_at_ms"][..],
        ),
    ] {
        for column in columns {
            if !index_column_exists(conn, table, column)? {
                return Err(format!(
                    "unsupported index schema: missing column {table}.{column}"
                ));
            }
        }
    }
    for index in [
        "databases_active_mount_id_idx",
        "database_restore_chunks_database_id_idx",
        "database_cycle_ledger_database_idx",
        "database_cycle_pending_operations_database_idx",
    ] {
        if !tx_sqlite_master_entry_exists(conn, "index", index)? {
            return Err(format!("unsupported index schema: missing index {index}"));
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn wasm_index_table_exists(conn: &Transaction<'_>, table: &str) -> Result<bool, String> {
    tx_sqlite_master_entry_exists(conn, "table", table)
}

fn tx_sqlite_master_entry_exists(
    conn: &Transaction<'_>,
    entry_type: &str,
    name: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2",
        params![entry_type, name],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn index_column_exists(conn: &Transaction<'_>, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let columns = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 1)
    })
    .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|name| name == column))
}

fn migration_applied_tx(conn: &Transaction<'_>, version: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM schema_migrations WHERE version = ?1",
        params![version],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn legacy_credit_index_table_name(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND (name LIKE 'database_' || 'credit_%'
                OR name = 'credits_' || 'config')
         ORDER BY name
         LIMIT 1",
        params![],
        |row| crate::sqlite::row_get::<String>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn legacy_credit_index_table_name_tx(conn: &Transaction<'_>) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND (name LIKE 'database_' || 'credit_%'
                OR name = 'credits_' || 'config')
         ORDER BY name
         LIMIT 1",
        params![],
        |row| crate::sqlite::row_get::<String>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn sqlite_master_entry_exists(
    conn: &Connection,
    entry_type: &str,
    name: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = ?1 AND name = ?2",
        params![entry_type, name],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn load_cycles_billing_config(conn: &Connection) -> Result<CyclesBillingConfig, String> {
    Ok(CyclesBillingConfig {
        kinic_ledger_canister_id: load_cycles_billing_config_text(
            conn,
            "kinic_ledger_canister_id",
        )?,
        billing_authority_id: load_cycles_billing_config_text(conn, "billing_authority_id")?,
        cycles_per_kinic: load_cycles_billing_config_u64(conn, "cycles_per_kinic")?,
        min_update_cycles: load_cycles_billing_config_u64(conn, "min_update_cycles")?,
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

fn validate_index_select_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("index SQL must not be empty".to_string());
    }
    if trimmed.contains(';') {
        return Err("index SQL must be a single SELECT statement".to_string());
    }
    let first = trimmed
        .split(|character: char| !is_sql_identifier_character(character))
        .find(|token| !token.is_empty())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if first != "select" {
        return Err("index SQL must start with SELECT".to_string());
    }
    let blocked = [
        "pragma", "attach", "detach", "insert", "update", "delete", "create", "drop", "alter",
        "replace", "vacuum", "reindex", "analyze",
    ];
    for token in sql_identifier_tokens(trimmed) {
        if blocked.contains(&token.as_str()) {
            return Err(format!("index SQL token is not allowed: {token}"));
        }
    }
    Ok(())
}

fn sql_identifier_tokens(sql: &str) -> Vec<String> {
    sql.split(|character: char| !is_sql_identifier_character(character))
        .filter(|token| !token.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

fn is_sql_identifier_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
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

fn delete_database_index_rows(conn: &Connection, database_id: &str) -> Result<(), String> {
    for table in [
        "database_cycle_pending_operations",
        "database_cycle_ledger",
        "database_cycle_accounts",
        "database_members",
        "database_restore_chunks",
        "database_restore_sessions",
        "url_ingest_trigger_sessions",
        "ops_answer_sessions",
        "source_run_sessions",
        "databases",
    ] {
        let sql = format!("DELETE FROM {table} WHERE database_id = ?1");
        conn.execute(&sql, params![database_id])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn purge_expired_unstarted_pending_databases(
    conn: &Transaction<'_>,
    caller: &str,
    now: i64,
) -> Result<(), String> {
    let expires_before = now.saturating_sub(PENDING_DATABASE_TTL_MS);
    let expired_database_ids = {
        let mut stmt = conn
            .prepare(
                "SELECT d.database_id
                 FROM databases d
                 JOIN database_members m ON m.database_id = d.database_id
                 WHERE d.status = 'pending'
                   AND d.active_mount_id IS NULL
                   AND d.created_at_ms <= ?2
                   AND m.principal = ?1
                   AND m.role = 'owner'
                   AND NOT EXISTS (
                     SELECT 1
                     FROM database_cycle_pending_operations p
                     WHERE p.database_id = d.database_id
                   )
                 ORDER BY d.created_at_ms ASC",
            )
            .map_err(|error| error.to_string())?;
        crate::sqlite::query_map(&mut stmt, params![caller, expires_before], |row| {
            crate::sqlite::row_get::<String>(row, 0)
        })
        .map_err(|error| error.to_string())?
    };
    for database_id in expired_database_ids {
        delete_database_index_rows(conn, &database_id)?;
    }
    Ok(())
}

fn pending_database_count_for_caller(conn: &Connection, caller: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM databases d
         JOIN database_members m ON m.database_id = d.database_id
         WHERE d.status = 'pending'
           AND d.active_mount_id IS NULL
           AND m.principal = ?1
           AND m.role = 'owner'",
        params![caller],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn complete_pending_database_activation(
    conn: &Connection,
    database_id: &str,
    now: i64,
) -> Result<(), String> {
    let status = load_database_status(conn, database_id)?;
    if status != DatabaseStatus::Pending {
        return Ok(());
    }
    let active_mount_id: Option<i64> = conn
        .query_row(
            "SELECT active_mount_id FROM databases WHERE database_id = ?1",
            params![database_id],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if active_mount_id.is_none() {
        return Err(format!(
            "pending database has no activation mount: {database_id}"
        ));
    }
    conn.execute(
        "UPDATE databases
         SET status = 'active',
             updated_at_ms = ?2
         WHERE database_id = ?1 AND status = 'pending'",
        params![database_id, now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE database_cycle_accounts
         SET storage_charged_at_ms = COALESCE(storage_charged_at_ms, ?2),
             updated_at_ms = ?2
         WHERE database_id = ?1",
        params![database_id, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn database_balance_for_update(conn: &Transaction<'_>, database_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id = ?1",
        params![database_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {database_id}"))
}

fn update_database_cycles_balance(
    conn: &Transaction<'_>,
    database_id: &str,
    balance: i64,
    config: &CyclesBillingConfig,
    now: i64,
) -> Result<(), String> {
    let min = cycles_to_i64(config.min_update_cycles)?;
    let suspended_at_ms = if balance >= min { None } else { Some(now) };
    let values = vec![
        crate::sqlite::text_value(database_id),
        crate::sqlite::integer_value(balance),
        crate::sqlite::nullable_integer_value(suspended_at_ms),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE database_cycle_accounts
         SET balance_cycles = ?2, suspended_at_ms = ?3, updated_at_ms = ?4
         WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_storage_cycle_account(
    conn: &Connection,
    database_id: &str,
) -> Result<StorageCycleAccount, String> {
    conn.query_row(
        "SELECT balance_cycles, suspended_at_ms, storage_charged_at_ms
         FROM database_cycle_accounts
         WHERE database_id = ?1",
        params![database_id],
        |row| {
            Ok(StorageCycleAccount {
                balance_cycles: crate::sqlite::row_get(row, 0)?,
                suspended_at_ms: crate::sqlite::row_get(row, 1)?,
                storage_charged_at_ms: crate::sqlite::row_get(row, 2)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {database_id}"))
}

fn update_database_storage_account(
    conn: &Transaction<'_>,
    database_id: &str,
    balance_cycles: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: i64,
    now: i64,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(database_id),
        crate::sqlite::integer_value(balance_cycles),
        crate::sqlite::nullable_integer_value(suspended_at_ms),
        crate::sqlite::integer_value(storage_charged_at_ms),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE database_cycle_accounts
         SET balance_cycles = ?2,
             suspended_at_ms = ?3,
             storage_charged_at_ms = ?4,
             updated_at_ms = ?5
         WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

struct PendingCyclesOperation {
    database_id: String,
    kind: String,
    caller: String,
    cycles: i64,
    payment_amount_e8s: i64,
    operation_status: String,
    ledger_block_index: Option<i64>,
}

struct DatabaseCyclesPendingPurchaseRaw {
    operation_id: i64,
    database_id: String,
    caller: String,
    status: String,
    amount_cycles: i64,
    payment_amount_e8s: i64,
    ledger_block_index: Option<i64>,
    created_at_ms: i64,
}

impl DatabaseCyclesPendingPurchaseRaw {
    fn into_public(self) -> Result<DatabaseCyclesPendingPurchase, String> {
        let amount_cycles = u64::try_from(self.amount_cycles).map_err(|error| error.to_string())?;
        let payment_amount_e8s =
            u64::try_from(self.payment_amount_e8s).map_err(|error| error.to_string())?;
        let operation_id = u64::try_from(self.operation_id).map_err(|error| error.to_string())?;
        let ledger_block_index = self
            .ledger_block_index
            .map(u64::try_from)
            .transpose()
            .map_err(|error| error.to_string())?;
        Ok(DatabaseCyclesPendingPurchase {
            operation_id,
            database_id: self.database_id,
            status: self.status.clone(),
            amount_cycles,
            payment_amount_e8s,
            ledger_block_index,
            created_at_ms: self.created_at_ms,
            required_action: pending_cycles_required_action(&self.status).to_string(),
        })
    }
}

struct PendingCyclesLedgerDetails<'a> {
    from_owner: &'a str,
    from_subaccount: Option<&'a [u8]>,
    to_owner: &'a str,
    to_subaccount: Option<&'a [u8]>,
    ledger_fee_e8s: i64,
    ledger_created_at_time_ns: i64,
}

struct PendingCyclesOperationInsert<'a> {
    database_id: &'a str,
    kind: &'a str,
    caller: &'a str,
    cycles: i64,
    payment_amount_e8s: i64,
    ledger: PendingCyclesLedgerDetails<'a>,
    operation_status: &'a str,
    now: i64,
}

struct PendingCyclesOperationMatch<'a> {
    operation_id: u64,
    database_id: &'a str,
    kind: &'a str,
    caller: &'a str,
    cycles: i64,
}

fn insert_pending_cycles_operation(
    conn: &Transaction<'_>,
    operation: PendingCyclesOperationInsert<'_>,
) -> Result<u64, String> {
    let values = vec![
        crate::sqlite::text_value(operation.database_id),
        crate::sqlite::text_value(operation.kind),
        crate::sqlite::text_value(operation.caller),
        crate::sqlite::integer_value(operation.cycles),
        crate::sqlite::integer_value(operation.payment_amount_e8s),
        crate::sqlite::text_value(operation.ledger.from_owner),
        crate::sqlite::nullable_blob_value(operation.ledger.from_subaccount.map(Vec::from)),
        crate::sqlite::text_value(operation.ledger.to_owner),
        crate::sqlite::nullable_blob_value(operation.ledger.to_subaccount.map(Vec::from)),
        crate::sqlite::integer_value(operation.ledger.ledger_fee_e8s),
        crate::sqlite::integer_value(operation.ledger.ledger_created_at_time_ns),
        crate::sqlite::text_value(operation.operation_status),
        crate::sqlite::integer_value(operation.now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_cycle_pending_operations
         (database_id, kind, caller, cycles, payment_amount_e8s, from_owner, from_subaccount,
          to_owner, to_subaccount, ledger_fee_e8s, ledger_created_at_time_ns, operation_status,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    let operation_id = crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
    u64::try_from(operation_id).map_err(|error| error.to_string())
}

fn load_pending_cycles_operation(
    conn: &Connection,
    operation_id: u64,
) -> Result<PendingCyclesOperation, String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT database_id, kind, caller, cycles, payment_amount_e8s,
                from_owner, from_subaccount, to_owner, to_subaccount,
                ledger_fee_e8s, ledger_created_at_time_ns, operation_status, ledger_block_index
         FROM database_cycle_pending_operations
         WHERE operation_id = ?1",
        params![operation_id],
        map_pending_cycles_operation,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "pending cycle operation not found".to_string())
}

fn require_pending_operation_status(
    operation: &PendingCyclesOperation,
    allowed: &[&str],
    action: &str,
) -> Result<(), String> {
    if allowed
        .iter()
        .any(|status| operation.operation_status == *status)
    {
        return Ok(());
    }
    Err(format!(
        "cannot {action}; cycle purchase operation is {}",
        operation.operation_status
    ))
}

fn load_required_pending_cycles_operation(
    conn: &Transaction<'_>,
    expected: PendingCyclesOperationMatch<'_>,
) -> Result<PendingCyclesOperation, String> {
    let operation = load_pending_cycles_operation(conn, expected.operation_id)?;
    if operation.database_id != expected.database_id
        || operation.kind != expected.kind
        || operation.caller != expected.caller
        || operation.cycles != expected.cycles
    {
        return Err("pending cycle operation mismatch".to_string());
    }
    Ok(operation)
}

fn delete_pending_cycles_operation(
    conn: &Transaction<'_>,
    operation_id: u64,
) -> Result<(), String> {
    let operation_id = i64::try_from(operation_id).map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM database_cycle_pending_operations WHERE operation_id = ?1",
        params![operation_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_no_pending_cycles_purchase_for_caller(
    conn: &Connection,
    database_id: &str,
    caller: &str,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM database_cycle_pending_operations
             WHERE database_id = ?1
               AND caller = ?2
               AND kind = 'cycles_purchase'",
            params![database_id, caller],
            |row| crate::sqlite::row_get(row, 0),
        )
        .map_err(|error| error.to_string())?;
    if count > 0 {
        return Err("cycles purchase already pending for caller".to_string());
    }
    Ok(())
}

fn load_database_cycles_pending_purchase_statuses(
    conn: &Connection,
    database_id: &str,
) -> Result<Vec<DatabaseCyclesPendingPurchaseRaw>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT operation_id, database_id, caller, operation_status, cycles,
                    payment_amount_e8s, ledger_block_index, created_at_ms
             FROM database_cycle_pending_operations
             WHERE database_id = ?1 AND kind = 'cycles_purchase'
             ORDER BY operation_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(
        &mut stmt,
        params![database_id],
        map_database_cycles_pending_purchase_raw,
    )
    .map_err(|error| error.to_string())
}

fn first_database_cycles_pending_purchase_status(
    conn: &Connection,
    database_id: &str,
) -> Result<Option<DatabaseCyclesPendingPurchase>, String> {
    conn.query_row(
        "SELECT operation_id, database_id, caller, operation_status, cycles,
                payment_amount_e8s, ledger_block_index, created_at_ms
         FROM database_cycle_pending_operations
         WHERE database_id = ?1 AND kind = 'cycles_purchase'
         ORDER BY operation_id ASC
         LIMIT 1",
        params![database_id],
        map_database_cycles_pending_purchase_raw,
    )
    .optional()
    .map_err(|error| error.to_string())?
    .map(DatabaseCyclesPendingPurchaseRaw::into_public)
    .transpose()
}

fn map_database_cycles_pending_purchase_raw(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseCyclesPendingPurchaseRaw> {
    Ok(DatabaseCyclesPendingPurchaseRaw {
        operation_id: crate::sqlite::row_get(row, 0)?,
        database_id: crate::sqlite::row_get(row, 1)?,
        caller: crate::sqlite::row_get(row, 2)?,
        status: crate::sqlite::row_get(row, 3)?,
        amount_cycles: crate::sqlite::row_get(row, 4)?,
        payment_amount_e8s: crate::sqlite::row_get(row, 5)?,
        ledger_block_index: crate::sqlite::row_get(row, 6)?,
        created_at_ms: crate::sqlite::row_get(row, 7)?,
    })
}

fn pending_cycles_required_action(status: &str) -> &'static str {
    match status {
        CYCLES_OPERATION_STATUS_IN_FLIGHT => "wait_for_ledger_result",
        CYCLES_OPERATION_STATUS_AMBIGUOUS | CYCLES_OPERATION_STATUS_COMPLETED => {
            "billing_authority_review"
        }
        _ => "billing_authority_review",
    }
}

fn map_pending_cycles_operation(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<PendingCyclesOperation> {
    Ok(PendingCyclesOperation {
        database_id: crate::sqlite::row_get(row, 0)?,
        kind: crate::sqlite::row_get(row, 1)?,
        caller: crate::sqlite::row_get(row, 2)?,
        cycles: crate::sqlite::row_get(row, 3)?,
        payment_amount_e8s: crate::sqlite::row_get(row, 4)?,
        operation_status: crate::sqlite::row_get(row, 11)?,
        ledger_block_index: crate::sqlite::row_get(row, 12)?,
    })
}

struct DatabaseLedgerInsert<'a> {
    database_id: &'a str,
    kind: &'a str,
    amount_cycles: i64,
    balance_after_cycles: i64,
    payment_amount_e8s: Option<i64>,
    caller: &'a str,
    method: Option<&'a str>,
    cycles_delta: Option<u128>,
    config: Option<&'a CyclesBillingConfig>,
    ledger_block_index: Option<u64>,
    now: i64,
}

struct DatabaseCharge<'a> {
    database_id: &'a str,
    caller: &'a str,
    method: &'a str,
    cycles_delta: u128,
    now: i64,
    config: &'a CyclesBillingConfig,
    computed_charge: i64,
}

struct AppliedDatabaseCharge {
    paid_cycles: i64,
    balance_after_cycles: i64,
}

struct StorageChargeInput<'a> {
    database_id: &'a str,
    caller: &'a str,
    size_bytes: u64,
    now: i64,
    config: &'a CyclesBillingConfig,
}

struct StorageBillingDatabaseBatch {
    databases: Vec<DatabaseMeta>,
    next_cursor_mount_id: Option<u16>,
}

struct StorageBillingTimerState {
    cursor_mount_id: Option<u16>,
    billing_now_ms: i64,
}

struct StorageBillingAccountRow {
    database_id: String,
    size_bytes: u64,
    balance_cycles: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: Option<i64>,
}

struct StorageBillingWorkRow {
    database_id: String,
    next_balance: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: i64,
    storage_cycles: i64,
    paid_cycles: i64,
    update_account: bool,
    charged: bool,
    newly_suspended: bool,
}

struct StorageChargeOutcome {
    charged: bool,
    suspended: bool,
    paid_cycles: u64,
}

struct StorageCycleAccount {
    balance_cycles: i64,
    suspended_at_ms: Option<i64>,
    storage_charged_at_ms: Option<i64>,
}

fn insert_database_ledger(
    conn: &Transaction<'_>,
    entry: DatabaseLedgerInsert<'_>,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(entry.database_id),
        crate::sqlite::text_value(entry.kind),
        crate::sqlite::integer_value(entry.amount_cycles),
        crate::sqlite::integer_value(entry.balance_after_cycles),
        crate::sqlite::nullable_integer_value(entry.payment_amount_e8s),
        crate::sqlite::text_value(entry.caller),
        entry
            .method
            .map(crate::sqlite::text_value)
            .unwrap_or(crate::sqlite::types::Value::Null),
        crate::sqlite::nullable_integer_value(
            entry
                .cycles_delta
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .config
                .map(|config| i64::try_from(config.cycles_per_kinic).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .ledger_block_index
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::integer_value(entry.now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_cycle_ledger
         (database_id, kind, amount_cycles, balance_after_cycles, payment_amount_e8s,
          caller, method, cycles_delta, cycles_per_kinic, ledger_block_index, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn settle_database_storage_billing_loop_in_tx(
    tx: &Transaction<'_>,
    caller: &str,
    databases: Vec<DatabaseMeta>,
    now: i64,
    config: &CyclesBillingConfig,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    let mut result = StorageBillingBatchResult {
        processed_databases: 0,
        charged_databases: 0,
        suspended_databases: 0,
        paid_cycles: 0,
        next_cursor_mount_id,
    };
    for meta in databases {
        let outcome = settle_database_storage_charge_in_tx(
            tx,
            StorageChargeInput {
                database_id: &meta.database_id,
                caller,
                size_bytes: meta.logical_size_bytes,
                now,
                config,
            },
        )?;
        result.processed_databases += 1;
        if outcome.charged {
            result.charged_databases += 1;
        }
        if outcome.suspended {
            result.suspended_databases += 1;
        }
        result.paid_cycles = result
            .paid_cycles
            .checked_add(outcome.paid_cycles)
            .ok_or_else(|| "storage billing paid cycles overflow".to_string())?;
    }
    Ok(result)
}

fn settle_database_storage_billing_bulk_in_tx(
    tx: &Transaction<'_>,
    caller: &str,
    databases: Vec<DatabaseMeta>,
    now: i64,
    config: &CyclesBillingConfig,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    prepare_storage_billing_input_table(tx)?;
    insert_storage_billing_input_rows(tx, &databases)?;
    let account_rows = load_storage_billing_account_rows(tx)?;
    let min_balance = cycles_to_i64(config.min_update_cycles)?;
    let work_rows = account_rows
        .into_iter()
        .map(|row| storage_billing_work_row(row, now, min_balance))
        .collect::<Result<Vec<_>, String>>()?;
    prepare_storage_billing_work_table(tx)?;
    insert_storage_billing_work_rows(tx, &work_rows)?;
    bulk_update_storage_billing_accounts(tx, now)?;
    bulk_insert_storage_billing_ledger(tx, caller, now, config)?;
    let result = load_storage_billing_bulk_result(tx, next_cursor_mount_id)?;
    drop_storage_billing_temp_tables(tx)?;
    Ok(result)
}

fn prepare_storage_billing_input_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_input", params![])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE temp_storage_billing_input (
           database_id TEXT PRIMARY KEY,
           logical_size_bytes INTEGER NOT NULL
         )",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_storage_billing_input_rows(
    tx: &Transaction<'_>,
    databases: &[DatabaseMeta],
) -> Result<(), String> {
    for chunk in databases.chunks(250) {
        let placeholders = (0..chunk.len())
            .map(|index| {
                let first = index * 2 + 1;
                format!("(?{first}, ?{})", first + 1)
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO temp_storage_billing_input (database_id, logical_size_bytes)
             VALUES {placeholders}"
        );
        let mut values = Vec::with_capacity(chunk.len() * 2);
        for meta in chunk {
            values.push(crate::sqlite::text_value(meta.database_id.as_str()));
            values.push(crate::sqlite::integer_value(
                i64::try_from(meta.logical_size_bytes).unwrap_or(i64::MAX),
            ));
        }
        crate::sqlite::execute_values(tx, &sql, &values).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn load_storage_billing_account_rows(
    tx: &Transaction<'_>,
) -> Result<Vec<StorageBillingAccountRow>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT i.database_id, i.logical_size_bytes, a.balance_cycles,
                    a.suspended_at_ms, a.storage_charged_at_ms
             FROM temp_storage_billing_input i
             LEFT JOIN database_cycle_accounts a ON a.database_id = i.database_id
             ORDER BY i.rowid ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = crate::sqlite::query_map(&mut stmt, params![], |row| {
        Ok((
            crate::sqlite::row_get::<String>(row, 0)?,
            crate::sqlite::row_get::<i64>(row, 1)?,
            crate::sqlite::row_get::<Option<i64>>(row, 2)?,
            crate::sqlite::row_get::<Option<i64>>(row, 3)?,
            crate::sqlite::row_get::<Option<i64>>(row, 4)?,
        ))
    })
    .map_err(|error| error.to_string())?;
    rows.into_iter()
        .map(
            |(database_id, size_bytes, balance_cycles, suspended_at_ms, storage_charged_at_ms)| {
                let balance_cycles = balance_cycles
                    .ok_or_else(|| format!("database cycles account not found: {database_id}"))?;
                Ok(StorageBillingAccountRow {
                    database_id,
                    size_bytes: size_bytes.max(0) as u64,
                    balance_cycles,
                    suspended_at_ms,
                    storage_charged_at_ms,
                })
            },
        )
        .collect()
}

fn storage_billing_work_row(
    row: StorageBillingAccountRow,
    now: i64,
    min_balance: i64,
) -> Result<StorageBillingWorkRow, String> {
    let Some(charged_at_ms) = row.storage_charged_at_ms else {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: now,
            storage_cycles: 0,
            paid_cycles: 0,
            update_account: true,
            charged: false,
            newly_suspended: false,
        });
    };
    let elapsed_ms = now.saturating_sub(charged_at_ms);
    if elapsed_ms < STORAGE_BILLING_INTERVAL_MS {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: charged_at_ms,
            storage_cycles: 0,
            paid_cycles: 0,
            update_account: false,
            charged: false,
            newly_suspended: false,
        });
    }
    let storage_cycles_u128 = compute_storage_charge_cycles(row.size_bytes, elapsed_ms)?;
    let storage_cycles = i64::try_from(storage_cycles_u128)
        .map_err(|_| "storage charge exceeds i64 limit".to_string())?;
    if storage_cycles == 0 {
        return Ok(StorageBillingWorkRow {
            database_id: row.database_id,
            next_balance: row.balance_cycles,
            suspended_at_ms: row.suspended_at_ms,
            storage_charged_at_ms: now,
            storage_cycles,
            paid_cycles: 0,
            update_account: true,
            charged: false,
            newly_suspended: false,
        });
    }
    let paid_cycles = row.balance_cycles.min(storage_cycles).max(0);
    let next_balance = row.balance_cycles.saturating_sub(paid_cycles);
    let should_suspend = paid_cycles < storage_cycles || next_balance < min_balance;
    let suspended_at_ms = if should_suspend {
        row.suspended_at_ms.or(Some(now))
    } else {
        None
    };
    let newly_suspended = should_suspend && row.suspended_at_ms.is_none();
    Ok(StorageBillingWorkRow {
        database_id: row.database_id,
        next_balance,
        suspended_at_ms,
        storage_charged_at_ms: now,
        storage_cycles,
        paid_cycles,
        update_account: true,
        charged: paid_cycles > 0,
        newly_suspended,
    })
}

fn prepare_storage_billing_work_table(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_work", params![])
        .map_err(|error| error.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE temp_storage_billing_work (
           database_id TEXT PRIMARY KEY,
           next_balance INTEGER NOT NULL,
           suspended_at_ms INTEGER,
           storage_charged_at_ms INTEGER NOT NULL,
           storage_cycles INTEGER NOT NULL,
           paid_cycles INTEGER NOT NULL,
           update_account INTEGER NOT NULL,
           charged INTEGER NOT NULL,
           newly_suspended INTEGER NOT NULL
         )",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_storage_billing_work_rows(
    tx: &Transaction<'_>,
    rows: &[StorageBillingWorkRow],
) -> Result<(), String> {
    for chunk in rows.chunks(100) {
        let placeholders = (0..chunk.len())
            .map(|index| {
                let first = index * 9 + 1;
                format!(
                    "(?{first}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{})",
                    first + 1,
                    first + 2,
                    first + 3,
                    first + 4,
                    first + 5,
                    first + 6,
                    first + 7,
                    first + 8
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO temp_storage_billing_work
             (database_id, next_balance, suspended_at_ms, storage_charged_at_ms,
              storage_cycles, paid_cycles, update_account, charged, newly_suspended)
             VALUES {placeholders}"
        );
        let mut values = Vec::with_capacity(chunk.len() * 9);
        for row in chunk {
            values.push(crate::sqlite::text_value(row.database_id.as_str()));
            values.push(crate::sqlite::integer_value(row.next_balance));
            values.push(crate::sqlite::nullable_integer_value(row.suspended_at_ms));
            values.push(crate::sqlite::integer_value(row.storage_charged_at_ms));
            values.push(crate::sqlite::integer_value(row.storage_cycles));
            values.push(crate::sqlite::integer_value(row.paid_cycles));
            values.push(crate::sqlite::integer_value(if row.update_account {
                1
            } else {
                0
            }));
            values.push(crate::sqlite::integer_value(if row.charged {
                1
            } else {
                0
            }));
            values.push(crate::sqlite::integer_value(if row.newly_suspended {
                1
            } else {
                0
            }));
        }
        crate::sqlite::execute_values(tx, &sql, &values).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn bulk_update_storage_billing_accounts(tx: &Transaction<'_>, now: i64) -> Result<(), String> {
    tx.execute(
        "UPDATE database_cycle_accounts
         SET balance_cycles = (
               SELECT next_balance
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             suspended_at_ms = (
               SELECT suspended_at_ms
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             storage_charged_at_ms = (
               SELECT storage_charged_at_ms
               FROM temp_storage_billing_work
               WHERE temp_storage_billing_work.database_id = database_cycle_accounts.database_id
             ),
             updated_at_ms = ?1
         WHERE database_id IN (
             SELECT database_id FROM temp_storage_billing_work WHERE update_account = 1
         )",
        params![now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn bulk_insert_storage_billing_ledger(
    tx: &Transaction<'_>,
    caller: &str,
    now: i64,
    config: &CyclesBillingConfig,
) -> Result<(), String> {
    let cycles_per_kinic = i64::try_from(config.cycles_per_kinic).unwrap_or(i64::MAX);
    tx.execute(
        "INSERT INTO database_cycle_ledger
         (database_id, kind, amount_cycles, balance_after_cycles, payment_amount_e8s,
          caller, method, cycles_delta, cycles_per_kinic, ledger_block_index, created_at_ms)
         SELECT database_id, kind, amount_cycles, next_balance, NULL,
                ?1, 'storage_billing', storage_cycles, ?2, NULL, ?3
         FROM (
             SELECT rowid AS work_order, 0 AS ledger_order, database_id,
                    'storage_charge' AS kind, -paid_cycles AS amount_cycles,
                    next_balance, storage_cycles
             FROM temp_storage_billing_work
             WHERE paid_cycles > 0
             UNION ALL
             SELECT rowid AS work_order, 1 AS ledger_order, database_id,
                    'suspend' AS kind, 0 AS amount_cycles,
                    next_balance, storage_cycles
             FROM temp_storage_billing_work
             WHERE newly_suspended = 1
         )
         ORDER BY work_order ASC, ledger_order ASC",
        params![caller, cycles_per_kinic, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_storage_billing_bulk_result(
    tx: &Transaction<'_>,
    next_cursor_mount_id: Option<u16>,
) -> Result<StorageBillingBatchResult, String> {
    tx.query_row(
        "SELECT COUNT(*),
                COALESCE(SUM(charged), 0),
                COALESCE(SUM(newly_suspended), 0),
                COALESCE(SUM(paid_cycles), 0)
         FROM temp_storage_billing_work",
        params![],
        |row| {
            let processed: i64 = crate::sqlite::row_get(row, 0)?;
            let charged: i64 = crate::sqlite::row_get(row, 1)?;
            let suspended: i64 = crate::sqlite::row_get(row, 2)?;
            let paid: i64 = crate::sqlite::row_get(row, 3)?;
            Ok(StorageBillingBatchResult {
                processed_databases: processed.max(0) as u32,
                charged_databases: charged.max(0) as u32,
                suspended_databases: suspended.max(0) as u32,
                paid_cycles: paid.max(0) as u64,
                next_cursor_mount_id,
            })
        },
    )
    .map_err(|error| error.to_string())
}

fn drop_storage_billing_temp_tables(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_work", params![])
        .map_err(|error| error.to_string())?;
    tx.execute("DROP TABLE IF EXISTS temp_storage_billing_input", params![])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn settle_database_storage_charge_in_tx(
    tx: &Transaction<'_>,
    input: StorageChargeInput<'_>,
) -> Result<StorageChargeOutcome, String> {
    let account = load_storage_cycle_account(tx, input.database_id)?;
    let Some(charged_at_ms) = account.storage_charged_at_ms else {
        update_database_storage_account(
            tx,
            input.database_id,
            account.balance_cycles,
            account.suspended_at_ms,
            input.now,
            input.now,
        )?;
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    };
    let elapsed_ms = input.now.saturating_sub(charged_at_ms);
    if elapsed_ms < STORAGE_BILLING_INTERVAL_MS {
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    }
    let storage_cycles = compute_storage_charge_cycles(input.size_bytes, elapsed_ms)?;
    if storage_cycles == 0 {
        update_database_storage_account(
            tx,
            input.database_id,
            account.balance_cycles,
            account.suspended_at_ms,
            input.now,
            input.now,
        )?;
        return Ok(StorageChargeOutcome {
            charged: false,
            suspended: false,
            paid_cycles: 0,
        });
    }
    let charge_cycles = i64::try_from(storage_cycles)
        .map_err(|_| "storage charge exceeds i64 limit".to_string())?;

    let paid_cycles = account.balance_cycles.min(charge_cycles).max(0);
    let next_balance = account.balance_cycles.saturating_sub(paid_cycles);
    let min_balance = cycles_to_i64(input.config.min_update_cycles)?;
    let should_suspend = paid_cycles < charge_cycles || next_balance < min_balance;
    let suspended_at_ms = if should_suspend {
        account.suspended_at_ms.or(Some(input.now))
    } else {
        None
    };
    let newly_suspended = should_suspend && account.suspended_at_ms.is_none();
    update_database_storage_account(
        tx,
        input.database_id,
        next_balance,
        suspended_at_ms,
        input.now,
        input.now,
    )?;
    if paid_cycles > 0 {
        insert_database_ledger(
            tx,
            DatabaseLedgerInsert {
                database_id: input.database_id,
                kind: "storage_charge",
                amount_cycles: -paid_cycles,
                balance_after_cycles: next_balance,
                payment_amount_e8s: None,
                caller: input.caller,
                method: Some("storage_billing"),
                cycles_delta: Some(storage_cycles),
                config: Some(input.config),
                ledger_block_index: None,
                now: input.now,
            },
        )?;
    }
    if newly_suspended {
        insert_database_ledger(
            tx,
            DatabaseLedgerInsert {
                database_id: input.database_id,
                kind: "suspend",
                amount_cycles: 0,
                balance_after_cycles: next_balance,
                payment_amount_e8s: None,
                caller: input.caller,
                method: Some("storage_billing"),
                cycles_delta: Some(storage_cycles),
                config: Some(input.config),
                ledger_block_index: None,
                now: input.now,
            },
        )?;
    }
    Ok(StorageChargeOutcome {
        charged: paid_cycles > 0,
        suspended: newly_suspended,
        paid_cycles: u64::try_from(paid_cycles).unwrap_or(0),
    })
}

fn charge_database_update_in_tx(
    tx: &Transaction<'_>,
    charge: DatabaseCharge<'_>,
) -> Result<(), String> {
    let applied = apply_database_update_charge(tx, &charge)?;
    insert_database_ledger(
        tx,
        DatabaseLedgerInsert {
            database_id: charge.database_id,
            kind: "charge",
            amount_cycles: -applied.paid_cycles,
            balance_after_cycles: applied.balance_after_cycles,
            payment_amount_e8s: None,
            caller: charge.caller,
            method: Some(charge.method),
            cycles_delta: Some(charge.cycles_delta),
            config: Some(charge.config),
            ledger_block_index: None,
            now: charge.now,
        },
    )?;
    Ok(())
}

fn apply_database_update_charge(
    tx: &Transaction<'_>,
    charge: &DatabaseCharge<'_>,
) -> Result<AppliedDatabaseCharge, String> {
    let min = cycles_to_i64(charge.config.min_update_cycles)?;
    tx.query_row(
        "WITH charge_input AS MATERIALIZED (
             SELECT min(max(balance_cycles, 0), ?2) AS paid_cycles,
                    max(balance_cycles, 0) - min(max(balance_cycles, 0), ?2)
                        AS balance_after_cycles
             FROM database_cycle_accounts
             WHERE database_id = ?1
         )
         UPDATE database_cycle_accounts
         SET balance_cycles = (SELECT balance_after_cycles FROM charge_input),
             suspended_at_ms = CASE
                 WHEN (SELECT balance_after_cycles FROM charge_input) >= ?3 THEN NULL
                 ELSE ?4
             END,
             updated_at_ms = ?4
         WHERE database_id = ?1 AND EXISTS (SELECT 1 FROM charge_input)
         RETURNING (SELECT paid_cycles FROM charge_input), balance_cycles",
        params![charge.database_id, charge.computed_charge, min, charge.now],
        |row| {
            Ok(AppliedDatabaseCharge {
                paid_cycles: crate::sqlite::row_get(row, 0)?,
                balance_after_cycles: crate::sqlite::row_get(row, 1)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database cycles account not found: {}", charge.database_id))
}

fn compute_update_charge(cycles_delta: u128) -> Result<i64, String> {
    i64::try_from(cycles_delta).map_err(|_| "cycle charge exceeds i64 limit".to_string())
}

fn compute_storage_charge_cycles(size_bytes: u64, elapsed_ms: i64) -> Result<u128, String> {
    if elapsed_ms <= 0 || size_bytes == 0 {
        return Ok(0);
    }
    let elapsed_seconds = u128::try_from(elapsed_ms / 1000)
        .map_err(|_| "storage billing elapsed time is negative".to_string())?;
    let byte_seconds = u128::from(size_bytes)
        .checked_mul(elapsed_seconds)
        .ok_or_else(|| "storage byte seconds overflow".to_string())?;
    byte_seconds
        .checked_mul(STORAGE_CYCLES_PER_GIB_SECOND)
        .ok_or_else(|| "storage charge cycles overflow".to_string())
        .map(|cycles| cycles / GIB_BYTES)
}

fn page_limit(limit: u32) -> u32 {
    limit.clamp(1, 100)
}

fn map_database_cycles_entry(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseCycleEntry> {
    let entry_id: i64 = crate::sqlite::row_get(row, 0)?;
    let balance_after: i64 = crate::sqlite::row_get(row, 4)?;
    let payment_amount_e8s: Option<i64> = crate::sqlite::row_get(row, 5)?;
    let cycles_delta: Option<i64> = crate::sqlite::row_get(row, 8)?;
    let cycles_per_kinic: Option<i64> = crate::sqlite::row_get(row, 9)?;
    let ledger_block_index: Option<i64> = crate::sqlite::row_get(row, 10)?;
    Ok(DatabaseCycleEntry {
        entry_id: entry_id.max(0) as u64,
        database_id: crate::sqlite::row_get(row, 1)?,
        kind: crate::sqlite::row_get(row, 2)?,
        amount_cycles: crate::sqlite::row_get(row, 3)?,
        balance_after_cycles: balance_after.max(0) as u64,
        payment_amount_e8s: payment_amount_e8s.map(|value| value.max(0) as u64),
        caller: crate::sqlite::row_get(row, 6)?,
        method: crate::sqlite::row_get(row, 7)?,
        cycles_delta: cycles_delta.map(|value| value.max(0) as u64),
        cycles_per_kinic: cycles_per_kinic.map(|value| value.max(0) as u64),
        ledger_block_index: ledger_block_index.map(|value| value.max(0) as u64),
        created_at_ms: crate::sqlite::row_get(row, 11)?,
    })
}

fn validate_url_ingest_trigger_session_request(
    request: &UrlIngestTriggerSessionRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_url_ingest_trigger_session_nonce(&request.session_nonce)
}

fn validate_url_ingest_trigger_session_check_request(
    request: &UrlIngestTriggerSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_url_ingest_trigger_session_nonce(&request.session_nonce)?;
    validate_url_ingest_request_path(&request.request_path)
}

fn validate_ops_answer_session_request(request: &OpsAnswerSessionRequest) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_ops_answer_session_check_request(
    request: &OpsAnswerSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_source_for_generation_request(
    request: &WriteSourceForGenerationRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_raw_source_run_path(&request.path)?;
    validate_session_nonce(&request.session_nonce)
}

fn validate_source_run_session_check_request(
    request: &SourceRunSessionCheckRequest,
) -> Result<(), String> {
    if request.database_id.trim().is_empty() {
        return Err("database_id is required".to_string());
    }
    validate_raw_source_run_path(&request.source_path)?;
    if request.source_etag.trim().is_empty() {
        return Err("source_etag is required".to_string());
    }
    validate_session_nonce(&request.session_nonce)
}

fn validate_raw_source_run_path(path: &str) -> Result<(), String> {
    if !(path == RAW_SOURCES_PREFIX || path.starts_with(&format!("{RAW_SOURCES_PREFIX}/"))) {
        return Err(format!(
            "source_path must stay under {RAW_SOURCES_PREFIX}: {path}"
        ));
    }
    validate_source_path_for_kind(path, &NodeKind::Source)
}

fn validate_url_ingest_trigger_session_nonce(session_nonce: &str) -> Result<(), String> {
    validate_session_nonce(session_nonce)
}

fn validate_session_nonce(session_nonce: &str) -> Result<(), String> {
    if session_nonce.trim().is_empty() {
        return Err("session_nonce is required".to_string());
    }
    if session_nonce.len() > 128 {
        return Err("session_nonce is too long".to_string());
    }
    Ok(())
}

fn validate_url_ingest_request_path(request_path: &str) -> Result<(), String> {
    if !request_path.starts_with("/Sources/ingest-requests/") || !request_path.ends_with(".md") {
        return Err("request_path must be a URL ingest request path".to_string());
    }
    Ok(())
}

fn validate_url_ingest_request_node(node: &Node, caller: &str) -> Result<(), String> {
    if node.kind != NodeKind::File {
        return Err("url ingest request must be a file node".to_string());
    }
    let frontmatter = parse_frontmatter_fields(&node.content)?;
    expect_frontmatter(&frontmatter, "kind", "kinic.url_ingest_request")?;
    expect_frontmatter(&frontmatter, "schema_version", "1")?;
    let status = frontmatter
        .get("status")
        .and_then(|value| value.as_deref())
        .ok_or_else(|| "url ingest request status is required".to_string())?;
    if status != "queued"
        && status != "fetching"
        && status != "source_written"
        && status != "generating"
    {
        return Err("url ingest request is not triggerable".to_string());
    }
    let requested_by = frontmatter
        .get("requested_by")
        .and_then(|value| value.as_deref())
        .ok_or_else(|| "url ingest request requested_by is required".to_string())?;
    if requested_by != caller {
        return Err("url ingest request caller mismatch".to_string());
    }
    Ok(())
}

fn parse_frontmatter_fields(content: &str) -> Result<BTreeMap<String, Option<String>>, String> {
    let rest = content
        .strip_prefix("---\n")
        .ok_or_else(|| "url ingest request frontmatter is required".to_string())?;
    let end = frontmatter_end(rest)
        .ok_or_else(|| "url ingest request frontmatter is not closed".to_string())?;
    let frontmatter = &rest[..end];
    let mut fields = BTreeMap::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err("url ingest request frontmatter is invalid".to_string());
        };
        fields.insert(key.trim().to_string(), frontmatter_scalar(value.trim())?);
    }
    Ok(fields)
}

fn frontmatter_scalar(value: &str) -> Result<Option<String>, String> {
    if value == "null" || value == "~" {
        return Ok(None);
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return parse_json_string_literal(value).map(Some);
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Ok(Some(value[1..value.len() - 1].replace("''", "'")));
    }
    Ok(Some(value.to_string()))
}

fn frontmatter_end(rest: &str) -> Option<usize> {
    rest.find("\n---\n").or_else(|| {
        rest.ends_with("\n---")
            .then_some(rest.len() - "\n---".len())
    })
}

fn parse_json_string_literal(value: &str) -> Result<String, String> {
    let body = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .ok_or_else(|| "url ingest request frontmatter quoted scalar is invalid".to_string())?;
    let mut chars = body.chars();
    let mut decoded = String::new();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next().ok_or_else(invalid_quoted_scalar)?;
            decode_json_escape(escaped, &mut chars, &mut decoded)?;
            continue;
        }
        if ch.is_control() {
            return Err(invalid_quoted_scalar());
        }
        decoded.push(ch);
    }
    Ok(decoded)
}

fn decode_json_escape(
    escaped: char,
    chars: &mut std::str::Chars<'_>,
    decoded: &mut String,
) -> Result<(), String> {
    match escaped {
        '"' => decoded.push('"'),
        '\\' => decoded.push('\\'),
        '/' => decoded.push('/'),
        'b' => decoded.push('\u{0008}'),
        'f' => decoded.push('\u{000c}'),
        'n' => decoded.push('\n'),
        'r' => decoded.push('\r'),
        't' => decoded.push('\t'),
        'u' => {
            let code = parse_json_hex4(chars)?;
            if (0xD800..=0xDBFF).contains(&code) {
                let slash = chars.next().ok_or_else(invalid_quoted_scalar)?;
                let marker = chars.next().ok_or_else(invalid_quoted_scalar)?;
                if slash != '\\' || marker != 'u' {
                    return Err(invalid_quoted_scalar());
                }
                let low = parse_json_hex4(chars)?;
                if !(0xDC00..=0xDFFF).contains(&low) {
                    return Err(invalid_quoted_scalar());
                }
                let scalar = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                decoded.push(char::from_u32(scalar).ok_or_else(invalid_quoted_scalar)?);
            } else if (0xDC00..=0xDFFF).contains(&code) {
                return Err(invalid_quoted_scalar());
            } else {
                decoded.push(char::from_u32(code).ok_or_else(invalid_quoted_scalar)?);
            }
        }
        _ => return Err(invalid_quoted_scalar()),
    }
    Ok(())
}

fn parse_json_hex4(chars: &mut std::str::Chars<'_>) -> Result<u32, String> {
    let mut code = 0u32;
    for _ in 0..4 {
        code *= 16;
        code += chars
            .next()
            .and_then(|ch| ch.to_digit(16))
            .ok_or_else(invalid_quoted_scalar)?;
    }
    Ok(code)
}

fn invalid_quoted_scalar() -> String {
    "url ingest request frontmatter quoted scalar is invalid".to_string()
}

fn expect_frontmatter(
    frontmatter: &BTreeMap<String, Option<String>>,
    key: &str,
    expected: &str,
) -> Result<(), String> {
    let value = frontmatter
        .get(key)
        .and_then(|value| value.as_deref())
        .ok_or_else(|| format!("url ingest request {key} is required"))?;
    if value == expected {
        Ok(())
    } else {
        Err(format!("url ingest request {key} is invalid"))
    }
}

fn purge_expired_url_ingest_trigger_sessions(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM url_ingest_trigger_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn purge_expired_ops_answer_sessions(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM ops_answer_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn purge_expired_source_run_sessions(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM source_run_sessions WHERE expires_at_ms < ?1",
        params![now],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn load_restore_chunks(conn: &Connection, database_id: &str) -> Result<Vec<RestoreChunk>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT offset_bytes, end_bytes, bytes
             FROM database_restore_chunks
             WHERE database_id = ?1
             ORDER BY offset_bytes ASC, end_bytes ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![database_id], |row| {
        let offset = u64::try_from(crate::sqlite::row_get::<i64>(row, 0)?)
            .map_err(|_| crate::sqlite::invalid_query())?;
        let end = u64::try_from(crate::sqlite::row_get::<i64>(row, 1)?)
            .map_err(|_| crate::sqlite::invalid_query())?;
        let bytes: Option<Vec<u8>> = crate::sqlite::row_get(row, 2)?;
        Ok(RestoreChunk {
            offset,
            end,
            bytes: bytes.unwrap_or_default(),
        })
    })
    .map_err(|error| error.to_string())
}

fn restore_chunks_cover_expected_size(
    chunks: &[RestoreChunk],
    expected_size: u64,
) -> Result<bool, String> {
    if expected_size == 0 {
        return Ok(true);
    }
    let mut covered_end = 0_u64;
    for chunk in chunks {
        if chunk.offset != covered_end {
            return Ok(false);
        }
        if chunk.end > expected_size {
            return Ok(false);
        }
        if chunk.end.saturating_sub(chunk.offset) != chunk.bytes.len() as u64 {
            return Ok(false);
        }
        covered_end = covered_end.max(chunk.end);
        if covered_end == expected_size {
            return Ok(true);
        }
    }
    Ok(false)
}

fn record_database_restore_session(
    conn: &Connection,
    rollback: &DatabaseRestoreRollback,
    now: i64,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(rollback.database_id.clone()),
        crate::sqlite::text_value(status_to_db(rollback.status)),
        crate::sqlite::nullable_integer_value(rollback.active_mount_id.map(i64::from)),
        crate::sqlite::nullable_blob_value(rollback.snapshot_hash.clone()),
        crate::sqlite::nullable_integer_value(rollback.archived_at_ms),
        crate::sqlite::nullable_integer_value(
            rollback
                .restore_size_bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|error| error.to_string())?,
        ),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_restore_sessions
         (database_id, status, active_mount_id, snapshot_hash, archived_at_ms,
          restore_size_bytes, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn restore_database_state(
    conn: &Connection,
    rollback: &DatabaseRestoreRollback,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM database_restore_sessions WHERE database_id = ?1",
        params![rollback.database_id.as_str()],
    )
    .map_err(|error| error.to_string())?;
    let values = vec![
        crate::sqlite::text_value(rollback.database_id.clone()),
        crate::sqlite::text_value(status_to_db(rollback.status)),
        crate::sqlite::nullable_integer_value(rollback.active_mount_id.map(i64::from)),
        crate::sqlite::nullable_blob_value(rollback.snapshot_hash.clone()),
        crate::sqlite::nullable_integer_value(rollback.archived_at_ms),
        crate::sqlite::nullable_integer_value(
            rollback
                .restore_size_bytes
                .map(i64::try_from)
                .transpose()
                .map_err(|error| error.to_string())?,
        ),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE databases
	         SET status = ?2,
	             active_mount_id = ?3,
	             snapshot_hash = ?4,
	             archived_at_ms = ?5,
	             restore_size_bytes = ?6,
	             updated_at_ms = ?7
	        WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_database_id(database_id: &str) -> Result<(), String> {
    if database_id.is_empty() || database_id.len() > 64 {
        return Err("database_id must be 1..64 characters".to_string());
    }
    if !database_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("database_id may only contain ASCII letters, digits, '-' and '_'".to_string());
    }
    Ok(())
}

fn normalize_database_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_DATABASE_NAME_CHARS {
        return Err(format!(
            "database name must be 1..{MAX_DATABASE_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("database name may not contain control characters".to_string());
    }
    Ok(name.to_string())
}

fn generated_database_id(caller: &str, now: i64, mount_id: u16, attempt: u32) -> String {
    let mut hasher = Sha256::new();
    hasher.update(caller.as_bytes());
    hasher.update(now.to_be_bytes());
    hasher.update(mount_id.to_be_bytes());
    hasher.update(attempt.to_be_bytes());
    format!(
        "{GENERATED_DATABASE_ID_PREFIX}{}",
        &base32_lower(&hasher.finalize())[..GENERATED_DATABASE_ID_HASH_CHARS]
    )
}

fn base32_lower(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut output = String::new();
    let mut buffer = 0_u16;
    let mut bit_count = 0_u8;
    for byte in bytes {
        buffer = (buffer << 8) | u16::from(*byte);
        bit_count += 8;
        while bit_count >= 5 {
            let shift = bit_count - 5;
            let index = ((buffer >> shift) & 0b11111) as usize;
            output.push(ALPHABET[index] as char);
            bit_count -= 5;
            buffer &= (1_u16 << bit_count) - 1;
        }
    }
    if bit_count > 0 {
        let index = ((buffer << (5 - bit_count)) & 0b11111) as usize;
        output.push(ALPHABET[index] as char);
    }
    output
}

fn fnv1a64_update(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV1A64_PRIME);
    }
    hash
}

#[cfg(not(target_arch = "wasm32"))]
fn database_file_name(databases_dir: &Path, database_id: &str) -> Result<String, String> {
    validate_database_id(database_id)?;
    Ok(databases_dir
        .join(format!("{database_id}.sqlite3"))
        .to_string_lossy()
        .into_owned())
}

fn database_exists(conn: &Connection, database_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM databases WHERE database_id = ?1",
        params![database_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn database_has_owner(conn: &Connection, database_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM database_members
         WHERE database_id = ?1 AND role = 'owner'
         LIMIT 1",
        params![database_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn insert_initial_database_members(
    tx: &Transaction<'_>,
    database_id: &str,
    caller: &str,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO database_members
         (database_id, principal, role, created_at_ms)
         VALUES (?1, ?2, 'owner', ?3)",
        params![database_id, caller, now],
    )
    .map_err(|error| error.to_string())?;
    if caller != DEFAULT_LLM_WRITER_PRINCIPAL {
        tx.execute(
            "INSERT INTO database_members
             (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, 'writer', ?3)",
            params![database_id, DEFAULT_LLM_WRITER_PRINCIPAL, now],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn allocate_mount_id(conn: &Connection) -> Result<u16, String> {
    let mut stmt = conn
        .prepare(
            "SELECT mount_id AS used_mount_id
             FROM database_mount_history
             ORDER BY used_mount_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let used = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<i64>(row, 0)
    })
    .map_err(|error| error.to_string())?;
    let mut used = used.into_iter().map(mount_id_from_db).peekable();
    for mount_id in MIN_DATABASE_MOUNT_ID..=MAX_DATABASE_MOUNT_ID {
        while let Some(used_mount_id) = used.peek() {
            match used_mount_id {
                Ok(used_mount_id) if *used_mount_id < mount_id => {
                    used.next();
                }
                Ok(used_mount_id) if *used_mount_id == mount_id => break,
                Ok(_) => return Ok(mount_id),
                Err(error) => return Err(error.to_string()),
            }
        }
        if used.peek().is_none() {
            return Ok(mount_id);
        }
        used.next();
    }
    Err("database mount_id capacity exhausted".to_string())
}

fn record_mount_history(
    conn: &Connection,
    database_id: &str,
    mount_id: u16,
    reason: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_mount_history
         (database_id, mount_id, reason, created_at_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![database_id, i64::from(mount_id), reason, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_snapshot_hash(snapshot_hash: &[u8]) -> Result<(), String> {
    if snapshot_hash.len() == SHA256_DIGEST_BYTES {
        Ok(())
    } else {
        Err(format!(
            "snapshot_hash must be a {SHA256_DIGEST_BYTES}-byte SHA-256 digest"
        ))
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn file_sha256(path: &str) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_vec())
}

fn database_meta_error(conn: &Connection, database_id: &str) -> String {
    match conn
        .query_row(
            "SELECT status FROM databases WHERE database_id = ?1",
            params![database_id],
            |row| crate::sqlite::row_get::<String>(row, 0),
        )
        .optional()
    {
        Ok(Some(status))
            if status == "active"
                || status == "pending"
                || status == "archived"
                || status == "archiving"
                || status == "restoring" =>
        {
            format!("database is {status}: {database_id}")
        }
        _ => format!("database not found: {database_id}"),
    }
}

fn load_database(conn: &Connection, database_id: &str) -> Result<Option<DatabaseMeta>, String> {
    load_database_with_statuses(conn, database_id, &[DatabaseStatus::Active])
}

fn load_database_status(conn: &Connection, database_id: &str) -> Result<DatabaseStatus, String> {
    conn.query_row(
        "SELECT status FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| status_from_db(&crate::sqlite::row_get::<String>(row, 0)?),
    )
    .optional()
    .map_err(|error| error.to_string())?
    .ok_or_else(|| format!("database not found: {database_id}"))
}

fn load_database_with_statuses(
    conn: &Connection,
    database_id: &str,
    statuses: &[DatabaseStatus],
) -> Result<Option<DatabaseMeta>, String> {
    conn.query_row(
        "SELECT database_id, name, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE database_id = ?1",
        params![database_id],
        |row| map_database_meta_with_statuses(row, statuses),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_databases(conn: &Connection) -> Result<Vec<DatabaseMeta>, String> {
    let mut stmt = conn.prepare(
        "SELECT database_id, name, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status IN ('pending', 'active', 'archiving', 'archived', 'restoring') AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
    )
    .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], map_database_meta)
        .map_err(|error| error.to_string())
}

fn load_active_databases_for_storage_billing_batch(
    conn: &Connection,
    cursor_mount_id: u16,
    limit: u32,
) -> Result<StorageBillingDatabaseBatch, String> {
    let fetch_limit = i64::from(limit.saturating_add(1));
    let mut stmt = conn.prepare(
        "SELECT database_id, name, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status = 'active'
           AND active_mount_id IS NOT NULL
           AND mount_id > ?1
         ORDER BY mount_id ASC
         LIMIT ?2",
    )
    .map_err(|error| error.to_string())?;
    let mut databases = crate::sqlite::query_map(
        &mut stmt,
        params![i64::from(cursor_mount_id), fetch_limit],
        map_database_meta,
    )
    .map_err(|error| error.to_string())?;
    let next_cursor_mount_id = if databases.len() > limit as usize {
        databases.pop();
        databases.last().map(|meta| meta.mount_id)
    } else {
        None
    };
    Ok(StorageBillingDatabaseBatch {
        databases,
        next_cursor_mount_id,
    })
}

#[cfg(test)]
fn load_active_databases_for_storage_billing(
    conn: &Connection,
) -> Result<Vec<DatabaseMeta>, String> {
    let mut stmt = conn.prepare(
        "SELECT database_id, name, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status = 'active'
           AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
    )
    .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], map_database_meta)
        .map_err(|error| error.to_string())
}

fn storage_billing_batch_limit(limit: Option<u32>) -> u32 {
    limit
        .unwrap_or(DEFAULT_STORAGE_BILLING_BATCH_LIMIT)
        .clamp(1, MAX_STORAGE_BILLING_BATCH_LIMIT)
}

fn load_or_create_storage_billing_timer_state(
    tx: &Transaction<'_>,
    now: i64,
) -> Result<StorageBillingTimerState, String> {
    let existing = tx
        .query_row(
            "SELECT cursor_mount_id, billing_now_ms
             FROM storage_billing_state
             WHERE key = 'timer'",
            params![],
            |row| {
                let cursor: Option<i64> = crate::sqlite::row_get(row, 0)?;
                Ok(StorageBillingTimerState {
                    cursor_mount_id: cursor.map(mount_id_from_db).transpose()?,
                    billing_now_ms: crate::sqlite::row_get(row, 1)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(state) = existing {
        return Ok(state);
    }
    update_storage_billing_timer_state(tx, None, now, now)?;
    Ok(StorageBillingTimerState {
        cursor_mount_id: None,
        billing_now_ms: now,
    })
}

fn update_storage_billing_timer_state(
    tx: &Transaction<'_>,
    cursor_mount_id: Option<u16>,
    billing_now_ms: i64,
    updated_at_ms: i64,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO storage_billing_state
         (key, cursor_mount_id, billing_now_ms, updated_at_ms)
         VALUES ('timer', ?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           cursor_mount_id = excluded.cursor_mount_id,
           billing_now_ms = excluded.billing_now_ms,
           updated_at_ms = excluded.updated_at_ms",
        params![
            crate::sqlite::nullable_integer_value(cursor_mount_id.map(i64::from)),
            billing_now_ms,
            updated_at_ms
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn clear_storage_billing_timer_state(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute(
        "DELETE FROM storage_billing_state WHERE key = 'timer'",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn load_database_infos(conn: &Connection) -> Result<Vec<DatabaseInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, status, active_mount_id, schema_version, logical_size_bytes,
                snapshot_hash, archived_at_ms
         FROM databases
         ORDER BY database_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], |row| {
        let mount_id: Option<i64> = crate::sqlite::row_get(row, 3)?;
        let logical_size_bytes: i64 = crate::sqlite::row_get(row, 5)?;
        Ok(DatabaseInfo {
            database_id: crate::sqlite::row_get(row, 0)?,
            name: crate::sqlite::row_get(row, 1)?,
            status: status_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
            mount_id: mount_id.map(mount_id_from_db).transpose()?,
            schema_version: crate::sqlite::row_get(row, 4)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
            snapshot_hash: crate::sqlite::row_get(row, 6)?,
            archived_at_ms: crate::sqlite::row_get(row, 7)?,
        })
    })
    .map_err(|error| error.to_string())
}

fn load_database_summaries_for_caller(
    conn: &Connection,
    caller: &str,
) -> Result<Vec<DatabaseSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.database_id, d.name, d.status, m.role, d.logical_size_bytes,
                COALESCE(b.balance_cycles, 0), b.suspended_at_ms,
                d.archived_at_ms, d.deleted_at_ms
         FROM databases d
         INNER JOIN database_members m ON m.database_id = d.database_id
         LEFT JOIN database_cycle_accounts b ON b.database_id = d.database_id
         WHERE m.principal = ?1
         ORDER BY d.database_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![caller], |row| {
        let logical_size_bytes: i64 = crate::sqlite::row_get(row, 4)?;
        let cycles_balance: i64 = crate::sqlite::row_get(row, 5)?;
        Ok(DatabaseSummary {
            database_id: crate::sqlite::row_get(row, 0)?,
            name: crate::sqlite::row_get(row, 1)?,
            status: status_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
            role: role_from_db(&crate::sqlite::row_get::<String>(row, 3)?)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
            cycles_balance: Some(cycles_balance.max(0) as u64),
            cycles_suspended_at_ms: crate::sqlite::row_get(row, 6)?,
            archived_at_ms: crate::sqlite::row_get(row, 7)?,
            deleted_at_ms: crate::sqlite::row_get(row, 8)?,
        })
    })
    .map_err(|error| error.to_string())
}

fn map_database_meta_with_statuses(
    row: &crate::sqlite::Row<'_>,
    statuses: &[DatabaseStatus],
) -> crate::sqlite::Result<DatabaseMeta> {
    let status: String = crate::sqlite::row_get(row, 6).unwrap_or_else(|_| "active".to_string());
    let status = status_from_db(&status)?;
    if !statuses.contains(&status) {
        return Err(crate::sqlite::query_returned_no_rows());
    }
    map_database_meta(row)
}

fn map_database_meta(row: &crate::sqlite::Row<'_>) -> crate::sqlite::Result<DatabaseMeta> {
    let mount_id: Option<i64> = crate::sqlite::row_get(row, 3)?;
    let mount_id = mount_id.ok_or_else(crate::sqlite::query_returned_no_rows)?;
    let logical_size_bytes: i64 = crate::sqlite::row_get(row, 5)?;
    Ok(DatabaseMeta {
        database_id: crate::sqlite::row_get(row, 0)?,
        name: crate::sqlite::row_get(row, 1)?,
        db_file_name: crate::sqlite::row_get(row, 2)?,
        mount_id: mount_id_from_db(mount_id)?,
        schema_version: crate::sqlite::row_get(row, 4)?,
        logical_size_bytes: logical_size_bytes.max(0) as u64,
    })
}

fn mount_id_from_db(mount_id: i64) -> crate::sqlite::Result<u16> {
    u16::try_from(mount_id).map_err(|_| crate::sqlite::integral_value_out_of_range(2, mount_id))
}

fn load_member_role(
    conn: &Connection,
    database_id: &str,
    principal: &str,
) -> Result<Option<DatabaseRole>, String> {
    conn.query_row(
        "SELECT role FROM database_members WHERE database_id = ?1 AND principal = ?2",
        params![database_id, principal],
        |row| role_from_db(&crate::sqlite::row_get::<String>(row, 0)?),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn database_member_exists(
    conn: &Connection,
    database_id: &str,
    principal: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM database_members WHERE database_id = ?1 AND principal = ?2",
        params![database_id, principal],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map_err(|error| error.to_string())
    .map(|value| value.is_some())
}

fn database_member_count_for_conn(conn: &Connection, database_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM database_members WHERE database_id = ?1",
        params![database_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn role_from_db(role: &str) -> crate::sqlite::Result<DatabaseRole> {
    match role {
        "owner" => Ok(DatabaseRole::Owner),
        "writer" => Ok(DatabaseRole::Writer),
        "reader" => Ok(DatabaseRole::Reader),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

fn role_to_db(role: DatabaseRole) -> &'static str {
    match role {
        DatabaseRole::Owner => "owner",
        DatabaseRole::Writer => "writer",
        DatabaseRole::Reader => "reader",
    }
}

fn status_from_db(status: &str) -> crate::sqlite::Result<DatabaseStatus> {
    match status {
        "pending" => Ok(DatabaseStatus::Pending),
        "active" => Ok(DatabaseStatus::Active),
        "archiving" => Ok(DatabaseStatus::Archiving),
        "archived" => Ok(DatabaseStatus::Archived),
        "restoring" => Ok(DatabaseStatus::Restoring),
        "deleted" => Ok(DatabaseStatus::Deleted),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

fn status_to_db(status: DatabaseStatus) -> &'static str {
    match status {
        DatabaseStatus::Pending => "pending",
        DatabaseStatus::Active => "active",
        DatabaseStatus::Archiving => "archiving",
        DatabaseStatus::Archived => "archived",
        DatabaseStatus::Restoring => "restoring",
        DatabaseStatus::Deleted => "deleted",
    }
}

fn role_allows(role: DatabaseRole, required_role: RequiredRole) -> bool {
    match required_role {
        RequiredRole::Reader => matches!(
            role,
            DatabaseRole::Reader | DatabaseRole::Writer | DatabaseRole::Owner
        ),
        RequiredRole::Writer => matches!(role, DatabaseRole::Writer | DatabaseRole::Owner),
        RequiredRole::Owner => role == DatabaseRole::Owner,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn url_ingest_frontmatter_requires_whole_line_terminator() {
        let fields = parse_frontmatter_fields(
            "---\nkind: \"kinic.url_ingest_request\"\nstatus: queued\nnote: ---not-a-terminator\nrequested_by: alice\n---\n# Body\n",
        )
        .expect("frontmatter should parse at the real terminator");

        assert_eq!(
            fields.get("kind").and_then(|value| value.as_deref()),
            Some("kinic.url_ingest_request")
        );
        assert_eq!(
            fields
                .get("requested_by")
                .and_then(|value| value.as_deref()),
            Some("alice")
        );
    }

    #[test]
    fn url_ingest_frontmatter_unescapes_json_quoted_scalars() {
        let fields = parse_frontmatter_fields(
            "---\nkind: kinic.url_ingest_request\nrequested_by: \"principal-\\\"1\\\"-\\uD83D\\uDE00\"\n---\n# Body\n",
        )
        .expect("frontmatter should parse quoted scalars");

        assert_eq!(
            fields
                .get("requested_by")
                .and_then(|value| value.as_deref()),
            Some("principal-\"1\"-😀")
        );
    }

    #[test]
    fn url_ingest_frontmatter_rejects_invalid_json_quoted_scalars() {
        let error = parse_frontmatter_fields(
            "---\nkind: kinic.url_ingest_request\nrequested_by: \"principal-\\q\"\n---\n# Body\n",
        )
        .expect_err("invalid JSON escape must not be accepted as a raw quoted value");

        assert!(error.contains("quoted scalar"));
    }

    fn test_cycles_billing_config() -> CyclesBillingConfig {
        CyclesBillingConfig {
            kinic_ledger_canister_id: "aaaaa-aa".to_string(),
            billing_authority_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
            cycles_per_kinic: DEFAULT_CYCLES_PER_KINIC,
            min_update_cycles: DEFAULT_MIN_UPDATE_CYCLES,
        }
    }

    fn write_pre_cycles_schema(index_path: &Path) {
        let conn = Connection::open(index_path).expect("index DB should open");
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version TEXT PRIMARY KEY,
               applied_at INTEGER NOT NULL
             );
             INSERT INTO schema_migrations (version, applied_at) VALUES
	               ('database_index:000_initial', 0),
	               ('database_index:001_lifecycle', 0),
	               ('database_index:002_restore_size', 0),
	               ('database_index:003_restore_chunks', 0),
	               ('database_index:005_mount_history', 0),
	               ('database_index:006_url_ingest_trigger_sessions', 0),
	               ('database_index:007_ops_answer_sessions', 0),
               ('database_index:008_restore_sessions', 0),
               ('database_index:009_restore_chunk_bytes', 0),
               ('database_index:010_database_name_breaking', 0),
               ('database_index:011_source_run_sessions', 0);
             CREATE TABLE databases (
               database_id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               db_file_name TEXT NOT NULL,
               mount_id INTEGER NOT NULL,
               active_mount_id INTEGER,
               status TEXT NOT NULL DEFAULT 'active',
               schema_version TEXT NOT NULL,
               logical_size_bytes INTEGER NOT NULL DEFAULT 0,
               snapshot_hash BLOB,
               archived_at_ms INTEGER,
               deleted_at_ms INTEGER,
               restore_size_bytes INTEGER,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX databases_active_mount_id_idx
               ON databases(active_mount_id)
               WHERE active_mount_id IS NOT NULL;
             CREATE TABLE database_members (
               database_id TEXT NOT NULL,
               principal TEXT NOT NULL,
               role TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               PRIMARY KEY (database_id, principal),
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );
             CREATE TABLE database_restore_chunks (
               database_id TEXT NOT NULL,
               offset_bytes INTEGER NOT NULL,
               end_bytes INTEGER NOT NULL,
               bytes BLOB,
               PRIMARY KEY (database_id, offset_bytes, end_bytes),
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );
             CREATE INDEX database_restore_chunks_database_id_idx
               ON database_restore_chunks(database_id, offset_bytes);
	             CREATE TABLE database_mount_history (
               database_id TEXT NOT NULL,
               mount_id INTEGER NOT NULL,
               reason TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               PRIMARY KEY (mount_id)
             );
             CREATE TABLE url_ingest_trigger_sessions (
               database_id TEXT NOT NULL,
               session_nonce TEXT NOT NULL,
               principal TEXT NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               created_at_ms INTEGER NOT NULL,
               refreshed_at_ms INTEGER NOT NULL,
               PRIMARY KEY (database_id, session_nonce),
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );
             CREATE INDEX url_ingest_trigger_sessions_expiry_idx
               ON url_ingest_trigger_sessions(expires_at_ms);
             CREATE TABLE ops_answer_sessions (
               database_id TEXT NOT NULL,
               session_nonce TEXT NOT NULL,
               principal TEXT NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               created_at_ms INTEGER NOT NULL,
               refreshed_at_ms INTEGER NOT NULL,
               PRIMARY KEY (database_id, session_nonce),
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );
             CREATE INDEX ops_answer_sessions_expiry_idx
               ON ops_answer_sessions(expires_at_ms);
             CREATE TABLE source_run_sessions (
               database_id TEXT NOT NULL,
               source_path TEXT NOT NULL,
               source_etag TEXT NOT NULL,
               session_nonce TEXT NOT NULL,
               principal TEXT NOT NULL,
               expires_at_ms INTEGER NOT NULL,
               created_at_ms INTEGER NOT NULL,
               refreshed_at_ms INTEGER NOT NULL,
               PRIMARY KEY (database_id, session_nonce),
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );
             CREATE INDEX source_run_sessions_expiry_idx
               ON source_run_sessions(expires_at_ms);
             CREATE TABLE database_restore_sessions (
               database_id TEXT PRIMARY KEY,
               status TEXT NOT NULL,
               active_mount_id INTEGER,
               snapshot_hash BLOB,
               archived_at_ms INTEGER,
               deleted_at_ms INTEGER,
               restore_size_bytes INTEGER,
               created_at_ms INTEGER NOT NULL,
               FOREIGN KEY (database_id) REFERENCES databases(database_id)
             );",
        )
        .expect("pre-cycles schema should write");
    }

    #[test]
    fn old_upgrade_migrations_require_config() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        write_pre_cycles_schema(&index_path);
        let service = VfsService::new(index_path, dir.path().join("databases"));

        let error = service
            .run_index_migrations_for_upgrade(None)
            .expect_err("old index should require config");

        assert!(error.contains("cycles config required for first cycles upgrade"));
    }

    #[test]
    fn old_upgrade_migrations_apply_with_config() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        write_pre_cycles_schema(&index_path);
        let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
        let config = test_cycles_billing_config();

        service
            .run_index_migrations_for_upgrade(Some(config.clone()))
            .expect("old index should upgrade");

        assert_eq!(
            service.cycles_billing_config().expect("config should load"),
            config
        );
        let conn = Connection::open(&index_path).expect("index DB should reopen");
        let marker: String = conn
            .query_row(
                "SELECT version FROM schema_migrations
	                 WHERE version = 'database_index:018_cycles_ledger_only'",
                params![],
                |row| row.get(0),
            )
            .expect("cycle ledger only marker should exist");
        let usage_table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
	                 WHERE type = 'table' AND name = 'usage_events'",
                params![],
                |row| row.get(0),
            )
            .expect("usage table count should load");
        assert_eq!(marker, "database_index:018_cycles_ledger_only");
        assert_eq!(usage_table_count, 0);
    }

    #[test]
    fn upgrade_migrations_accept_no_config_after_cycles_initial() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        let config = test_cycles_billing_config();
        service
            .run_index_migrations_with_config(config.clone())
            .expect("initial migrations should run");

        service
            .run_index_migrations_for_upgrade(None)
            .expect("post-cycles upgrade should not need config");

        assert_eq!(
            service.cycles_billing_config().expect("config should load"),
            config
        );
    }

    #[test]
    fn partial_billing_schema_is_rejected_for_upgrade() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        write_pre_cycles_schema(&index_path);
        let conn = Connection::open(&index_path).expect("index DB should reopen");
        let legacy_marker = format!("database_index:020_{}config_version", "credits_");
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at)
             VALUES (?1, 0)",
            params![legacy_marker],
        )
        .expect("legacy billing marker should insert");
        drop(conn);
        let service = VfsService::new(index_path, dir.path().join("databases"));

        let error = service
            .run_index_migrations_for_upgrade(Some(test_cycles_billing_config()))
            .expect_err("partial billing schema should be unsupported");

        assert!(error.contains("unsupported partial billing index schema"));
        assert!(error.contains("database_index:020_"));
    }

    #[test]
    fn apply_database_cycles_purchase_rejects_in_flight_operation() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("default", "2vxsx-fae", 1)
            .expect("database should create");
        let operation_id = service
            .begin_database_cycles_purchase("default", "2vxsx-fae", 1_000_000, 2)
            .expect("cycle purchase should begin");
        let cycles = cycles_for_payment_amount_e8s(
            1_000_000,
            &service.cycles_billing_config().expect("config should load"),
        )
        .expect("cycles should compute");

        let error = service
            .apply_database_cycles_purchase(operation_id, "default", "2vxsx-fae", cycles, 1, 2)
            .expect_err("in-flight operation must not apply before ledger completion");

        assert!(error.contains("cycle purchase operation is in_flight"));
    }

    #[test]
    fn ambiguous_database_cycles_purchase_blocks_duplicate_until_repair() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("default", "payer", 1)
            .expect("database should create");
        let operation_id = service
            .begin_database_cycles_purchase("default", "payer", 1_000_000, 2)
            .expect("cycle purchase should begin");
        let cycles = cycles_for_payment_amount_e8s(
            1_000_000,
            &service.cycles_billing_config().expect("config should load"),
        )
        .expect("cycles should compute");

        service
            .mark_database_cycles_purchase_ambiguous(operation_id, "default", "payer", cycles)
            .expect("operation should become ambiguous");
        let duplicate = service
            .begin_database_cycles_purchase("default", "payer", 1_000_000, 3)
            .expect_err("ambiguous operation should block duplicate");
        let conn = Connection::open(index_path).expect("index DB should reopen");
        let status: String = conn
            .query_row(
                "SELECT operation_status FROM database_cycle_pending_operations WHERE operation_id = ?1",
                params![i64::try_from(operation_id).expect("operation id should fit")],
                |row| row.get(0),
            )
            .expect("pending status should load");

        assert_eq!(status, "ambiguous");
        assert!(
            duplicate.contains("database activation is pending")
                || duplicate.contains("cycles purchase already pending")
        );
    }

    #[test]
    fn index_sql_json_returns_cycles_json_rows() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("default", "2vxsx-fae", 1_700_000_000_000)
            .expect("database should create");
        let operation_id = service
            .begin_database_cycles_purchase("default", "2vxsx-fae", 1_000_000, 1_700_000_000_001)
            .expect("cycle purchase should begin");
        let cycles = cycles_for_payment_amount_e8s(
            1_000_000,
            &service.cycles_billing_config().expect("config should load"),
        )
        .expect("cycles should compute");
        service
            .complete_database_cycles_purchase_ledger_transfer(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
            )
            .expect("ledger transfer should complete");
        service
            .apply_database_cycles_purchase(
                operation_id,
                "default",
                "2vxsx-fae",
                cycles,
                1,
                1_700_000_000_001,
            )
            .expect("cycle purchase should cycle");

        let result = service
            .query_index_sql_json(
                "SELECT json_object('cycles_purchase_cycles', COALESCE(SUM(amount_cycles), 0)) FROM database_cycle_ledger WHERE kind = 'cycles_purchase' LIMIT 1",
                10,
            )
            .expect("index SQL should query");

        assert_eq!(result.limit, 10);
        assert_eq!(result.row_count, 1);
        assert_eq!(
            result.rows,
            vec![format!(r#"{{"cycles_purchase_cycles":{cycles}}}"#)]
        );
    }

    #[test]
    fn index_sql_json_clamps_limit() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");

        let result = service
            .query_index_sql_json(
                "SELECT json_object('n', 1) UNION ALL SELECT json_object('n', 2) LIMIT 2",
                0,
            )
            .expect("index SQL should query");

        assert_eq!(result.limit, 1);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows, vec![r#"{"n":1}"#.to_string()]);
    }

    #[test]
    fn index_sql_json_stops_reading_at_limit() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");

        let result = service
            .query_index_sql_json("SELECT json_object('n', 1) UNION ALL SELECT 2", 1)
            .expect("second non-text row should not be read");

        assert_eq!(result.limit, 1);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows, vec![r#"{"n":1}"#.to_string()]);
    }

    #[test]
    fn index_sql_json_rejects_mutating_sql() {
        for sql in [
            "UPDATE database_cycle_accounts SET balance_cycles = 0",
            "DELETE FROM database_cycle_ledger",
            "INSERT INTO database_cycle_ledger (database_id) VALUES ('x')",
            "CREATE TABLE x (id INTEGER)",
            "DROP TABLE database_cycle_ledger",
            "ALTER TABLE database_cycle_ledger ADD COLUMN x INTEGER",
            "REPLACE INTO cycles_billing_config (key, value) VALUES ('x', 'y')",
            "VACUUM",
            "PRAGMA table_info(database_cycle_ledger)",
            "ATTACH DATABASE 'x' AS x",
            "DETACH DATABASE x",
            "REINDEX database_cycle_ledger_database_idx",
            "ANALYZE",
            "SELECT json_object('ok', 1); SELECT json_object('ok', 2)",
        ] {
            assert!(
                validate_index_select_sql(sql).is_err(),
                "SQL should reject: {sql}"
            );
        }
    }

    #[test]
    fn index_sql_json_rejects_non_text_first_column() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");

        let error = service
            .query_index_sql_json("SELECT 1 LIMIT 1", 10)
            .expect_err("non-text first column should reject");

        assert!(error.contains("one non-null TEXT JSON column"));
    }

    #[test]
    fn storage_billing_daily_cycles_match_subnet_rate() {
        let one_gib_cycles =
            compute_storage_charge_cycles(GIB_BYTES as u64, STORAGE_BILLING_INTERVAL_MS)
                .expect("1GiB storage cycles should compute");
        assert_eq!(one_gib_cycles, 10_972_800_000);

        let ten_mib = 10 * 1024 * 1024;
        let ten_mib_cycles = compute_storage_charge_cycles(ten_mib, STORAGE_BILLING_INTERVAL_MS)
            .expect("10MiB storage cycles should compute");
        assert_eq!(ten_mib_cycles, 107_156_250);
    }

    #[test]
    fn storage_billing_charges_raw_storage_cycles() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_balance(&service, "alpha", 1_000);
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: 1,
                        now: STORAGE_BILLING_INTERVAL_MS,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        let (balance, charged_at, amount) = service
            .read_index(|conn| {
                let account = load_storage_cycle_account(conn, "alpha")?;
                let amount: i64 = conn
                    .query_row(
                        "SELECT amount_cycles FROM database_cycle_ledger
                         WHERE database_id = 'alpha' AND kind = 'storage_charge'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((
                    account.balance_cycles,
                    account.storage_charged_at_ms,
                    amount,
                ))
            })
            .expect("account should load");
        assert_eq!(balance, 990);
        assert_eq!(charged_at, Some(STORAGE_BILLING_INTERVAL_MS));
        assert_eq!(amount, -10);
    }

    #[test]
    fn storage_billing_zero_cycles_updates_cursor_without_ledger() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_balance(&service, "alpha", 1_000);
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: 0,
                        now: STORAGE_BILLING_INTERVAL_MS,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        let (balance, charged_at, ledger_count) = service
            .read_index(|conn| {
                let account = load_storage_cycle_account(conn, "alpha")?;
                let ledger_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM database_cycle_ledger WHERE database_id = 'alpha'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((
                    account.balance_cycles,
                    account.storage_charged_at_ms,
                    ledger_count,
                ))
            })
            .expect("account should load");
        assert_eq!(balance, 1_000);
        assert_eq!(charged_at, Some(STORAGE_BILLING_INTERVAL_MS));
        assert_eq!(ledger_count, 0);
    }

    #[test]
    fn storage_billing_skips_less_than_interval() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_balance(&service, "alpha", 1_000);
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: GIB_BYTES as u64,
                        now: STORAGE_BILLING_INTERVAL_MS - 1,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        let (balance, charged_at) = service
            .read_index(|conn| {
                let account = load_storage_cycle_account(conn, "alpha")?;
                Ok((account.balance_cycles, account.storage_charged_at_ms))
            })
            .expect("account should load");
        assert_eq!(balance, 1_000);
        assert_eq!(charged_at, Some(0));
    }

    #[test]
    fn storage_billing_suspends_when_balance_is_insufficient() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_balance(&service, "alpha", 100);
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: GIB_BYTES as u64,
                        now: STORAGE_BILLING_INTERVAL_MS,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: GIB_BYTES as u64,
                        now: STORAGE_BILLING_INTERVAL_MS * 2,
                        config: &config,
                    },
                )
            })
            .expect("second storage charge should settle");

        let (balance, suspended_at, charged_at, kinds, amount) = service
            .read_index(|conn| {
                let account = load_storage_cycle_account(conn, "alpha")?;
                let mut stmt = conn
                    .prepare(
                        "SELECT kind FROM database_cycle_ledger
                         WHERE database_id = 'alpha'
                         ORDER BY entry_id ASC",
                    )
                    .map_err(|error| error.to_string())?;
                let kinds = crate::sqlite::query_map(&mut stmt, params![], |row| {
                    crate::sqlite::row_get::<String>(row, 0)
                })
                .map_err(|error| error.to_string())?;
                let amount: i64 = conn
                    .query_row(
                        "SELECT amount_cycles FROM database_cycle_ledger
                         WHERE database_id = 'alpha' AND kind = 'storage_charge'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((
                    account.balance_cycles,
                    account.suspended_at_ms,
                    account.storage_charged_at_ms,
                    kinds,
                    amount,
                ))
            })
            .expect("ledger should load");
        assert_eq!(balance, 0);
        assert_eq!(suspended_at, Some(STORAGE_BILLING_INTERVAL_MS));
        assert_eq!(charged_at, Some(STORAGE_BILLING_INTERVAL_MS * 2));
        assert_eq!(kinds, vec!["storage_charge", "suspend"]);
        assert_eq!(amount, -100);
    }

    #[test]
    fn storage_billing_exact_charge_consumes_balance_and_suspends() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_balance(&service, "alpha", 10);
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: 1,
                        now: STORAGE_BILLING_INTERVAL_MS,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        let (balance, suspended_at, kinds, amount) = storage_test_account_and_ledger(&service);
        assert_eq!(balance, 0);
        assert_eq!(suspended_at, Some(STORAGE_BILLING_INTERVAL_MS));
        assert_eq!(kinds, vec!["storage_charge", "suspend"]);
        assert_eq!(amount, -10);
    }

    #[test]
    fn storage_billing_keeps_existing_suspension_timestamp() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        service
            .create_database("alpha", "owner", 0)
            .expect("database should create");
        set_test_database_account(&service, "alpha", 10, Some(123));
        let config = service.cycles_billing_config().expect("config should load");

        service
            .write_index(|tx| {
                settle_database_storage_charge_in_tx(
                    tx,
                    StorageChargeInput {
                        database_id: "alpha",
                        caller: "canister",
                        size_bytes: 1,
                        now: STORAGE_BILLING_INTERVAL_MS,
                        config: &config,
                    },
                )
            })
            .expect("storage charge should settle");

        let (balance, suspended_at, kinds, amount) = storage_test_account_and_ledger(&service);
        assert_eq!(balance, 0);
        assert_eq!(suspended_at, Some(123));
        assert_eq!(kinds, vec!["storage_charge"]);
        assert_eq!(amount, -10);
    }

    #[test]
    fn storage_billing_loads_mounted_databases() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        for (database_id, status, mount_id) in [
            ("active", "active", Some(11_i64)),
            ("pending", "pending", Some(12_i64)),
            ("archiving", "archiving", Some(13_i64)),
            ("archived", "archived", Some(14_i64)),
            ("restoring", "restoring", Some(15_i64)),
            ("deleted", "deleted", None),
        ] {
            service
                .write_index(|tx| {
                    tx.execute(
                        "INSERT INTO databases
                         (database_id, name, db_file_name, mount_id, active_mount_id, status,
                          schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
                         VALUES (?1, ?1, ?1, COALESCE(?3, 0), ?3, ?2, ?4, 0, 0, 0)",
                        params![database_id, status, mount_id, DATABASE_SCHEMA_VERSION],
                    )
                    .map_err(|error| error.to_string())?;
                    Ok(())
                })
                .expect("database row should insert");
        }

        let database_ids = service
            .read_index(load_active_databases_for_storage_billing)
            .expect("storage billing databases should load")
            .into_iter()
            .map(|meta| meta.database_id)
            .collect::<Vec<_>>();

        assert_eq!(database_ids, vec!["active"]);
    }

    #[test]
    fn storage_billing_batch_clamps_limits_and_paginates() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        for index in 0..101 {
            seed_storage_billing_database(&service, &format!("db-{index:03}"), index);
        }

        let first = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: None,
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("first batch should settle");
        assert_eq!(first.processed_databases, 100);
        assert_eq!(first.charged_databases, 100);
        assert_eq!(first.suspended_databases, 0);
        assert_eq!(first.next_cursor_mount_id, Some(110));

        let second = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: first.next_cursor_mount_id,
                    limit: Some(500),
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("second batch should settle");
        assert_eq!(second.processed_databases, 1);
        assert_eq!(second.charged_databases, 1);
        assert_eq!(second.next_cursor_mount_id, None);

        let limited = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: Some(0),
                },
                STORAGE_BILLING_INTERVAL_MS * 2,
            )
            .expect("limited batch should settle");
        assert_eq!(limited.processed_databases, 1);
        assert_eq!(limited.next_cursor_mount_id, Some(11));
    }

    #[test]
    fn storage_billing_batch_filters_non_active_mounted_databases() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        seed_storage_billing_database(&service, "active", 0);
        for (database_id, status, mount_id) in [
            ("pending", "pending", 100_i64),
            ("archiving", "archiving", 101_i64),
            ("archived", "archived", 102_i64),
            ("restoring", "restoring", 103_i64),
        ] {
            service
                .write_index(|tx| {
                    tx.execute(
                        "INSERT INTO databases
                         (database_id, name, db_file_name, mount_id, active_mount_id, status,
                          schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
                         VALUES (?1, ?1, ?1, ?3, ?3, ?2, ?4, 0, 0, 0)",
                        params![database_id, status, mount_id, DATABASE_SCHEMA_VERSION],
                    )
                    .map_err(|error| error.to_string())?;
                    Ok(())
                })
                .expect("non-active mounted row should insert");
        }

        let result = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: None,
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("batch should settle");

        assert_eq!(result.processed_databases, 1);
        assert_eq!(result.charged_databases, 1);
        assert_eq!(result.next_cursor_mount_id, None);
    }

    #[test]
    fn storage_billing_batch_clamps_manual_limit_to_thousand() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        for index in 0..1001 {
            seed_storage_billing_index_database(
                &service,
                &format!("db-{index:04}"),
                MIN_DATABASE_MOUNT_ID + index as u16,
                GIB_BYTES as i64,
            );
        }

        let result = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: Some(100_000),
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("oversized batch should settle at max limit");

        assert_eq!(result.processed_databases, 1000);
        assert_eq!(result.next_cursor_mount_id, Some(1010));
    }

    #[test]
    fn storage_billing_batch_uses_cached_logical_size_without_opening_database() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        seed_storage_billing_database(&service, "cached-size", 0);
        let cached_size = GIB_BYTES as i64;
        let meta = service
            .database_meta("cached-size")
            .expect("database metadata should load");
        service
            .write_index(|tx| {
                tx.execute(
                    "UPDATE databases
                     SET logical_size_bytes = ?2
                     WHERE database_id = ?1",
                    params!["cached-size", cached_size],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .expect("cached logical size should update");
        remove_file(&meta.db_file_name).expect("test database file should be removed");

        let result = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: None,
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("storage billing should use cached logical size");

        assert_eq!(result.processed_databases, 1);
        assert_eq!(result.charged_databases, 1);
        let cycles_delta: i64 = service
            .read_index(|conn| {
                conn.query_row(
                    "SELECT cycles_delta
                     FROM database_cycle_ledger
                     WHERE database_id = 'cached-size' AND kind = 'storage_charge'",
                    params![],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .map_err(|error| error.to_string())
            })
            .expect("storage charge ledger should load");
        let expected =
            compute_storage_charge_cycles(cached_size as u64, STORAGE_BILLING_INTERVAL_MS)
                .expect("expected storage cycles should compute");
        assert_eq!(cycles_delta, expected as i64);
    }

    #[test]
    fn storage_billing_batch_bulk_handles_mixed_outcomes() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        let base_databases = [
            (0, "no-op", GIB_BYTES as i64),
            (1, "zero", 0),
            (2, "suspended", GIB_BYTES as i64),
            (3, "charged", GIB_BYTES as i64),
        ];
        for (index, database_id, size) in base_databases {
            seed_storage_billing_index_database(
                &service,
                database_id,
                MIN_DATABASE_MOUNT_ID + index,
                size,
            );
        }
        for index in 4..STORAGE_BILLING_BULK_MIN_BATCH_LEN {
            let database_id = format!("skip-{index:03}");
            seed_storage_billing_index_database(
                &service,
                &database_id,
                MIN_DATABASE_MOUNT_ID + 100 + index as u16,
                GIB_BYTES as i64,
            );
        }
        service
            .write_index(|tx| {
                tx.execute(
                    "UPDATE database_cycle_accounts
                     SET storage_charged_at_ms = ?2
                     WHERE database_id = ?1",
                    params!["no-op", 1_i64],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE database_cycle_accounts
                     SET balance_cycles = 10
                     WHERE database_id = 'suspended'",
                    params![],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE database_cycle_accounts
                     SET storage_charged_at_ms = ?1
                     WHERE database_id LIKE 'skip-%'",
                    params![STORAGE_BILLING_INTERVAL_MS - 1],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .expect("mixed accounts should update");

        let result = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: Some(STORAGE_BILLING_BULK_MIN_BATCH_LEN as u32),
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect("mixed batch should settle");

        let expected_charge =
            compute_storage_charge_cycles(GIB_BYTES as u64, STORAGE_BILLING_INTERVAL_MS)
                .expect("expected storage cycles should compute") as u64;
        assert_eq!(
            result.processed_databases,
            STORAGE_BILLING_BULK_MIN_BATCH_LEN as u32
        );
        assert_eq!(result.charged_databases, 2);
        assert_eq!(result.suspended_databases, 1);
        assert_eq!(result.paid_cycles, expected_charge + 10);
        let (no_op_charged_at, zero_charged_at, ledger_entries, suspend_rows): (
            i64,
            i64,
            Vec<(String, String)>,
            i64,
        ) = service
            .read_index(|conn| {
                let no_op_charged_at = conn
                    .query_row(
                        "SELECT storage_charged_at_ms
                             FROM database_cycle_accounts
                             WHERE database_id = 'no-op'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                let zero_charged_at = conn
                    .query_row(
                        "SELECT storage_charged_at_ms
                             FROM database_cycle_accounts
                             WHERE database_id = 'zero'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                let mut stmt = conn
                    .prepare(
                        "SELECT database_id, kind
                             FROM database_cycle_ledger
                             ORDER BY entry_id ASC",
                    )
                    .map_err(|error| error.to_string())?;
                let ledger_entries = crate::sqlite::query_map(&mut stmt, params![], |row| {
                    Ok((
                        crate::sqlite::row_get::<String>(row, 0)?,
                        crate::sqlite::row_get::<String>(row, 1)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
                let suspend_rows = conn
                    .query_row(
                        "SELECT COUNT(*) FROM database_cycle_ledger WHERE kind = 'suspend'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((
                    no_op_charged_at,
                    zero_charged_at,
                    ledger_entries,
                    suspend_rows,
                ))
            })
            .expect("mixed batch state should load");
        assert_eq!(no_op_charged_at, 1);
        assert_eq!(zero_charged_at, STORAGE_BILLING_INTERVAL_MS);
        assert_eq!(
            ledger_entries,
            vec![
                ("suspended".to_string(), "storage_charge".to_string()),
                ("suspended".to_string(), "suspend".to_string()),
                ("charged".to_string(), "storage_charge".to_string()),
            ]
        );
        assert_eq!(suspend_rows, 1);
    }

    #[test]
    fn storage_billing_batch_rolls_back_when_account_is_missing() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        seed_storage_billing_index_database(&service, "first", 11, GIB_BYTES as i64);
        seed_storage_billing_index_database(&service, "missing-account", 12, GIB_BYTES as i64);
        for index in 2..STORAGE_BILLING_BULK_MIN_BATCH_LEN {
            let database_id = format!("rollback-skip-{index:03}");
            seed_storage_billing_index_database(
                &service,
                &database_id,
                MIN_DATABASE_MOUNT_ID + 100 + index as u16,
                GIB_BYTES as i64,
            );
        }
        service
            .write_index(|tx| {
                tx.execute(
                    "DELETE FROM database_cycle_accounts WHERE database_id = 'missing-account'",
                    params![],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .expect("test account should delete");

        let error = service
            .settle_database_storage_charges_batch(
                "canister",
                StorageBillingBatchRequest {
                    cursor_mount_id: None,
                    limit: Some(STORAGE_BILLING_BULK_MIN_BATCH_LEN as u32),
                },
                STORAGE_BILLING_INTERVAL_MS,
            )
            .expect_err("missing account should reject batch");

        assert!(error.contains("database cycles account not found: missing-account"));
        let (charged_at, ledger_rows): (i64, i64) = service
            .read_index(|conn| {
                let charged_at = conn
                    .query_row(
                        "SELECT storage_charged_at_ms
                         FROM database_cycle_accounts
                         WHERE database_id = 'first'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                let ledger_rows = conn
                    .query_row(
                        "SELECT COUNT(*) FROM database_cycle_ledger",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((charged_at, ledger_rows))
            })
            .expect("rollback state should load");
        assert_eq!(charged_at, 0);
        assert_eq!(ledger_rows, 0);
    }

    #[test]
    fn storage_billing_timer_state_reuses_billing_time_across_batches() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        service
            .run_index_migrations()
            .expect("index migrations should run");
        for index in 0..1001 {
            seed_storage_billing_index_database(
                &service,
                &format!("db-{index:04}"),
                MIN_DATABASE_MOUNT_ID + index as u16,
                GIB_BYTES as i64,
            );
        }

        let first = service
            .settle_database_storage_charges_timer_batch("canister", STORAGE_BILLING_INTERVAL_MS)
            .expect("first timer batch should settle");
        assert_eq!(first.processed_databases, 1000);
        assert_eq!(first.next_cursor_mount_id, Some(1010));
        let second = service
            .settle_database_storage_charges_timer_batch(
                "canister",
                STORAGE_BILLING_INTERVAL_MS * 10,
            )
            .expect("second timer batch should settle");
        assert_eq!(second.processed_databases, 1);
        assert_eq!(second.next_cursor_mount_id, None);

        let (logical_size_bytes, cycles_delta): (i64, i64) = service
            .read_index(|conn| {
                let logical_size_bytes = conn
                    .query_row(
                        "SELECT logical_size_bytes FROM databases WHERE database_id = 'db-1000'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                let cycles_delta = conn
                    .query_row(
                        "SELECT cycles_delta FROM database_cycle_ledger
                         WHERE database_id = 'db-1000' AND kind = 'storage_charge'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((logical_size_bytes, cycles_delta))
            })
            .expect("timer billed row should load");
        let expected =
            compute_storage_charge_cycles(logical_size_bytes as u64, STORAGE_BILLING_INTERVAL_MS)
                .expect("expected storage cycles should compute");
        assert_eq!(cycles_delta, expected as i64);
    }

    fn storage_test_account_and_ledger(
        service: &VfsService,
    ) -> (i64, Option<i64>, Vec<String>, i64) {
        service
            .read_index(|conn| {
                let account = load_storage_cycle_account(conn, "alpha")?;
                let mut stmt = conn
                    .prepare(
                        "SELECT kind FROM database_cycle_ledger
                         WHERE database_id = 'alpha'
                         ORDER BY entry_id ASC",
                    )
                    .map_err(|error| error.to_string())?;
                let kinds = crate::sqlite::query_map(&mut stmt, params![], |row| {
                    crate::sqlite::row_get::<String>(row, 0)
                })
                .map_err(|error| error.to_string())?;
                let amount: i64 = conn
                    .query_row(
                        "SELECT amount_cycles FROM database_cycle_ledger
                         WHERE database_id = 'alpha' AND kind = 'storage_charge'",
                        params![],
                        |row| crate::sqlite::row_get(row, 0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((
                    account.balance_cycles,
                    account.suspended_at_ms,
                    kinds,
                    amount,
                ))
            })
            .expect("storage account and ledger should load")
    }

    fn set_test_database_balance(service: &VfsService, database_id: &str, balance: i64) {
        set_test_database_account(service, database_id, balance, None);
    }

    fn set_test_database_account(
        service: &VfsService,
        database_id: &str,
        balance: i64,
        suspended_at_ms: Option<i64>,
    ) {
        service
            .write_index(|tx| {
                tx.execute(
                    "UPDATE database_cycle_accounts
                     SET balance_cycles = ?2, suspended_at_ms = ?3
                     WHERE database_id = ?1",
                    params![database_id, balance, suspended_at_ms],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .expect("test database account should update");
    }

    fn seed_storage_billing_database(service: &VfsService, database_id: &str, index: usize) {
        service
            .create_database(database_id, "owner", 0)
            .expect("database should create");
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: database_id.to_string(),
                    path: "/Wiki/storage.md".to_string(),
                    kind: NodeKind::File,
                    content: format!("storage billing payload {index}"),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                1,
            )
            .expect("storage node should write");
        set_test_database_balance(service, database_id, 1_000_000_000);
    }

    fn seed_storage_billing_index_database(
        service: &VfsService,
        database_id: &str,
        mount_id: u16,
        logical_size_bytes: i64,
    ) {
        service
            .write_index(|tx| {
                tx.execute(
                    "INSERT INTO databases
                     (database_id, name, db_file_name, mount_id, active_mount_id, status,
                      schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
                     VALUES (?1, ?1, ?1, ?2, ?2, 'active', ?3, ?4, 0, 0)",
                    params![
                        database_id,
                        i64::from(mount_id),
                        DATABASE_SCHEMA_VERSION,
                        logical_size_bytes,
                    ],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO database_cycle_accounts
                     (database_id, balance_cycles, suspended_at_ms, storage_charged_at_ms,
                      created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, NULL, 0, 0, 0)",
                    params![database_id, 1_000_000_000_000_i64],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .expect("storage billing index database should insert");
    }
}
