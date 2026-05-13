// Where: crates/vfs_runtime/src/lib.rs
// What: Service orchestration for multiple SQLite-backed VFS databases.
// Why: One canister can host isolated databases while sharing one VFS store implementation.
use std::fs::{File, OpenOptions, create_dir_all, metadata, remove_file};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use candid::Principal;
use rusqlite::{Connection, OptionalExtension, params};
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
    NodeKind, OutgoingLinksRequest, PrincipalBillingEntry, PrincipalBillingEntryPage,
    PrincipalBillingSummary, QueryContext, QueryContextRequest, RecentNodeHit, RecentNodesRequest,
    SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest, SourceEvidence,
    SourceEvidenceRequest, Status, WriteNodeRequest, WriteNodeResult,
};
use wiki_domain::validate_source_path_for_kind;

const INDEX_SCHEMA_VERSION_INITIAL: &str = "database_index:100_billing_initial";
const DATABASE_SCHEMA_VERSION: &str = "vfs_store:current";
const MIN_DATABASE_MOUNT_ID: u16 = 11;
const MAX_DATABASE_MOUNT_ID: u16 = 32767;
pub const MAX_ARCHIVE_CHUNK_BYTES: u32 = 1024 * 1024;
pub const MAX_RESTORE_CHUNK_BYTES: usize = 1024 * 1024;
pub const MAX_DATABASE_SIZE_BYTES: u64 = i64::MAX as u64;
pub const USAGE_EVENTS_RETENTION_LIMIT: u64 = 100_000;
const USAGE_EVENTS_PURGE_INTERVAL: i64 = 100;
const SHA256_DIGEST_BYTES: usize = 32;
const GENERATED_DATABASE_ID_PREFIX: &str = "db_";
const GENERATED_DATABASE_ID_HASH_CHARS: usize = 12;
pub const DEFAULT_RATE_NUMERATOR_E8S: u64 = 200;
pub const DEFAULT_RATE_DENOMINATOR_CYCLES: u64 = 1_000_000;
pub const DEFAULT_FIXED_UPDATE_FEE_E8S: u64 = 100;
pub const DEFAULT_MIN_UPDATE_BALANCE_E8S: u64 = 10_000;
pub const DEFAULT_MIN_INITIAL_DEPOSIT_E8S: u64 = 1_000_000;
const DISPLAY_NAME_MAX_CHARS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseMeta {
    pub database_id: String,
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

pub struct VfsService {
    index_path: PathBuf,
    databases_dir: PathBuf,
}

impl VfsService {
    pub fn new(index_path: PathBuf, databases_dir: PathBuf) -> Self {
        Self {
            index_path,
            databases_dir,
        }
    }

    pub fn run_index_migrations(&self) -> Result<(), String> {
        self.run_index_migrations_with_config(default_billing_config())
    }

    pub fn run_index_migrations_with_config(&self, config: BillingConfig) -> Result<(), String> {
        let mut conn = self.open_index()?;
        run_index_migrations(&mut conn, &config)
    }

    pub fn list_databases(&self) -> Result<Vec<DatabaseMeta>, String> {
        let conn = self.open_index()?;
        load_databases(&conn)
    }

    pub fn list_database_infos(&self) -> Result<Vec<DatabaseInfo>, String> {
        let conn = self.open_index()?;
        load_database_infos(&conn)
    }

    pub fn list_database_summaries_for_caller(
        &self,
        caller: &str,
    ) -> Result<Vec<DatabaseSummary>, String> {
        let conn = self.open_index()?;
        load_database_summaries_for_caller(&conn, caller)
    }

    pub fn record_usage_event(&self, event: UsageEvent<'_>) -> Result<u64, String> {
        let conn = self.open_index()?;
        conn.execute(
            "INSERT INTO usage_events
             (method, database_id, caller, success, cycles_delta, error, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.method,
                event.database_id,
                event.caller,
                if event.success { 1_i64 } else { 0_i64 },
                i64::try_from(event.cycles_delta).unwrap_or(i64::MAX),
                event.error,
                event.now
            ],
        )
        .map_err(|error| error.to_string())?;
        let event_id = conn.last_insert_rowid();
        if event_id % USAGE_EVENTS_PURGE_INTERVAL == 0 {
            let _ = purge_old_usage_events(&conn);
        }
        Ok(event_id.max(0) as u64)
    }

    pub fn usage_event_count(&self) -> Result<u64, String> {
        let conn = self.open_index()?;
        conn.query_row("SELECT COUNT(*) FROM usage_events", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|count| count.max(0) as u64)
        .map_err(|error| error.to_string())
    }

    pub fn billing_config(&self) -> Result<BillingConfig, String> {
        let conn = self.open_index()?;
        load_billing_config(&conn)
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
        let mut conn = self.open_index()?;
        let current = load_billing_config(&conn)?;
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
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        set_billing_config_value(&tx, "rate_numerator_e8s", next.rate_numerator_e8s)?;
        set_billing_config_value(&tx, "rate_denominator_cycles", next.rate_denominator_cycles)?;
        set_billing_config_value(&tx, "fixed_update_fee_e8s", next.fixed_update_fee_e8s)?;
        set_billing_config_value(&tx, "min_update_balance_e8s", next.min_update_balance_e8s)?;
        set_billing_config_value(&tx, "min_initial_deposit_e8s", next.min_initial_deposit_e8s)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(next)
    }

    pub fn principal_billing_summary(
        &self,
        principal: &str,
    ) -> Result<PrincipalBillingSummary, String> {
        let mut conn = self.open_index()?;
        let balance = ensure_principal_billing_account(&mut conn, principal, 0)?;
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
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = principal_balance_for_update(&tx, principal, now)?;
        let next = checked_balance_add(balance, amount)?;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![principal, next, now],
        )
        .map_err(|error| error.to_string())?;
        insert_principal_ledger(
            &tx,
            principal,
            "top_up",
            amount,
            next,
            None,
            Some(ledger_block_index),
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(next as u64)
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
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = principal_balance_for_update(&tx, principal, now)?;
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
            &tx,
            principal,
            "withdraw_pending",
            -amount,
            after_amount,
            None,
            None,
            now,
        )?;
        insert_principal_ledger(
            &tx,
            principal,
            "withdraw_fee_pending",
            -fee,
            after_amount - fee,
            None,
            None,
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok((after_amount - fee) as u64)
    }

    pub fn complete_principal_withdraw(
        &self,
        principal: &str,
        ledger_block_index: u64,
        now: i64,
    ) -> Result<u64, String> {
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = principal_balance_for_update(&tx, principal, now)?;
        insert_principal_ledger(
            &tx,
            principal,
            "withdraw_complete",
            0,
            balance,
            None,
            Some(ledger_block_index),
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(balance as u64)
    }

    pub fn mark_principal_withdraw_ambiguous(
        &self,
        principal: &str,
        now: i64,
    ) -> Result<u64, String> {
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = principal_balance_for_update(&tx, principal, now)?;
        insert_principal_ledger(
            &tx,
            principal,
            "withdraw_ambiguous",
            0,
            balance,
            None,
            None,
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(balance as u64)
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
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = principal_balance_for_update(&tx, principal, now)?;
        let next = checked_balance_add(balance, total)?;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![principal, next, now],
        )
        .map_err(|error| error.to_string())?;
        insert_principal_ledger(
            &tx,
            principal,
            "withdraw_reversal",
            total,
            next,
            None,
            None,
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(next as u64)
    }

    pub fn list_principal_billing_entries(
        &self,
        principal: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<PrincipalBillingEntryPage, String> {
        let conn = self.open_index()?;
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        let mut entries = conn
            .prepare(
                "SELECT entry_id, principal, kind, amount_e8s, balance_after_e8s,
                        database_id, ledger_block_index, created_at_ms
                 FROM principal_billing_ledger
                 WHERE principal = ?1 AND entry_id > ?2
                 ORDER BY entry_id ASC
                 LIMIT ?3",
            )
            .map_err(|error| error.to_string())?
            .query_map(params![principal, after, i64::from(limit) + 1], |row| {
                map_principal_billing_entry(row)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
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
    }

    pub fn create_database(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_database(database_id, caller, now)?;
        self.run_database_migrations(database_id)?;
        Ok(meta)
    }

    pub fn create_generated_database_with_initial_deposit(
        &self,
        display_name: &str,
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
        self.reserve_generated_database_with_billing(display_name, caller, amount, now)
    }

    pub fn create_generated_database(
        &self,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let meta = self.reserve_generated_database(caller, now)?;
        self.run_database_migrations(&meta.database_id)?;
        Ok(meta)
    }

    pub fn reserve_generated_database(
        &self,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let mount_id = allocate_mount_id(&tx)?;
        let mut selected_database_id = None;
        for attempt in 0_u32..100 {
            let database_id = generated_database_id(caller, now, mount_id, attempt);
            if !database_exists(&tx, &database_id)? {
                selected_database_id = Some(database_id);
                break;
            }
        }
        let database_id = selected_database_id
            .ok_or_else(|| "failed to generate unique database id".to_string())?;
        let display_name = validate_display_name(&database_id)?;
        let db_file_name = database_file_name(&self.databases_dir, &database_id)?;
        tx.execute(
            "INSERT INTO databases
             (database_id, display_name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, 'hot', ?5, 0, ?6, ?6)",
            params![
                database_id,
                display_name,
                db_file_name,
                i64::from(mount_id),
                DATABASE_SCHEMA_VERSION,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        record_mount_history(&tx, &database_id, mount_id, "create", now)?;
        tx.execute(
            "INSERT INTO database_members
             (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, 'owner', ?3)",
            params![database_id, caller, now],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO database_billing_accounts
             (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, NULL, ?3, ?3)",
            params![
                database_id,
                i64::try_from(DEFAULT_MIN_INITIAL_DEPOSIT_E8S).unwrap_or(i64::MAX),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id,
            db_file_name,
            mount_id,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    fn reserve_generated_database_with_billing(
        &self,
        display_name: &str,
        caller: &str,
        initial_deposit_e8s: i64,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        let display_name = validate_display_name(display_name)?;
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let principal_balance = principal_balance_for_update(&tx, caller, now)?;
        if principal_balance < initial_deposit_e8s {
            return Err("principal billing balance is insufficient".to_string());
        }
        let mount_id = allocate_mount_id(&tx)?;
        let mut selected_database_id = None;
        for attempt in 0_u32..100 {
            let database_id = generated_database_id(caller, now, mount_id, attempt);
            if !database_exists(&tx, &database_id)? {
                selected_database_id = Some(database_id);
                break;
            }
        }
        let database_id = selected_database_id
            .ok_or_else(|| "failed to generate unique database id".to_string())?;
        let db_file_name = database_file_name(&self.databases_dir, &database_id)?;
        let next_principal_balance = principal_balance - initial_deposit_e8s;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![caller, next_principal_balance, now],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO databases
             (database_id, display_name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, 'hot', ?5, 0, ?6, ?6)",
            params![
                database_id,
                display_name,
                db_file_name,
                i64::from(mount_id),
                DATABASE_SCHEMA_VERSION,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        record_mount_history(&tx, &database_id, mount_id, "create", now)?;
        tx.execute(
            "INSERT INTO database_members
             (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, 'owner', ?3)",
            params![database_id, caller, now],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO database_billing_accounts
             (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, NULL, ?3, ?3)",
            params![database_id, initial_deposit_e8s, now],
        )
        .map_err(|error| error.to_string())?;
        insert_principal_ledger(
            &tx,
            caller,
            "initial_deposit",
            -initial_deposit_e8s,
            next_principal_balance,
            Some(&database_id),
            None,
            now,
        )?;
        insert_database_ledger(
            &tx,
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
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id,
            db_file_name,
            mount_id,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    pub fn reserve_database(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseMeta, String> {
        validate_database_id(database_id)?;
        let display_name = validate_display_name(database_id)?;
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if database_exists(&tx, database_id)? {
            return Err(format!("database already exists: {database_id}"));
        }
        let mount_id = allocate_mount_id(&tx)?;
        let db_file_name = database_file_name(&self.databases_dir, database_id)?;
        tx.execute(
            "INSERT INTO databases
             (database_id, display_name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, 'hot', ?5, 0, ?6, ?6)",
            params![
                database_id,
                display_name,
                db_file_name,
                i64::from(mount_id),
                DATABASE_SCHEMA_VERSION,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        record_mount_history(&tx, database_id, mount_id, "create", now)?;
        tx.execute(
            "INSERT INTO database_members
             (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, 'owner', ?3)",
            params![database_id, caller, now],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "INSERT INTO database_billing_accounts
             (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, NULL, ?3, ?3)",
            params![
                database_id,
                i64::try_from(DEFAULT_MIN_INITIAL_DEPOSIT_E8S).unwrap_or(i64::MAX),
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(DatabaseMeta {
            database_id: database_id.to_string(),
            db_file_name,
            mount_id,
            schema_version: DATABASE_SCHEMA_VERSION.to_string(),
            logical_size_bytes: 0,
        })
    }

    pub fn discard_database_reservation(&self, database_id: &str) -> Result<(), String> {
        let mut conn = self.open_index()?;
        let db_file_name: Option<String> = conn
            .query_row(
                "SELECT db_file_name
                 FROM databases
                 WHERE database_id = ?1",
                params![database_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
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
        tx.commit().map_err(|error| error.to_string())?;
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
        let mut conn = self.open_index()?;
        let db_file_name: Option<String> = conn
            .query_row(
                "SELECT db_file_name FROM databases WHERE database_id = ?1",
                params![database_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let principal_balance = principal_balance_for_update(&tx, caller, now)?;
        let next_principal_balance = checked_balance_add(principal_balance, initial_deposit_e8s)?;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![caller, next_principal_balance, now],
        )
        .map_err(|error| error.to_string())?;
        insert_principal_ledger(
            &tx,
            caller,
            "create_database_reversal",
            initial_deposit_e8s,
            next_principal_balance,
            Some(database_id),
            None,
            now,
        )?;
        insert_database_ledger(
            &tx,
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
        tx.commit().map_err(|error| error.to_string())?;
        if let Some(db_file_name) = db_file_name
            && let Err(error) = remove_file(&db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        Ok(())
    }

    pub fn rename_database(
        &self,
        database_id: &str,
        display_name: &str,
        caller: &str,
        now: i64,
    ) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.require_database_billable(database_id)?;
        let display_name = validate_display_name(display_name)?;
        let conn = self.open_index()?;
        conn.execute(
            "UPDATE databases
             SET display_name = ?2, updated_at_ms = ?3
             WHERE database_id = ?1",
            params![database_id, display_name, now],
        )
        .map_err(|error| error.to_string())?;
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
        let mut conn = self.open_index()?;
        let status = load_database_status(&conn, database_id)?;
        if status == DatabaseStatus::Deleted {
            return Err(format!("database is deleted: {database_id}"));
        }
        let config = load_billing_config(&conn)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let principal_balance = principal_balance_for_update(&tx, caller, now)?;
        if principal_balance < amount {
            return Err("principal billing balance is insufficient".to_string());
        }
        let db_balance = database_balance_for_update(&tx, database_id, now)?;
        let next_principal = principal_balance - amount;
        let next_database = checked_balance_add(db_balance, amount)?;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![caller, next_principal, now],
        )
        .map_err(|error| error.to_string())?;
        update_database_billing_balance(&tx, database_id, next_database, &config, now)?;
        insert_principal_ledger(
            &tx,
            caller,
            "allocate_to_database",
            -amount,
            next_principal,
            Some(database_id),
            None,
            now,
        )?;
        insert_database_ledger(
            &tx,
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
        )?;
        tx.commit().map_err(|error| error.to_string())
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
        let mut conn = self.open_index()?;
        let config = load_billing_config(&conn)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let db_balance = database_balance_for_update(&tx, database_id, now)?;
        if db_balance < amount {
            return Err("database billing balance is insufficient".to_string());
        }
        let principal_balance = principal_balance_for_update(&tx, caller, now)?;
        let next_database = db_balance - amount;
        let next_principal = checked_balance_add(principal_balance, amount)?;
        update_database_billing_balance(&tx, database_id, next_database, &config, now)?;
        tx.execute(
            "UPDATE principal_billing_accounts
             SET balance_e8s = ?2, updated_at_ms = ?3
             WHERE principal = ?1",
            params![caller, next_principal, now],
        )
        .map_err(|error| error.to_string())?;
        insert_database_ledger(
            &tx,
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
            &tx,
            caller,
            "database_withdraw",
            amount,
            next_principal,
            Some(database_id),
            None,
            now,
        )?;
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn list_database_billing_entries(
        &self,
        database_id: &str,
        caller: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<DatabaseBillingEntryPage, String> {
        self.require_role(database_id, caller, RequiredRole::Reader)?;
        let conn = self.open_index()?;
        let limit = page_limit(limit);
        let after = i64::try_from(cursor.unwrap_or(0)).map_err(|error| error.to_string())?;
        let mut entries = conn
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
            .map_err(|error| error.to_string())?
            .query_map(params![database_id, after, i64::from(limit) + 1], |row| {
                map_database_billing_entry(row)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
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
    }

    pub fn require_database_billable(&self, database_id: &str) -> Result<(), String> {
        let conn = self.open_index()?;
        let config = load_billing_config(&conn)?;
        let (balance, suspended_at_ms): (i64, Option<i64>) = conn
            .query_row(
                "SELECT balance_e8s, suspended_at_ms
                 FROM database_billing_accounts
                 WHERE database_id = ?1",
                params![database_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database billing account not found: {database_id}"))?;
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
        let mut conn = self.open_index()?;
        let config = load_billing_config(&conn)?;
        let computed_charge = compute_update_charge(&config, cycles_delta)?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let balance = database_balance_for_update(&tx, database_id, now)?;
        let charge = balance.min(computed_charge);
        let next = balance - charge;
        update_database_billing_balance(&tx, database_id, next, &config, now)?;
        insert_database_ledger(
            &tx,
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
                &tx,
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
        tx.commit().map_err(|error| error.to_string())
    }

    pub fn run_database_migrations(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta(database_id)?;
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let result = FsStore::new(PathBuf::from(&meta.db_file_name)).run_fs_migrations();
        if result.is_ok() {
            self.refresh_logical_size(database_id)?;
        }
        result
    }

    pub fn delete_database(&self, database_id: &str, caller: &str, now: i64) -> Result<(), String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta(database_id)?;
        if let Err(error) = remove_file(&meta.db_file_name)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.to_string());
        }
        let conn = self.open_index()?;
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
    }

    pub fn begin_database_archive(
        &self,
        database_id: &str,
        caller: &str,
        now: i64,
    ) -> Result<DatabaseArchiveInfo, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        let meta = self.database_meta(database_id)?;
        let size_bytes = file_size(&meta.db_file_name)?;
        let conn = self.open_index()?;
        conn.execute(
            "UPDATE databases
             SET status = 'archiving',
                 updated_at_ms = ?2
             WHERE database_id = ?1",
            params![database_id, now],
        )
        .map_err(|error| error.to_string())?;
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
        let size = file_size(&meta.db_file_name)?;
        if offset >= size {
            return Ok(Vec::new());
        }
        let mut file = File::open(&meta.db_file_name).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let remaining = size.saturating_sub(offset);
        let chunk_len = remaining.min(u64::from(max_bytes));
        let mut bytes = Vec::with_capacity(chunk_len as usize);
        file.take(chunk_len)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(bytes)
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
        let actual_hash = file_sha256(&meta.db_file_name)?;
        if actual_hash != snapshot_hash {
            return Err("snapshot_hash does not match archived database bytes".to_string());
        }
        let conn = self.open_index()?;
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
        let conn = self.open_index()?;
        conn.execute(
            "UPDATE databases
             SET status = 'hot',
                 updated_at_ms = ?2
             WHERE database_id = ?1",
            params![database_id, now],
        )
        .map_err(|error| error.to_string())?;
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
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let mount_id = allocate_mount_id(&tx)?;
        record_mount_history(&tx, database_id, mount_id, "restore", now)?;
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
        tx.commit().map_err(|error| error.to_string())?;
        let meta = self.database_meta_allowing_restoring(database_id)?;
        let _ = remove_file(&meta.db_file_name);
        Ok(DatabaseRestoreBegin { meta, rollback })
    }

    pub fn rollback_database_restore_begin(
        &self,
        rollback: DatabaseRestoreRollback,
        now: i64,
    ) -> Result<(), String> {
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        let current_status = load_database_status(&tx, &rollback.database_id)?;
        if current_status != DatabaseStatus::Restoring {
            return Err(format!(
                "database restore rollback requires restoring status: {}",
                rollback.database_id
            ));
        }
        tx.execute(
            "DELETE FROM database_restore_chunks WHERE database_id = ?1",
            params![&rollback.database_id],
        )
        .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE databases
             SET status = ?2,
                 active_mount_id = ?3,
                 snapshot_hash = ?4,
                 archived_at_ms = ?5,
                 deleted_at_ms = ?6,
                 restore_size_bytes = ?7,
                 updated_at_ms = ?8
            WHERE database_id = ?1",
            params![
                &rollback.database_id,
                status_to_db(rollback.status),
                rollback.active_mount_id.map(i64::from),
                rollback.snapshot_hash,
                rollback.archived_at_ms,
                rollback.deleted_at_ms,
                rollback
                    .restore_size_bytes
                    .map(i64::try_from)
                    .transpose()
                    .map_err(|error| error.to_string())?,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
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
        let meta = self.database_meta_with_statuses(database_id, &[DatabaseStatus::Restoring])?;
        let expected_size = self.restore_size_bytes(database_id)?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "restore chunk range overflows u64".to_string())?;
        if end > expected_size {
            return Err(format!(
                "restore chunk exceeds expected size: end {end} > {expected_size}"
            ));
        }
        if let Some(parent) = Path::new(&meta.db_file_name).parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&meta.db_file_name)
            .map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        let conn = self.open_index()?;
        conn.execute(
            "INSERT OR REPLACE INTO database_restore_chunks (database_id, offset_bytes, end_bytes)
             VALUES (?1, ?2, ?3)",
            params![
                database_id,
                i64::try_from(offset).map_err(|error| error.to_string())?,
                i64::try_from(end).map_err(|error| error.to_string())?
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
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
        if !restore_chunks_cover_expected_size(&self.open_index()?, database_id, expected_size)? {
            return Err(format!(
                "restore chunks are incomplete for expected size {expected_size} bytes"
            ));
        }
        OpenOptions::new()
            .write(true)
            .open(&meta.db_file_name)
            .and_then(|file| file.set_len(expected_size))
            .map_err(|error| error.to_string())?;
        let size = file_size(&meta.db_file_name)?;
        if size != expected_size {
            return Err(format!(
                "restore size mismatch: expected {expected_size} bytes, got {size} bytes"
            ));
        }
        let expected_hash = self.restore_snapshot_hash(database_id)?;
        let actual_hash = file_sha256(&meta.db_file_name)?;
        if actual_hash != expected_hash {
            return Err("snapshot_hash does not match restored database bytes".to_string());
        }
        FsStore::new(PathBuf::from(&meta.db_file_name)).run_fs_migrations()?;
        let mut conn = self.open_index()?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute(
            "DELETE FROM database_restore_chunks WHERE database_id = ?1",
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
                i64::try_from(size).map_err(|error| error.to_string())?,
                now
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
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
        let conn = self.open_index()?;
        conn.execute(
            "INSERT INTO database_members (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(database_id, principal)
             DO UPDATE SET role = excluded.role",
            params![database_id, principal, role_to_db(role), now],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
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
        let conn = self.open_index()?;
        conn.execute(
            "DELETE FROM database_members WHERE database_id = ?1 AND principal = ?2",
            params![database_id, principal],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_database_members(
        &self,
        database_id: &str,
        caller: &str,
    ) -> Result<Vec<DatabaseMember>, String> {
        self.require_role(database_id, caller, RequiredRole::Owner)?;
        self.database_meta(database_id)?;
        let conn = self.open_index()?;
        conn.prepare(
            "SELECT database_id, principal, role, created_at_ms
             FROM database_members
             WHERE database_id = ?1
             ORDER BY principal ASC",
        )
        .map_err(|error| error.to_string())?
        .query_map(params![database_id], |row| {
            Ok(DatabaseMember {
                database_id: row.get(0)?,
                principal: row.get(1)?,
                role: role_from_db(&row.get::<_, String>(2)?)?,
                created_at_ms: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
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
    ) -> Result<MkdirNodeResult, String> {
        let database_id = request.database_id.clone();
        let result =
            self.with_database_store(&database_id, caller, RequiredRole::Writer, |store| {
                store.mkdir_node(request)
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
        let store = FsStore::new(PathBuf::from(meta.db_file_name));
        f(&store)
    }

    fn require_role(
        &self,
        database_id: &str,
        caller: &str,
        required_role: RequiredRole,
    ) -> Result<(), String> {
        let conn = self.open_index()?;
        let role = load_member_role(&conn, database_id, caller)?
            .ok_or_else(|| format!("principal has no access to database: {database_id}"))?;
        if role_allows(role, required_role) {
            Ok(())
        } else {
            Err(format!(
                "principal lacks required database role: {database_id}"
            ))
        }
    }

    fn database_meta(&self, database_id: &str) -> Result<DatabaseMeta, String> {
        let conn = self.open_index()?;
        load_database(&conn, database_id)?.ok_or_else(|| database_meta_error(&conn, database_id))
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
        let conn = self.open_index()?;
        load_database_with_statuses(&conn, database_id, statuses)?
            .ok_or_else(|| database_meta_error(&conn, database_id))
    }

    fn database_restore_rollback(
        &self,
        database_id: &str,
    ) -> Result<DatabaseRestoreRollback, String> {
        let conn = self.open_index()?;
        conn.query_row(
            "SELECT database_id, status, active_mount_id, snapshot_hash, archived_at_ms,
                    deleted_at_ms, restore_size_bytes
             FROM databases
             WHERE database_id = ?1",
            params![database_id],
            |row| {
                let active_mount_id: Option<i64> = row.get(2)?;
                let restore_size_bytes: Option<i64> = row.get(6)?;
                Ok(DatabaseRestoreRollback {
                    database_id: row.get(0)?,
                    status: status_from_db(&row.get::<_, String>(1)?)?,
                    active_mount_id: active_mount_id.map(mount_id_from_db).transpose()?,
                    snapshot_hash: row.get(3)?,
                    archived_at_ms: row.get(4)?,
                    deleted_at_ms: row.get(5)?,
                    restore_size_bytes: restore_size_bytes.map(|size| size.max(0) as u64),
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("database not found: {database_id}"))
    }

    fn restore_size_bytes(&self, database_id: &str) -> Result<u64, String> {
        let conn = self.open_index()?;
        let size: Option<i64> = conn
            .query_row(
                "SELECT restore_size_bytes FROM databases WHERE database_id = ?1",
                params![database_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database not found: {database_id}"))?;
        size.map(|size| size.max(0) as u64)
            .ok_or_else(|| format!("restore size is missing: {database_id}"))
    }

    fn restore_snapshot_hash(&self, database_id: &str) -> Result<Vec<u8>, String> {
        let conn = self.open_index()?;
        let hash: Option<Vec<u8>> = conn
            .query_row(
                "SELECT snapshot_hash FROM databases WHERE database_id = ?1",
                params![database_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("database not found: {database_id}"))?;
        hash.ok_or_else(|| format!("snapshot_hash is missing: {database_id}"))
    }

    fn refresh_logical_size(&self, database_id: &str) -> Result<(), String> {
        let meta = self.database_meta_allowing_restoring(database_id)?;
        let size = file_size(&meta.db_file_name)?;
        let conn = self.open_index()?;
        conn.execute(
            "UPDATE databases
             SET logical_size_bytes = ?2
             WHERE database_id = ?1",
            params![database_id, i64::try_from(size).unwrap_or(i64::MAX)],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn open_index(&self) -> Result<Connection, String> {
        Connection::open(&self.index_path).map_err(|error| error.to_string())
    }
}

fn run_index_migrations(conn: &mut Connection, config: &BillingConfig) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|error| error.to_string())?;
    let versions = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if versions
        .iter()
        .any(|version| version != INDEX_SCHEMA_VERSION_INITIAL)
    {
        return Err("fresh index required for billing schema".to_string());
    }
    if versions
        .iter()
        .any(|version| version == INDEX_SCHEMA_VERSION_INITIAL)
    {
        return Ok(());
    }
    validate_billing_config(config)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute_batch(
        "CREATE TABLE databases (
           database_id TEXT PRIMARY KEY,
           display_name TEXT NOT NULL,
           db_file_name TEXT NOT NULL,
           mount_id INTEGER NOT NULL,
           active_mount_id INTEGER,
           status TEXT NOT NULL,
           schema_version TEXT NOT NULL,
           logical_size_bytes INTEGER NOT NULL,
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
    .map_err(|error| error.to_string())?;
    insert_billing_config(&tx, config)?;
    tx.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, strftime('%s','now'))",
        params![INDEX_SCHEMA_VERSION_INITIAL],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
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

fn insert_billing_config(conn: &Connection, config: &BillingConfig) -> Result<(), String> {
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

fn set_billing_config_value(conn: &Connection, key: &str, value: u64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO billing_config (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn load_billing_config_u64(conn: &Connection, key: &str) -> Result<u64, String> {
    let value = load_billing_config_text(conn, key)?;
    value.parse::<u64>().map_err(|error| error.to_string())
}

fn validate_display_name(display_name: &str) -> Result<String, String> {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        return Err("display_name must not be empty".to_string());
    }
    if trimmed.chars().count() > DISPLAY_NAME_MAX_CHARS {
        return Err(format!(
            "display_name must be at most {DISPLAY_NAME_MAX_CHARS} characters"
        ));
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '\n' | '\r'))
    {
        return Err("display_name must not contain control characters".to_string());
    }
    Ok(trimmed.to_string())
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
    conn: &Connection,
    principal: &str,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT OR IGNORE INTO principal_billing_accounts
         (principal, balance_e8s, created_at_ms, updated_at_ms)
         VALUES (?1, 0, ?2, ?2)",
        params![principal, now],
    )
    .map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT balance_e8s FROM principal_billing_accounts WHERE principal = ?1",
        params![principal],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn ensure_principal_billing_account(
    conn: &mut Connection,
    principal: &str,
    now: i64,
) -> Result<i64, String> {
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let balance = principal_balance_for_update(&tx, principal, now)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(balance)
}

fn database_balance_for_update(
    conn: &Connection,
    database_id: &str,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT OR IGNORE INTO database_billing_accounts
         (database_id, balance_e8s, suspended_at_ms, created_at_ms, updated_at_ms)
         VALUES (?1, 0, ?2, ?2, ?2)",
        params![database_id, now],
    )
    .map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT balance_e8s FROM database_billing_accounts WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn update_database_billing_balance(
    conn: &Connection,
    database_id: &str,
    balance: i64,
    config: &BillingConfig,
    now: i64,
) -> Result<(), String> {
    let min = amount_to_i64(config.min_update_balance_e8s)?;
    let suspended_at_ms = if balance >= min { None } else { Some(now) };
    conn.execute(
        "UPDATE database_billing_accounts
         SET balance_e8s = ?2, suspended_at_ms = ?3, updated_at_ms = ?4
         WHERE database_id = ?1",
        params![database_id, balance, suspended_at_ms, now],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_principal_ledger(
    conn: &Connection,
    principal: &str,
    kind: &str,
    amount_e8s: i64,
    balance_after_e8s: i64,
    database_id: Option<&str>,
    ledger_block_index: Option<u64>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO principal_billing_ledger
         (principal, kind, amount_e8s, balance_after_e8s, database_id, ledger_block_index,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            principal,
            kind,
            amount_e8s,
            balance_after_e8s,
            database_id,
            ledger_block_index.map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
            now
        ],
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
    conn: &Connection,
    entry: DatabaseLedgerInsert<'_>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO database_billing_ledger
         (database_id, kind, amount_e8s, balance_after_e8s, caller, method, cycles_delta,
          rate_numerator_e8s, rate_denominator_cycles, fixed_update_fee_e8s, usage_event_id,
          created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            entry.database_id,
            entry.kind,
            entry.amount_e8s,
            entry.balance_after_e8s,
            entry.caller,
            entry.method,
            entry
                .cycles_delta
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
            entry
                .config
                .map(|config| i64::try_from(config.rate_numerator_e8s).unwrap_or(i64::MAX)),
            entry
                .config
                .map(|config| i64::try_from(config.rate_denominator_cycles).unwrap_or(i64::MAX)),
            entry
                .config
                .map(|config| i64::try_from(config.fixed_update_fee_e8s).unwrap_or(i64::MAX)),
            entry
                .usage_event_id
                .map(|value| i64::try_from(value).unwrap_or(i64::MAX)),
            entry.now
        ],
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

fn map_principal_billing_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<PrincipalBillingEntry> {
    let entry_id: i64 = row.get(0)?;
    let balance_after: i64 = row.get(4)?;
    let ledger_block_index: Option<i64> = row.get(6)?;
    Ok(PrincipalBillingEntry {
        entry_id: entry_id.max(0) as u64,
        principal: row.get(1)?,
        kind: row.get(2)?,
        amount_e8s: row.get(3)?,
        balance_after_e8s: balance_after.max(0) as u64,
        database_id: row.get(5)?,
        ledger_block_index: ledger_block_index.map(|value| value.max(0) as u64),
        created_at_ms: row.get(7)?,
    })
}

fn map_database_billing_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseBillingEntry> {
    let entry_id: i64 = row.get(0)?;
    let balance_after: i64 = row.get(4)?;
    let cycles_delta: Option<i64> = row.get(7)?;
    let rate_numerator: Option<i64> = row.get(8)?;
    let rate_denominator: Option<i64> = row.get(9)?;
    let fixed_fee: Option<i64> = row.get(10)?;
    let usage_event_id: Option<i64> = row.get(11)?;
    Ok(DatabaseBillingEntry {
        entry_id: entry_id.max(0) as u64,
        database_id: row.get(1)?,
        kind: row.get(2)?,
        amount_e8s: row.get(3)?,
        balance_after_e8s: balance_after.max(0) as u64,
        caller: row.get(5)?,
        method: row.get(6)?,
        cycles_delta: cycles_delta.map(|value| value.max(0) as u64),
        rate_numerator_e8s: rate_numerator.map(|value| value.max(0) as u64),
        rate_denominator_cycles: rate_denominator.map(|value| value.max(0) as u64),
        fixed_update_fee_e8s: fixed_fee.map(|value| value.max(0) as u64),
        usage_event_id: usage_event_id.map(|value| value.max(0) as u64),
        created_at_ms: row.get(12)?,
    })
}

fn restore_chunks_cover_expected_size(
    conn: &Connection,
    database_id: &str,
    expected_size: u64,
) -> Result<bool, String> {
    if expected_size == 0 {
        return Ok(true);
    }
    let chunks = conn
        .prepare(
            "SELECT offset_bytes, end_bytes
             FROM database_restore_chunks
             WHERE database_id = ?1
             ORDER BY offset_bytes ASC, end_bytes ASC",
        )
        .map_err(|error| error.to_string())?
        .query_map(params![database_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut covered_end = 0_u64;
    for (offset, end) in chunks {
        let offset = u64::try_from(offset).map_err(|error| error.to_string())?;
        let end = u64::try_from(end).map_err(|error| error.to_string())?;
        if offset > covered_end {
            return Ok(false);
        }
        if end > expected_size {
            return Ok(false);
        }
        covered_end = covered_end.max(end);
        if covered_end == expected_size {
            return Ok(true);
        }
    }
    Ok(false)
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

fn allocate_mount_id(conn: &Connection) -> Result<u16, String> {
    let used = conn
        .prepare(
            "SELECT mount_id AS used_mount_id
             FROM database_mount_history
             ORDER BY used_mount_id ASC",
        )
        .map_err(|error| error.to_string())?
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
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
            |row| row.get::<_, String>(0),
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
        |row| status_from_db(&row.get::<_, String>(0)?),
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
        "SELECT database_id, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE database_id = ?1",
        params![database_id],
        |row| map_database_meta_with_statuses(row, statuses),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_databases(conn: &Connection) -> Result<Vec<DatabaseMeta>, String> {
    conn.prepare(
        "SELECT database_id, db_file_name, active_mount_id, schema_version, logical_size_bytes, status
         FROM databases
         WHERE status IN ('hot', 'archiving', 'restoring') AND active_mount_id IS NOT NULL
         ORDER BY mount_id ASC",
    )
    .map_err(|error| error.to_string())?
    .query_map([], map_database_meta)
    .map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_database_infos(conn: &Connection) -> Result<Vec<DatabaseInfo>, String> {
    conn.prepare(
        "SELECT database_id, status, active_mount_id, schema_version, logical_size_bytes,
                snapshot_hash, archived_at_ms, deleted_at_ms
         FROM databases
         ORDER BY database_id ASC",
    )
    .map_err(|error| error.to_string())?
    .query_map([], |row| {
        let mount_id: Option<i64> = row.get(2)?;
        let logical_size_bytes: i64 = row.get(4)?;
        Ok(DatabaseInfo {
            database_id: row.get(0)?,
            status: status_from_db(&row.get::<_, String>(1)?)?,
            mount_id: mount_id.map(mount_id_from_db).transpose()?,
            schema_version: row.get(3)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
            snapshot_hash: row.get(5)?,
            archived_at_ms: row.get(6)?,
            deleted_at_ms: row.get(7)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn load_database_summaries_for_caller(
    conn: &Connection,
    caller: &str,
) -> Result<Vec<DatabaseSummary>, String> {
    conn.prepare(
        "SELECT d.database_id, d.display_name, d.status, m.role, d.logical_size_bytes,
                COALESCE(b.balance_e8s, 0), b.suspended_at_ms,
                d.archived_at_ms, d.deleted_at_ms
         FROM databases d
         INNER JOIN database_members m ON m.database_id = d.database_id
         LEFT JOIN database_billing_accounts b ON b.database_id = d.database_id
         WHERE m.principal = ?1
         ORDER BY d.database_id ASC",
    )
    .map_err(|error| error.to_string())?
    .query_map(params![caller], |row| {
        let logical_size_bytes: i64 = row.get(4)?;
        let billing_balance_e8s: i64 = row.get(5)?;
        Ok(DatabaseSummary {
            database_id: row.get(0)?,
            display_name: row.get(1)?,
            status: status_from_db(&row.get::<_, String>(2)?)?,
            role: role_from_db(&row.get::<_, String>(3)?)?,
            logical_size_bytes: logical_size_bytes.max(0) as u64,
            billing_balance_e8s: billing_balance_e8s.max(0) as u64,
            billing_suspended_at_ms: row.get(6)?,
            archived_at_ms: row.get(7)?,
            deleted_at_ms: row.get(8)?,
        })
    })
    .map_err(|error| error.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|error| error.to_string())
}

fn map_database_meta_with_statuses(
    row: &rusqlite::Row<'_>,
    statuses: &[DatabaseStatus],
) -> rusqlite::Result<DatabaseMeta> {
    let status: String = row.get(5).unwrap_or_else(|_| "hot".to_string());
    let status = status_from_db(&status)?;
    if !statuses.contains(&status) {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    map_database_meta(row)
}

fn map_database_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatabaseMeta> {
    let mount_id: Option<i64> = row.get(2)?;
    let mount_id = mount_id.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let logical_size_bytes: i64 = row.get(4)?;
    Ok(DatabaseMeta {
        database_id: row.get(0)?,
        db_file_name: row.get(1)?,
        mount_id: mount_id_from_db(mount_id)?,
        schema_version: row.get(3)?,
        logical_size_bytes: logical_size_bytes.max(0) as u64,
    })
}

fn mount_id_from_db(mount_id: i64) -> rusqlite::Result<u16> {
    u16::try_from(mount_id).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(2, mount_id))
}

fn load_member_role(
    conn: &Connection,
    database_id: &str,
    principal: &str,
) -> Result<Option<DatabaseRole>, String> {
    conn.query_row(
        "SELECT role FROM database_members WHERE database_id = ?1 AND principal = ?2",
        params![database_id, principal],
        |row| role_from_db(&row.get::<_, String>(0)?),
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn role_from_db(role: &str) -> rusqlite::Result<DatabaseRole> {
    match role {
        "owner" => Ok(DatabaseRole::Owner),
        "writer" => Ok(DatabaseRole::Writer),
        "reader" => Ok(DatabaseRole::Reader),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn role_to_db(role: DatabaseRole) -> &'static str {
    match role {
        DatabaseRole::Owner => "owner",
        DatabaseRole::Writer => "writer",
        DatabaseRole::Reader => "reader",
    }
}

fn status_from_db(status: &str) -> rusqlite::Result<DatabaseStatus> {
    match status {
        "hot" => Ok(DatabaseStatus::Hot),
        "archiving" => Ok(DatabaseStatus::Archiving),
        "archived" => Ok(DatabaseStatus::Archived),
        "deleted" => Ok(DatabaseStatus::Deleted),
        "restoring" => Ok(DatabaseStatus::Restoring),
        _ => Err(rusqlite::Error::InvalidQuery),
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

fn file_size(path: &str) -> Result<u64, String> {
    metadata(path)
        .map(|metadata| metadata.len())
        .map_err(|error| error.to_string())
}
