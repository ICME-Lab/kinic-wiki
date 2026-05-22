// Where: crates/vfs_runtime/src/lib.rs
// What: Service orchestration for multiple SQLite-backed VFS databases.
// Why: One canister can host isolated databases while sharing one VFS store implementation.
mod sqlite;

use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::fs::{File, OpenOptions, create_dir_all, metadata, remove_file};
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
    AppendNodeRequest, BillingConfig, BillingConfigUpdate, ChildNode, DatabaseArchiveInfo,
    DatabaseBillingEntry, DatabaseBillingEntryPage, DatabaseInfo, DatabaseMember, DatabaseRole,
    DatabaseStatus, DatabaseSummary, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
    EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
    FetchUpdatesResponse, GlobNodeHit, GlobNodesRequest, GraphLinksRequest,
    GraphNeighborhoodRequest, IncomingLinksRequest, LinkEdge, ListChildrenRequest,
    ListNodesRequest, MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult,
    MultiEditNodeRequest, MultiEditNodeResult, Node, NodeContext, NodeContextRequest, NodeEntry,
    NodeKind, OpsAnswerSessionCheckRequest, OpsAnswerSessionCheckResult, OpsAnswerSessionRequest,
    OutgoingLinksRequest, PrincipalBillingEntry, PrincipalBillingEntryPage,
    PrincipalBillingSummary, QueryContext, QueryContextRequest, RecentNodeHit, RecentNodesRequest,
    SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest, SourceEvidence,
    SourceEvidenceRequest, Status, UrlIngestTriggerSessionCheckRequest,
    UrlIngestTriggerSessionRequest, WriteNodeRequest, WriteNodeResult, WriteNodesRequest,
};
use wiki_domain::validate_source_path_for_kind;

const INDEX_SCHEMA_VERSION_INITIAL: &str = "database_index:000_initial";
const INDEX_SCHEMA_VERSION_LIFECYCLE: &str = "database_index:001_lifecycle";
const INDEX_SCHEMA_VERSION_RESTORE_SIZE: &str = "database_index:002_restore_size";
const INDEX_SCHEMA_VERSION_RESTORE_CHUNKS: &str = "database_index:003_restore_chunks";
const INDEX_SCHEMA_VERSION_USAGE_EVENTS: &str = "database_index:004_usage_events";
const INDEX_SCHEMA_VERSION_MOUNT_HISTORY: &str = "database_index:005_mount_history";
const INDEX_SCHEMA_VERSION_URL_INGEST_TRIGGER_SESSIONS: &str =
    "database_index:006_url_ingest_trigger_sessions";
const INDEX_SCHEMA_VERSION_OPS_ANSWER_SESSIONS: &str = "database_index:007_ops_answer_sessions";
const INDEX_SCHEMA_VERSION_RESTORE_SESSIONS: &str = "database_index:008_restore_sessions";
const INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES: &str = "database_index:009_restore_chunk_bytes";
const INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING: &str =
    "database_index:010_database_name_breaking";
const INDEX_SCHEMA_VERSION_BILLING_INITIAL: &str = "database_index:011_billing_initial";
const DATABASE_SCHEMA_VERSION: &str = "vfs_store:current";
const MIN_DATABASE_MOUNT_ID: u16 = 11;
const MAX_DATABASE_MOUNT_ID: u16 = 32767;
pub const MAX_ARCHIVE_CHUNK_BYTES: u32 = 1024 * 1024;
pub const MAX_RESTORE_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_DATABASE_SIZE_BYTES: u64 = i64::MAX as u64;
pub const USAGE_EVENTS_RETENTION_LIMIT: u64 = 100_000;
const USAGE_EVENTS_PURGE_INTERVAL: i64 = 100;
const URL_INGEST_TRIGGER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const OPS_ANSWER_SESSION_TTL_MS: i64 = 30 * 60 * 1000;
const SHA256_DIGEST_BYTES: usize = 32;
const GENERATED_DATABASE_ID_PREFIX: &str = "db_";
const GENERATED_DATABASE_ID_HASH_CHARS: usize = 12;
pub const DEFAULT_RATE_NUMERATOR_E8S: u64 = 200;
pub const DEFAULT_RATE_DENOMINATOR_CYCLES: u64 = 1_000_000;
pub const DEFAULT_FIXED_UPDATE_FEE_E8S: u64 = 100;
pub const DEFAULT_MIN_UPDATE_BALANCE_E8S: u64 = 10_000;
pub const DEFAULT_MIN_INITIAL_DEPOSIT_E8S: u64 = 1_000_000;
const MAX_DATABASE_NAME_CHARS: usize = 80;
const FNV1A64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV1A64_PRIME: u64 = 0x0000_0100_0000_01b3;
pub const DEFAULT_LLM_WRITER_PRINCIPAL: &str =
    "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe";
const ANONYMOUS_PRINCIPAL: &str = "2vxsx-fae";

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
    deleted_at_ms: Option<i64>,
    restore_size_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequiredRole {
    Reader,
    Writer,
    Owner,
}

pub struct UsageEvent<'a> {
    pub method: &'a str,
    pub database_id: Option<&'a str>,
    pub caller: &'a str,
    pub success: bool,
    pub cycles_delta: u128,
    pub error: Option<&'a str>,
    pub now: i64,
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
        self.run_index_migrations_with_config(default_billing_config())
    }

    pub fn run_index_migrations_with_config(&self, config: BillingConfig) -> Result<(), String> {
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
        config: Option<BillingConfig>,
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

    pub fn list_database_summaries_for_caller(
        &self,
        caller: &str,
    ) -> Result<Vec<DatabaseSummary>, String> {
        self.read_index(|conn| load_database_summaries_for_caller(conn, caller))
    }

    pub fn record_usage_event(&self, event: UsageEvent<'_>) -> Result<u64, String> {
        self.write_index(|conn| {
            let values = vec![
                crate::sqlite::text_value(event.method),
                event
                    .database_id
                    .map(|database_id| crate::sqlite::text_value(database_id.to_string()))
                    .unwrap_or(crate::sqlite::types::Value::Null),
                crate::sqlite::text_value(event.caller),
                crate::sqlite::integer_value(if event.success { 1_i64 } else { 0_i64 }),
                crate::sqlite::integer_value(i64::try_from(event.cycles_delta).unwrap_or(i64::MAX)),
                event
                    .error
                    .map(|error| crate::sqlite::text_value(error.to_string()))
                    .unwrap_or(crate::sqlite::types::Value::Null),
                crate::sqlite::integer_value(event.now),
            ];
            crate::sqlite::execute_values(
                conn,
                "INSERT INTO usage_events
             (method, database_id, caller, success, cycles_delta, error, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                &values,
            )
            .map_err(|error| error.to_string())?;
            let event_id =
                crate::sqlite::last_insert_rowid(conn).map_err(|error| error.to_string())?;
            if event_id % USAGE_EVENTS_PURGE_INTERVAL == 0 {
                let _ = purge_old_usage_events(conn);
            }
            Ok(event_id.max(0) as u64)
        })
    }

    pub fn usage_event_count(&self) -> Result<u64, String> {
        self.read_index(|conn| {
            conn.query_row("SELECT COUNT(*) FROM usage_events", params![], |row| {
                crate::sqlite::row_get::<i64>(row, 0)
            })
            .map(|count| count.max(0) as u64)
            .map_err(|error| error.to_string())
        })
    }

    pub fn usage_event_database_ids(&self) -> Result<Vec<Option<String>>, String> {
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare("SELECT database_id FROM usage_events ORDER BY event_id ASC")
                .map_err(|error| error.to_string())?;
            crate::sqlite::query_map(&mut stmt, params![], |row| crate::sqlite::row_get(row, 0))
                .map_err(|error| error.to_string())
        })
    }

    pub fn billing_config(&self) -> Result<BillingConfig, String> {
        self.read_index(load_billing_config)
    }

    pub fn validate_billing_config_update(
        &self,
        update: &BillingConfigUpdate,
    ) -> Result<(), String> {
        let current = self.billing_config()?;
        validate_billing_config(&BillingConfig {
            kinic_ledger_canister_id: current.kinic_ledger_canister_id,
            sns_governance_id: current.sns_governance_id,
            rate_numerator_e8s: update.rate_numerator_e8s,
            rate_denominator_cycles: update.rate_denominator_cycles,
            fixed_update_fee_e8s: update.fixed_update_fee_e8s,
            min_update_balance_e8s: update.min_update_balance_e8s,
            min_initial_deposit_e8s: update.min_initial_deposit_e8s,
        })
    }

    pub fn update_billing_config(
        &self,
        update: BillingConfigUpdate,
        caller: &str,
    ) -> Result<BillingConfig, String> {
        let current = self.billing_config()?;
        if caller != current.sns_governance_id {
            return Err("caller is not SNS governance".to_string());
        }
        let next = BillingConfig {
            kinic_ledger_canister_id: current.kinic_ledger_canister_id,
            sns_governance_id: current.sns_governance_id,
            rate_numerator_e8s: update.rate_numerator_e8s,
            rate_denominator_cycles: update.rate_denominator_cycles,
            fixed_update_fee_e8s: update.fixed_update_fee_e8s,
            min_update_balance_e8s: update.min_update_balance_e8s,
            min_initial_deposit_e8s: update.min_initial_deposit_e8s,
        };
        validate_billing_config(&next)?;
        self.write_index(|tx| {
            set_billing_config_value(tx, "rate_numerator_e8s", next.rate_numerator_e8s)?;
            set_billing_config_value(tx, "rate_denominator_cycles", next.rate_denominator_cycles)?;
            set_billing_config_value(tx, "fixed_update_fee_e8s", next.fixed_update_fee_e8s)?;
            set_billing_config_value(tx, "min_update_balance_e8s", next.min_update_balance_e8s)?;
            set_billing_config_value(tx, "min_initial_deposit_e8s", next.min_initial_deposit_e8s)
        })?;
        Ok(next)
    }

    pub fn principal_billing_summary(
        &self,
        principal: &str,
    ) -> Result<PrincipalBillingSummary, String> {
        let balance = self.read_index(|conn| principal_balance_or_zero(conn, principal))?;
        Ok(PrincipalBillingSummary {
            principal: principal.to_string(),
            balance_e8s: balance as u64,
        })
    }

    pub fn credit_principal_top_up(
        &self,
        principal: &str,
        amount_e8s: u64,
        ledger_block_index: u64,
        now: i64,
    ) -> Result<u64, String> {
        let amount = amount_to_i64(amount_e8s)?;
        if amount <= 0 {
            return Err("top-up amount must be positive".to_string());
        }
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            let next = checked_balance_add(balance, amount)?;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![principal, next, now],
            )
            .map_err(|error| error.to_string())?;
            insert_principal_ledger(
                tx,
                principal,
                "top_up",
                amount,
                next,
                None,
                Some(ledger_block_index),
                now,
            )?;
            Ok(next as u64)
        })
    }

    pub fn mark_principal_top_up_ambiguous(
        &self,
        principal: &str,
        amount_e8s: u64,
        now: i64,
    ) -> Result<u64, String> {
        let amount = amount_to_i64(amount_e8s)?;
        if amount <= 0 {
            return Err("top-up amount must be positive".to_string());
        }
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            insert_principal_ledger(
                tx,
                principal,
                "top_up_ambiguous",
                amount,
                balance,
                None,
                None,
                now,
            )?;
            Ok(balance as u64)
        })
    }

    pub fn begin_principal_withdraw(
        &self,
        principal: &str,
        amount_e8s: u64,
        fee_e8s: u64,
        now: i64,
    ) -> Result<u64, String> {
        let amount = amount_to_i64(amount_e8s)?;
        let fee = amount_to_i64(fee_e8s)?;
        if amount <= 0 {
            return Err("withdraw amount must be positive".to_string());
        }
        let total = amount
            .checked_add(fee)
            .ok_or_else(|| "withdraw amount overflows".to_string())?;
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            if balance < total {
                return Err("principal billing balance is insufficient".to_string());
            }
            let after_amount = balance - amount;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![principal, after_amount - fee, now],
            )
            .map_err(|error| error.to_string())?;
            insert_principal_ledger(
                tx,
                principal,
                "withdraw_pending",
                -amount,
                after_amount,
                None,
                None,
                now,
            )?;
            insert_principal_ledger(
                tx,
                principal,
                "withdraw_fee_pending",
                -fee,
                after_amount - fee,
                None,
                None,
                now,
            )?;
            Ok((after_amount - fee) as u64)
        })
    }

    pub fn complete_principal_withdraw(
        &self,
        principal: &str,
        ledger_block_index: u64,
        now: i64,
    ) -> Result<u64, String> {
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            insert_principal_ledger(
                tx,
                principal,
                "withdraw_complete",
                0,
                balance,
                None,
                Some(ledger_block_index),
                now,
            )?;
            Ok(balance as u64)
        })
    }

    pub fn mark_principal_withdraw_ambiguous(
        &self,
        principal: &str,
        now: i64,
    ) -> Result<u64, String> {
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            insert_principal_ledger(
                tx,
                principal,
                "withdraw_ambiguous",
                0,
                balance,
                None,
                None,
                now,
            )?;
            Ok(balance as u64)
        })
    }

    pub fn reverse_principal_withdraw(
        &self,
        principal: &str,
        amount_e8s: u64,
        fee_e8s: u64,
        now: i64,
    ) -> Result<u64, String> {
        let amount = amount_to_i64(amount_e8s)?;
        let fee = amount_to_i64(fee_e8s)?;
        let total = amount
            .checked_add(fee)
            .ok_or_else(|| "withdraw reversal amount overflows".to_string())?;
        self.write_index(|tx| {
            let balance = principal_balance_for_update(tx, principal, now)?;
            let next = checked_balance_add(balance, total)?;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![principal, next, now],
            )
            .map_err(|error| error.to_string())?;
            insert_principal_ledger(
                tx,
                principal,
                "withdraw_reversal",
                total,
                next,
                None,
                None,
                now,
            )?;
            Ok(next as u64)
        })
    }

    pub fn list_principal_billing_entries(
        &self,
        principal: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PrincipalBillingEntryPage, String> {
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT entry_id, principal, kind, amount_e8s, balance_after_e8s,
                            database_id, ledger_block_index, created_at_ms
                     FROM principal_billing_ledger
                     WHERE principal = ?1 AND entry_id > ?2
                     ORDER BY entry_id ASC
                     LIMIT ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut entries = crate::sqlite::query_map(
                &mut stmt,
                params![principal, after, i64::from(limit) + 1],
                map_principal_billing_entry,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if entries.len() > limit as usize {
                entries.pop();
                entries.last().map(|entry| entry.entry_id)
            } else {
                None
            };
            Ok(PrincipalBillingEntryPage {
                entries,
                next_cursor,
            })
        })
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

    pub fn create_generated_database_with_initial_deposit(
        &self,
        name: &str,
        caller: &str,
        initial_deposit_e8s: u64,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let config = self.billing_config()?;
        if initial_deposit_e8s < config.min_initial_deposit_e8s {
            return Err(format!(
                "initial deposit below minimum: {initial_deposit_e8s} < {}",
                config.min_initial_deposit_e8s
            ));
        }
        let amount = amount_to_i64(initial_deposit_e8s)?;
        let meta = self.reserve_generated_database_with_billing(name, caller, amount, now)?;
        if let Err(error) = self.run_database_migrations(&meta.database_id) {
            let cleanup_error = self.discard_database_reservation(&meta.database_id).err();
            return Err(match cleanup_error {
                Some(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
                None => error,
            });
        }
        Ok(meta)
    }

    fn reserve_generated_database_with_billing(
        &self,
        name: &str,
        caller: &str,
        initial_deposit_e8s: i64,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let name = normalize_database_name(name)?;
        self.write_index(|tx| {
            let principal_balance = principal_balance_for_update(tx, caller, now)?;
            if principal_balance < initial_deposit_e8s {
                return Err("principal billing balance is insufficient".to_string());
            }
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
            let next_principal_balance = principal_balance - initial_deposit_e8s;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![caller, next_principal_balance, now],
            )
            .map_err(|error| error.to_string())?;
            let meta = self.insert_database_reservation(
                tx,
                &database_id,
                &name,
                caller,
                now,
                mount_id,
                initial_deposit_e8s,
            )?;
            insert_principal_ledger(
                tx,
                caller,
                "initial_deposit",
                -initial_deposit_e8s,
                next_principal_balance,
                Some(&database_id),
                None,
                now,
            )?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id: &database_id,
                    kind: "initial_deposit",
                    amount_e8s: initial_deposit_e8s,
                    balance_after_e8s: initial_deposit_e8s,
                    caller,
                    method: Some("create_database"),
                    cycles_delta: None,
                    config: None,
                    usage_event_id: None,
                    now,
                },
            )?;
            Ok(meta)
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
        initial_balance_e8s: i64,
    ) -> Result<DatabaseMeta, String> {
        let db_file_name = self.database_file_name(database_id, mount_id)?;
        tx.execute(
            "INSERT INTO databases
             (database_id, name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, 'hot', ?5, 0, ?6, ?6)",
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
        tx.execute(
            "INSERT INTO database_billing_accounts
             (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, NULL, ?3, ?3)",
            params![database_id, initial_balance_e8s, now],
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
                "DELETE FROM database_billing_ledger WHERE database_id = ?1",
                params![database_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "DELETE FROM database_billing_accounts WHERE database_id = ?1",
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

    pub fn reverse_failed_database_create(
        &self,
        database_id: &str,
        caller: &str,
        initial_deposit_e8s: i64,
        now: i64,
    ) -> Result<(), String> {
        let db_file_name = self.write_index(|tx| {
            let db_file_name: Option<String> = tx
                .query_row(
                    "SELECT db_file_name FROM databases WHERE database_id = ?1",
                    params![database_id],
                    |row| crate::sqlite::row_get(row, 0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let principal_balance = principal_balance_for_update(tx, caller, now)?;
            let next_principal_balance =
                checked_balance_add(principal_balance, initial_deposit_e8s)?;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![caller, next_principal_balance, now],
            )
            .map_err(|error| error.to_string())?;
            insert_principal_ledger(
                tx,
                caller,
                "create_database_reversal",
                initial_deposit_e8s,
                next_principal_balance,
                Some(database_id),
                None,
                now,
            )?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "create_database_reversal",
                    amount_e8s: -initial_deposit_e8s,
                    balance_after_e8s: 0,
                    caller,
                    method: Some("create_database"),
                    cycles_delta: None,
                    config: None,
                    usage_event_id: None,
                    now,
                },
            )?;
            tx.execute(
                "DELETE FROM database_billing_accounts WHERE database_id = ?1",
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

    pub fn top_up_database(
        &self,
        database_id: &str,
        caller: &str,
        amount_e8s: u64,
        now: i64,
    ) -> Result<(), String> {
        let amount = amount_to_i64(amount_e8s)?;
        if amount <= 0 {
            return Err("top-up amount must be positive".to_string());
        }
        let status = self.read_index(|conn| load_database_status(conn, database_id))?;
        if status == DatabaseStatus::Deleted {
            return Err(format!("database is deleted: {database_id}"));
        }
        let config = self.billing_config()?;
        self.write_index(|tx| {
            let principal_balance = principal_balance_for_update(tx, caller, now)?;
            if principal_balance < amount {
                return Err("principal billing balance is insufficient".to_string());
            }
            let db_balance = database_balance_for_update(tx, database_id, now)?;
            let next_principal = principal_balance - amount;
            let next_database = checked_balance_add(db_balance, amount)?;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![caller, next_principal, now],
            )
            .map_err(|error| error.to_string())?;
            update_database_billing_balance(tx, database_id, next_database, &config, now)?;
            insert_principal_ledger(
                tx,
                caller,
                "allocate_to_database",
                -amount,
                next_principal,
                Some(database_id),
                None,
                now,
            )?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "top_up_from_principal",
                    amount_e8s: amount,
                    balance_after_e8s: next_database,
                    caller,
                    method: Some("top_up_database"),
                    cycles_delta: None,
                    config: None,
                    usage_event_id: None,
                    now,
                },
            )
        })
    }

    pub fn withdraw_database_balance(
        &self,
        database_id: &str,
        caller: &str,
        amount_e8s: u64,
        now: i64,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let amount = amount_to_i64(amount_e8s)?;
        if amount <= 0 {
            return Err("withdraw amount must be positive".to_string());
        }
        let config = self.billing_config()?;
        self.write_index(|tx| {
            let db_balance = database_balance_for_update(tx, database_id, now)?;
            if db_balance < amount {
                return Err("database billing balance is insufficient".to_string());
            }
            let principal_balance = principal_balance_for_update(tx, caller, now)?;
            let next_database = db_balance - amount;
            let next_principal = checked_balance_add(principal_balance, amount)?;
            update_database_billing_balance(tx, database_id, next_database, &config, now)?;
            tx.execute(
                "UPDATE principal_billing_accounts
                 SET balance_e8s = ?2, updated_at_ms = ?3
                 WHERE principal = ?1",
                params![caller, next_principal, now],
            )
            .map_err(|error| error.to_string())?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "withdraw_to_owner_principal",
                    amount_e8s: -amount,
                    balance_after_e8s: next_database,
                    caller,
                    method: Some("withdraw_database_balance"),
                    cycles_delta: None,
                    config: None,
                    usage_event_id: None,
                    now,
                },
            )?;
            insert_principal_ledger(
                tx,
                caller,
                "database_withdraw",
                amount,
                next_principal,
                Some(database_id),
                None,
                now,
            )
        })
    }

    pub fn list_database_billing_entries(
        &self,
        database_id: &str,
        caller: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<DatabaseBillingEntryPage, String> {
        self.require_role(database_id, caller, RequiredRole::Reader)?;
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        self.read_index(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT entry_id, database_id, kind, amount_e8s, balance_after_e8s,
                            caller, method, cycles_delta, rate_numerator_e8s,
                            rate_denominator_cycles, fixed_update_fee_e8s, usage_event_id,
                            created_at_ms
                     FROM database_billing_ledger
                     WHERE database_id = ?1 AND entry_id > ?2
                     ORDER BY entry_id ASC
                     LIMIT ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut entries = crate::sqlite::query_map(
                &mut stmt,
                params![database_id, after, i64::from(limit) + 1],
                map_database_billing_entry,
            )
            .map_err(|error| error.to_string())?;
            let next_cursor = if entries.len() > limit as usize {
                entries.pop();
                entries.last().map(|entry| entry.entry_id)
            } else {
                None
            };
            Ok(DatabaseBillingEntryPage {
                entries,
                next_cursor,
            })
        })
    }

    pub fn require_database_billable(&self, database_id: &str) -> Result<(), String> {
        let config = self.billing_config()?;
        let (balance, suspended_at_ms): (i64, Option<i64>) = self.read_index(|conn| {
            conn.query_row(
                "SELECT balance_e8s, suspended_at_ms
                     FROM database_billing_accounts
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
            .ok_or_else(|| format!("database billing account not found: {database_id}"))
        })?;
        if suspended_at_ms.is_some() {
            return Err(format!("database billing is suspended: {database_id}"));
        }
        if balance < amount_to_i64(config.min_update_balance_e8s)? {
            return Err(format!(
                "database billing balance is too low: {database_id}"
            ));
        }
        Ok(())
    }

    pub fn charge_database_update(
        &self,
        database_id: &str,
        caller: &str,
        method: &str,
        cycles_delta: u128,
        usage_event_id: Option<u64>,
        now: i64,
    ) -> Result<(), String> {
        let config = self.billing_config()?;
        let computed_charge = compute_update_charge(&config, cycles_delta)?;
        self.write_index(|tx| {
            let balance = database_balance_for_update(tx, database_id, now)?;
            let charge = balance.min(computed_charge);
            let next = balance - charge;
            update_database_billing_balance(tx, database_id, next, &config, now)?;
            insert_database_ledger(
                tx,
                DatabaseLedgerInsert {
                    database_id,
                    kind: "charge",
                    amount_e8s: -charge,
                    balance_after_e8s: next,
                    caller,
                    method: Some(method),
                    cycles_delta: Some(cycles_delta),
                    config: Some(&config),
                    usage_event_id,
                    now,
                },
            )?;
            if computed_charge > balance {
                insert_database_ledger(
                    tx,
                    DatabaseLedgerInsert {
                        database_id,
                        kind: "suspend",
                        amount_e8s: 0,
                        balance_after_e8s: next,
                        caller,
                        method: Some(method),
                        cycles_delta: Some(cycles_delta),
                        config: Some(&config),
                        usage_event_id,
                        now,
                    },
                )?;
            }
            Ok(())
        })
    }

    pub fn run_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta(database_id)?;
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let result = self.database_store(&meta)?.run_fs_migrations();
        if result.is_ok() {
            self.refresh_logical_size(database_id)?;
        }
        result
    }

    pub fn delete_database(&self, database_id: &str, caller: &str, now: i64) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta(database_id)?;
        #[cfg(target_arch = "wasm32")]
        let _ = &meta;
        #[cfg(not(target_arch = "wasm32"))]
        if let Err(error) = remove_file(&meta.db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        self.write_index(|conn| {
            conn.execute(
                "UPDATE databases
             SET status = 'deleted',
                 active_mount_id = NULL,
                 logical_size_bytes = 0,
                 restore_size_bytes = NULL,
                 deleted_at_ms = ?2,
                 updated_at_ms = ?2
             WHERE database_id = ?1",
                params![database_id, now],
            )
            .map_err(|error| error.to_string())?;
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
                 active_mount_id = NULL,
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
             SET status = 'hot',
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
        let rollback = self.database_restore_rollback(database_id)?;
        if !matches!(
            rollback.status,
            DatabaseStatus::Archived | DatabaseStatus::Deleted
        ) {
            return Err(
                "database restore can only begin from archived or deleted status".to_string(),
            );
        }
        self.write_index(|tx| {
            let mount_id = allocate_mount_id(tx)?;
            record_mount_history(tx, database_id, mount_id, "restore", now)?;
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
                 deleted_at_ms = NULL,
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
             SET status = 'hot',
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
        validate_url_ingest_request_node(&node, &principal)
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
        Ok(OpsAnswerSessionCheckResult { principal })
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
            self.refresh_logical_size(&database_id)?;
        }
        result
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
            self.refresh_logical_size(&database_id)?;
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
            self.refresh_logical_size(&database_id)?;
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
            self.refresh_logical_size(&database_id)?;
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
            self.refresh_logical_size(&database_id)?;
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
            self.refresh_logical_size(&database_id)?;
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
            self.refresh_logical_size(&database_id)?;
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

    pub fn recent_nodes(
        &self,
        caller: &str,
        request: RecentNodesRequest,
    ) -> Result<Vec<RecentNodeHit>, String> {
        let database_id = request.database_id.clone();
        self.with_database_store(&database_id, caller, RequiredRole::Reader, |store| {
            store.recent_nodes(request)
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
            self.refresh_logical_size(&database_id)?;
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

    fn require_role(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
    ) -> Result<(), String> {
        let role = self.read_index(|conn| {
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
            &[DatabaseStatus::Hot, DatabaseStatus::Restoring],
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
                    deleted_at_ms, restore_size_bytes
             FROM databases
             WHERE database_id = ?1",
                params![database_id],
                |row| {
                    let active_mount_id: Option<i64> = crate::sqlite::row_get(row, 2)?;
                    let restore_size_bytes: Option<i64> = crate::sqlite::row_get(row, 6)?;
                    Ok(DatabaseRestoreRollback {
                        database_id: crate::sqlite::row_get(row, 0)?,
                        status: status_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
                        active_mount_id: active_mount_id.map(mount_id_from_db).transpose()?,
                        snapshot_hash: crate::sqlite::row_get(row, 3)?,
                        archived_at_ms: crate::sqlite::row_get(row, 4)?,
                        deleted_at_ms: crate::sqlite::row_get(row, 5)?,
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
                    deleted_at_ms, restore_size_bytes
             FROM database_restore_sessions
             WHERE database_id = ?1",
                params![database_id],
                |row| {
                    let active_mount_id: Option<i64> = crate::sqlite::row_get(row, 2)?;
                    let restore_size_bytes: Option<i64> = crate::sqlite::row_get(row, 6)?;
                    Ok(DatabaseRestoreRollback {
                        database_id: crate::sqlite::row_get(row, 0)?,
                        status: status_from_db(&crate::sqlite::row_get::<String>(row, 1)?)?,
                        active_mount_id: active_mount_id.map(mount_id_from_db).transpose()?,
                        snapshot_hash: crate::sqlite::row_get(row, 3)?,
                        archived_at_ms: crate::sqlite::row_get(row, 4)?,
                        deleted_at_ms: crate::sqlite::row_get(row, 5)?,
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
        #[cfg(not(target_arch = "wasm32"))]
        {
            file_size(&meta.db_file_name)
        }
        #[cfg(target_arch = "wasm32")]
        {
            (self.database_handle)(meta.mount_id)?
                .refresh_checksum_chunk(u64::MAX)
                .map(|report| report.db_size)
                .map_err(|error| error.to_string())
        }
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
fn run_index_migrations(conn: &mut Connection, config: &BillingConfig) -> Result<(), String> {
    if !sqlite_master_entry_exists(conn, "table", "schema_migrations")? {
        conn.execute_batch("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);")
            .map_err(|error| error.to_string())?;
    }
    for table in INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS {
        if schema_migration_count(conn)? == 0 && sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without supported schema_migrations; recreate the index database"
            ));
        }
    }
    if migration_applied(conn, INDEX_SCHEMA_VERSION_BILLING_INITIAL)? {
        return Ok(());
    }
    if schema_migration_count(conn)? != 0 {
        if !migration_applied(conn, INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING)? {
            if !migration_applied(conn, INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES)? {
                return Err(format!(
                    "unsupported index schema: missing migration {INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING}"
                ));
            }
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            apply_database_name_index_migration(&tx)?;
            tx.commit().map_err(|error| error.to_string())?;
        }
        validate_billing_config(config)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        apply_billing_index_migration(&tx, config)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(());
    }
    validate_billing_config(config)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    create_fresh_index_schema(&tx)?;
    insert_billing_config(&tx, config)?;
    for &version in INDEX_SCHEMA_VERSIONS {
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
            params![version],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
fn run_index_migrations_for_upgrade(
    conn: &mut Connection,
    config: Option<&BillingConfig>,
) -> Result<(), String> {
    if sqlite_master_entry_exists(conn, "table", "schema_migrations")?
        && migration_applied(conn, INDEX_SCHEMA_VERSION_BILLING_INITIAL)?
    {
        return Ok(());
    }
    let config =
        config.ok_or_else(|| "billing config required for first billing upgrade".to_string())?;
    run_index_migrations(conn, config)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx(
    conn: &Transaction<'_>,
    config: &BillingConfig,
) -> Result<(), String> {
    if wasm_index_table_exists(conn, "schema_migrations")? {
        if !wasm_index_migration_exists(conn, INDEX_SCHEMA_VERSION_BILLING_INITIAL)? {
            if !wasm_index_migration_exists(conn, INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING)? {
                if !wasm_index_migration_exists(conn, INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES)? {
                    return Err(format!(
                        "unsupported index schema: missing migration {INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING}"
                    ));
                }
                apply_database_name_index_migration(conn)?;
            }
            validate_billing_config(config)?;
            apply_billing_index_migration(conn, config)?;
        }
        validate_wasm_index_schema(conn)?;
        for &version in INDEX_SCHEMA_VERSIONS {
            if !wasm_index_migration_exists(conn, version)? {
                return Err(format!(
                    "unsupported index schema: missing migration {version}"
                ));
            }
        }
        return Ok(());
    }
    for table in INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS {
        if wasm_index_table_exists(conn, table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without schema_migrations"
            ));
        }
    }
    validate_billing_config(config)?;
    create_fresh_index_schema(conn)?;
    insert_billing_config(conn, config)?;
    for &version in INDEX_SCHEMA_VERSIONS {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            params![version],
        )
        .map_err(|error| error.to_string())?;
    }
    validate_wasm_index_schema(conn)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx_for_upgrade(
    conn: &Transaction<'_>,
    config: Option<&BillingConfig>,
) -> Result<(), String> {
    if wasm_index_table_exists(conn, "schema_migrations")?
        && wasm_index_migration_exists(conn, INDEX_SCHEMA_VERSION_BILLING_INITIAL)?
    {
        validate_wasm_index_schema(conn)?;
        for &version in INDEX_SCHEMA_VERSIONS {
            if !wasm_index_migration_exists(conn, version)? {
                return Err(format!(
                    "unsupported index schema: missing migration {version}"
                ));
            }
        }
        return Ok(());
    }
    let config =
        config.ok_or_else(|| "billing config required for first billing upgrade".to_string())?;
    run_index_migrations_in_tx(conn, config)
}

fn apply_database_name_index_migration(conn: &Transaction<'_>) -> Result<(), String> {
    if !index_column_exists(conn, "databases", "name")? {
        conn.execute("ALTER TABLE databases ADD COLUMN name TEXT", params![])
            .map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE databases
             SET name = database_id
             WHERE name IS NULL OR name = ''",
            params![],
        )
        .map_err(|error| error.to_string())?;
    }
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params![INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn apply_billing_index_migration(
    conn: &Transaction<'_>,
    config: &BillingConfig,
) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE principal_billing_accounts (
           principal TEXT PRIMARY KEY,
           balance_e8s INTEGER NOT NULL,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE principal_billing_ledger (
           entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
           principal TEXT NOT NULL,
           kind TEXT NOT NULL,
           amount_e8s INTEGER NOT NULL,
           balance_after_e8s INTEGER NOT NULL,
           database_id TEXT,
           ledger_block_index INTEGER,
           created_at_ms INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX principal_billing_ledger_block_idx
           ON principal_billing_ledger(ledger_block_index)
           WHERE ledger_block_index IS NOT NULL;
         CREATE INDEX principal_billing_ledger_principal_idx
           ON principal_billing_ledger(principal, entry_id);
         CREATE TABLE database_billing_accounts (
           database_id TEXT PRIMARY KEY,
           balance_e8s INTEGER NOT NULL,
           suspended_at_ms INTEGER,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL,
           FOREIGN KEY (database_id) REFERENCES databases(database_id)
         );
         CREATE TABLE database_billing_ledger (
           entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
           database_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           amount_e8s INTEGER NOT NULL,
           balance_after_e8s INTEGER NOT NULL,
           caller TEXT NOT NULL,
           method TEXT,
           cycles_delta INTEGER,
           rate_numerator_e8s INTEGER,
           rate_denominator_cycles INTEGER,
           fixed_update_fee_e8s INTEGER,
           usage_event_id INTEGER,
           created_at_ms INTEGER NOT NULL
         );
         CREATE INDEX database_billing_ledger_database_idx
           ON database_billing_ledger(database_id, entry_id);
         CREATE TABLE billing_config (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .map_err(|error| error.to_string())?;
    let initial_deposit = amount_to_i64(config.min_initial_deposit_e8s)?;
    conn.execute(
        "INSERT INTO database_billing_accounts
         (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
         SELECT database_id, ?1, NULL, 0, 0 FROM databases",
        params![initial_deposit],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO database_billing_ledger
         (database_id, kind, amount_e8s, balance_after_e8s, caller, created_at_ms)
         SELECT database_id, 'migration_initial_grant', ?1, ?1, 'system', 0 FROM databases",
        params![initial_deposit],
    )
    .map_err(|error| error.to_string())?;
    insert_billing_config(conn, config)?;
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
        params![INDEX_SCHEMA_VERSION_BILLING_INITIAL],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_fresh_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE databases (
           database_id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           db_file_name TEXT NOT NULL,
           mount_id INTEGER NOT NULL,
           active_mount_id INTEGER,
           status TEXT NOT NULL DEFAULT 'hot',
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
         CREATE TABLE usage_events (
           event_id INTEGER PRIMARY KEY AUTOINCREMENT,
           method TEXT NOT NULL,
           database_id TEXT,
           caller TEXT NOT NULL,
           success INTEGER NOT NULL,
           cycles_delta INTEGER NOT NULL,
           error TEXT,
           created_at_ms INTEGER NOT NULL
         );
         CREATE INDEX usage_events_database_id_created_at_idx
           ON usage_events(database_id, created_at_ms);
         CREATE INDEX usage_events_caller_created_at_idx
           ON usage_events(caller, created_at_ms);
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
         );
         CREATE TABLE principal_billing_accounts (
           principal TEXT PRIMARY KEY,
           balance_e8s INTEGER NOT NULL,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE principal_billing_ledger (
           entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
           principal TEXT NOT NULL,
           kind TEXT NOT NULL,
           amount_e8s INTEGER NOT NULL,
           balance_after_e8s INTEGER NOT NULL,
           database_id TEXT,
           ledger_block_index INTEGER,
           created_at_ms INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX principal_billing_ledger_block_idx
           ON principal_billing_ledger(ledger_block_index)
           WHERE ledger_block_index IS NOT NULL;
         CREATE INDEX principal_billing_ledger_principal_idx
           ON principal_billing_ledger(principal, entry_id);
         CREATE TABLE database_billing_accounts (
           database_id TEXT PRIMARY KEY,
           balance_e8s INTEGER NOT NULL,
           suspended_at_ms INTEGER,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL,
           FOREIGN KEY (database_id) REFERENCES databases(database_id)
         );
         CREATE TABLE database_billing_ledger (
           entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
           database_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           amount_e8s INTEGER NOT NULL,
           balance_after_e8s INTEGER NOT NULL,
           caller TEXT NOT NULL,
           method TEXT,
           cycles_delta INTEGER,
           rate_numerator_e8s INTEGER,
           rate_denominator_cycles INTEGER,
           fixed_update_fee_e8s INTEGER,
           usage_event_id INTEGER,
           created_at_ms INTEGER NOT NULL
         );
         CREATE INDEX database_billing_ledger_database_idx
           ON database_billing_ledger(database_id, entry_id);
         CREATE TABLE billing_config (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .map_err(|error| error.to_string())
}

fn default_billing_config() -> BillingConfig {
    BillingConfig {
        kinic_ledger_canister_id: "2vxsx-fae".to_string(),
        sns_governance_id: "2vxsx-fae".to_string(),
        rate_numerator_e8s: DEFAULT_RATE_NUMERATOR_E8S,
        rate_denominator_cycles: DEFAULT_RATE_DENOMINATOR_CYCLES,
        fixed_update_fee_e8s: DEFAULT_FIXED_UPDATE_FEE_E8S,
        min_update_balance_e8s: DEFAULT_MIN_UPDATE_BALANCE_E8S,
        min_initial_deposit_e8s: DEFAULT_MIN_INITIAL_DEPOSIT_E8S,
    }
}

fn validate_billing_config(config: &BillingConfig) -> Result<(), String> {
    validate_principal_text(&config.kinic_ledger_canister_id)?;
    validate_principal_text(&config.sns_governance_id)?;
    if config.rate_numerator_e8s == 0 {
        return Err("rate_numerator_e8s must be positive".to_string());
    }
    if config.rate_denominator_cycles == 0 {
        return Err("rate_denominator_cycles must be positive".to_string());
    }
    amount_to_i64(config.rate_numerator_e8s)?;
    amount_to_i64(config.rate_denominator_cycles)?;
    amount_to_i64(config.fixed_update_fee_e8s)?;
    amount_to_i64(config.min_update_balance_e8s)?;
    amount_to_i64(config.min_initial_deposit_e8s)?;
    if config.min_update_balance_e8s < config.fixed_update_fee_e8s {
        return Err("min_update_balance_e8s must be >= fixed_update_fee_e8s".to_string());
    }
    if config.min_initial_deposit_e8s < config.min_update_balance_e8s {
        return Err("min_initial_deposit_e8s must be >= min_update_balance_e8s".to_string());
    }
    Ok(())
}

fn validate_principal_text(value: &str) -> Result<(), String> {
    Principal::from_text(value)
        .map(|_| ())
        .map_err(|error| format!("principal text is invalid: {error}"))
}

fn insert_billing_config(conn: &Transaction<'_>, config: &BillingConfig) -> Result<(), String> {
    conn.execute(
        "INSERT INTO billing_config (key, value) VALUES (?1, ?2)",
        params!["kinic_ledger_canister_id", config.kinic_ledger_canister_id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO billing_config (key, value) VALUES (?1, ?2)",
        params!["sns_governance_id", config.sns_governance_id],
    )
    .map_err(|error| error.to_string())?;
    set_billing_config_value(conn, "rate_numerator_e8s", config.rate_numerator_e8s)?;
    set_billing_config_value(
        conn,
        "rate_denominator_cycles",
        config.rate_denominator_cycles,
    )?;
    set_billing_config_value(conn, "fixed_update_fee_e8s", config.fixed_update_fee_e8s)?;
    set_billing_config_value(
        conn,
        "min_update_balance_e8s",
        config.min_update_balance_e8s,
    )?;
    set_billing_config_value(
        conn,
        "min_initial_deposit_e8s",
        config.min_initial_deposit_e8s,
    )?;
    Ok(())
}

fn set_billing_config_value(conn: &Transaction<'_>, key: &str, value: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO billing_config (key, value)
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
    INDEX_SCHEMA_VERSION_USAGE_EVENTS,
    INDEX_SCHEMA_VERSION_MOUNT_HISTORY,
    INDEX_SCHEMA_VERSION_URL_INGEST_TRIGGER_SESSIONS,
    INDEX_SCHEMA_VERSION_OPS_ANSWER_SESSIONS,
    INDEX_SCHEMA_VERSION_RESTORE_SESSIONS,
    INDEX_SCHEMA_VERSION_RESTORE_CHUNK_BYTES,
    INDEX_SCHEMA_VERSION_DATABASE_NAME_BREAKING,
    INDEX_SCHEMA_VERSION_BILLING_INITIAL,
];

const INDEX_SCHEMA_TABLES_WITHOUT_MIGRATIONS: &[&str] = &[
    "databases",
    "database_members",
    "database_restore_chunks",
    "usage_events",
    "database_mount_history",
    "url_ingest_trigger_sessions",
    "ops_answer_sessions",
    "database_restore_sessions",
    "principal_billing_accounts",
    "principal_billing_ledger",
    "database_billing_accounts",
    "database_billing_ledger",
    "billing_config",
];

#[cfg(target_arch = "wasm32")]
fn validate_wasm_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    for table in [
        "schema_migrations",
        "databases",
        "database_restore_chunks",
        "database_restore_sessions",
        "principal_billing_accounts",
        "database_billing_accounts",
        "billing_config",
    ] {
        if !wasm_index_table_exists(conn, table)? {
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
            "database_billing_accounts",
            &["database_id", "balance_e8s", "suspended_at_ms"][..],
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
        "database_billing_ledger_database_idx",
    ] {
        if !wasm_index_index_exists(conn, index)? {
            return Err(format!("unsupported index schema: missing index {index}"));
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn wasm_index_table_exists(conn: &Transaction<'_>, table: &str) -> Result<bool, String> {
    sqlite_master_entry_exists(conn, "table", table)
}

#[cfg(target_arch = "wasm32")]
fn wasm_index_index_exists(conn: &Transaction<'_>, index: &str) -> Result<bool, String> {
    sqlite_master_entry_exists(conn, "index", index)
}

#[cfg(target_arch = "wasm32")]
fn wasm_index_migration_exists(conn: &Transaction<'_>, version: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM schema_migrations WHERE version = ?1",
        params![version],
        |row| crate::sqlite::row_get::<i64>(row, 0),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

#[cfg(target_arch = "wasm32")]
fn sqlite_master_entry_exists(
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

#[cfg(not(target_arch = "wasm32"))]
fn index_column_exists(conn: &Transaction<'_>, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let columns = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 1)
    })
    .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|name| name == column))
}

#[cfg(target_arch = "wasm32")]
fn index_column_exists(conn: &Transaction<'_>, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let columns = crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 1)
    })
    .map_err(|error| error.to_string())?;
    Ok(columns.iter().any(|name| name == column))
}

#[cfg(not(target_arch = "wasm32"))]
fn migration_applied(conn: &Connection, version: &str) -> Result<bool, String> {
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
fn schema_migration_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM schema_migrations", params![], |row| {
        crate::sqlite::row_get(row, 0)
    })
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

fn load_billing_config(conn: &Connection) -> Result<BillingConfig, String> {
    Ok(BillingConfig {
        kinic_ledger_canister_id: load_billing_config_text(conn, "kinic_ledger_canister_id")?,
        sns_governance_id: load_billing_config_text(conn, "sns_governance_id")?,
        rate_numerator_e8s: load_billing_config_u64(conn, "rate_numerator_e8s")?,
        rate_denominator_cycles: load_billing_config_u64(conn, "rate_denominator_cycles")?,
        fixed_update_fee_e8s: load_billing_config_u64(conn, "fixed_update_fee_e8s")?,
        min_update_balance_e8s: load_billing_config_u64(conn, "min_update_balance_e8s")?,
        min_initial_deposit_e8s: load_billing_config_u64(conn, "min_initial_deposit_e8s")?,
    })
}

fn load_billing_config_text(conn: &Connection, key: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT value FROM billing_config WHERE key = ?1",
        params![key],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn load_billing_config_u64(conn: &Connection, key: &str) -> Result<u64, String> {
    let value = load_billing_config_text(conn, key)?;
    value.parse::<u64>().map_err(|error| error.to_string())
}

fn amount_to_i64(amount: u64) -> Result<i64, String> {
    i64::try_from(amount).map_err(|_| "amount exceeds i64 limit".to_string())
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

fn principal_balance_for_update(
    conn: &Transaction<'_>,
    principal: &str,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT OR IGNORE INTO principal_billing_accounts (principal, balance_e8s, created_at_ms, updated_at_ms) VALUES (?1, 0, ?2, ?2)",
        params![principal, now],
    )
    .map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT balance_e8s FROM principal_billing_accounts WHERE principal = ?1",
        params![principal],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn principal_balance_or_zero(conn: &Connection, principal: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT balance_e8s FROM principal_billing_accounts WHERE principal = ?1",
        params![principal],
        |row| crate::sqlite::row_get(row, 0),
    )
    .optional()
    .map(|balance| balance.unwrap_or(0))
    .map_err(|error| error.to_string())
}

fn database_balance_for_update(
    conn: &Transaction<'_>,
    database_id: &str,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT OR IGNORE INTO database_billing_accounts
         (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
         VALUES (?1, 0, NULL, ?2, ?2)",
        params![database_id, now],
    )
    .map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT balance_e8s FROM database_billing_accounts WHERE database_id = ?1",
        params![database_id],
        |row| crate::sqlite::row_get(row, 0),
    )
    .map_err(|error| error.to_string())
}

fn update_database_billing_balance(
    conn: &Transaction<'_>,
    database_id: &str,
    balance: i64,
    config: &BillingConfig,
    now: i64,
) -> Result<(), String> {
    let min = amount_to_i64(config.min_update_balance_e8s)?;
    let suspended_at_ms = if balance >= min { None } else { Some(now) };
    let values = vec![
        crate::sqlite::text_value(database_id),
        crate::sqlite::integer_value(balance),
        crate::sqlite::nullable_integer_value(suspended_at_ms),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "UPDATE database_billing_accounts
         SET balance_e8s = ?2, suspended_at_ms = ?3, updated_at_ms = ?4
         WHERE database_id = ?1",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_principal_ledger(
    conn: &Transaction<'_>,
    principal: &str,
    kind: &str,
    amount_e8s: i64,
    balance_after_e8s: i64,
    database_id: Option<&str>,
    ledger_block_index: Option<u64>,
    now: i64,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(principal),
        crate::sqlite::text_value(kind),
        crate::sqlite::integer_value(amount_e8s),
        crate::sqlite::integer_value(balance_after_e8s),
        database_id
            .map(crate::sqlite::text_value)
            .unwrap_or(crate::sqlite::types::Value::Null),
        crate::sqlite::nullable_integer_value(
            ledger_block_index.map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::integer_value(now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO principal_billing_ledger
         (principal, kind, amount_e8s, balance_after_e8s, database_id, ledger_block_index,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

struct DatabaseLedgerInsert<'a> {
    database_id: &'a str,
    kind: &'a str,
    amount_e8s: i64,
    balance_after_e8s: i64,
    caller: &'a str,
    method: Option<&'a str>,
    cycles_delta: Option<u128>,
    config: Option<&'a BillingConfig>,
    usage_event_id: Option<u64>,
    now: i64,
}

fn insert_database_ledger(
    conn: &Transaction<'_>,
    entry: DatabaseLedgerInsert<'_>,
) -> Result<(), String> {
    let values = vec![
        crate::sqlite::text_value(entry.database_id),
        crate::sqlite::text_value(entry.kind),
        crate::sqlite::integer_value(entry.amount_e8s),
        crate::sqlite::integer_value(entry.balance_after_e8s),
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
                .map(|config| i64::try_from(config.rate_numerator_e8s).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .config
                .map(|config| i64::try_from(config.rate_denominator_cycles).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .config
                .map(|config| i64::try_from(config.fixed_update_fee_e8s).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::nullable_integer_value(
            entry
                .usage_event_id
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
        ),
        crate::sqlite::integer_value(entry.now),
    ];
    crate::sqlite::execute_values(
        conn,
        "INSERT INTO database_billing_ledger
         (database_id, kind, amount_e8s, balance_after_e8s, caller, method, cycles_delta,
          rate_numerator_e8s, rate_denominator_cycles, fixed_update_fee_e8s, usage_event_id,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        &values,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn compute_update_charge(config: &BillingConfig, cycles_delta: u128) -> Result<i64, String> {
    let numerator = u128::from(config.rate_numerator_e8s);
    let denominator = u128::from(config.rate_denominator_cycles);
    let variable = cycles_delta
        .checked_mul(numerator)
        .ok_or_else(|| "cycle charge overflow".to_string())?
        .div_ceil(denominator);
    let total = variable
        .checked_add(u128::from(config.fixed_update_fee_e8s))
        .ok_or_else(|| "cycle charge overflow".to_string())?;
    i64::try_from(total).map_err(|_| "cycle charge exceeds i64 limit".to_string())
}

fn page_limit(limit: u32) -> u32 {
    limit.clamp(1, 100)
}

fn map_principal_billing_entry(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<PrincipalBillingEntry> {
    let entry_id: i64 = crate::sqlite::row_get(row, 0)?;
    let balance_after: i64 = crate::sqlite::row_get(row, 4)?;
    let ledger_block_index: Option<i64> = crate::sqlite::row_get(row, 6)?;
    Ok(PrincipalBillingEntry {
        entry_id: entry_id.max(0) as u64,
        principal: crate::sqlite::row_get(row, 1)?,
        kind: crate::sqlite::row_get(row, 2)?,
        amount_e8s: crate::sqlite::row_get(row, 3)?,
        balance_after_e8s: balance_after.max(0) as u64,
        database_id: crate::sqlite::row_get(row, 5)?,
        ledger_block_index: ledger_block_index.map(|value| value.max(0) as u64),
        created_at_ms: crate::sqlite::row_get(row, 7)?,
    })
}

fn map_database_billing_entry(
    row: &crate::sqlite::Row<'_>,
) -> crate::sqlite::Result<DatabaseBillingEntry> {
    let entry_id: i64 = crate::sqlite::row_get(row, 0)?;
    let balance_after: i64 = crate::sqlite::row_get(row, 4)?;
    let cycles_delta: Option<i64> = crate::sqlite::row_get(row, 7)?;
    let rate_numerator: Option<i64> = crate::sqlite::row_get(row, 8)?;
    let rate_denominator: Option<i64> = crate::sqlite::row_get(row, 9)?;
    let fixed_fee: Option<i64> = crate::sqlite::row_get(row, 10)?;
    let usage_event_id: Option<i64> = crate::sqlite::row_get(row, 11)?;
    Ok(DatabaseBillingEntry {
        entry_id: entry_id.max(0) as u64,
        database_id: crate::sqlite::row_get(row, 1)?,
        kind: crate::sqlite::row_get(row, 2)?,
        amount_e8s: crate::sqlite::row_get(row, 3)?,
        balance_after_e8s: balance_after.max(0) as u64,
        caller: crate::sqlite::row_get(row, 5)?,
        method: crate::sqlite::row_get(row, 6)?,
        cycles_delta: cycles_delta.map(|value| value.max(0) as u64),
        rate_numerator_e8s: rate_numerator.map(|value| value.max(0) as u64),
        rate_denominator_cycles: rate_denominator.map(|value| value.max(0) as u64),
        fixed_update_fee_e8s: fixed_fee.map(|value| value.max(0) as u64),
        usage_event_id: usage_event_id.map(|value| value.max(0) as u64),
        created_at_ms: crate::sqlite::row_get(row, 12)?,
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
    if status != "queued" && status != "fetching" && status != "source_written" {
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
    let (frontmatter, _body) = rest
        .split_once("\n---")
        .ok_or_else(|| "url ingest request frontmatter is not closed".to_string())?;
    let mut fields = BTreeMap::new();
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err("url ingest request frontmatter is invalid".to_string());
        };
        fields.insert(key.trim().to_string(), frontmatter_scalar(value.trim()));
    }
    Ok(fields)
}

fn frontmatter_scalar(value: &str) -> Option<String> {
    if value == "null" || value == "~" {
        return None;
    }
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        return Some(value[1..value.len() - 1].to_string());
    }
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        return Some(value[1..value.len() - 1].to_string());
    }
    Some(value.to_string())
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
        crate::sqlite::nullable_integer_value(rollback.deleted_at_ms),
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
          deleted_at_ms, restore_size_bytes, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
        crate::sqlite::nullable_integer_value(rollback.deleted_at_ms),
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
             deleted_at_ms = ?6,
             restore_size_bytes = ?7,
             updated_at_ms = ?8
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

fn purge_old_usage_events(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM usage_events
         WHERE event_id <= (
           SELECT COALESCE(MAX(event_id), 0) - ?1 FROM usage_events
         )",
        params![i64::try_from(USAGE_EVENTS_RETENTION_LIMIT).unwrap_or(i64::MAX)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
            if status == "hot"
                || status == "archived"
                || status == "archiving"
                || status == "restoring"
                || status == "deleted" =>
        {
            format!("database is {status}: {database_id}")
        }
        _ => format!("database not found: {database_id}"),
    }
}

fn load_database(conn: &Connection, database_id: &str) -> Result<Option<DatabaseMeta>, String> {
    load_database_with_statuses(conn, database_id, &[DatabaseStatus::Hot])
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
         WHERE status IN ('hot', 'archiving', 'restoring') AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
    )
    .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], map_database_meta)
        .map_err(|error| error.to_string())
}

fn load_database_infos(conn: &Connection) -> Result<Vec<DatabaseInfo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT database_id, name, status, active_mount_id, schema_version, logical_size_bytes,
                snapshot_hash, archived_at_ms, deleted_at_ms
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
            deleted_at_ms: crate::sqlite::row_get(row, 8)?,
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
                COALESCE(b.balance_e8s, 0), b.suspended_at_ms,
                d.archived_at_ms, d.deleted_at_ms
         FROM databases d
         INNER JOIN database_members m ON m.database_id = d.database_id
         LEFT JOIN database_billing_accounts b ON b.database_id = d.database_id
         WHERE m.principal = ?1
         ORDER BY d.database_id ASC",
        )
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![caller], |row| {
        let logical_size_bytes: i64 = crate::sqlite::row_get(row, 4)?;
        let billing_balance_e8s: i64 = crate::sqlite::row_get(row, 5)?;
        Ok(DatabaseSummary {
            database_id: crate::sqlite::row_get(row, 0)?,
            name: crate::sqlite::row_get(row, 1)?,
            status: status_from_db(&crate::sqlite::row_get::<String>(row, 2)?)?,
            role: role_from_db(&crate::sqlite::row_get::<String>(row, 3)?)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
            billing_balance_e8s: Some(billing_balance_e8s.max(0) as u64),
            billing_suspended_at_ms: crate::sqlite::row_get(row, 6)?,
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
    let status: String = crate::sqlite::row_get(row, 6).unwrap_or_else(|_| "hot".to_string());
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
        "hot" => Ok(DatabaseStatus::Hot),
        "archiving" => Ok(DatabaseStatus::Archiving),
        "archived" => Ok(DatabaseStatus::Archived),
        "deleted" => Ok(DatabaseStatus::Deleted),
        "restoring" => Ok(DatabaseStatus::Restoring),
        _ => Err(crate::sqlite::invalid_query()),
    }
}

fn status_to_db(status: DatabaseStatus) -> &'static str {
    match status {
        DatabaseStatus::Hot => "hot",
        DatabaseStatus::Archiving => "archiving",
        DatabaseStatus::Archived => "archived",
        DatabaseStatus::Deleted => "deleted",
        DatabaseStatus::Restoring => "restoring",
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

#[cfg(not(target_arch = "wasm32"))]
fn file_size(path: &str) -> Result<u64, String> {
    metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tempfile::tempdir;

    use super::*;

    fn test_billing_config() -> BillingConfig {
        BillingConfig {
            kinic_ledger_canister_id: "aaaaa-aa".to_string(),
            sns_governance_id: "rrkah-fqaaa-aaaaa-aaaaq-cai".to_string(),
            rate_numerator_e8s: DEFAULT_RATE_NUMERATOR_E8S,
            rate_denominator_cycles: DEFAULT_RATE_DENOMINATOR_CYCLES,
            fixed_update_fee_e8s: DEFAULT_FIXED_UPDATE_FEE_E8S,
            min_update_balance_e8s: DEFAULT_MIN_UPDATE_BALANCE_E8S,
            min_initial_deposit_e8s: DEFAULT_MIN_INITIAL_DEPOSIT_E8S,
        }
    }

    fn write_pre_billing_schema(index_path: &Path) {
        let conn = Connection::open(index_path).expect("index DB should open");
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
               version TEXT PRIMARY KEY,
               applied_at INTEGER NOT NULL
             );
             INSERT INTO schema_migrations (version, applied_at)
               VALUES ('database_index:010_database_name_breaking', 0);
             CREATE TABLE databases (
               database_id TEXT PRIMARY KEY
             );",
        )
        .expect("pre-billing schema should write");
    }

    #[test]
    fn upgrade_migrations_require_config_before_billing_initial() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        write_pre_billing_schema(&index_path);
        let service = VfsService::new(index_path, dir.path().join("databases"));

        let error = service
            .run_index_migrations_for_upgrade(None)
            .expect_err("missing billing config should reject first billing upgrade");

        assert!(error.contains("billing config required for first billing upgrade"));
    }

    #[test]
    fn upgrade_migrations_apply_explicit_config_before_billing_initial() {
        let dir = tempdir().expect("tempdir should create");
        let index_path = dir.path().join("index.sqlite3");
        write_pre_billing_schema(&index_path);
        let service = VfsService::new(index_path, dir.path().join("databases"));
        let config = test_billing_config();

        service
            .run_index_migrations_for_upgrade(Some(config.clone()))
            .expect("explicit config should run first billing upgrade");

        assert_eq!(
            service.billing_config().expect("config should load"),
            config
        );
    }

    #[test]
    fn upgrade_migrations_accept_no_config_after_billing_initial() {
        let dir = tempdir().expect("tempdir should create");
        let service = VfsService::new(
            dir.path().join("index.sqlite3"),
            dir.path().join("databases"),
        );
        let config = test_billing_config();
        service
            .run_index_migrations_with_config(config.clone())
            .expect("initial migrations should run");

        service
            .run_index_migrations_for_upgrade(None)
            .expect("post-billing upgrade should not need config");

        assert_eq!(
            service.billing_config().expect("config should load"),
            config
        );
    }
}
