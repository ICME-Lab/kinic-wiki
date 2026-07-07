// Where: crates/vfs_runtime/src/index_schema.rs
// What: Index database migrations and schema validation.
// Why: Mechanical split out of lib.rs; a child module keeps same-crate private access.
use super::*;

impl VfsService {
    pub fn run_index_migrations(&self) -> Result<(), String> {
        self.run_index_migrations_with_config(default_cycles_billing_config())
    }

    pub fn run_index_migrations_with_config(
        &self,
        config: CyclesBillingConfig,
    ) -> Result<(), String> {
        let action = {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let mut conn = self.open_index()?;
                run_index_migrations(&mut conn, &config)
            }
            #[cfg(target_arch = "wasm32")]
            {
                self.write_index(|conn| run_index_migrations_in_tx(conn, &config))
            }
        }?;
        self.apply_index_post_migration_action(action)
    }

    pub fn run_index_migrations_for_upgrade(
        &self,
        config: Option<CyclesBillingConfig>,
    ) -> Result<(), String> {
        let action = {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let mut conn = self.open_index()?;
                run_index_migrations_for_upgrade(&mut conn, config.as_ref())
            }
            #[cfg(target_arch = "wasm32")]
            {
                self.write_index(|conn| {
                    run_index_migrations_in_tx_for_upgrade(conn, config.as_ref())
                })
            }
        }?;
        self.apply_index_post_migration_action(action)
    }

    fn apply_index_post_migration_action(
        &self,
        action: IndexPostMigrationAction,
    ) -> Result<(), String> {
        match action {
            IndexPostMigrationAction::None => Ok(()),
        }
    }
}

fn run_index_migrations(
    conn: &mut Connection,
    config: &CyclesBillingConfig,
) -> Result<IndexPostMigrationAction, String> {
    if sqlite_master_entry_exists(conn, "table", "schema_migrations")? {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        validate_current_index_schema(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(IndexPostMigrationAction::None);
    }
    reject_existing_index_tables_without_migrations(conn)?;
    validate_cycles_billing_config(config)?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    create_schema_migrations(&tx)?;
    create_fresh_index_schema(&tx)?;
    insert_cycles_billing_config(&tx, config)?;
    insert_schema_migration_now(&tx, INDEX_SCHEMA_VERSION_CURRENT)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(IndexPostMigrationAction::None)
}

#[cfg(not(target_arch = "wasm32"))]
fn run_index_migrations_for_upgrade(
    conn: &mut Connection,
    config: Option<&CyclesBillingConfig>,
) -> Result<IndexPostMigrationAction, String> {
    if sqlite_master_entry_exists(conn, "table", "schema_migrations")? {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        validate_current_index_schema(&tx)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(IndexPostMigrationAction::None);
    }
    let config =
        config.ok_or_else(|| "cycles config required for fresh index upgrade".to_string())?;
    run_index_migrations(conn, config)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx(
    conn: &Transaction<'_>,
    config: &CyclesBillingConfig,
) -> Result<IndexPostMigrationAction, String> {
    if wasm_index_table_exists(conn, "schema_migrations")? {
        validate_current_index_schema(conn)?;
        return Ok(IndexPostMigrationAction::None);
    }
    reject_existing_index_tables_without_migrations_tx(conn)?;
    validate_cycles_billing_config(config)?;
    create_schema_migrations(conn)?;
    create_fresh_index_schema(conn)?;
    insert_cycles_billing_config(conn, config)?;
    insert_schema_migration_zero(conn, INDEX_SCHEMA_VERSION_CURRENT)?;
    validate_index_schema(conn)?;
    Ok(IndexPostMigrationAction::None)
}

#[cfg(target_arch = "wasm32")]
fn run_index_migrations_in_tx_for_upgrade(
    conn: &Transaction<'_>,
    config: Option<&CyclesBillingConfig>,
) -> Result<IndexPostMigrationAction, String> {
    if wasm_index_table_exists(conn, "schema_migrations")? {
        validate_current_index_schema(conn)?;
        return Ok(IndexPostMigrationAction::None);
    }
    let config =
        config.ok_or_else(|| "cycles config required for fresh index upgrade".to_string())?;
    run_index_migrations_in_tx(conn, config)
}

#[cfg(not(target_arch = "wasm32"))]
fn reject_existing_index_tables_without_migrations(conn: &Connection) -> Result<(), String> {
    for table in INDEX_SCHEMA_TABLES {
        if sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without supported schema_migrations; recreate the index database"
            ));
        }
    }
    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn reject_existing_index_tables_without_migrations_tx(
    conn: &Transaction<'_>,
) -> Result<(), String> {
    for table in INDEX_SCHEMA_TABLES {
        if tx_sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!(
                "unsupported index schema: {table} exists without schema_migrations"
            ));
        }
    }
    Ok(())
}

fn validate_current_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    let versions = applied_index_versions(conn)?;
    if versions.len() != 1 || versions[0] != INDEX_SCHEMA_VERSION_CURRENT {
        return Err(format!(
            "unsupported index schema version; recreate the index database: {}",
            versions.join(", ")
        ));
    }
    validate_index_schema(conn)
}

fn applied_index_versions(conn: &Transaction<'_>) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .map_err(|error| error.to_string())?;
    crate::sqlite::query_map(&mut stmt, params![], |row| {
        crate::sqlite::row_get::<String>(row, 0)
    })
    .map_err(|error| error.to_string())
}

fn create_schema_migrations(conn: &Transaction<'_>) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
        params![],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
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

fn validate_index_schema(conn: &Transaction<'_>) -> Result<(), String> {
    for table in [
        "schema_migrations",
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
                "description",
                "llm_summary",
                "tags_json",
                "db_file_name",
                "mount_id",
                "active_mount_id",
                "status",
                "schema_version",
                "logical_size_bytes",
                "deleted_at_ms",
                "created_at_ms",
                "updated_at_ms",
            ][..],
        ),
        (
            "source_capture_trigger_sessions",
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
            "database_members",
            &["database_id", "principal", "role", "created_at_ms"][..],
        ),
        (
            "database_mount_history",
            &["database_id", "mount_id", "reason", "created_at_ms"][..],
        ),
        (
            "database_cycle_accounts",
            &[
                "database_id",
                "balance_cycles",
                "suspended_at_ms",
                "storage_charged_at_ms",
                "created_at_ms",
                "updated_at_ms",
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
            "database_free_cycle_grants",
            &["principal", "database_id", "grant_cycles", "created_at_ms"][..],
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
        ("cycles_billing_config", &["key", "value"][..]),
        (
            "market_listings",
            &[
                "listing_id",
                "seller_principal",
                "payout_principal",
                "database_id",
                "price_e8s",
                "status",
                "revision",
                "purchase_count",
                "report_count",
                "created_at_ms",
                "updated_at_ms",
            ][..],
        ),
        (
            "market_orders",
            &[
                "order_id",
                "listing_id",
                "database_id",
                "buyer_principal",
                "seller_principal",
                "payout_principal",
                "price_e8s",
                "ledger_block_index",
                "created_at_ms",
            ][..],
        ),
        (
            "market_purchase_pending_operations",
            &[
                "operation_id",
                "listing_id",
                "database_id",
                "buyer_principal",
                "seller_principal",
                "price_e8s",
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
            "market_entitlements",
            &[
                "database_id",
                "buyer_principal",
                "listing_id",
                "order_id",
                "purchased_at_ms",
                "status",
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
    if index_column_exists(conn, "databases", "profile")? {
        return Err("unsupported index schema: stale column databases.profile".to_string());
    }
    for column in ["snapshot_hash", "restore_size_bytes"] {
        if index_column_exists(conn, "databases", column)? {
            return Err(format!(
                "unsupported index schema: stale column databases.{column}"
            ));
        }
    }
    if tx_sqlite_master_entry_exists(conn, "table", "url_ingest_trigger_sessions")? {
        return Err(
            "unsupported index schema: stale table url_ingest_trigger_sessions".to_string(),
        );
    }
    for table in ["database_restore_chunks", "database_restore_sessions"] {
        if tx_sqlite_master_entry_exists(conn, "table", table)? {
            return Err(format!("unsupported index schema: stale table {table}"));
        }
    }
    for index in [
        "databases_active_mount_id_idx",
        "source_capture_trigger_sessions_expiry_idx",
        "ops_answer_sessions_expiry_idx",
        "source_run_sessions_expiry_idx",
        "database_cycle_ledger_database_idx",
        "database_cycle_pending_operations_database_idx",
        "market_listings_status_idx",
        "market_listings_database_idx",
        "market_orders_buyer_idx",
        "market_purchase_pending_buyer_idx",
        "market_entitlements_database_buyer_active_idx",
        "market_entitlements_buyer_idx",
    ] {
        if !tx_sqlite_master_entry_exists(conn, "index", index)? {
            return Err(format!("unsupported index schema: missing index {index}"));
        }
    }
    if index_column_exists(conn, "databases", "title")? {
        return Err("unsupported index schema: stale column databases.title".to_string());
    }
    for column in ["name", "description", "llm_summary", "tags_json"] {
        if index_column_exists(conn, "market_listings", column)? {
            return Err(format!(
                "unsupported index schema: stale column market_listings.{column}"
            ));
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
