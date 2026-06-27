// Where: crates/vfs_runtime/tests/database_service.rs
// What: Multi-database service tests over local SQLite files.
// Why: The canister mount layer depends on runtime index and role semantics being deterministic.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use vfs_runtime::{
    CyclesPendingLedgerDetailsInput, DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL,
    DEFAULT_CYCLES_TOP_UP_THRESHOLD, DEFAULT_LLM_WRITER_PRINCIPAL,
    DatabaseCyclesPurchaseWithLedgerDetails, MAX_ARCHIVE_CHUNK_BYTES, MAX_DATABASE_SIZE_BYTES,
    MAX_RESTORE_CHUNK_BYTES, VfsService, cycles_for_payment_amount_e8s,
};
use vfs_store::FsStore;
use vfs_types::{
    AppendNodeRequest, CyclesBillingConfigUpdate, CyclesTopUpConfig, DatabaseRole, DatabaseStatus,
    DeleteDatabaseRequest, DeleteNodeRequest, EditNodeRequest, KINIC_LEDGER_FEE_E8S,
    MarketCreateListingRequest, MarketListing, MarketListingStatus, MarketPurchaseRequest,
    MarketUpdateListingRequest, MkdirNodeRequest, MoveNodeRequest, NodeKind,
    OpsAnswerSessionCheckRequest, OpsAnswerSessionRequest, QueryContextRequest, SearchNodesRequest,
    SearchPreviewMode, SourceRunSessionCheckRequest, UrlIngestTriggerSessionCheckRequest,
    UrlIngestTriggerSessionRequest, WriteNodeRequest, WriteSourceForGenerationRequest,
};

const MARKET_BUYER_PRINCIPAL: &str = "r7inp-6aaaa-aaaaa-aaabq-cai";
const MARKET_SECOND_BUYER_PRINCIPAL: &str = "rrkah-fqaaa-aaaaa-aaaaq-cai";

fn service() -> VfsService {
    service_with_root().0
}

fn service_with_root() -> (VfsService, PathBuf) {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    (service, root)
}

fn activate_pending_database(service: &VfsService) -> String {
    let pending = service
        .reserve_pending_generated_database("Workspace DB", "owner", 1)
        .expect("pending database should create");
    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 1_000_000, 2)
        .expect("cycle purchase should begin");
    service
        .prepare_pending_database_activation(&pending.database_id, 3)
        .expect("pending activation should prepare");
    let purchased_cycles = default_cycles_for_payment(1_000_000);
    service
        .complete_database_cycles_purchase_ledger_transfer(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
            42,
        )
        .expect("cycle purchase ledger transfer should complete");
    service
        .apply_database_cycles_purchase(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
            42,
            4,
        )
        .expect("cycle purchase should apply");
    pending.database_id
}

fn seed_sql_budget_rows(database_path: &Path, count: i64) {
    let mut conn = Connection::open(database_path).expect("db should open");
    let tx = conn.transaction().expect("seed transaction should start");
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO fs_nodes
                 (path, kind, content, created_at, updated_at, etag, metadata_json, name)
                 VALUES (?1, 'file', ?2, ?3, ?3, ?4, '{}', ?5)",
            )
            .expect("seed insert should prepare");
        for index in 0_i64..count {
            let name = format!("node-{index:05}.md");
            insert
                .execute(params![
                    format!("/Knowledge/budget/{name}"),
                    format!("budget content row {index}"),
                    index,
                    format!("etag-{index}"),
                    name,
                ])
                .expect("seed row should insert");
        }
    }
    tx.commit().expect("seed transaction should commit");
}

fn heavy_missing_sql() -> String {
    let predicates = vec!["length(content) >= 0"; 50].join(" AND ");
    format!(
        "SELECT json_object('path', path) FROM fs_nodes WHERE {predicates} AND content LIKE '%missing-budget-token%' LIMIT 1"
    )
}

fn test_cycles_top_up_config() -> CyclesTopUpConfig {
    CyclesTopUpConfig {
        enabled: true,
        launcher_principal: DEFAULT_CYCLES_TOP_UP_LAUNCHER_PRINCIPAL.to_string(),
        threshold_cycles: DEFAULT_CYCLES_TOP_UP_THRESHOLD,
    }
}

fn delete_request(database_id: &str) -> DeleteDatabaseRequest {
    DeleteDatabaseRequest {
        database_id: database_id.to_string(),
    }
}

fn market_listing_request(database_id: &str, price_e8s: u64) -> MarketCreateListingRequest {
    MarketCreateListingRequest {
        database_id: database_id.to_string(),
        payout_principal: "aaaaa-aa".to_string(),
        title: "Team database".to_string(),
        description: "Reusable team knowledge base".to_string(),
        llm_summary: None,
        tags_json: "[]".to_string(),
        price_e8s,
    }
}

fn market_purchase_request(
    listing: &MarketListing,
    access_principal: &str,
) -> MarketPurchaseRequest {
    MarketPurchaseRequest {
        listing_id: listing.listing_id.clone(),
        price_e8s: listing.price_e8s,
        access_principal: access_principal.to_string(),
    }
}

fn ledger_details<'a>(
    from_owner: &'a str,
    to_owner: &'a str,
    ledger_fee_e8s: u64,
    now: i64,
) -> CyclesPendingLedgerDetailsInput<'a> {
    CyclesPendingLedgerDetailsInput {
        from_owner,
        from_subaccount: None,
        to_owner,
        to_subaccount: None,
        ledger_fee_e8s,
        ledger_created_at_time_ns: u64::try_from(now).expect("now should fit u64") * 1_000_000,
    }
}

#[test]
fn mainnet_011_index_upgrades_to_latest() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    write_mainnet_011_index_schema(&index_path, "hot");

    let service = VfsService::new(index_path.clone(), root.join("databases"));
    service
        .run_index_migrations()
        .expect("only supported index migration should upgrade mainnet 011");

    let conn = Connection::open(&index_path).expect("index should open");
    let status: String = conn
        .query_row(
            "SELECT status FROM databases WHERE database_id = 'db_existing'",
            params![],
            |row| row.get(0),
        )
        .expect("database status should load");
    let profile_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('databases') WHERE name = 'profile'",
            params![],
            |row| row.get(0),
        )
        .expect("legacy column count should load");
    let profile: String = conn
        .query_row(
            "SELECT profile FROM databases WHERE database_id = 'db_existing'",
            params![],
            |row| row.get(0),
        )
        .expect("database profile should load");
    let balance: i64 = conn
        .query_row(
            "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id = 'db_existing'",
            params![],
            |row| row.get(0),
        )
        .expect("database cycles account should exist");
    let suspended_at_ms: Option<i64> = conn
        .query_row(
            "SELECT suspended_at_ms FROM database_cycle_accounts WHERE database_id = 'db_existing'",
            params![],
            |row| row.get(0),
        )
        .expect("database cycles suspension should exist");
    let storage_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_accounts')
             WHERE name = 'storage_charged_at_ms'",
            params![],
            |row| row.get(0),
        )
        .expect("storage charged cursor column should load");
    let removed_storage_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_accounts')
             WHERE name = 'storage_unbilled_cycles'",
            params![],
            |row| row.get(0),
        )
        .expect("removed storage column count should load");
    let pending_details_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_pending_operations')
             WHERE name IN ('from_owner', 'from_subaccount', 'to_owner', 'to_subaccount',
                            'ledger_fee_e8s', 'ledger_created_at_time_ns')",
            params![],
            |row| row.get(0),
        )
        .expect("pending details columns should load");
    let pending_ledger_block_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_pending_operations')
             WHERE name = 'ledger_block_index'",
            params![],
            |row| row.get(0),
        )
        .expect("pending ledger block column count should load");
    let ledger_cycles_column_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_ledger')
             WHERE name = 'cycles_per_cycle'",
            params![],
            |row| row.get(0),
        )
        .expect("ledger cycles column count should load");
    let usage_table_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'usage_events'",
            params![],
            |row| row.get(0),
        )
        .expect("usage table count should load");

    assert_eq!(status, "active");
    assert_eq!(profile_columns, 1);
    assert_eq!(profile, "memory");
    assert_eq!(balance, 0);
    assert_eq!(suspended_at_ms, Some(0));
    assert_eq!(storage_columns, 1);
    assert_eq!(removed_storage_columns, 0);
    assert_eq!(pending_details_columns, 6);
    assert_eq!(pending_ledger_block_columns, 1);
    assert_eq!(ledger_cycles_column_count, 0);
    assert_eq!(usage_table_count, 0);
    assert_eq!(
        schema_migration_count(&root, "database_index:020_cycles_billing_config_version"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:028_kinic_external_block_indexes"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:031_drop_app_balance"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:033_store_roots"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:034_database_profile"),
        1
    );
    assert_eq!(cycles_billing_config_key_count(&root, "config_version"), 0);
}

fn write_mainnet_011_index_schema(index_path: &std::path::Path, status: &str) {
    let database_root = index_path
        .parent()
        .expect("index path should have parent")
        .join("databases");
    std::fs::create_dir_all(&database_root).expect("database root should create");
    let database_path = database_root.join("db_existing.sqlite3");
    FsStore::new(database_path.clone())
        .run_fs_migrations()
        .expect("existing database schema should create");

    let conn = Connection::open(index_path).expect("index should open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );
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
    .expect("mainnet 011 schema should create");
    for version in [
        "database_index:000_initial",
        "database_index:001_lifecycle",
        "database_index:002_restore_size",
        "database_index:003_restore_chunks",
        "database_index:005_mount_history",
        "database_index:006_url_ingest_trigger_sessions",
        "database_index:007_ops_answer_sessions",
        "database_index:008_restore_sessions",
        "database_index:009_restore_chunk_bytes",
        "database_index:010_database_name_breaking",
        "database_index:011_source_run_sessions",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            params![version],
        )
        .expect("migration marker should insert");
    }
    conn.execute(
        "INSERT INTO databases
	           (database_id, name, db_file_name, mount_id, active_mount_id, status,
	            schema_version, logical_size_bytes, created_at_ms, updated_at_ms)
	         VALUES
	           ('db_existing', 'Existing', ?2, 11, 11, ?1,
	            'vfs_store:current', 0, 1, 1)",
        params![status, database_path.to_string_lossy()],
    )
    .expect("existing database row should insert");
}

#[test]
fn partial_billing_index_schema_is_rejected() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    write_mainnet_011_index_schema(&index_path, "hot");
    let conn = Connection::open(&index_path).expect("index should reopen");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params!["database_index:012_cycles_initial"],
    )
    .expect("partial billing marker should insert");
    drop(conn);

    let service = VfsService::new(index_path, root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("partial billing schema should reject");

    assert!(error.contains("unsupported partial index schema"));
}

#[test]
fn partial_marketplace_index_schema_is_rejected() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    write_mainnet_011_index_schema(&index_path, "hot");
    let conn = Connection::open(&index_path).expect("index should reopen");
    conn.execute(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
        params!["database_index:027_marketplace_core"],
    )
    .expect("partial marketplace marker should insert");
    drop(conn);

    let service = VfsService::new(index_path, root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("partial marketplace schema should reject");

    assert!(error.contains("unsupported partial index schema"));
    assert!(error.contains("database_index:027_marketplace_core"));
}

#[test]
fn pre_011_index_schema_is_rejected() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    let conn = Connection::open(&index_path).expect("index should open");
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
           ('database_index:010_database_name_breaking', 0);",
    )
    .expect("pre-011 marker schema should create");
    drop(conn);

    let service = VfsService::new(index_path, root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("pre-011 schema should reject");

    assert!(error.contains("database_index:011_source_run_sessions"));
}

#[test]
fn cycles_per_cycle_ledger_schema_is_rejected() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    let conn = Connection::open(&index_path).expect("index should open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );
         CREATE TABLE database_cycle_ledger (
           entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
           database_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           amount_cycles INTEGER NOT NULL,
           balance_after_cycles INTEGER NOT NULL,
           payment_amount_e8s INTEGER,
           caller TEXT NOT NULL,
           method TEXT,
           cycles_delta INTEGER,
           cycles_per_kinic INTEGER,
           cycles_per_cycle INTEGER,
           ledger_block_index INTEGER,
           created_at_ms INTEGER NOT NULL
         );
         CREATE TABLE cycles_billing_config (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )
    .expect("legacy cycles schema should create");
    for version in [
        "database_index:000_initial",
        "database_index:001_lifecycle",
        "database_index:002_restore_size",
        "database_index:003_restore_chunks",
        "database_index:005_mount_history",
        "database_index:006_url_ingest_trigger_sessions",
        "database_index:007_ops_answer_sessions",
        "database_index:008_restore_sessions",
        "database_index:009_restore_chunk_bytes",
        "database_index:010_database_name_breaking",
        "database_index:011_source_run_sessions",
        "database_index:012_cycles_initial",
    ] {
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
            params![version],
        )
        .expect("migration marker should insert");
    }
    drop(conn);

    let service = VfsService::new(index_path.clone(), root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("cycles_per_cycle schema should reject");

    let conn = Connection::open(index_path).expect("index should reopen");
    let ledger_cycles_column_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_ledger')
             WHERE name = 'cycles_per_cycle'",
            params![],
            |row| row.get(0),
        )
        .expect("ledger cycles column count should load");

    assert!(error.contains("unsupported partial index schema"));
    assert_eq!(ledger_cycles_column_count, 1);
}

fn assert_restore_size(root: &std::path::Path, database_id: &str, expected: Option<u64>) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let actual: Option<i64> = conn
        .query_row(
            "SELECT restore_size_bytes FROM databases WHERE database_id = ?1",
            params![database_id],
            |row| row.get(0),
        )
        .expect("restore size row should exist");
    assert_eq!(actual.map(|size| size as u64), expected);
}

fn sha256_bytes(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn database_index_row(
    root: &std::path::Path,
    database_id: &str,
) -> (String, Option<u16>, u64, Option<u64>) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT status, active_mount_id, logical_size_bytes, restore_size_bytes
         FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| {
            let active_mount_id: Option<i64> = row.get(1)?;
            let logical_size_bytes: i64 = row.get(2)?;
            let restore_size_bytes: Option<i64> = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                active_mount_id.map(|value| value as u16),
                logical_size_bytes.max(0) as u64,
                restore_size_bytes.map(|value| value.max(0) as u64),
            ))
        },
    )
    .expect("database index row should exist")
}

fn pending_database_activation_row(
    root: &std::path::Path,
    database_id: &str,
) -> (String, u16, Option<u16>, bool) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT status, mount_id, active_mount_id, db_file_name <> ''
         FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| {
            let mount_id: i64 = row.get(1)?;
            let active_mount_id: Option<i64> = row.get(2)?;
            let has_db_file_name: i64 = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                mount_id as u16,
                active_mount_id.map(|value| value as u16),
                has_db_file_name != 0,
            ))
        },
    )
    .expect("database activation row should exist")
}

fn assert_all_store_roots_exist(service: &VfsService, database_id: &str) {
    for path in [
        "/Memory",
        "/Knowledge",
        "/Skills",
        "/Sessions",
        "/Sources",
        "/Sources/sessions",
        "/Sources/skill-runs",
    ] {
        assert!(
            service
                .read_node(database_id, "owner", path)
                .expect("store root read should succeed")
                .is_some(),
            "{path} should exist"
        );
    }
}

fn database_index_row_exists(root: &std::path::Path, database_id: &str) -> bool {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT 1 FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .expect("database row check should load")
    .is_some()
}

fn database_updated_at_ms(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT updated_at_ms FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("database updated_at_ms should load")
}

fn set_database_logical_size(root: &std::path::Path, database_id: &str, size: u64) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.execute(
        "UPDATE databases SET logical_size_bytes = ?2 WHERE database_id = ?1",
        params![
            database_id,
            i64::try_from(size).expect("test size fits i64")
        ],
    )
    .expect("database logical size should update");
}

fn database_member_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_members WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("member count should load")
}

fn market_row_count(root: &std::path::Path, table: &str, database_id: &str) -> i64 {
    assert!(
        ["market_listings", "market_orders", "market_entitlements"].contains(&table),
        "test helper must only read marketplace tables"
    );
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE database_id = ?1"),
        params![database_id],
        |row| row.get(0),
    )
    .expect("market row count should load")
}

fn market_pending_operation_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM market_purchase_pending_operations WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("market pending operation count should load")
}

fn delete_market_listing_row(root: &std::path::Path, listing_id: &str) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.execute(
        "DELETE FROM market_listings WHERE listing_id = ?1",
        params![listing_id],
    )
    .expect("market listing row should delete");
}

fn database_cycles_balance(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT balance_cycles FROM database_cycle_accounts WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("database cycles balance should load")
}

fn database_cycles_suspended_at(root: &std::path::Path, database_id: &str) -> Option<i64> {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT suspended_at_ms FROM database_cycle_accounts WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("database cycles suspension should load")
}

fn cycles_billing_config_key_count(root: &std::path::Path, key: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM cycles_billing_config WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .expect("cycles config key count should load")
}

fn database_pending_operation_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_cycle_pending_operations WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("pending cycle operation count should load")
}

fn cycle_database(
    service: &VfsService,
    database_id: &str,
    caller: &str,
    payment_amount_e8s: u64,
    block_index: u64,
    now: i64,
) -> u64 {
    let operation_id = service
        .begin_database_cycles_purchase(database_id, caller, payment_amount_e8s, now)
        .expect("database cycle purchase should begin");
    let cycles = cycles_for_payment(service, database_id, payment_amount_e8s);
    service
        .complete_database_cycles_purchase_ledger_transfer(
            operation_id,
            database_id,
            caller,
            cycles,
            block_index,
        )
        .expect("database cycle purchase ledger transfer should complete");
    service
        .apply_database_cycles_purchase(operation_id, database_id, caller, cycles, block_index, now)
        .expect("database cycle purchase should cycle")
}

fn cycles_for_payment(service: &VfsService, database_id: &str, payment_amount_e8s: u64) -> u64 {
    service
        .validate_database_cycles_purchase(database_id, payment_amount_e8s)
        .expect("database cycle purchase should validate");
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");
    cycles_for_payment_amount_e8s(payment_amount_e8s, &config)
        .expect("database cycle purchase amount should compute")
}

fn default_cycles_for_payment(payment_amount_e8s: u64) -> u64 {
    payment_amount_e8s * 2_345
}

fn database_ledger_kinds(root: &std::path::Path, database_id: &str) -> Vec<String> {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let mut stmt = conn
        .prepare(
            "SELECT kind FROM database_cycle_ledger
             WHERE database_id = ?1
             ORDER BY entry_id ASC",
        )
        .expect("database ledger query should prepare");
    stmt.query_map(params![database_id], |row| row.get(0))
        .expect("database ledger query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("database ledger rows should load")
}

fn schema_migration_count(root: &std::path::Path, version: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
        params![version],
        |row| row.get(0),
    )
    .expect("migration count should load")
}

fn table_exists(root: &std::path::Path, name: &str) -> bool {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .expect("index existence should load")
    .is_some()
}

#[test]
fn fresh_index_schema_applies_app_balance_drop_marker_without_legacy_tables() {
    let (_service, root) = service_with_root();
    assert_eq!(
        schema_migration_count(&root, "database_index:031_drop_app_balance"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:027_marketplace_core"),
        1
    );
    assert!(table_exists(&root, "market_listings"));
    assert!(table_exists(&root, "market_purchase_pending_operations"));
    assert!(table_exists(&root, "market_entitlements"));
    assert!(!table_exists(&root, "kinic_accounts"));
    assert!(!table_exists(&root, "kinic_ledger"));
    assert!(!table_exists(&root, "kinic_pending_operations"));
}

fn mount_history_row(root: &std::path::Path, mount_id: u16) -> (String, String) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT database_id, reason FROM database_mount_history WHERE mount_id = ?1",
        params![i64::from(mount_id)],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("mount history row should exist")
}

fn mount_history_count(root: &std::path::Path) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_mount_history",
        params![],
        |row| row.get(0),
    )
    .expect("mount history count should load")
}

fn url_ingest_session_request(
    database_id: &str,
    session_nonce: &str,
) -> UrlIngestTriggerSessionRequest {
    UrlIngestTriggerSessionRequest {
        database_id: database_id.to_string(),
        session_nonce: session_nonce.to_string(),
    }
}

fn url_ingest_session_check_request(
    database_id: &str,
    request_path: &str,
    session_nonce: &str,
) -> UrlIngestTriggerSessionCheckRequest {
    UrlIngestTriggerSessionCheckRequest {
        database_id: database_id.to_string(),
        request_path: request_path.to_string(),
        session_nonce: session_nonce.to_string(),
    }
}

fn ops_answer_session_request(database_id: &str, session_nonce: &str) -> OpsAnswerSessionRequest {
    OpsAnswerSessionRequest {
        database_id: database_id.to_string(),
        session_nonce: session_nonce.to_string(),
    }
}

fn ops_answer_session_check_request(
    database_id: &str,
    session_nonce: &str,
) -> OpsAnswerSessionCheckRequest {
    OpsAnswerSessionCheckRequest {
        database_id: database_id.to_string(),
        session_nonce: session_nonce.to_string(),
    }
}

fn source_run_session_check_request(
    database_id: &str,
    source_path: &str,
    source_etag: &str,
    session_nonce: &str,
) -> SourceRunSessionCheckRequest {
    SourceRunSessionCheckRequest {
        database_id: database_id.to_string(),
        source_path: source_path.to_string(),
        source_etag: source_etag.to_string(),
        session_nonce: session_nonce.to_string(),
    }
}

fn write_source_for_generation_request(
    database_id: &str,
    path: &str,
    session_nonce: &str,
) -> WriteSourceForGenerationRequest {
    WriteSourceForGenerationRequest {
        database_id: database_id.to_string(),
        path: path.to_string(),
        content: "raw source".to_string(),
        metadata_json: "{}".to_string(),
        expected_etag: None,
        session_nonce: session_nonce.to_string(),
    }
}

fn url_ingest_content(status: &str, requested_by: &str) -> String {
    [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        &format!("status: {status}"),
        "url: \"https://example.com/\"",
        &format!("requested_by: \"{requested_by}\""),
        "requested_at: \"2026-05-14T00:00:00Z\"",
        "claimed_at: null",
        "source_path: null",
        "target_path: null",
        "finished_at: null",
        "error: null",
        "---",
        "",
        "# URL Ingest Request",
        "",
    ]
    .join("\n")
}

fn write_url_ingest_request(
    service: &VfsService,
    caller: &str,
    database_id: &str,
    path: &str,
    status: &str,
    requested_by: &str,
) {
    ensure_parent_folders(service, caller, database_id, path, 1);
    service
        .write_node(
            caller,
            WriteNodeRequest {
                database_id: database_id.to_string(),
                path: path.to_string(),
                kind: NodeKind::File,
                content: url_ingest_content(status, requested_by),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("url ingest request should write");
}

fn ensure_parent_folders(
    service: &VfsService,
    caller: &str,
    database_id: &str,
    path: &str,
    now_ms: i64,
) {
    let segments = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let mut current = String::new();
    for segment in segments.iter().take(segments.len().saturating_sub(1)) {
        current.push('/');
        current.push_str(segment);
        service
            .mkdir_node(
                caller,
                MkdirNodeRequest {
                    database_id: database_id.to_string(),
                    path: current.clone(),
                },
                now_ms,
            )
            .expect("parent folder should exist or be created");
    }
}

fn database_restore_chunk_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_restore_chunks WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("restore chunk count should load")
}

fn database_restore_session_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_restore_sessions WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("restore session count should load")
}

fn database_file_path(root: &std::path::Path, database_id: &str) -> PathBuf {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let db_file_name: String = conn
        .query_row(
            "SELECT db_file_name FROM databases WHERE database_id = ?1",
            params![database_id],
            |row| row.get(0),
        )
        .expect("database file path should load");
    PathBuf::from(db_file_name)
}

fn read_archive_in_chunks(
    service: &VfsService,
    database_id: &str,
    size_bytes: u64,
    chunk_size: u32,
) -> Vec<u8> {
    let mut offset = 0_u64;
    let mut bytes = Vec::new();
    while offset < size_bytes {
        let chunk = service
            .read_database_archive_chunk(database_id, "owner", offset, chunk_size)
            .expect("archive chunk should read");
        assert!(chunk.len() <= chunk_size as usize);
        assert!(!chunk.is_empty());
        offset += chunk.len() as u64;
        bytes.extend(chunk);
    }
    bytes
}

fn archive_bytes_for_chunk_size(
    service: &VfsService,
    database_id: &str,
    size_bytes: u64,
    chunk_size: u32,
) -> Vec<u8> {
    if chunk_size >= size_bytes as u32 {
        return service
            .read_database_archive_chunk(database_id, "owner", 0, chunk_size)
            .expect("single archive chunk should read");
    }
    read_archive_in_chunks(service, database_id, size_bytes, chunk_size)
}

#[test]
fn index_migrations_create_cycle_ledger_only_schema_once() {
    let (service, root) = service_with_root();

    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    for table_name in ["database_mount_history", "database_cycle_ledger"] {
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table_name],
                |row| row.get(0),
            )
            .expect("table lookup should work");
        assert_eq!(table_exists, 1);
    }
    let usage_table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'usage_events'",
            params![],
            |row| row.get(0),
        )
        .expect("usage table lookup should work");
    assert_eq!(usage_table_exists, 0);
    let usage_column_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('database_cycle_ledger')
             WHERE name = 'usage_event_id'",
            params![],
            |row| row.get(0),
        )
        .expect("cycle ledger column lookup should work");
    assert_eq!(usage_column_exists, 0);
    assert_eq!(
        schema_migration_count(&root, "database_index:018_cycles_ledger_only"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:005_mount_history"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:006_url_ingest_trigger_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:007_ops_answer_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:008_restore_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:011_source_run_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:010_database_name_breaking"),
        1
    );

    service
        .run_index_migrations()
        .expect("index migrations should be idempotent");
    assert_eq!(
        schema_migration_count(&root, "database_index:018_cycles_ledger_only"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:005_mount_history"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:006_url_ingest_trigger_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:007_ops_answer_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:008_restore_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:011_source_run_sessions"),
        1
    );
    assert_eq!(
        schema_migration_count(&root, "database_index:010_database_name_breaking"),
        1
    );
}

#[test]
fn url_ingest_trigger_session_requires_writer_and_allows_replay() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(&service, "owner", "alpha", request_path, "queued", "owner");

    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-1"),
            100,
        )
        .expect("owner should authorize session");
    service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            101,
        )
        .expect("session should check");
    service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            102,
        )
        .expect("session check should allow replay");
}

#[test]
fn url_ingest_trigger_session_requires_default_llm_writer() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(&service, "owner", "alpha", request_path, "queued", "owner");
    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-1"),
            100,
        )
        .expect("default LLM writer should allow session");

    service
        .revoke_database_access("alpha", "owner", DEFAULT_LLM_WRITER_PRINCIPAL)
        .expect("owner should revoke LLM writer");
    let check = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            101,
        )
        .expect_err("revoked LLM writer should fail session check");
    assert!(check.contains("LLM writer principal lacks writer access"));

    let authorize = service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-2"),
            102,
        )
        .expect_err("revoked LLM writer should fail session authorization");
    assert!(authorize.contains("LLM writer principal lacks writer access"));
}

#[test]
fn url_ingest_trigger_session_rejects_invalid_request_nodes() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("alpha", "owner", "other", DatabaseRole::Reader, 2)
        .expect("reader grant should succeed");
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(&service, "owner", "alpha", request_path, "queued", "owner");

    let reader = service
        .authorize_url_ingest_trigger_session(
            "other",
            url_ingest_session_request("alpha", "session-reader"),
            100,
        )
        .expect_err("reader principal should fail");
    assert!(reader.contains("lacks required database role"));

    let anonymous = service
        .authorize_url_ingest_trigger_session(
            "2vxsx-fae",
            url_ingest_session_request("alpha", "session-anonymous"),
            100,
        )
        .expect_err("anonymous principal should fail");
    assert!(anonymous.contains("anonymous caller not allowed"));

    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-owner"),
            100,
        )
        .expect("owner should authorize session");

    let invalid_path = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", "/Knowledge/not-request.md", "session-owner"),
            101,
        )
        .expect_err("non request path should fail");
    assert!(invalid_path.contains("request_path must be a URL ingest request path"));

    let missing = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request(
                "alpha",
                "/Sources/ingest-requests/missing.md",
                "session-owner",
            ),
            101,
        )
        .expect_err("missing node should fail");
    assert!(missing.contains("not found"));

    let completed_path = "/Sources/ingest-requests/completed.md";
    write_url_ingest_request(
        &service,
        "owner",
        "alpha",
        completed_path,
        "completed",
        "owner",
    );
    let completed = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", completed_path, "session-owner"),
            101,
        )
        .expect_err("completed request should fail");
    assert!(completed.contains("not triggerable"));

    let invalid_frontmatter_path = "/Sources/ingest-requests/invalid.md";
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: invalid_frontmatter_path.to_string(),
                kind: NodeKind::File,
                content: "not frontmatter".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("invalid request node should write");
    let invalid_frontmatter = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", invalid_frontmatter_path, "session-owner"),
            101,
        )
        .expect_err("invalid frontmatter should fail");
    assert!(invalid_frontmatter.contains("frontmatter"));

    let mismatch_path = "/Sources/ingest-requests/mismatch.md";
    write_url_ingest_request(&service, "owner", "alpha", mismatch_path, "queued", "other");
    let caller_mismatch = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", mismatch_path, "session-owner"),
            101,
        )
        .expect_err("requested_by mismatch should fail");
    assert!(caller_mismatch.contains("caller mismatch"));
}

#[test]
fn url_ingest_trigger_session_rejects_expired_and_unknown_nonce() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(&service, "owner", "alpha", request_path, "queued", "owner");

    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-1"),
            0,
        )
        .expect("session should authorize");
    let unknown = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "unknown"),
            1,
        )
        .expect_err("unknown nonce should fail");
    assert!(unknown.contains("missing or expired"));

    service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            1_800_000,
        )
        .expect("session should remain valid at ttl boundary");

    let expired = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            1_800_001,
        )
        .expect_err("expired session should fail");
    assert!(expired.contains("missing or expired"));
}

#[test]
fn url_ingest_trigger_session_check_requires_write_cycles_database() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(&service, "owner", "alpha", request_path, "queued", "owner");
    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-1"),
            100,
        )
        .expect("session should authorize before cycles changes");

    let error = service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            101,
        )
        .expect_err("suspended database should reject session check");

    assert!(error.contains("database cycles are suspended"));
}

#[test]
fn url_ingest_trigger_session_check_allows_generating_status() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    let request_path = "/Sources/ingest-requests/1.md";
    write_url_ingest_request(
        &service,
        "owner",
        "alpha",
        request_path,
        "generating",
        "owner",
    );
    service
        .authorize_url_ingest_trigger_session(
            "owner",
            url_ingest_session_request("alpha", "session-1"),
            100,
        )
        .expect("session should authorize");

    service
        .check_url_ingest_trigger_session(
            url_ingest_session_check_request("alpha", request_path, "session-1"),
            101,
        )
        .expect("generating request should remain session-checkable");
}

#[test]
fn source_for_generation_writes_source_and_authorizes_bound_session() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer grant should succeed");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 3)
        .expect("reader grant should succeed");
    let path = "/Sources/web/abc.md";
    ensure_parent_folders(&service, "owner", "alpha", path, 4);

    let reader = service
        .write_source_for_generation(
            "reader",
            write_source_for_generation_request("alpha", path, "session-reader"),
            100,
        )
        .expect_err("reader should not write source for generation");
    assert!(reader.contains("lacks required database role"));

    let written = service
        .write_source_for_generation(
            "writer",
            write_source_for_generation_request("alpha", path, "session-1"),
            101,
        )
        .expect("writer should write source and authorize session");
    assert_eq!(written.write.node.path, path);
    assert_eq!(written.write.node.kind, vfs_types::NodeKind::Source);
    assert_eq!(written.session_nonce, "session-1");

    let wrong_path = service
        .check_source_run_session(
            source_run_session_check_request(
                "alpha",
                "/Sources/other/other.md",
                &written.write.node.etag,
                "session-1",
            ),
            102,
        )
        .expect_err("session should be bound to source path");
    assert!(wrong_path.contains("missing or expired"));

    let wrong_etag = service
        .check_source_run_session(
            source_run_session_check_request("alpha", path, "etag-other", "session-1"),
            102,
        )
        .expect_err("session should be bound to source etag");
    assert!(wrong_etag.contains("missing or expired"));

    service
        .check_source_run_session(
            source_run_session_check_request("alpha", path, &written.write.node.etag, "session-1"),
            102,
        )
        .expect("source run session should check");
    service
        .check_source_run_session(
            source_run_session_check_request("alpha", path, &written.write.node.etag, "session-1"),
            102,
        )
        .expect("source run session should allow retry within ttl");

    let revoke_session = service
        .write_source_for_generation(
            "writer",
            write_source_for_generation_request("alpha", "/Sources/web/def.md", "session-2"),
            103,
        )
        .expect("writer should authorize second session");
    service
        .revoke_database_access("alpha", "owner", "writer")
        .expect("writer revoke should succeed");
    let revoked = service
        .check_source_run_session(
            source_run_session_check_request(
                "alpha",
                "/Sources/web/def.md",
                &revoke_session.write.node.etag,
                "session-2",
            ),
            104,
        )
        .expect_err("revoked writer should fail even before ttl");
    assert!(revoked.contains("principal has no access"));
}

#[test]
fn source_run_session_requires_funded_database() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let path = "/Sources/web/abc.md";
    ensure_parent_folders(&service, "owner", "alpha", path, 2);
    let written = service
        .write_source_for_generation(
            "owner",
            write_source_for_generation_request("alpha", path, "session-1"),
            100,
        )
        .expect("source run session should be authorized");

    let error = service
        .check_source_run_session(
            source_run_session_check_request("alpha", path, &written.write.node.etag, "session-1"),
            101,
        )
        .expect_err("suspended database should reject source run session");
    assert!(error.contains("database cycles are suspended"));
}

#[test]
fn source_for_generation_requires_default_llm_writer() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let path = "/Sources/web/abc.md";
    ensure_parent_folders(&service, "owner", "alpha", path, 2);
    let written = service
        .write_source_for_generation(
            "owner",
            write_source_for_generation_request("alpha", path, "session-1"),
            100,
        )
        .expect("default LLM writer should allow source run session");

    service
        .revoke_database_access("alpha", "owner", DEFAULT_LLM_WRITER_PRINCIPAL)
        .expect("owner should revoke LLM writer");
    let check = service
        .check_source_run_session(
            source_run_session_check_request("alpha", path, &written.write.node.etag, "session-1"),
            101,
        )
        .expect_err("revoked LLM writer should fail session check");
    assert!(check.contains("LLM writer principal lacks writer access"));

    let write = service
        .write_source_for_generation(
            "owner",
            write_source_for_generation_request("alpha", "/Sources/web/def.md", "session-2"),
            102,
        )
        .expect_err("revoked LLM writer should fail source write authorization");
    assert!(write.contains("LLM writer principal lacks writer access"));
}

#[test]
fn ops_answer_session_allows_database_members_and_replay() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer grant should succeed");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 3)
        .expect("reader grant should succeed");

    for principal in ["owner", "writer", "reader"] {
        let nonce = format!("session-{principal}");
        service
            .authorize_ops_answer_session(
                principal,
                ops_answer_session_request("alpha", &nonce),
                100,
            )
            .expect("member should authorize ops answer session");
        let checked = service
            .check_ops_answer_session(ops_answer_session_check_request("alpha", &nonce), 101)
            .expect("ops answer session should check");
        assert_eq!(checked.principal, principal);
        service
            .check_ops_answer_session(ops_answer_session_check_request("alpha", &nonce), 102)
            .expect("ops answer session check should allow replay");
    }
}

#[test]
fn ops_answer_session_rejects_anonymous_and_non_members() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("alpha", "owner", "2vxsx-fae", DatabaseRole::Reader, 2)
        .expect("anonymous public grant should succeed");

    let anonymous = service
        .authorize_ops_answer_session(
            "2vxsx-fae",
            ops_answer_session_request("alpha", "session-anonymous"),
            100,
        )
        .expect_err("anonymous principal should fail");
    assert!(anonymous.contains("anonymous caller not allowed"));

    let missing = service
        .authorize_ops_answer_session(
            "other",
            ops_answer_session_request("alpha", "session-other"),
            100,
        )
        .expect_err("non member should fail");
    assert!(missing.contains("principal has no access"));
}

#[test]
fn ops_answer_session_check_requires_write_cycles_database() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .authorize_ops_answer_session("owner", ops_answer_session_request("alpha", "session-1"), 0)
        .expect("session should authorize before cycles changes");

    let error = service
        .check_ops_answer_session(ops_answer_session_check_request("alpha", "session-1"), 1)
        .expect_err("suspended database should reject ops answer session check");

    assert!(error.contains("database cycles are suspended"));
}

#[test]
fn check_database_write_cycles_requires_writer_and_funded_database() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer grant should succeed");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 3)
        .expect("reader grant should succeed");

    let suspended = service
        .check_database_write_cycles("alpha", "writer")
        .expect_err("suspended database should reject writer");
    assert!(suspended.contains("database cycles are suspended"));

    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 4);
    service
        .check_database_write_cycles("alpha", "owner")
        .expect("owner should pass write cycles check");
    service
        .check_database_write_cycles("alpha", "writer")
        .expect("writer should pass write cycles check");

    let reader = service
        .check_database_write_cycles("alpha", "reader")
        .expect_err("reader should fail write cycles check");
    assert!(reader.contains("principal lacks required database role"));
    let anonymous = service
        .check_database_write_cycles("alpha", "2vxsx-fae")
        .expect_err("anonymous should fail write cycles check");
    assert!(anonymous.contains("anonymous caller not allowed"));
    let missing = service
        .check_database_write_cycles("alpha", "missing")
        .expect_err("non-member should fail write cycles check");
    assert!(missing.contains("principal has no access"));
}

#[test]
fn ops_answer_session_rechecks_current_role_after_revoke() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 2)
        .expect("reader grant should succeed");
    service
        .authorize_ops_answer_session(
            "reader",
            ops_answer_session_request("alpha", "session-reader"),
            100,
        )
        .expect("reader should authorize session");
    service
        .check_ops_answer_session(
            ops_answer_session_check_request("alpha", "session-reader"),
            101,
        )
        .expect("session should check before revoke");

    service
        .revoke_database_access("alpha", "owner", "reader")
        .expect("reader revoke should succeed");
    let revoked = service
        .check_ops_answer_session(
            ops_answer_session_check_request("alpha", "session-reader"),
            102,
        )
        .expect_err("revoked reader should fail even before ttl");
    assert!(revoked.contains("principal has no access"));
}

#[test]
fn ops_answer_session_rejects_invalid_and_expired_nonce() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000_000, 1, 2);

    service
        .authorize_ops_answer_session("owner", ops_answer_session_request("alpha", "session-1"), 0)
        .expect("session should authorize");
    let unknown = service
        .check_ops_answer_session(ops_answer_session_check_request("alpha", "unknown"), 1)
        .expect_err("unknown nonce should fail");
    assert!(unknown.contains("missing or expired"));

    service
        .check_ops_answer_session(
            ops_answer_session_check_request("alpha", "session-1"),
            1_800_000,
        )
        .expect("session should remain valid at ttl boundary");

    let expired = service
        .check_ops_answer_session(
            ops_answer_session_check_request("alpha", "session-1"),
            1_800_001,
        )
        .expect_err("expired session should fail");
    assert!(expired.contains("missing or expired"));
}

#[test]
fn database_create_returns_generated_id_and_name() {
    let (service, root) = service_with_root();

    assert_eq!(
        schema_migration_count(&root, "database_index:010_database_name_breaking"),
        1
    );

    let result = service
        .create_generated_database(" Team skills ", "owner", 1)
        .expect("database should create");

    assert!(result.database_id.starts_with("db_"));
    assert_eq!(result.database_id.len(), 15);
    assert_eq!(result.name, "Team skills");
    assert_eq!(database_member_count(&root, &result.database_id), 2);
    assert_eq!(database_cycles_balance(&root, &result.database_id), 0);
    assert_eq!(
        database_cycles_suspended_at(&root, &result.database_id),
        Some(1)
    );
    assert!(database_ledger_kinds(&root, &result.database_id).is_empty());
    let row = database_index_row(&root, &result.database_id);
    assert_eq!(row.0, "active");
    assert_eq!(row.1, Some(11));
    assert!(row.2 > 0);
    assert_eq!(row.3, None);
    assert_all_store_roots_exist(&service, &result.database_id);
}

#[test]
fn pending_database_creation_defers_mount_slot_until_cycles_purchase_activation() {
    let (service, root) = service_with_root();

    let pending = service
        .reserve_pending_generated_database(" Pending ", "owner", 1)
        .expect("pending database should create");

    assert!(pending.database_id.starts_with("db_"));
    assert_eq!(pending.name, "Pending");
    assert_eq!(database_member_count(&root, &pending.database_id), 2);
    assert_eq!(database_cycles_balance(&root, &pending.database_id), 0);
    assert_eq!(
        database_cycles_suspended_at(&root, &pending.database_id),
        Some(1)
    );
    assert_eq!(mount_history_count(&root), 0);
    assert_eq!(
        database_index_row(&root, &pending.database_id),
        ("pending".to_string(), None, 0, None)
    );
    assert!(
        service
            .read_node(&pending.database_id, "owner", "/Knowledge/a.md")
            .expect_err("pending DB should reject VFS reads")
            .contains("database is pending")
    );
    service
        .validate_database_cycles_purchase(&pending.database_id, 500)
        .expect("validation should accept pending DB cycle purchase");

    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 1_000_000, 2)
        .expect("cycle purchase should begin");
    assert_eq!(mount_history_count(&root), 0);
    assert_eq!(
        database_index_row(&root, &pending.database_id),
        ("pending".to_string(), None, 0, None)
    );
    let meta = service
        .prepare_pending_database_activation(&pending.database_id, 2)
        .expect("pending activation should prepare")
        .expect("pending activation should allocate mount");
    assert_eq!(meta.mount_id, 11);
    assert_eq!(
        pending_database_activation_row(&root, &pending.database_id),
        ("pending".to_string(), 11, None, true)
    );
    let purchased_cycles = default_cycles_for_payment(1_000_000);
    service
        .complete_database_cycles_purchase_ledger_transfer(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
            42,
        )
        .expect("cycle purchase ledger transfer should complete");
    let balance = service
        .apply_database_cycles_purchase(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
            42,
            4,
        )
        .expect("cycle purchase should activate and cycle");

    assert_eq!(balance, purchased_cycles);
    let row = database_index_row(&root, &pending.database_id);
    assert_eq!(row.0, "active");
    assert_eq!(row.1, Some(11));
    assert!(row.2 > 0);
    assert_eq!(
        database_cycles_balance(&root, &pending.database_id),
        purchased_cycles as i64
    );
    assert_eq!(
        database_pending_operation_count(&root, &pending.database_id),
        0
    );
    assert_eq!(
        mount_history_row(&root, 11),
        (pending.database_id.clone(), "activate".to_string())
    );
}

#[test]
fn pending_database_creation_uses_default_internal_profile() {
    let (service, root) = service_with_root();
    let pending = service
        .reserve_pending_generated_database(" Agent Memory ", "owner", 1)
        .expect("pending database should create");
    let summaries = service
        .list_database_summaries_for_caller("owner")
        .expect("owner summaries should load");
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let profile_columns: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('databases') WHERE name = 'profile'",
            params![],
            |row| row.get(0),
        )
        .expect("profile column count should load");
    let profile: String = conn
        .query_row(
            "SELECT profile FROM databases WHERE database_id = ?1",
            params![&pending.database_id],
            |row| row.get(0),
        )
        .expect("pending profile should load");

    assert_eq!(pending.name, "Agent Memory");
    assert_eq!(summaries[0].database_id, pending.database_id);
    assert_eq!(
        pending_database_activation_row(&root, &pending.database_id),
        ("pending".to_string(), 0, None, false)
    );
    assert_eq!(profile_columns, 1);
    assert_eq!(profile, "memory");
}

#[test]
fn pending_database_activation_seeds_all_store_roots() {
    let (service, _root) = service_with_root();
    let database_id = activate_pending_database(&service);
    assert_all_store_roots_exist(&service, &database_id);
}

#[test]
fn query_context_defaults_namespace_to_memory() {
    let (service, _root) = service_with_root();
    let database_id = activate_pending_database(&service);
    let memory = service
        .query_context(
            "owner",
            QueryContextRequest {
                database_id,
                task: "remember facts".to_string(),
                entities: vec![],
                namespace: None,
                budget_tokens: 100,
                include_evidence: false,
                depth: 0,
            },
        )
        .expect("memory recall should succeed");
    assert_eq!(memory.namespace, "/Memory");
}

#[test]
fn pending_database_creation_limits_unresolved_per_caller() {
    let service = service();

    for offset in 0..3 {
        service
            .reserve_pending_generated_database(
                &format!("Pending {offset}"),
                "owner",
                1_700_000_000_000 + offset,
            )
            .expect("pending database should create within limit");
    }

    let error = service
        .reserve_pending_generated_database("Pending 3", "owner", 1_700_000_000_010)
        .expect_err("fourth unresolved pending database should fail");
    assert!(error.contains("too many pending databases for caller"));

    service
        .reserve_pending_generated_database("Other caller", "other", 1_700_000_000_010)
        .expect("pending limit should be per caller");
}

#[test]
fn pending_database_creation_purges_expired_unstarted_reservations() {
    let (service, root) = service_with_root();
    let mut expired_ids = Vec::new();
    for offset in 0..3 {
        let pending = service
            .reserve_pending_generated_database(&format!("Expired {offset}"), "owner", offset)
            .expect("expired pending database should create");
        expired_ids.push(pending.database_id);
    }

    let fresh = service
        .reserve_pending_generated_database("Fresh", "owner", 86_400_003)
        .expect("expired unstarted pending databases should be purged before limit check");

    assert!(database_index_row_exists(&root, &fresh.database_id));
    for database_id in expired_ids {
        assert!(!database_index_row_exists(&root, &database_id));
    }
}

#[test]
fn pending_database_creation_preserves_in_flight_cycle_operations_during_cleanup() {
    let (service, root) = service_with_root();
    let protected = service
        .reserve_pending_generated_database("In flight", "owner", 0)
        .expect("pending database should create");
    service
        .begin_database_cycles_purchase(&protected.database_id, "payer", 500, 1)
        .expect("cycle purchase should begin");
    for offset in 0..2 {
        service
            .reserve_pending_generated_database(&format!("Expired {offset}"), "owner", offset + 2)
            .expect("expired pending database should create");
    }

    service
        .reserve_pending_generated_database("Fresh", "owner", 86_400_003)
        .expect("unprotected expired pending databases should be purged");

    assert!(database_index_row_exists(&root, &protected.database_id));
    assert_eq!(
        database_pending_operation_count(&root, &protected.database_id),
        1
    );
}

#[test]
fn pending_database_creation_preserves_activation_started_reservations_during_cleanup() {
    let (service, root) = service_with_root();
    let activated = service
        .reserve_pending_generated_database("Activating", "owner", 0)
        .expect("pending database should create");
    service
        .prepare_pending_database_activation(&activated.database_id, 1)
        .expect("pending activation should start")
        .expect("pending activation should allocate mount");
    for offset in 0..2 {
        service
            .reserve_pending_generated_database(&format!("Expired {offset}"), "owner", offset + 2)
            .expect("expired pending database should create");
    }

    service
        .reserve_pending_generated_database("Fresh", "owner", 86_400_003)
        .expect("unactivated expired pending databases should be purged");

    assert!(database_index_row_exists(&root, &activated.database_id));
    let row = database_index_row(&root, &activated.database_id);
    assert_eq!(row.0, "pending");
    assert_eq!(row.1, None);
    assert_eq!(
        pending_database_activation_row(&root, &activated.database_id),
        ("pending".to_string(), 11, None, true)
    );
    assert_eq!(row.3, None);
}

#[test]
fn pending_database_cycles_purchase_cancel_does_not_allocate_mount_slot() {
    let (service, root) = service_with_root();
    let pending = service
        .reserve_pending_generated_database("Cancel", "owner", 1)
        .expect("pending database should create");

    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 500, 3)
        .expect("cycle purchase should begin");
    let purchased_cycles = default_cycles_for_payment(500);
    service
        .cancel_database_cycles_purchase(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
        )
        .expect("ledger reject cancel should delete operation");

    assert_eq!(mount_history_count(&root), 0);
    assert_eq!(
        database_index_row(&root, &pending.database_id),
        ("pending".to_string(), None, 0, None)
    );
    let active = service
        .create_database("active", "owner", 5)
        .expect("active database should use first mount");
    assert_eq!(active.mount_id, 11);
}

#[test]
fn cleanup_database_cycles_purchase_discards_started_pending_activation() {
    let (service, root) = service_with_root();
    let pending = service
        .reserve_pending_generated_database("Started cleanup", "owner", 1)
        .expect("pending database should create");
    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 500, 2)
        .expect("cycle purchase should begin");
    let purchased_cycles = default_cycles_for_payment(500);
    let meta = service
        .prepare_pending_database_activation(&pending.database_id, 4)
        .expect("pending activation should prepare")
        .expect("activation should allocate mount");
    assert_eq!(meta.mount_id, 11);

    service
        .cleanup_database_cycles_purchase_after_no_credit(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
        )
        .expect("no-credit cleanup should discard reservation");

    assert_eq!(
        database_pending_operation_count(&root, &pending.database_id),
        0
    );
    assert_eq!(mount_history_count(&root), 0);
    assert!(!database_index_row_exists(&root, &pending.database_id));
}

#[test]
fn cycles_purchase_rejects_archive_restore_statuses() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let archive_info = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let archiving = service
        .validate_database_cycles_purchase("alpha", 500)
        .expect_err("archiving database should reject purchase");
    assert!(archiving.contains("database is archiving"));

    let archive = read_archive_in_chunks(&service, "alpha", archive_info.size_bytes, 17);
    let snapshot_hash = sha256_bytes(&archive);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");
    let archived = service
        .validate_database_cycles_purchase("alpha", 500)
        .expect_err("archived database should reject purchase");
    assert!(archived.contains("database is archived"));

    service
        .begin_database_restore("alpha", "owner", snapshot_hash, archive_info.size_bytes, 4)
        .expect("restore should begin");
    let restoring = service
        .validate_database_cycles_purchase("alpha", 500)
        .expect_err("restoring database should reject purchase");
    assert!(restoring.contains("database is restoring"));
}

#[test]
fn lifecycle_operations_reject_pending_cycle_purchase() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .begin_database_cycles_purchase("alpha", "payer", 500, 2)
        .expect("cycle purchase should begin");

    let archive = service
        .begin_database_archive("alpha", "owner", 3)
        .expect_err("archive should reject pending cycle operation");
    assert!(archive.contains("pending cycle operation"));
}

#[test]
fn old_index_schema_without_schema_migrations_stays_unsupported() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    let conn = Connection::open(&index_path).expect("index should open");
    conn.execute_batch(
        "CREATE TABLE databases (
           database_id TEXT PRIMARY KEY,
           db_file_name TEXT NOT NULL,
           mount_id INTEGER NOT NULL,
           schema_version TEXT NOT NULL,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL
         );",
    )
    .expect("old schema should create");

    let service = VfsService::new(index_path, root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("schema without migrations should be unsupported");
    assert!(error.contains("exists without supported schema_migrations"));
}

#[test]
fn database_create_rejects_duplicate_requested_id_for_internal_setup() {
    let service = service();

    service
        .create_database("team-skills", "owner", 1)
        .expect("first database should create");
    let error = service
        .create_database("team-skills", "owner", 2)
        .expect_err("duplicate database id should fail");

    assert!(error.contains("database already exists"));
}

#[test]
fn requested_database_create_starts_with_zero_cycles_balance() {
    let (service, root) = service_with_root();

    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    assert_eq!(database_cycles_balance(&root, "alpha"), 0);
    assert_eq!(database_cycles_suspended_at(&root, "alpha"), Some(1));
    assert!(database_ledger_kinds(&root, "alpha").is_empty());
}

#[test]
fn reservation_starts_with_zero_cycles_balance() {
    let (service, root) = service_with_root();

    service
        .reserve_database("reserved", "Reserved", "owner", 1)
        .expect("reservation should create");

    assert_eq!(database_cycles_balance(&root, "reserved"), 0);
    assert_eq!(database_cycles_suspended_at(&root, "reserved"), Some(1));
    assert!(database_ledger_kinds(&root, "reserved").is_empty());
}

#[test]
fn database_cycles_purchase_allows_authenticated_non_owner() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "alpha", "owner", 1_000, 1, 3);

    service
        .begin_database_cycles_purchase("alpha", "stranger", 100, 4)
        .expect("authenticated non-owner should be allowed to purchase cycles");
}

#[test]
fn cycles_billing_config_update_changes_only_mutable_values() {
    let (service, root) = service_with_root();
    assert_eq!(cycles_billing_config_key_count(&root, "config_version"), 0);

    service
        .update_cycles_billing_config(
            CyclesBillingConfigUpdate {
                cycles_per_kinic: 234_500_000_000,
                min_update_cycles: 1_000_000,
                top_up: test_cycles_top_up_config(),
            },
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
        )
        .expect("same config should update");
    assert_eq!(cycles_billing_config_key_count(&root, "config_version"), 0);

    service
        .update_cycles_billing_config(
            CyclesBillingConfigUpdate {
                cycles_per_kinic: 469_000_000_000,
                min_update_cycles: 1_000_000,
                top_up: test_cycles_top_up_config(),
            },
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
        )
        .expect("changed config should update");
    assert_eq!(
        service
            .cycles_billing_config()
            .expect("cycles config should load")
            .cycles_per_kinic,
        469_000_000_000
    );
    assert_eq!(cycles_billing_config_key_count(&root, "config_version"), 0);
}

#[test]
fn cycles_purchase_validation_accepts_current_payment_inputs() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    service
        .validate_database_cycles_purchase("alpha", 50_000)
        .expect("purchase should validate");
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");

    assert_eq!(
        cycles_for_payment_amount_e8s(50_000, &config).expect("cycles should compute"),
        117_250_000
    );
}

#[test]
fn cycles_purchase_begin_returns_current_config_amount() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let start = service
        .begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id: "alpha",
                caller: "payer",
                payment_amount_e8s: 50_000,
                min_expected_cycles: 1,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: "payer",
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: KINIC_LEDGER_FEE_E8S,
                    ledger_created_at_time_ns: 2_000_000,
                },
                now: 2,
            },
        )
        .expect("purchase should begin");
    assert_eq!(start.amount_cycles, 117_250_000);
    assert_eq!(database_pending_operation_count(&root, "alpha"), 1);
}

#[test]
fn database_cycles_purchase_settlement_survives_owner_role_change() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let operation_id = service
        .begin_database_cycles_purchase("alpha", "owner", 500, 2)
        .expect("owner should start cycle purchase");
    let purchased_cycles = cycles_for_payment(&service, "alpha", 500);
    service
        .grant_database_access("alpha", "owner", "replacement", DatabaseRole::Owner, 2)
        .expect("replacement owner should grant");
    service
        .revoke_database_access("alpha", "replacement", "owner")
        .expect("replacement should revoke original owner");

    service
        .complete_database_cycles_purchase_ledger_transfer(
            operation_id,
            "alpha",
            "owner",
            purchased_cycles,
            7,
        )
        .expect("cycle purchase ledger transfer should complete");
    let balance = service
        .apply_database_cycles_purchase(operation_id, "alpha", "owner", purchased_cycles, 7, 3)
        .expect("started cycle purchase should settle");

    assert_eq!(balance, purchased_cycles);
    assert_eq!(
        database_cycles_balance(&root, "alpha"),
        purchased_cycles as i64
    );
    assert_eq!(
        database_ledger_kinds(&root, "alpha"),
        vec!["cycles_purchase"]
    );
}

#[test]
fn pending_database_cycles_purchase_blocks_delete_until_resolved() {
    let (service, root) = service_with_root();
    for database_id in ["complete", "cancel"] {
        service
            .create_database(database_id, "owner", 1)
            .expect("database should create");
    }
    let complete = service
        .begin_database_cycles_purchase("complete", "owner", 500, 2)
        .expect("cycle purchase should begin");
    let cancel = service
        .begin_database_cycles_purchase("cancel", "owner", 500, 2)
        .expect("cycle purchase should begin");
    let purchased_cycles = cycles_for_payment(&service, "complete", 500);

    for database_id in ["complete", "cancel"] {
        let error = service
            .delete_database(delete_request(database_id), "owner", 3)
            .expect_err("pending cycle purchase should block delete");
        assert!(error.contains("pending cycle operation"));
        assert_eq!(database_pending_operation_count(&root, database_id), 1);
    }

    service
        .complete_database_cycles_purchase_ledger_transfer(
            complete,
            "complete",
            "owner",
            purchased_cycles,
            10,
        )
        .expect("cycle purchase ledger transfer should complete");
    service
        .apply_database_cycles_purchase(complete, "complete", "owner", purchased_cycles, 10, 4)
        .expect("cycle purchase should complete");
    service
        .cancel_database_cycles_purchase(cancel, "cancel", "owner", purchased_cycles)
        .expect("cycle purchase should cancel");

    for database_id in ["complete", "cancel"] {
        assert_eq!(database_pending_operation_count(&root, database_id), 0);
        service
            .delete_database(delete_request(database_id), "owner", 5)
            .expect("resolved cycle purchase should allow delete");
    }
}

#[test]
fn delete_database_removes_index_rows_and_discards_remaining_cycles() {
    let (service, root) = service_with_root();
    service
        .create_database("funded", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "funded", "owner", 100_000_000, 1, 2);

    service
        .delete_database(delete_request("funded"), "owner", 3)
        .expect("remaining cycles should be discarded on delete");
    assert!(!database_index_row_exists(&root, "funded"));
    assert_eq!(database_member_count(&root, "funded"), 0);
    assert_eq!(database_pending_operation_count(&root, "funded"), 0);
    assert!(database_ledger_kinds(&root, "funded").is_empty());
}

#[test]
fn cycles_history_requires_writer_and_redacts_principals_for_non_owners() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer should be granted");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 2)
        .expect("reader should be granted");
    cycle_database(&service, "alpha", "payer-principal", 500, 42, 3);

    let reader_error = service
        .list_database_cycle_entries("alpha", "reader", None, 10)
        .expect_err("reader should not list history");
    assert!(reader_error.contains("principal lacks required database role"));

    let writer_entry = service
        .list_database_cycle_entries("alpha", "writer", None, 10)
        .expect("writer should list history")
        .entries
        .remove(0);
    assert_eq!(writer_entry.caller, "redacted");

    let owner_entry = service
        .list_database_cycle_entries("alpha", "owner", None, 10)
        .expect("owner should list history")
        .entries
        .remove(0);
    assert_eq!(owner_entry.caller, "payer-principal");

    let billing_authority_entry = service
        .list_database_cycle_entries("alpha", "rrkah-fqaaa-aaaaa-aaaaq-cai", None, 10)
        .expect("billing authority should list history without membership")
        .entries
        .remove(0);
    assert_eq!(billing_authority_entry.caller, "payer-principal");

    let error = service
        .list_database_cycle_entries("alpha", "outsider", None, 10)
        .expect_err("outsider should not list history");
    assert!(error.contains("principal has no access"));
}

#[test]
fn cycles_history_paginates_with_clamped_limits() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    for index in 0..105 {
        cycle_database(&service, "alpha", "owner", 500, index + 1, index as i64 + 2);
    }

    let minimum_page = service
        .list_database_cycle_entries("alpha", "owner", None, 0)
        .expect("minimum page should load");
    assert_eq!(minimum_page.entries.len(), 1);
    assert_eq!(minimum_page.entries[0].entry_id, 1);
    assert_eq!(minimum_page.next_cursor, Some(1));

    let first_page = service
        .list_database_cycle_entries("alpha", "owner", None, 200)
        .expect("first clamped page should load");
    assert_eq!(first_page.entries.len(), 100);
    assert_eq!(first_page.entries[0].entry_id, 1);
    assert_eq!(first_page.entries[99].entry_id, 100);
    assert_eq!(first_page.next_cursor, Some(100));

    let second_page = service
        .list_database_cycle_entries("alpha", "owner", first_page.next_cursor, 200)
        .expect("second clamped page should load");
    assert_eq!(second_page.entries.len(), 5);
    assert_eq!(second_page.entries[0].entry_id, 101);
    assert_eq!(second_page.entries[4].entry_id, 105);
    assert_eq!(second_page.next_cursor, None);
}

#[test]
fn database_rename_requires_owner() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "writer", DatabaseRole::Writer, 2)
        .expect("writer should grant");

    let error = service
        .rename_database("alpha", "writer", "Writer rename", 3)
        .expect_err("writer should not rename");
    assert!(error.contains("required database role"));

    service
        .rename_database("alpha", "owner", " Owner rename ", 4)
        .expect("owner should rename");
    let summaries = service
        .list_database_summaries_for_caller("owner")
        .expect("summaries should load");
    assert_eq!(summaries[0].name, "Owner rename");
    let row = database_index_row(&root, "alpha");
    assert_eq!(row.0, "active");
}

#[test]
fn zero_cycle_charge_skips_cycle_ledger() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let purchased_cycles = cycle_database(&service, "alpha", "owner", 5_000, 7, 2);
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");

    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 0, 3)
        .expect("zero-cycle update should skip charge");

    assert_eq!(
        database_cycles_balance(&root, "alpha"),
        purchased_cycles as i64
    );
    assert_eq!(
        database_ledger_kinds(&root, "alpha"),
        vec!["cycles_purchase"]
    );

    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 1_000_000, 4)
        .expect("charged update should record cycle ledger");

    let after_first_charge = purchased_cycles as i64 - 1_000_000;
    assert_eq!(database_cycles_balance(&root, "alpha"), after_first_charge);
    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 1_000_001, 5)
        .expect("raw update cycle charge should record cycle ledger");

    let after_second_charge = after_first_charge - 1_000_001;
    assert_eq!(database_cycles_balance(&root, "alpha"), after_second_charge);
    service
        .charge_database_update(
            &config,
            "alpha",
            "owner",
            "write_node",
            u128::try_from(after_second_charge).expect("remaining balance should fit") + 1,
            6,
        )
        .expect("overdrawn update cycle charge should consume remaining balance");
    assert_eq!(database_cycles_balance(&root, "alpha"), 0);
    assert_eq!(database_cycles_suspended_at(&root, "alpha"), Some(6));
    assert_eq!(
        database_ledger_kinds(&root, "alpha"),
        vec!["cycles_purchase", "charge", "charge", "charge"]
    );

    let overdrawn_entries = service
        .list_database_cycle_entries("alpha", "owner", None, 10)
        .expect("cycle entries should load")
        .entries;
    assert_eq!(overdrawn_entries[3].kind, "charge");
    assert_eq!(overdrawn_entries[3].amount_cycles, -after_second_charge);
    assert_eq!(
        overdrawn_entries[3].cycles_delta,
        Some(after_second_charge as u64 + 1)
    );

    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let purchased_cycles = cycle_database(&service, "alpha", "owner", 5_000, 7, 2);
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");

    service
        .charge_database_update(
            &config,
            "alpha",
            "owner",
            "write_node",
            u128::from(purchased_cycles),
            7,
        )
        .expect("exact balance cycle charge should succeed");

    assert_eq!(database_cycles_balance(&root, "alpha"), 0);
    let entries = service
        .list_database_cycle_entries("alpha", "owner", None, 10)
        .expect("cycle entries should load")
        .entries;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].kind, "charge");
    assert_eq!(entries[1].amount_cycles, -(purchased_cycles as i64));
}

#[test]
fn charge_database_update_reports_missing_cycle_account() {
    let (service, _) = service_with_root();
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");

    let error = service
        .charge_database_update(&config, "missing", "owner", "write_node", 1, 1)
        .expect_err("missing cycle account should fail");

    assert!(error.contains("database cycles account not found: missing"));
}

#[test]
fn creates_databases_with_unique_mount_ids() {
    let service = service();

    let alpha = service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    let beta = service
        .create_database("beta", "owner", 2)
        .expect("beta should create");

    assert_eq!(alpha.mount_id, 11);
    assert_eq!(beta.mount_id, 12);
    assert_ne!(alpha.db_file_name, beta.db_file_name);
}

#[test]
fn lists_database_summaries_for_caller_memberships_only() {
    let service = service();
    service
        .create_database("alpha", "owner_a", 1)
        .expect("alpha should create");
    service
        .create_database("beta", "owner_b", 2)
        .expect("beta should create");
    service
        .grant_database_access("alpha", "owner_a", "owner_b", DatabaseRole::Reader, 3)
        .expect("shared grant should succeed");

    let owner_a_summaries = service
        .list_database_summaries_for_caller("owner_a")
        .expect("owner_a summaries should load");
    assert_eq!(owner_a_summaries.len(), 1);
    assert_eq!(owner_a_summaries[0].database_id, "alpha");
    assert_eq!(owner_a_summaries[0].role, DatabaseRole::Owner);
    assert_eq!(owner_a_summaries[0].status, DatabaseStatus::Active);

    let owner_b_summaries = service
        .list_database_summaries_for_caller("owner_b")
        .expect("owner_b summaries should load");
    let owner_b_ids = owner_b_summaries
        .iter()
        .map(|summary| summary.database_id.clone())
        .collect::<Vec<_>>();
    let owner_b_roles = owner_b_summaries
        .into_iter()
        .map(|summary| summary.role)
        .collect::<Vec<_>>();
    assert_eq!(owner_b_ids, vec!["alpha".to_string(), "beta".to_string()]);
    assert_eq!(
        owner_b_roles,
        vec![DatabaseRole::Reader, DatabaseRole::Owner]
    );

    let outsider_summaries = service
        .list_database_summaries_for_caller("outsider")
        .expect("outsider summaries should load");
    assert!(outsider_summaries.is_empty());
}

#[test]
fn grant_database_access_enforces_member_limit_for_new_members_only() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    for index in 0..30 {
        service
            .grant_database_access(
                "alpha",
                "owner",
                &format!("member-{index}"),
                DatabaseRole::Reader,
                2 + index,
            )
            .expect("member grant should fit limit");
    }
    assert_eq!(database_member_count(&root, "alpha"), 32);

    service
        .grant_database_access("alpha", "owner", "member-0", DatabaseRole::Writer, 40)
        .expect("existing member role update should ignore member cap");

    let error = service
        .grant_database_access("alpha", "owner", "member-30", DatabaseRole::Reader, 41)
        .expect_err("new member beyond cap should fail");
    assert!(error.contains("too many database members"));

    service
        .revoke_database_access("alpha", "owner", "member-1")
        .expect("member revoke should succeed");
    service
        .grant_database_access("alpha", "owner", "member-30", DatabaseRole::Reader, 42)
        .expect("new member should fit after revoke");
    assert_eq!(database_member_count(&root, "alpha"), 32);
}

#[test]
fn discards_failed_database_reservation_for_retry() {
    let (service, root) = service_with_root();
    service
        .reserve_database("retryable", "Retryable", "owner", 1)
        .expect("reservation should create");
    assert_eq!(database_member_count(&root, "retryable"), 2);

    service
        .discard_database_reservation("retryable")
        .expect("reservation should discard");
    assert_eq!(database_member_count(&root, "retryable"), 0);

    let meta = service
        .create_database("retryable", "owner", 2)
        .expect("same database_id should create after discard");
    assert_eq!(meta.database_id, "retryable");
    assert_eq!(database_member_count(&root, "retryable"), 2);
}

#[test]
fn database_cycles_purchase_rejects_duplicate_pending_operation_for_caller() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let first = service
        .begin_database_cycles_purchase("alpha", "payer", 500, 2)
        .expect("first purchase should begin");
    let duplicate = service
        .begin_database_cycles_purchase("alpha", "payer", 600, 3)
        .expect_err("same caller should not create duplicate pending purchase");
    assert!(duplicate.contains("cycles purchase already pending for caller"));

    service
        .begin_database_cycles_purchase("alpha", "other-payer", 600, 4)
        .expect("different caller can begin separate purchase");

    let cycles = default_cycles_for_payment(500);
    service
        .cancel_database_cycles_purchase(first, "alpha", "payer", cycles)
        .expect("first purchase should cancel");
    service
        .begin_database_cycles_purchase("alpha", "payer", 700, 5)
        .expect("caller can begin after pending operation resolves");

    assert_eq!(database_pending_operation_count(&root, "alpha"), 2);
}

#[test]
fn database_cycles_purchase_rejects_when_cycles_below_minimum_quote() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let cycles = default_cycles_for_payment(50_000);

    let error = service
        .begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id: "alpha",
                caller: "payer",
                payment_amount_e8s: 50_000,
                min_expected_cycles: cycles + 1,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: "payer",
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: KINIC_LEDGER_FEE_E8S,
                    ledger_created_at_time_ns: 2_000_000,
                },
                now: 2,
            },
        )
        .expect_err("stale quote should reject before pending operation");

    assert!(error.contains("below min_expected_cycles"));
    assert_eq!(database_pending_operation_count(&root, "alpha"), 0);
}

#[test]
fn lists_pending_cycles_purchases_for_owner_authority_and_payer() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let operation_id = service
        .begin_database_cycles_purchase("alpha", "payer", 500, 2)
        .expect("purchase should begin");

    let owner = service
        .list_database_cycles_pending_purchases("alpha", "owner")
        .expect("owner should view pending purchase");
    assert_eq!(owner.len(), 1);
    assert_eq!(owner[0].operation_id, operation_id);
    assert_eq!(owner[0].status, "in_flight");
    assert_eq!(owner[0].required_action, "wait_for_ledger_result");

    let payer = service
        .list_database_cycles_pending_purchases("alpha", "payer")
        .expect("payer should view own pending purchase");
    assert_eq!(payer, owner);

    let authority = service
        .cycles_billing_config()
        .expect("config should load")
        .billing_authority_id;
    let authority_view = service
        .list_database_cycles_pending_purchases("alpha", &authority)
        .expect("billing authority should view pending purchase");
    assert_eq!(authority_view, owner);

    let error = service
        .list_database_cycles_pending_purchases("alpha", "stranger")
        .expect_err("unrelated caller should reject");
    assert!(error.contains("cannot view pending cycle purchases"));
}

#[test]
fn delete_database_reports_pending_cycles_purchase_action() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let operation_id = service
        .begin_database_cycles_purchase("alpha", "payer", 500, 2)
        .expect("purchase should begin");

    let error = service
        .delete_database(
            DeleteDatabaseRequest {
                database_id: "alpha".to_string(),
            },
            "owner",
            3,
        )
        .expect_err("delete should block while pending purchase exists");

    assert!(error.contains(&format!("operation_id={operation_id}")));
    assert!(error.contains("status=in_flight"));
    assert!(error.contains("required_action=wait_for_ledger_result"));
}

#[test]
fn rejects_invalid_database_ids() {
    let service = service();

    for database_id in ["", "../escape", "has/slash", "has.dot", "has space"] {
        let error = service
            .create_database(database_id, "owner", 1)
            .expect_err("invalid database_id should be rejected");
        assert!(
            error.contains("database_id"),
            "error should mention database_id for {database_id:?}: {error}"
        );
    }

    let too_long = "a".repeat(65);
    let error = service
        .create_database(&too_long, "owner", 1)
        .expect_err("too long database_id should be rejected");
    assert!(error.contains("1..64"));
}

#[test]
fn rejects_database_creation_after_mount_capacity() {
    let (service, root) = service_with_root();
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");

    for mount_id in 11..32767 {
        conn.execute(
            "INSERT INTO database_mount_history
             (database_id, mount_id, reason, created_at_ms)
             VALUES (?1, ?2, 'create', 1)",
            params![format!("reserved_{mount_id}"), i64::from(mount_id)],
        )
        .expect("reserved mount history should insert");
    }

    let meta = service
        .create_database("db_32767", "owner", 32767)
        .expect("last mount_id should create");
    assert_eq!(meta.mount_id, 32767);

    let error = service
        .create_database("db_32768", "owner", 32768)
        .expect_err("next database should exceed mount capacity");
    assert_eq!(error, "database mount_id capacity exhausted");
}

#[test]
fn isolates_nodes_between_databases() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .create_database("beta", "owner", 2)
        .expect("beta should create");

    for database_id in ["alpha", "beta"] {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: database_id.to_string(),
                    path: "/Knowledge/shared.md".to_string(),
                    kind: NodeKind::File,
                    content: format!("{database_id} body"),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                10,
            )
            .expect("write should succeed");
    }

    let alpha = service
        .read_node("alpha", "owner", "/Knowledge/shared.md")
        .expect("alpha read should succeed")
        .expect("alpha node should exist");
    let beta_hits = service
        .search_nodes(
            "owner",
            SearchNodesRequest {
                database_id: "beta".to_string(),
                query_text: "alpha".to_string(),
                prefix: Some("/Knowledge".to_string()),
                top_k: 10,
                preview_mode: Some(SearchPreviewMode::None),
            },
        )
        .expect("beta search should succeed");

    assert_eq!(alpha.content, "alpha body");
    assert!(beta_hits.is_empty());
}

#[test]
fn tracks_logical_size_and_does_not_reuse_deleted_slots() {
    let (service, root) = service_with_root();
    let alpha = service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let alpha_info = service
        .list_database_infos()
        .expect("infos should load")
        .into_iter()
        .find(|info| info.database_id == "alpha")
        .expect("alpha info should exist");
    assert_eq!(alpha_info.status, DatabaseStatus::Active);
    assert!(alpha_info.logical_size_bytes > 0);

    service
        .delete_database(delete_request("alpha"), "owner", 3)
        .expect("delete should succeed");
    assert!(!database_index_row_exists(&root, "alpha"));
    service
        .read_node("alpha", "owner", "/Knowledge/a.md")
        .expect_err("deleted DB should reject reads");

    let beta = service
        .create_database("beta", "owner", 4)
        .expect("beta should create with a fresh slot");
    assert_ne!(beta.mount_id, alpha.mount_id);
    assert_eq!(
        mount_history_row(&root, alpha.mount_id),
        ("alpha".to_string(), "create".to_string())
    );
    assert_eq!(
        mount_history_row(&root, beta.mount_id),
        ("beta".to_string(), "create".to_string())
    );
}

#[test]
fn logical_size_refreshes_after_node_mutations() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");

    let written = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");
    assert!(database_index_row(&root, "alpha").2 > 0);

    let appended = service
        .append_node(
            "owner",
            AppendNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                content: "beta body".to_string(),
                expected_etag: Some(written.node.etag),
                separator: Some("\n".to_string()),
                metadata_json: None,
                kind: None,
            },
            3,
        )
        .expect("append should succeed");
    assert!(database_index_row(&root, "alpha").2 > 0);

    let edited = service
        .edit_node(
            "owner",
            EditNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                old_text: "beta body".to_string(),
                new_text: "gamma body".to_string(),
                expected_etag: Some(appended.node.etag),
                replace_all: false,
            },
            4,
        )
        .expect("edit should succeed");
    assert!(database_index_row(&root, "alpha").2 > 0);

    let moved = service
        .move_node(
            "owner",
            MoveNodeRequest {
                database_id: "alpha".to_string(),
                from_path: "/Knowledge/a.md".to_string(),
                to_path: "/Knowledge/b.md".to_string(),
                expected_etag: Some(edited.node.etag),
                overwrite: false,
            },
            5,
        )
        .expect("move should succeed");
    assert!(database_index_row(&root, "alpha").2 > 0);

    service
        .delete_node(
            "owner",
            DeleteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/b.md".to_string(),
                expected_etag: Some(moved.node.etag),
                expected_folder_index_etag: None,
            },
            6,
        )
        .expect("delete should succeed");
    assert!(database_index_row(&root, "alpha").2 > 0);
}

#[test]
fn delete_database_allows_missing_file_but_rejects_other_remove_errors() {
    let (service, root) = service_with_root();
    service
        .create_database("missing_file", "owner", 1)
        .expect("database should create");
    let missing_file = service
        .list_databases()
        .expect("databases should load")
        .into_iter()
        .find(|meta| meta.database_id == "missing_file")
        .expect("database meta should exist")
        .db_file_name;
    std::fs::remove_file(&missing_file).expect("database file should delete");
    service
        .delete_database(delete_request("missing_file"), "owner", 2)
        .expect("missing file should not block delete");
    assert!(!database_index_row_exists(&root, "missing_file"));

    service
        .create_database("remove_error", "owner", 3)
        .expect("database should create");
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.execute(
        "UPDATE databases SET db_file_name = ?2 WHERE database_id = ?1",
        params!["remove_error", root.to_string_lossy().as_ref()],
    )
    .expect("db file path should update");

    let error = service
        .delete_database(delete_request("remove_error"), "owner", 4)
        .expect_err("non-NotFound remove error should fail");
    assert!(!error.is_empty());
    assert_eq!(database_index_row(&root, "remove_error").0, "active");
}

#[test]
fn begin_database_archive_rejects_missing_database_file_without_recreating_it() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    let db_file_name = service
        .list_databases()
        .expect("databases should load")
        .into_iter()
        .find(|meta| meta.database_id == "alpha")
        .expect("database meta should exist")
        .db_file_name;
    std::fs::remove_file(&db_file_name).expect("database file should delete");

    let error = service
        .begin_database_archive("alpha", "owner", 2)
        .expect_err("missing database file should fail archive");

    assert!(!error.is_empty());
    assert_eq!(database_index_row(&root, "alpha").0, "active");
    assert!(!PathBuf::from(db_file_name).exists());
}

#[test]
fn begin_database_archive_updates_updated_at_ms() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    assert_eq!(database_updated_at_ms(&root, "alpha"), 1);

    service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");

    assert_eq!(database_updated_at_ms(&root, "alpha"), 2);
}

#[test]
fn archive_chunks_use_stored_archiving_size() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 3)
        .expect("archive should begin");
    assert_eq!(database_index_row(&root, "alpha").2, archive.size_bytes);

    set_database_logical_size(&root, "alpha", 1);
    assert_eq!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, 17)
            .expect("stored-size bounded archive chunk should read")
            .len(),
        1
    );
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 1, 17)
            .expect("stored-size tail should read")
            .is_empty()
    );
}

#[test]
fn archives_and_restores_database_bytes() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, 17)
            .expect_err("active DB should reject archive chunk reads")
            .contains("database")
    );
    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    assert_eq!(database_updated_at_ms(&root, "alpha"), 2);
    assert!(archive.size_bytes > 0);
    let archiving = database_index_row(&root, "alpha");
    let archiving_mount_id = archiving.1;
    assert_eq!(
        archiving,
        (
            "archiving".to_string(),
            archiving_mount_id,
            archive.size_bytes,
            None
        )
    );
    assert!(
        service
            .read_node("alpha", "owner", "/Knowledge/a.md")
            .expect_err("archiving DB should reject reads")
            .contains("database is archiving")
    );
    assert!(
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: "/Knowledge/b.md".to_string(),
                    kind: NodeKind::File,
                    content: "blocked".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                3,
            )
            .expect_err("archiving DB should reject writes")
            .contains("database is archiving")
    );
    assert!(
        service
            .append_node(
                "owner",
                AppendNodeRequest {
                    database_id: "alpha".to_string(),
                    path: "/Knowledge/a.md".to_string(),
                    content: "blocked".to_string(),
                    expected_etag: None,
                    separator: None,
                    metadata_json: None,
                    kind: None,
                },
                3,
            )
            .expect_err("archiving DB should reject appends")
            .contains("database is archiving")
    );
    assert!(
        service
            .delete_node(
                "owner",
                DeleteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: "/Knowledge/a.md".to_string(),
                    expected_etag: None,
                    expected_folder_index_etag: None,
                },
                3,
            )
            .expect_err("archiving DB should reject deletes")
            .contains("database is archiving")
    );
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, MAX_ARCHIVE_CHUNK_BYTES + 1)
            .expect_err("oversized archive chunk should fail")
            .contains("archive chunk size exceeds limit")
    );
    let bytes = read_archive_in_chunks(&service, "alpha", archive.size_bytes, 17);
    assert_eq!(bytes.len() as u64, archive.size_bytes);
    assert_eq!(
        archive_bytes_for_chunk_size(&service, "alpha", archive.size_bytes, 64 * 1024),
        bytes
    );
    assert_eq!(
        archive_bytes_for_chunk_size(
            &service,
            "alpha",
            archive.size_bytes,
            archive.size_bytes as u32 + 1
        ),
        bytes
    );
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, 0)
            .expect("zero-byte archive chunk should read")
            .is_empty()
    );
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", archive.size_bytes, 17)
            .expect("tail archive chunk should read")
            .is_empty()
    );
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", archive.size_bytes + 10, 17)
            .expect("out-of-range archive chunk should read")
            .is_empty()
    );
    let full_chunk = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    assert_eq!(full_chunk, bytes);
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, 17)
            .expect_err("archived DB should reject archive chunk reads")
            .contains("database is archived")
    );
    assert_eq!(
        database_index_row(&root, "alpha"),
        (
            "archived".to_string(),
            archiving_mount_id,
            archive.size_bytes,
            None,
        )
    );
    assert!(
        service
            .read_node("alpha", "owner", "/Knowledge/a.md")
            .expect_err("archived DB should reject reads")
            .contains("database is archived")
    );

    service
        .begin_database_restore(
            "alpha",
            "owner",
            snapshot_hash.clone(),
            archive.size_bytes,
            4,
        )
        .expect("restore should begin");
    assert!(
        service
            .read_database_archive_chunk("alpha", "owner", 0, 17)
            .expect_err("restoring DB should reject archive chunk reads")
            .contains("database is restoring")
    );
    let restoring = database_index_row(&root, "alpha");
    assert_eq!(restoring.0, "restoring");
    assert!(restoring.1.is_some());
    assert_eq!(restoring.2, archive.size_bytes);
    assert_eq!(restoring.3, Some(archive.size_bytes));
    let error = service
        .begin_database_restore("alpha", "owner", vec![1, 2, 3], archive.size_bytes, 5)
        .expect_err("invalid restore hash should fail before state checks");
    assert!(error.contains("snapshot_hash must be"));
    assert_eq!(
        service
            .list_database_infos()
            .expect("infos should load")
            .into_iter()
            .find(|info| info.database_id == "alpha")
            .expect("alpha info should exist")
            .status,
        DatabaseStatus::Restoring
    );
    assert!(
        service
            .read_node("alpha", "owner", "/Knowledge/a.md")
            .expect_err("restoring DB should reject reads")
            .contains("database is restoring")
    );
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes)
        .expect("restore chunk should write");
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 1);
    assert_eq!(database_restore_session_count(&root, "alpha"), 1);
    service
        .finalize_database_restore("alpha", "owner", 5)
        .expect("restore should finalize");
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);

    let node = service
        .read_node("alpha", "owner", "/Knowledge/a.md")
        .expect("restored read should succeed")
        .expect("restored node should exist");
    assert_eq!(node.content, "alpha body");
    let info = service
        .list_database_infos()
        .expect("infos should load")
        .into_iter()
        .find(|info| info.database_id == "alpha")
        .expect("alpha info should exist");
    assert_eq!(info.status, DatabaseStatus::Active);
    assert_eq!(info.snapshot_hash, Some(snapshot_hash));
    assert_eq!(info.archived_at_ms, None);
    assert_restore_size(&root, "alpha", None);
    assert_eq!(
        database_index_row(&root, "alpha").1,
        Some(restoring.1.unwrap())
    );
}

#[test]
fn restore_reuses_archived_mount_id_after_rearchive() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let bytes = archive_bytes_for_chunk_size(&service, "alpha", archive.size_bytes, 17);
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");
    let restored = service
        .begin_database_restore("alpha", "owner", snapshot_hash, archive.size_bytes, 4)
        .expect("restore should begin");
    assert_eq!(restored.mount_id, 11);
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes)
        .expect("restore chunk should write");
    service
        .finalize_database_restore("alpha", "owner", 5)
        .expect("restore should finalize");

    let second_archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("second archive should begin");
    let second_bytes =
        archive_bytes_for_chunk_size(&service, "alpha", second_archive.size_bytes, 17);
    service
        .finalize_database_archive("alpha", "owner", sha256_bytes(&second_bytes), 6)
        .expect("second archive should finalize");
    let beta = service
        .create_database("beta", "owner", 7)
        .expect("beta should create");

    assert_ne!(beta.mount_id, restored.mount_id);
    assert_eq!(
        mount_history_row(&root, restored.mount_id),
        ("alpha".to_string(), "create".to_string())
    );
}

#[test]
fn cancel_database_archive_returns_archiving_database_to_active() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let before = database_index_row(&root, "alpha");
    service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let archiving = database_index_row(&root, "alpha");
    assert_eq!(archiving.0, "archiving");
    assert_eq!(archiving.1, before.1);

    let canceled = service
        .cancel_database_archive("alpha", "owner", 3)
        .expect("archive cancel should succeed");
    assert_eq!(canceled.database_id, "alpha");
    let after = database_index_row(&root, "alpha");
    assert_eq!(after.0, "active");
    assert_eq!(after.1, before.1);

    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/b.md".to_string(),
                kind: NodeKind::File,
                content: "beta body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            4,
        )
        .expect("write should succeed after cancel");
    let node = service
        .read_node("alpha", "owner", "/Knowledge/b.md")
        .expect("read should succeed after cancel")
        .expect("node should exist");
    assert_eq!(node.content, "beta body");
}

#[test]
fn cancel_database_archive_after_hash_mismatch_keeps_mount_id() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");
    let before = database_index_row(&root, "alpha");
    service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");

    assert!(
        service
            .finalize_database_archive("alpha", "owner", vec![0; 32], 3)
            .expect_err("wrong hash should fail")
            .contains("snapshot_hash does not match")
    );
    assert_eq!(database_index_row(&root, "alpha").0, "archiving");

    service
        .cancel_database_archive("alpha", "owner", 4)
        .expect("archive cancel should succeed after mismatch");
    let after = database_index_row(&root, "alpha");
    assert_eq!(after.0, "active");
    assert_eq!(after.1, before.1);
}

#[test]
fn cancel_database_archive_rejects_invalid_statuses_and_non_owner() {
    let service = service();
    service
        .create_database("active_db", "owner", 1)
        .expect("active_db should create");
    assert!(
        service
            .cancel_database_archive("active_db", "owner", 2)
            .expect_err("active cancel should fail")
            .contains("database is active")
    );

    service
        .create_database("archiving_db", "owner", 3)
        .expect("archiving_db should create");
    service
        .begin_database_archive("archiving_db", "owner", 2)
        .expect("archive should begin");
    assert!(
        service
            .cancel_database_archive("archiving_db", "writer", 4)
            .expect_err("non-owner cancel should fail")
            .contains("principal has no access")
    );
    service
        .cancel_database_archive("archiving_db", "owner", 5)
        .expect("archive cancel should succeed");

    service
        .create_database("archived_db", "owner", 6)
        .expect("archived_db should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "archived_db".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            7,
        )
        .expect("write should succeed");
    let archive = service
        .begin_database_archive("archived_db", "owner", 2)
        .expect("archive should begin");
    let bytes = read_archive_in_chunks(&service, "archived_db", archive.size_bytes, 17);
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("archived_db", "owner", snapshot_hash.clone(), 8)
        .expect("archive should finalize");
    assert!(
        service
            .cancel_database_archive("archived_db", "owner", 9)
            .expect_err("archived cancel should fail")
            .contains("database is archived")
    );

    service
        .begin_database_restore(
            "archived_db",
            "owner",
            snapshot_hash,
            archive.size_bytes,
            10,
        )
        .expect("restore should begin");
    assert!(
        service
            .cancel_database_archive("archived_db", "owner", 11)
            .expect_err("restoring cancel should fail")
            .contains("database is restoring")
    );

    service
        .create_database("deleted_db", "owner", 12)
        .expect("deleted_db should create");
    service
        .delete_database(delete_request("deleted_db"), "owner", 13)
        .expect("delete should succeed");
    service
        .cancel_database_archive("deleted_db", "owner", 14)
        .expect_err("deleted cancel should fail");
}

#[test]
fn restore_finalize_rejects_size_mismatch_until_missing_bytes_arrive() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");
    assert_restore_size(&root, "alpha", None);

    service
        .begin_database_restore("alpha", "owner", snapshot_hash, archive.size_bytes, 4)
        .expect("restore should begin");
    assert_restore_size(&root, "alpha", Some(archive.size_bytes));
    assert_eq!(database_restore_session_count(&root, "alpha"), 1);
    let overflow_error = service
        .write_database_restore_chunk("alpha", "owner", archive.size_bytes, &[0])
        .expect_err("restore chunk past declared size should fail");
    assert!(overflow_error.contains("restore chunk exceeds expected size"));

    let split_at = bytes.len() / 2;
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes[..split_at])
        .expect("first restore chunk should write");
    let error = service
        .finalize_database_restore("alpha", "owner", 5)
        .expect_err("short restore should fail");
    assert!(error.contains("restore chunks are incomplete"));
    assert_eq!(
        service
            .list_database_infos()
            .expect("infos should load")
            .into_iter()
            .find(|info| info.database_id == "alpha")
            .expect("alpha info should exist")
            .status,
        DatabaseStatus::Restoring
    );

    service
        .write_database_restore_chunk("alpha", "owner", split_at as u64, &bytes[split_at..])
        .expect("second restore chunk should write");
    service
        .finalize_database_restore("alpha", "owner", 6)
        .expect("complete restore should finalize");
    assert_restore_size(&root, "alpha", None);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
    let node = service
        .read_node("alpha", "owner", "/Knowledge/a.md")
        .expect("restored read should succeed")
        .expect("restored node should exist");
    assert_eq!(node.content, "alpha body");
}

#[test]
fn archive_and_restore_reject_snapshot_hash_mismatch() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let mut wrong_hash = sha256_bytes(&bytes);
    wrong_hash[0] ^= 0xff;
    let error = service
        .finalize_database_archive("alpha", "owner", wrong_hash, 3)
        .expect_err("wrong archive hash should fail");
    assert!(error.contains("snapshot_hash does not match archived"));
    assert_eq!(database_index_row(&root, "alpha").0, "archiving");

    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 4)
        .expect("archive should finalize");
    service
        .begin_database_restore("alpha", "owner", snapshot_hash, archive.size_bytes, 5)
        .expect("restore should begin");
    let mut changed = bytes;
    let last = changed.len() - 1;
    changed[last] ^= 0xff;
    service
        .write_database_restore_chunk("alpha", "owner", 0, &changed)
        .expect("restore chunk should write");
    let error = service
        .finalize_database_restore("alpha", "owner", 6)
        .expect_err("wrong restored bytes should fail");
    assert!(error.contains("snapshot_hash does not match restored"));
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 1);
    assert_eq!(database_restore_session_count(&root, "alpha"), 1);
}

#[test]
fn archive_and_restore_enforce_size_limits_without_state_changes() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");

    let state_before = database_index_row(&root, "alpha");
    let size_error = service
        .begin_database_restore(
            "alpha",
            "owner",
            snapshot_hash.clone(),
            MAX_DATABASE_SIZE_BYTES + 1,
            4,
        )
        .expect_err("oversized restore size should fail");
    assert!(size_error.contains("database size exceeds limit"));
    assert_eq!(database_index_row(&root, "alpha"), state_before);

    let oversized_restore_chunk = vec![0; MAX_RESTORE_CHUNK_BYTES + 1];
    service
        .begin_database_restore(
            "alpha",
            "owner",
            snapshot_hash.clone(),
            archive.size_bytes,
            4,
        )
        .expect("restore should begin");
    let chunk_error = service
        .write_database_restore_chunk("alpha", "owner", 0, &oversized_restore_chunk)
        .expect_err("oversized restore chunk should fail");
    assert!(chunk_error.contains("restore chunk size exceeds limit"));
}

#[test]
fn restore_accepts_in_range_chunks_written_out_of_order() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".repeat(100),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");

    let archive = service
        .begin_database_archive("alpha", "owner", 2)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 3)
        .expect("archive should finalize");
    service
        .begin_database_restore(
            "alpha",
            "owner",
            snapshot_hash.clone(),
            archive.size_bytes,
            4,
        )
        .expect("restore should begin");

    let split_at = bytes.len() / 2;
    service
        .write_database_restore_chunk("alpha", "owner", split_at as u64, &bytes[split_at..])
        .expect("second half should write first");
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes[..split_at])
        .expect("first half should write second");
    assert_eq!(database_restore_chunk_count(&_root, "alpha"), 2);
    assert_eq!(database_restore_session_count(&_root, "alpha"), 1);
    service
        .finalize_database_restore("alpha", "owner", 5)
        .expect("out-of-order restore should finalize");
    assert_eq!(database_restore_chunk_count(&_root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&_root, "alpha"), 0);

    let node = service
        .read_node("alpha", "owner", "/Knowledge/a.md")
        .expect("restored read should succeed")
        .expect("restored node should exist");
    assert_eq!(node.content, "alpha body".repeat(100));
    let info = service
        .list_database_infos()
        .expect("infos should load")
        .into_iter()
        .find(|info| info.database_id == "alpha")
        .expect("alpha info should exist");
    assert_eq!(info.snapshot_hash, Some(snapshot_hash));
}

#[test]
fn cancel_database_restore_returns_archived_database_and_removes_partial_state() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".repeat(20),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");
    let archive = service
        .begin_database_archive("alpha", "owner", 3)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 4)
        .expect("archive should finalize");

    let restore = service
        .begin_database_restore_session("alpha", "owner", snapshot_hash, archive.size_bytes, 5)
        .expect("restore should begin");
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes[..bytes.len() / 2])
        .expect("partial restore should write");
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 1);
    assert_eq!(database_restore_session_count(&root, "alpha"), 1);
    let restoring_file = database_file_path(&root, "alpha");
    assert!(!restoring_file.exists());

    service
        .cancel_database_restore("alpha", "owner", 6)
        .expect("restore cancel should succeed");

    assert_eq!(
        database_index_row(&root, "alpha"),
        (
            "archived".to_string(),
            Some(restore.meta.mount_id),
            archive.size_bytes,
            None,
        )
    );
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
    assert!(!restoring_file.exists());
    assert_eq!(
        mount_history_row(&root, restore.meta.mount_id),
        ("alpha".to_string(), "create".to_string())
    );
}

#[test]
fn deleted_database_cannot_begin_restore() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");
    let archive = service
        .begin_database_archive("alpha", "owner", 3)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .cancel_database_archive("alpha", "owner", 4)
        .expect("archive should cancel");
    service
        .delete_database(delete_request("alpha"), "owner", 5)
        .expect("delete should succeed");

    service
        .begin_database_restore("alpha", "owner", snapshot_hash, archive.size_bytes, 6)
        .expect_err("deleted database should not restore");
    assert!(!database_index_row_exists(&root, "alpha"));
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
}

#[test]
fn cancel_database_restore_rejects_invalid_statuses_and_non_owner() {
    let service = service();
    service
        .create_database("active_db", "owner", 1)
        .expect("active database should create");
    let active = service
        .cancel_database_restore("active_db", "owner", 2)
        .expect_err("active database should reject restore cancel");
    assert!(active.contains("database is active"));

    service
        .create_database("archived_db", "owner", 3)
        .expect("archived database should create");
    let archive = service
        .begin_database_archive("archived_db", "owner", 4)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("archived_db", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("archived_db", "owner", snapshot_hash.clone(), 5)
        .expect("archive should finalize");
    let archived = service
        .cancel_database_restore("archived_db", "owner", 6)
        .expect_err("archived database should reject restore cancel");
    assert!(archived.contains("database is archived"));

    service
        .begin_database_restore("archived_db", "owner", snapshot_hash, archive.size_bytes, 7)
        .expect("restore should begin");
    service
        .grant_database_access("archived_db", "owner", "writer", DatabaseRole::Writer, 8)
        .expect("writer grant should succeed");
    let writer = service
        .cancel_database_restore("archived_db", "writer", 9)
        .expect_err("writer should not cancel restore");
    assert!(writer.contains("principal lacks required database role"));
}

#[test]
fn rollback_database_restore_begin_restores_archived_state() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("write should succeed");
    let archive = service
        .begin_database_archive("alpha", "owner", 3)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk("alpha", "owner", 0, archive.size_bytes as u32)
        .expect("archive chunk should read");
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("alpha", "owner", snapshot_hash.clone(), 4)
        .expect("archive should finalize");

    let restore = service
        .begin_database_restore_session(
            "alpha",
            "owner",
            snapshot_hash.clone(),
            archive.size_bytes,
            5,
        )
        .expect("restore should begin");
    let failed_mount_id = restore.meta.mount_id;
    service
        .write_database_restore_chunk("alpha", "owner", 0, &bytes)
        .expect("restore chunk should write");
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 1);

    service
        .rollback_database_restore_begin(restore.rollback, 6)
        .expect("restore begin should rollback");
    assert_eq!(
        database_index_row(&root, "alpha"),
        (
            "archived".to_string(),
            Some(failed_mount_id),
            archive.size_bytes,
            None,
        )
    );
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
    assert_eq!(
        mount_history_row(&root, failed_mount_id),
        ("alpha".to_string(), "create".to_string())
    );

    let retry = service
        .begin_database_restore_session("alpha", "owner", snapshot_hash, archive.size_bytes, 7)
        .expect("restore should retry");
    assert_eq!(retry.meta.mount_id, failed_mount_id);
}

#[test]
fn enforces_reader_writer_owner_roles() {
    let service = service();
    service
        .create_database("shared", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("shared", "owner", "reader", DatabaseRole::Reader, 2)
        .expect("reader grant should succeed");
    service
        .grant_database_access("shared", "owner", "writer", DatabaseRole::Writer, 3)
        .expect("writer grant should succeed");

    assert!(
        service
            .read_node("shared", "reader", "/Knowledge/missing.md")
            .expect("reader read should be authorized")
            .is_none()
    );
    assert!(
        service
            .write_node(
                "reader",
                WriteNodeRequest {
                    database_id: "shared".to_string(),
                    path: "/Knowledge/nope.md".to_string(),
                    kind: NodeKind::File,
                    content: "nope".to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                10,
            )
            .is_err()
    );
    service
        .write_node(
            "writer",
            WriteNodeRequest {
                database_id: "shared".to_string(),
                path: "/Knowledge/ok.md".to_string(),
                kind: NodeKind::File,
                content: "ok".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            11,
        )
        .expect("writer write should succeed");
    assert!(
        service
            .grant_database_access("shared", "writer", "other", DatabaseRole::Reader, 12)
            .is_err()
    );
    assert!(
        service
            .grant_database_access("shared", "owner", "owner", DatabaseRole::Reader, 13)
            .expect_err("owner should not downgrade own access")
            .contains("downgrade own access")
    );
    service
        .grant_database_access("shared", "owner", "owner", DatabaseRole::Owner, 14)
        .expect("owner should be allowed to keep own owner access");
    assert!(
        service
            .list_database_members("shared", "writer")
            .expect_err("writer should not list members")
            .contains("lacks required database role")
    );

    let members = service
        .list_database_members("shared", "owner")
        .expect("owner should list members");
    assert_eq!(members.len(), 4);

    service
        .grant_database_access("shared", "owner", "2vxsx-fae", DatabaseRole::Reader, 15)
        .expect("anonymous public grant should succeed");
    let public_members = service
        .list_database_members("shared", "2vxsx-fae")
        .expect("anonymous should list members for public database");
    assert_eq!(public_members.len(), 5);

    service
        .revoke_database_access("shared", "owner", "reader")
        .expect("owner should revoke reader");
    assert!(
        service
            .read_node("shared", "reader", "/Knowledge/missing.md")
            .expect_err("revoked reader should lose access")
            .contains("no access")
    );
    assert!(
        service
            .revoke_database_access("shared", "owner", "owner")
            .expect_err("owner should not revoke own access")
            .contains("own access")
    );
}

#[test]
fn append_node_validates_effective_kind_paths() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let error = service
        .append_node(
            "owner",
            AppendNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/bad.md".to_string(),
                content: "bad".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: Some(NodeKind::Source),
            },
            2,
        )
        .expect_err("non-canonical source append should fail");
    assert!(error.contains("canonical form"));

    let error = service
        .append_node(
            "owner",
            AppendNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/bad/bad.md".to_string(),
                content: "bad".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            3,
        )
        .expect_err("kind=None under sources should be treated as file");
    assert!(error.contains("source path must use source kind"));

    ensure_parent_folders(
        &service,
        "owner",
        "alpha",
        "/Sources/skill-runs/review/1700000000000.md",
        3,
    );
    let error = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/skill-runs/review/1700000000000.md".to_string(),
                kind: NodeKind::File,
                content: "bad".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            4,
        )
        .expect_err("skill run source path should reject file kind");
    assert!(error.contains("source path must use source kind"));
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/skill-runs/review/1700000000000.md".to_string(),
                kind: NodeKind::Source,
                content: "source".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            5,
        )
        .expect("skill run source path should accept source kind");

    ensure_parent_folders(&service, "owner", "alpha", "/Sources/good/good.md", 3);
    let source = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/good/good.md".to_string(),
                kind: NodeKind::Source,
                content: "source".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            4,
        )
        .expect("canonical source should write");
    let appended = service
        .append_node(
            "owner",
            AppendNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/good/good.md".to_string(),
                content: " body".to_string(),
                expected_etag: Some(source.node.etag),
                separator: None,
                metadata_json: None,
                kind: None,
            },
            5,
        )
        .expect("kind=None should append to existing source");
    assert_eq!(appended.node.kind, NodeKind::Source);

    let wiki = service
        .append_node(
            "owner",
            AppendNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Knowledge/new.md".to_string(),
                content: "wiki".to_string(),
                expected_etag: None,
                separator: None,
                metadata_json: None,
                kind: None,
            },
            6,
        )
        .expect("kind=None should create wiki file");
    assert_eq!(wiki.node.kind, NodeKind::File);
}

#[test]
fn move_node_validates_source_target_path() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    ensure_parent_folders(&service, "owner", "alpha", "/Sources/web/abc.md", 2);
    ensure_parent_folders(&service, "owner", "alpha", "/Sources/web/wrong.md", 2);
    ensure_parent_folders(&service, "owner", "alpha", "/Sources/chatgpt/def.md", 2);
    let source = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/web/abc.md".to_string(),
                kind: NodeKind::Source,
                content: "source".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("source should write");

    let error = service
        .move_node(
            "owner",
            MoveNodeRequest {
                database_id: "alpha".to_string(),
                from_path: "/Sources/web/abc.md".to_string(),
                to_path: "/Sources/web/wrong.txt".to_string(),
                expected_etag: Some(source.node.etag.clone()),
                overwrite: false,
            },
            4,
        )
        .expect_err("non-canonical source target should fail");
    assert!(error.contains("canonical form"));

    service
        .move_node(
            "owner",
            MoveNodeRequest {
                database_id: "alpha".to_string(),
                from_path: "/Sources/web/abc.md".to_string(),
                to_path: "/Sources/chatgpt/def.md".to_string(),
                expected_etag: Some(source.node.etag),
                overwrite: false,
            },
            5,
        )
        .expect("canonical source target should pass");
}

#[test]
fn market_purchase_creates_order_with_ledger_block_and_entitlement() {
    let service = service();
    service
        .create_database("market-db", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing("seller", market_listing_request("market-db", 250), 2)
        .expect("listing should create");
    assert!(!listing.listing_id.starts_with("listing_"));
    assert_eq!(listing.status, MarketListingStatus::Active);
    let order = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("buyer", "aaaaa-aa", 100_000, 6),
            6,
        )
        .and_then(|start| {
            service.complete_market_purchase_ledger_transfer(
                start.operation_id,
                MARKET_BUYER_PRINCIPAL,
                &listing.listing_id,
                listing.price_e8s,
                42,
            )?;
            service.apply_market_purchase(
                start.operation_id,
                MARKET_BUYER_PRINCIPAL,
                &listing.listing_id,
                listing.price_e8s,
                7,
            )
        })
        .expect("purchase should succeed");

    assert_eq!(order.buyer_principal, MARKET_BUYER_PRINCIPAL);
    assert_eq!(order.seller_principal, "seller");
    assert_eq!(order.payout_principal, "aaaaa-aa");
    assert_eq!(order.ledger_block_index, 42);
    assert_eq!(
        service
            .market_list_entitlements(MARKET_BUYER_PRINCIPAL, None, 10)
            .expect("entitlements should load")
            .entitlements
            .len(),
        1
    );
    let second_listing = service
        .market_create_listing("seller", market_listing_request("market-db", 300), 7)
        .expect("second listing should create");
    assert!(
        service
            .market_purchase_access(
                "buyer",
                market_purchase_request(&second_listing, MARKET_BUYER_PRINCIPAL),
                9,
            )
            .is_err(),
        "same buyer cannot repurchase the same database"
    );
}

#[test]
fn market_listing_payout_principal_is_saved_updated_and_validated() {
    let service = service();
    service
        .create_database("payout-market", "seller", 1)
        .expect("database should create");
    let mut create = market_listing_request("payout-market", 100);
    create.payout_principal = "ryjl3-tyaaa-aaaaa-aaaba-cai".to_string();
    let listing = service
        .market_create_listing("seller", create, 2)
        .expect("listing should create with payout principal");
    assert_eq!(listing.payout_principal, "ryjl3-tyaaa-aaaaa-aaaba-cai");

    let updated = service
        .market_update_listing(
            "seller",
            MarketUpdateListingRequest {
                listing_id: listing.listing_id.clone(),
                expected_revision: listing.revision,
                payout_principal: "aaaaa-aa".to_string(),
                title: listing.title,
                description: listing.description,
                llm_summary: listing.llm_summary,
                tags_json: listing.tags_json,
                price_e8s: listing.price_e8s,
            },
            3,
        )
        .expect("seller should update payout principal");
    assert_eq!(updated.payout_principal, "aaaaa-aa");

    let mut invalid_create = market_listing_request("payout-market", 100);
    invalid_create.payout_principal = "not-a-principal".to_string();
    let invalid_error = service
        .market_create_listing("seller", invalid_create, 4)
        .expect_err("invalid payout principal should reject");
    assert!(invalid_error.contains("principal text is invalid"));

    let mut anonymous_create = market_listing_request("payout-market", 100);
    anonymous_create.payout_principal = "2vxsx-fae".to_string();
    let anonymous_error = service
        .market_create_listing("seller", anonymous_create, 5)
        .expect_err("anonymous payout principal should reject");
    assert!(anonymous_error.contains("principal must not be anonymous"));
}

#[test]
fn market_purchase_payer_can_grant_access_to_ii_principal() {
    let service = service();
    service
        .create_database("market-access-db", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing("seller", market_listing_request("market-access-db", 250), 2)
        .expect("listing should create");
    let start = service
        .begin_market_purchase_with_ledger_details(
            "wallet",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("wallet", "aaaaa-aa", 100_000, 6),
            6,
        )
        .expect("wallet payer should begin purchase");
    let pending = service
        .query_index_sql_json(
            "SELECT json_object('to_owner', to_owner) FROM market_purchase_pending_operations",
            10,
        )
        .expect("pending operation should be queryable");
    assert_eq!(pending.rows, vec![r#"{"to_owner":"aaaaa-aa"}"#]);
    service
        .complete_market_purchase_ledger_transfer(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            42,
        )
        .expect("ledger transfer should complete for access principal");
    let order = service
        .apply_market_purchase(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            7,
        )
        .expect("purchase should grant II access");

    assert_eq!(order.buyer_principal, MARKET_BUYER_PRINCIPAL);
    assert!(
        service
            .list_database_summaries_for_caller(MARKET_BUYER_PRINCIPAL)
            .expect("II principal should list purchased database")
            .iter()
            .any(|database| database.database_id == "market-access-db")
    );
    assert!(
        service
            .market_preview_purchase(MARKET_BUYER_PRINCIPAL, &listing.listing_id)
            .expect("II principal should preview purchase")
            .already_entitled
    );
    assert!(
        !service
            .market_preview_purchase("wallet", &listing.listing_id)
            .expect("wallet payer should preview purchase")
            .already_entitled
    );
}

#[test]
fn market_purchase_begin_records_listing_payout_for_empty_ledger_recipient() {
    let service = service();
    service
        .create_database("market-access-pending-payout", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("market-access-pending-payout", 250),
            2,
        )
        .expect("listing should create");
    let start = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("buyer", "", 100_000, 6),
            6,
        )
        .expect("purchase should begin");
    assert_eq!(start.payout_principal, "aaaaa-aa");
    let pending = service
        .query_index_sql_json(
            "SELECT json_object('to_owner', to_owner) FROM market_purchase_pending_operations",
            10,
        )
        .expect("pending operation should be queryable");

    assert_eq!(pending.rows, vec![r#"{"to_owner":"aaaaa-aa"}"#]);
}

#[test]
fn index_sql_json_requires_valid_json_object_values() {
    let service = service();

    for sql in [
        "SELECT 1 LIMIT 1",
        "SELECT NULL LIMIT 1",
        "SELECT 'not-json' LIMIT 1",
        "SELECT json_array(1, 2) LIMIT 1",
        "SELECT json_quote('value') LIMIT 1",
        "SELECT json('null') LIMIT 1",
        "SELECT json_object('ok', 1), 1 LIMIT 1",
    ] {
        let error = service
            .query_index_sql_json(sql, 10)
            .expect_err("invalid index SQL JSON should reject");
        assert!(
            error.contains("exactly one non-null valid JSON object TEXT column"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn index_sql_json_rejects_oversized_row_and_response() {
    let service = service();

    let row_error = service
        .query_index_sql_json(
            "SELECT json_object('content', printf('%70000s', 'x')) LIMIT 1",
            1,
        )
        .expect_err("oversized index SQL row should reject");
    assert!(row_error.contains("row JSON exceeds"));

    let response_error = service
        .query_index_sql_json(
            "SELECT json_object('content', printf('%60000s', 'x')) UNION ALL SELECT json_object('content', printf('%60000s', 'x')) UNION ALL SELECT json_object('content', printf('%60000s', 'x')) UNION ALL SELECT json_object('content', printf('%60000s', 'x')) UNION ALL SELECT json_object('content', printf('%60000s', 'x')) LIMIT 5",
            5,
        )
        .expect_err("oversized index SQL response should reject");
    assert!(response_error.contains("response JSON exceeds"));
}

#[test]
fn index_sql_json_interrupts_heavy_query_and_clears_progress_handler() {
    let service = service();

    let error = service
        .query_index_sql_json(
            "SELECT json_object('i', (WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) SELECT max(i) FROM n)) LIMIT 1",
            1,
        )
        .expect_err("heavy index SQL should exceed budget");
    assert!(
        error.contains("index SQL execution budget exceeded"),
        "unexpected error: {error}"
    );

    let result = service
        .query_index_sql_json("SELECT json_object('ok', 1) LIMIT 1", 1)
        .expect("progress handler should be cleared after interrupt");
    assert_eq!(result.rows, vec![r#"{"ok":1}"#.to_string()]);
}

#[test]
fn database_sql_json_returns_rows_for_readers_and_public_readers() {
    let service = service();
    service
        .create_database("sql-db", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "sql-db", "owner", 1_000_000, 1, 2);
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "sql-db".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("node should write");
    service
        .grant_database_access("sql-db", "owner", "reader", DatabaseRole::Reader, 4)
        .expect("reader grant should succeed");
    service
        .grant_database_access("sql-db", "owner", "2vxsx-fae", DatabaseRole::Reader, 5)
        .expect("public reader grant should succeed");

    let reader_result = service
        .query_database_sql_json(
            "sql-db",
            "reader",
            "SELECT json_object('path', path, 'content', content) FROM fs_nodes WHERE path = '/Knowledge/a.md' LIMIT 1",
            10,
        )
        .expect("reader should query database SQL");
    let public_result = service
        .query_database_sql_json(
            "sql-db",
            "2vxsx-fae",
            "SELECT json_object('path', path) FROM fs_nodes WHERE path = '/Knowledge/a.md' LIMIT 1",
            10,
        )
        .expect("public reader should query database SQL");

    assert_eq!(reader_result.row_count, 1);
    assert_eq!(
        reader_result.rows,
        vec![r#"{"path":"/Knowledge/a.md","content":"alpha"}"#]
    );
    assert_eq!(public_result.rows, vec![r#"{"path":"/Knowledge/a.md"}"#]);
}

#[test]
fn database_sql_json_rejects_internal_tables_for_reader() {
    let service = service();
    service
        .create_database("reader-table-guard-sql-db", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access(
            "reader-table-guard-sql-db",
            "owner",
            "reader",
            DatabaseRole::Reader,
            2,
        )
        .expect("reader grant should succeed");

    for sql in [
        "SELECT json_object('version', version) FROM schema_migrations LIMIT 1",
        "SELECT json_object('path', path) FROM fs_change_log LIMIT 1",
        "SELECT json_object('path', path) FROM fs_path_state LIMIT 1",
    ] {
        let error = service
            .query_database_sql_json("reader-table-guard-sql-db", "reader", sql, 10)
            .expect_err("internal table should reject for reader");
        assert!(
            error.contains("table is not allowed"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn database_sql_json_budget_applies_to_reader_and_public_reader() {
    let (service, root) = service_with_root();
    service
        .create_database("sql-budget-db", "owner", 1)
        .expect("database should create");
    cycle_database(&service, "sql-budget-db", "owner", 1_000_000, 1, 2);
    service
        .grant_database_access("sql-budget-db", "owner", "reader", DatabaseRole::Reader, 3)
        .expect("reader grant should succeed");
    service
        .grant_database_access(
            "sql-budget-db",
            "owner",
            "2vxsx-fae",
            DatabaseRole::Reader,
            4,
        )
        .expect("public reader grant should succeed");
    seed_sql_budget_rows(&root.join("databases/sql-budget-db.sqlite3"), 10_000);

    for caller in ["reader", "2vxsx-fae"] {
        let error = service
            .query_database_sql_json("sql-budget-db", caller, &heavy_missing_sql(), 1)
            .expect_err("heavy database SQL should exceed budget");

        assert!(
            error.contains("database SQL execution budget exceeded"),
            "unexpected error for {caller}: {error}"
        );
    }
}

#[test]
fn database_sql_json_returns_rows_from_links_table() {
    let service = service();
    service
        .create_database("sql-links-db", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "sql-links-db".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "[b](/Knowledge/b.md)".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");

    let result = service
        .query_database_sql_json(
            "sql-links-db",
            "owner",
            "SELECT json_object('source', source_path, 'target', target_path) FROM fs_links LIMIT 20",
            20,
        )
        .expect("owner should query link SQL");

    assert_eq!(
        result.rows,
        vec![r#"{"source":"/Knowledge/a.md","target":"/Knowledge/b.md"}"#]
    );
}

#[test]
fn database_sql_json_rejects_non_readers() {
    let service = service();
    service
        .create_database("private-sql-db", "owner", 1)
        .expect("database should create");

    let error = service
        .query_database_sql_json(
            "private-sql-db",
            "missing",
            "SELECT json_object('ok', 1) LIMIT 1",
            10,
        )
        .expect_err("non-reader should reject");

    assert!(error.contains("principal has no access"));
}

#[test]
fn database_sql_json_rejects_mutating_multi_statement_and_expensive_sql() {
    let service = service();
    service
        .create_database("guarded-sql-db", "owner", 1)
        .expect("database should create");

    for sql in [
        "UPDATE fs_nodes SET content = ''",
        "DELETE FROM fs_nodes",
        "INSERT INTO fs_nodes (path) VALUES ('/Knowledge/x.md')",
        "CREATE TABLE x (id INTEGER)",
        "DROP TABLE fs_nodes",
        "PRAGMA table_info(fs_nodes)",
        "ATTACH DATABASE 'x' AS x",
        "DETACH DATABASE x",
        "SELECT json_object('ok', 1); SELECT json_object('ok', 2)",
        "SELECT json_object('ok', 1) FROM fs_nodes -- comment LIMIT 1",
        "SELECT json_object('ok', 1) FROM fs_nodes /* comment */ LIMIT 1",
        "WITH x AS (SELECT 1) SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1",
        "SELECT json_object('ok', 1) FROM fs_nodes UNION SELECT json_object('ok', 2) FROM fs_nodes LIMIT 1",
        "SELECT json_object('ok', 1) FROM fs_nodes JOIN fs_links ON 1 = 1 LIMIT 1",
        "SELECT json_object('ok', 1) FROM fs_nodes, fs_links LIMIT 1",
        "SELECT json_object('ok', 1) FROM fs_nodes WHERE id IN (SELECT id FROM fs_nodes) LIMIT 1",
        "SELECT json_object('ok', count(*)) FROM fs_nodes LIMIT 1",
        "SELECT json_group_array(path) FROM fs_nodes LIMIT 1",
        "SELECT group_concat(path) FROM fs_nodes LIMIT 1",
        "SELECT json_object('x', hex(content)) FROM fs_nodes LIMIT 1",
        "SELECT json_object('x', randomblob(4)) FROM fs_nodes LIMIT 1",
        "SELECT json_object('x', zeroblob(4)) FROM fs_nodes LIMIT 1",
        "SELECT json_object('x', load_extension('x')) FROM fs_nodes LIMIT 1",
        "SELECT json_object('path', path) FROM fs_nodes LIMIT 1 OFFSET 10",
        "SELECT json_object('path', path) FROM fs_nodes LIMIT 1, 2",
        "SELECT json_object('path', path) FROM fs_nodes ORDER BY random() LIMIT 1",
        "SELECT json_object('path', path) FROM fs_nodes ORDER BY length(path) LIMIT 1",
        "SELECT json_object('path', path) FROM fs_nodes ORDER BY path, updated_at LIMIT 1",
        "SELECT json_object('path', path) FROM fs_nodes ORDER BY content LIMIT 1",
        "SELECT json_object('path', path) FROM fs_nodes ORDER BY path COLLATE NOCASE LIMIT 1",
    ] {
        let error = service
            .query_database_sql_json("guarded-sql-db", "owner", sql, 10)
            .expect_err("SQL should reject");
        assert!(
            error.contains("database SQL must")
                || error.contains("database SQL token is not allowed")
                || error.contains("database SQL comments are not allowed")
                || error.contains("database SQL ORDER BY")
                || error.contains("database SQL LIMIT"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn database_sql_json_rejects_raw_sql_over_byte_limit_before_trimming() {
    let service = service();
    service
        .create_database("raw-size-guard-sql-db", "owner", 1)
        .expect("database should create");
    let sql_body = "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 1";
    let padding_len = 4_097_usize.saturating_sub(sql_body.len());
    let cases = [
        (
            "valid SELECT after trimming",
            format!("{}{}", " ".repeat(padding_len), sql_body),
        ),
        ("spaces only", " ".repeat(4_097)),
        ("non-SELECT", "x".repeat(4_097)),
    ];

    for (label, sql) in cases {
        let error = service
            .query_database_sql_json("raw-size-guard-sql-db", "owner", &sql, 10)
            .expect_err("raw SQL over byte limit should reject");

        assert!(
            error.contains("must be at most 4096 bytes"),
            "unexpected error for {label}: {error}"
        );
    }
}

#[test]
fn database_sql_json_api_limit_stops_reading_before_sql_limit() {
    let service = service();
    service
        .create_database("limited-sql-db", "owner", 1)
        .expect("database should create");
    for (index, (path, content)) in [("/Knowledge/a.md", "alpha"), ("/Knowledge/b.md", "beta")]
        .into_iter()
        .enumerate()
    {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "limited-sql-db".to_string(),
                    path: path.to_string(),
                    kind: NodeKind::File,
                    content: content.to_string(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                2 + index as i64,
            )
            .expect("node should write");
    }

    let result = service
        .query_database_sql_json(
            "limited-sql-db",
            "owner",
            "SELECT json_object('path', path) FROM fs_nodes WHERE kind = 'file' ORDER BY path ASC LIMIT 2",
            1,
        )
        .expect("second row should not be read");

    assert_eq!(result.limit, 1);
    assert_eq!(result.row_count, 1);
    assert_eq!(
        result.rows,
        vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()]
    );

    let recent = service
        .query_database_sql_json(
            "limited-sql-db",
            "owner",
            "SELECT json_object('path', path) FROM fs_nodes WHERE kind = 'file' ORDER BY updated_at DESC LIMIT 20",
            20,
        )
        .expect("updated_at DESC should be allowed");

    assert_eq!(recent.row_count, 2);
    assert_eq!(recent.rows[0], r#"{"path":"/Knowledge/b.md"}"#);
}

#[test]
fn database_sql_json_requires_sql_limit_in_range() {
    let service = service();
    service
        .create_database("limit-guard-sql-db", "owner", 1)
        .expect("database should create");

    for sql in [
        "SELECT json_object('ok', 1) FROM fs_nodes",
        "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 0",
        "SELECT json_object('ok', 1) FROM fs_nodes LIMIT 101",
    ] {
        let error = service
            .query_database_sql_json("limit-guard-sql-db", "owner", sql, 10)
            .expect_err("SQL limit should reject");
        assert!(
            error.contains("LIMIT"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn database_sql_json_rejects_internal_tables() {
    let service = service();
    service
        .create_database("table-guard-sql-db", "owner", 1)
        .expect("database should create");

    for sql in [
        "SELECT json_object('name', name) FROM sqlite_master LIMIT 1",
        "SELECT json_object('name', name) FROM sqlite_schema LIMIT 1",
        "SELECT json_object('version', version) FROM schema_migrations LIMIT 1",
        "SELECT json_object('path', path) FROM fs_change_log LIMIT 1",
        "SELECT json_object('path', path) FROM fs_path_state LIMIT 1",
    ] {
        let error = service
            .query_database_sql_json("table-guard-sql-db", "owner", sql, 10)
            .expect_err("internal table should reject");
        assert!(
            error.contains("table is not allowed"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn database_sql_json_requires_json_object_text_first_column() {
    let service = service();
    service
        .create_database("typed-sql-db", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "typed-sql-db".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");

    for sql in [
        "SELECT 1 FROM fs_nodes LIMIT 1",
        "SELECT NULL FROM fs_nodes LIMIT 1",
        "SELECT 'not-json' FROM fs_nodes LIMIT 1",
        "SELECT json_array(1, 2) FROM fs_nodes LIMIT 1",
        "SELECT json_quote('value') FROM fs_nodes LIMIT 1",
        "SELECT json(1) FROM fs_nodes LIMIT 1",
        "SELECT json('null') FROM fs_nodes LIMIT 1",
    ] {
        let error = service
            .query_database_sql_json("typed-sql-db", "owner", sql, 10)
            .expect_err("non-object JSON text first column should reject");

        assert!(
            error.contains("exactly one non-null valid JSON object TEXT column"),
            "unexpected error for {sql}: {error}"
        );
    }
}

#[test]
fn database_sql_json_rejects_extra_result_columns() {
    let service = service();
    service
        .create_database("typed-sql-db", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "typed-sql-db".to_string(),
                path: "/Knowledge/sql.md".to_string(),
                kind: NodeKind::File,
                content: "database sql".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");

    let error = service
        .query_database_sql_json(
            "typed-sql-db",
            "owner",
            "SELECT json_object('path', path), kind FROM fs_nodes LIMIT 1",
            10,
        )
        .expect_err("extra result columns should reject");

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
}

#[test]
fn database_sql_json_accepts_valid_json_object_values() {
    let service = service();
    service
        .create_database("json-sql-db", "owner", 1)
        .expect("database should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "json-sql-db".to_string(),
                path: "/Knowledge/a.md".to_string(),
                kind: NodeKind::File,
                content: "alpha".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("node should write");

    let result = service
        .query_database_sql_json(
            "json-sql-db",
            "owner",
            "SELECT json_object('path', path) FROM fs_nodes WHERE path = '/Knowledge/a.md' LIMIT 1",
            10,
        )
        .expect("JSON object should be accepted");

    assert_eq!(
        result.rows,
        vec![r#"{"path":"/Knowledge/a.md"}"#.to_string()]
    );
}

#[test]
fn database_sql_json_rejects_oversized_row_and_response() {
    let service = service();
    service
        .create_database("size-sql-db", "owner", 1)
        .expect("database should create");
    let large_write = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "size-sql-db".to_string(),
                path: "/Knowledge/too-large.md".to_string(),
                kind: NodeKind::File,
                content: "x".repeat(66 * 1024),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("large node should write");

    let row_error = service
        .query_database_sql_json(
            "size-sql-db",
            "owner",
            "SELECT json_object('content', content) FROM fs_nodes WHERE path = '/Knowledge/too-large.md' LIMIT 1",
            1,
        )
        .expect_err("oversized row should reject");
    assert!(row_error.contains("row JSON exceeds"));

    service
        .delete_node(
            "owner",
            DeleteNodeRequest {
                database_id: "size-sql-db".to_string(),
                path: "/Knowledge/too-large.md".to_string(),
                expected_etag: Some(large_write.node.etag),
                expected_folder_index_etag: None,
            },
            3,
        )
        .expect("large node should delete");
    for index in 0..5 {
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "size-sql-db".to_string(),
                    path: format!("/Knowledge/large-{index}.md"),
                    kind: NodeKind::File,
                    content: "x".repeat(60 * 1024),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                4 + index,
            )
            .expect("node should write");
    }

    let response_error = service
        .query_database_sql_json(
            "size-sql-db",
            "owner",
            "SELECT json_object('content', content) FROM fs_nodes WHERE kind = 'file' ORDER BY path ASC LIMIT 5",
            5,
        )
        .expect_err("oversized response should reject");
    assert!(response_error.contains("response JSON exceeds"));
}

#[test]
fn wiki_metrics_returns_public_aggregate_counts() {
    const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;
    const NOW: i64 = 1_800_000_000_000;
    let old = NOW - THIRTY_DAYS_MS - 1_000;
    let recent = NOW - 1_000;
    let (service, root) = service_with_root();
    service
        .create_database("old-db", "old-owner", old)
        .expect("old database should create");
    cycle_database(&service, "old-db", "old-owner", 1_000_000, 1, old + 1);
    service
        .create_database("fresh-db", "fresh-owner", recent)
        .expect("fresh database should create");
    cycle_database(&service, "fresh-db", "payer", 2_000_000, 2, recent + 1);
    service
        .create_database("anonymous-db", "2vxsx-fae", recent + 10)
        .expect("anonymous database should create");
    cycle_database(
        &service,
        "anonymous-db",
        "2vxsx-fae",
        3_000_000,
        3,
        recent + 11,
    );
    let listing = service
        .market_create_listing(
            "fresh-owner",
            market_listing_request("fresh-db", 250),
            recent + 20,
        )
        .expect("listing should create");
    let start = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("buyer", "aaaaa-aa", 100_000, recent + 21),
            recent + 21,
        )
        .expect("market purchase should begin");
    service
        .complete_market_purchase_ledger_transfer(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            4,
        )
        .expect("market purchase ledger transfer should complete");
    service
        .apply_market_purchase(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            recent + 30,
        )
        .expect("market purchase should apply");
    Connection::open(root.join("index.sqlite3"))
        .expect("index should open")
        .execute(
            "INSERT INTO database_members (database_id, principal, role, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params!["fresh-db", "", "reader", recent + 40],
        )
        .expect("empty principal fixture should insert");

    let metrics = service.wiki_metrics(NOW).expect("wiki metrics should load");

    assert_eq!(metrics.users_total, 6);
    assert_eq!(metrics.users_active_30d, 5);
    assert_eq!(metrics.users_new_30d, 4);
    assert_eq!(metrics.databases_total, 3);
    assert_eq!(metrics.databases_active_30d, 2);
    assert_eq!(metrics.databases_new_30d, 2);
    assert_eq!(metrics.paid_users_total, 3);
    assert_eq!(metrics.charged_kinic_total_e8s, 6_000_250);
    assert_eq!(metrics.charged_kinic_30d_e8s, 5_000_250);
    assert_eq!(metrics.last_activity_at_ms, Some(recent + 40));
}

#[test]
fn wiki_metrics_returns_zero_counts_without_activity() {
    let service = service();

    let metrics = service
        .wiki_metrics(1_800_000_000_000)
        .expect("wiki metrics should load");

    assert_eq!(metrics.users_total, 0);
    assert_eq!(metrics.users_active_30d, 0);
    assert_eq!(metrics.users_new_30d, 0);
    assert_eq!(metrics.databases_total, 0);
    assert_eq!(metrics.databases_active_30d, 0);
    assert_eq!(metrics.databases_new_30d, 0);
    assert_eq!(metrics.paid_users_total, 0);
    assert_eq!(metrics.charged_kinic_total_e8s, 0);
    assert_eq!(metrics.charged_kinic_30d_e8s, 0);
    assert_eq!(metrics.last_activity_at_ms, None);
}

#[test]
fn wiki_metrics_series_clamps_days_to_one_through_seven_and_excludes_future_events() {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const NOW: i64 = 1_800_000_000_000;
    let today_start = (NOW / DAY_MS) * DAY_MS;
    let previous_start = today_start - DAY_MS;
    let first_start = today_start - (2 * DAY_MS);
    let service = service();
    service
        .create_database("previous-db", "previous-owner", previous_start + 1_000)
        .expect("previous database should create");
    service
        .create_database("today-db", "today-owner", today_start + 1_000)
        .expect("today database should create");

    let series = service
        .wiki_metrics_series(NOW, 3)
        .expect("wiki metrics series should load");
    let zero_day = service
        .wiki_metrics_series(NOW, 0)
        .expect("zero day should clamp to one point");
    let one_day = service
        .wiki_metrics_series(NOW, 1)
        .expect("one day should return one point");
    let seven_days = service
        .wiki_metrics_series(NOW, 7)
        .expect("seven days should return seven points");
    let eight_days = service
        .wiki_metrics_series(NOW, 8)
        .expect("eight days should clamp to seven points");
    let thirty_days = service
        .wiki_metrics_series(NOW, 30)
        .expect("thirty days should clamp to seven points");

    assert_eq!(zero_day.len(), 1);
    assert_eq!(one_day.len(), 1);
    assert_eq!(seven_days.len(), 7);
    assert_eq!(eight_days.len(), 7);
    assert_eq!(thirty_days.len(), 7);
    assert_eq!(series.len(), 3);
    assert_eq!(series[0].bucket_start_ms, first_start);
    assert_eq!(series[1].bucket_start_ms, previous_start);
    assert_eq!(series[2].bucket_start_ms, today_start);
    assert_eq!(series[0].metrics.databases_total, 0);
    assert_eq!(series[1].metrics.databases_total, 1);
    assert_eq!(series[2].metrics.databases_total, 2);
}

#[test]
fn wiki_metrics_series_uses_rolling_30d_window_per_bucket() {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    const NOW: i64 = 1_800_000_000_000;
    let cutoff = NOW - (30 * DAY_MS);
    let service = service();
    service
        .create_database("old-window-db", "old-window-owner", cutoff - 10_000)
        .expect("old database should create");
    cycle_database(
        &service,
        "old-window-db",
        "old-window-payer",
        100,
        1,
        cutoff - 1,
    );
    service
        .create_database("recent-window-db", "recent-window-owner", cutoff + 1)
        .expect("recent database should create");
    cycle_database(
        &service,
        "recent-window-db",
        "recent-window-payer",
        200,
        2,
        cutoff + 2,
    );

    let series = service
        .wiki_metrics_series(NOW, 1)
        .expect("wiki metrics series should load");
    let metrics = &series[0].metrics;

    assert_eq!(series.len(), 1);
    assert_eq!(metrics.databases_total, 2);
    assert_eq!(metrics.databases_new_30d, 1);
    assert_eq!(metrics.databases_active_30d, 1);
    assert_eq!(metrics.charged_kinic_total_e8s, 300);
    assert_eq!(metrics.charged_kinic_30d_e8s, 200);
}

#[test]
fn market_purchase_rejects_ledger_recipient_mismatch() {
    let service = service();
    service
        .create_database("recipient-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing("seller", market_listing_request("recipient-market", 250), 2)
        .expect("listing should create");
    let result = service.begin_market_purchase_with_ledger_details(
        "buyer",
        market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
        ledger_details("buyer", "ryjl3-tyaaa-aaaaa-aaaba-cai", 100_000, 6),
        6,
    );
    let error = match result {
        Ok(_) => panic!("mismatched ledger recipient should reject"),
        Err(error) => error,
    };

    assert!(error.contains("ledger recipient must match listing payout principal"));
}

#[test]
fn market_purchase_rejects_invalid_and_anonymous_access_principal() {
    let service = service();
    service
        .create_database("principal-reject-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("principal-reject-market", 250),
            2,
        )
        .expect("listing should create");

    for (principal, expected) in [
        ("not-a-principal", "principal text is invalid"),
        ("2vxsx-fae", "principal must not be anonymous"),
    ] {
        let result = service.begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, principal),
            ledger_details("buyer", "aaaaa-aa", 100_000, 6),
            6,
        );
        let error = match result {
            Ok(_) => panic!("invalid access principal should reject"),
            Err(error) => error,
        };
        assert!(error.contains(expected));
    }
}

#[test]
fn market_purchase_canonicalizes_access_principal() {
    let service = service();
    service
        .create_database("principal-canonical-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("principal-canonical-market", 250),
            2,
        )
        .expect("listing should create");
    let non_canonical = MARKET_BUYER_PRINCIPAL.to_ascii_uppercase();
    let start = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, &non_canonical),
            ledger_details("buyer", "aaaaa-aa", 100_000, 6),
            6,
        )
        .expect("non-canonical access principal should canonicalize");
    assert_eq!(start.access_principal, MARKET_BUYER_PRINCIPAL);
    let pending = service
        .query_index_sql_json(
            "SELECT json_object('buyer_principal', buyer_principal) FROM market_purchase_pending_operations",
            10,
        )
        .expect("pending operation should be queryable");
    assert_eq!(
        pending.rows,
        vec![format!(
            r#"{{"buyer_principal":"{}"}}"#,
            MARKET_BUYER_PRINCIPAL
        )]
    );

    service
        .complete_market_purchase_ledger_transfer(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            42,
        )
        .expect("ledger transfer should complete");
    let order = service
        .apply_market_purchase(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            7,
        )
        .expect("purchase should apply");

    assert_eq!(order.buyer_principal, MARKET_BUYER_PRINCIPAL);
    assert!(
        service
            .market_preview_purchase(MARKET_BUYER_PRINCIPAL, &listing.listing_id)
            .expect("canonical principal should preview entitlement")
            .already_entitled
    );
}

#[test]
fn market_purchase_applies_when_listing_pauses_during_ledger_transfer() {
    let (service, root) = service_with_root();
    service
        .create_database("paused-after-pay-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("paused-after-pay-market", 250),
            2,
        )
        .expect("listing should create");
    let start = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("buyer", "aaaaa-aa", 100_000, 3),
            3,
        )
        .expect("purchase should begin while listing is active");
    service
        .complete_market_purchase_ledger_transfer(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            42,
        )
        .expect("ledger transfer should complete");
    service
        .market_pause_listing("seller", &listing.listing_id, 4)
        .expect("seller may pause listing while ledger transfer is awaited");

    let order = service
        .apply_market_purchase(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            5,
        )
        .expect("ledger-completed purchase should apply from pending snapshot");

    assert_eq!(order.database_id, "paused-after-pay-market");
    assert_eq!(order.seller_principal, "seller");
    assert_eq!(order.payout_principal, "aaaaa-aa");
    assert_eq!(order.ledger_block_index, 42);
    assert_eq!(
        market_row_count(&root, "market_entitlements", "paused-after-pay-market"),
        1
    );
    assert_eq!(
        market_pending_operation_count(&root, "paused-after-pay-market"),
        0
    );
}

#[test]
fn market_purchase_applies_from_snapshot_when_listing_row_disappears_during_ledger_transfer() {
    let (service, root) = service_with_root();
    service
        .create_database("deleted-after-pay-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("deleted-after-pay-market", 250),
            2,
        )
        .expect("listing should create");
    let start = service
        .begin_market_purchase_with_ledger_details(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            ledger_details("buyer", "aaaaa-aa", 100_000, 3),
            3,
        )
        .expect("purchase should begin while listing exists");
    service
        .complete_market_purchase_ledger_transfer(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            42,
        )
        .expect("ledger transfer should complete");
    delete_market_listing_row(&root, &listing.listing_id);

    let order = service
        .apply_market_purchase(
            start.operation_id,
            MARKET_BUYER_PRINCIPAL,
            &listing.listing_id,
            listing.price_e8s,
            5,
        )
        .expect("ledger-completed purchase should apply from pending snapshot without listing row");

    assert_eq!(order.database_id, "deleted-after-pay-market");
    assert_eq!(order.seller_principal, "seller");
    assert_eq!(order.payout_principal, "aaaaa-aa");
    assert_eq!(order.ledger_block_index, 42);
    assert_eq!(
        market_row_count(&root, "market_listings", "deleted-after-pay-market"),
        0
    );
    assert_eq!(
        market_row_count(&root, "market_orders", "deleted-after-pay-market"),
        1
    );
    assert_eq!(
        market_row_count(&root, "market_entitlements", "deleted-after-pay-market"),
        1
    );
    assert_eq!(
        market_pending_operation_count(&root, "deleted-after-pay-market"),
        0
    );
}

#[test]
fn market_listing_description_allows_newlines() {
    let service = service();
    service
        .create_database("multiline-market", "seller", 1)
        .expect("database should create");

    let mut create = market_listing_request("multiline-market", 250);
    create.description = "Line one\nLine two\r\n\tIndented".to_string();
    create.llm_summary = Some("Summary one\nSummary two".to_string());
    let listing = service
        .market_create_listing("seller", create, 2)
        .expect("multiline description should create");
    assert_eq!(listing.description, "Line one\nLine two\r\n\tIndented");
    assert_eq!(
        listing.llm_summary,
        Some("Summary one\nSummary two".to_string())
    );

    let updated = service
        .market_update_listing(
            "seller",
            MarketUpdateListingRequest {
                listing_id: listing.listing_id,
                expected_revision: listing.revision,
                payout_principal: "aaaaa-aa".to_string(),
                title: "Updated market DB".to_string(),
                description: "Updated one\nUpdated two".to_string(),
                llm_summary: Some("Updated summary\nSecond line".to_string()),
                tags_json: "[]".to_string(),
                price_e8s: 300,
            },
            3,
        )
        .expect("multiline description should update");
    assert_eq!(updated.description, "Updated one\nUpdated two");
    assert_eq!(
        updated.llm_summary,
        Some("Updated summary\nSecond line".to_string())
    );
}

#[test]
fn market_listing_description_rejects_non_whitespace_control_characters() {
    let service = service();
    service
        .create_database("control-market", "seller", 1)
        .expect("database should create");

    let mut bad_description = market_listing_request("control-market", 250);
    bad_description.description = "bad\0description".to_string();
    let description_error = service
        .market_create_listing("seller", bad_description, 2)
        .expect_err("NUL in description should be rejected");
    assert!(
        description_error.contains("market listing description may not contain control characters")
    );

    let mut bad_title = market_listing_request("control-market", 250);
    bad_title.title = "bad\ntitle".to_string();
    let title_error = service
        .market_create_listing("seller", bad_title, 3)
        .expect_err("title newline should be rejected");
    assert!(title_error.contains("market listing title may not contain control characters"));

    let mut bad_tags = market_listing_request("control-market", 250);
    bad_tags.tags_json = "[\"bad\ntag\"]".to_string();
    let tags_error = service
        .market_create_listing("seller", bad_tags, 4)
        .expect_err("tags newline should be rejected");
    assert!(tags_error.contains("market listing tags may not contain control characters"));
}

#[test]
fn market_purchase_rejects_seller_self_purchase() {
    let service = service();
    service
        .create_database("self-market", MARKET_SECOND_BUYER_PRINCIPAL, 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            MARKET_SECOND_BUYER_PRINCIPAL,
            market_listing_request("self-market", 250),
            2,
        )
        .expect("listing should create");
    let error = service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_SECOND_BUYER_PRINCIPAL),
            5,
        )
        .expect_err("seller access principal must not buy their own listing");

    assert!(error.contains("seller cannot purchase own listing"));
}

#[test]
fn market_purchase_rejects_existing_entitlement_and_price_mismatch() {
    let service = service();
    service
        .create_database("reject-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing("seller", market_listing_request("reject-market", 100), 2)
        .expect("listing should create");

    let price_mismatch = service
        .market_purchase_access(
            "buyer",
            MarketPurchaseRequest {
                listing_id: listing.listing_id.clone(),
                price_e8s: listing.price_e8s + 1,
                access_principal: MARKET_BUYER_PRINCIPAL.to_string(),
            },
            6,
        )
        .expect_err("price mismatch should reject");
    assert!(price_mismatch.contains("market listing price mismatch"));

    service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            7,
        )
        .expect("first purchase should succeed");
    let duplicate = service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            8,
        )
        .expect_err("existing entitlement should reject");
    assert!(duplicate.contains("active entitlement already exists"));
}

#[test]
fn market_database_entitlements_are_owner_readonly_and_paged() {
    let service = service();
    service
        .create_database("buyer-list-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("buyer-list-market", 100),
            2,
        )
        .expect("listing should create");

    for (buyer, block_index) in [
        (MARKET_BUYER_PRINCIPAL, 10),
        (MARKET_SECOND_BUYER_PRINCIPAL, 11),
    ] {
        service
            .market_purchase_access(
                buyer,
                market_purchase_request(&listing, buyer),
                block_index as i64 + 10,
            )
            .expect("purchase should succeed");
    }

    let first_page = service
        .market_list_database_entitlements("seller", "buyer-list-market", None, 1)
        .expect("owner should list database entitlements");
    assert_eq!(first_page.entitlements.len(), 1);
    assert_eq!(
        first_page.entitlements[0].buyer_principal,
        MARKET_BUYER_PRINCIPAL
    );
    assert_eq!(
        first_page.next_cursor.as_deref(),
        Some(MARKET_BUYER_PRINCIPAL)
    );

    let second_page = service
        .market_list_database_entitlements("seller", "buyer-list-market", first_page.next_cursor, 1)
        .expect("owner should load next page");
    assert_eq!(second_page.entitlements.len(), 1);
    assert_eq!(
        second_page.entitlements[0].buyer_principal,
        MARKET_SECOND_BUYER_PRINCIPAL
    );
    assert_eq!(second_page.next_cursor, None);

    assert_eq!(
        service
            .market_list_entitlements(MARKET_BUYER_PRINCIPAL, None, 10)
            .expect("buyer entitlement query should remain buyer-scoped")
            .entitlements
            .len(),
        1
    );
    let forbidden = service
        .market_list_database_entitlements(MARKET_BUYER_PRINCIPAL, "buyer-list-market", None, 10)
        .expect_err("buyer must not inspect seller database entitlements");
    assert!(forbidden.contains("database owner or admin required"));
}

#[test]
fn market_listing_owner_policy_and_database_listing_query() {
    let service = service();
    service
        .create_database("owner-market", "seller", 1)
        .expect("database should create");
    service
        .grant_database_access("owner-market", "seller", "reader", DatabaseRole::Reader, 2)
        .expect("reader should be granted");
    assert!(
        service
            .market_create_listing("reader", market_listing_request("owner-market", 100), 3)
            .is_err(),
        "non-owner must not create listing"
    );

    let listing = service
        .market_create_listing("seller", market_listing_request("owner-market", 100), 4)
        .expect("owner should create listing");
    assert!(
        service
            .market_list_database_listings("reader", "owner-market")
            .is_err(),
        "non-owner must not list database listings"
    );
    let listings = service
        .market_list_database_listings("seller", "owner-market")
        .expect("owner should list database listings");
    assert_eq!(listings.len(), 1);
    assert_eq!(listings[0].listing_id, listing.listing_id);
    assert_eq!(listings[0].revision, 0);

    let updated = service
        .market_update_listing(
            "seller",
            MarketUpdateListingRequest {
                listing_id: listing.listing_id.clone(),
                expected_revision: listing.revision,
                payout_principal: "aaaaa-aa".to_string(),
                title: "Updated team database".to_string(),
                description: "Updated reusable team knowledge base".to_string(),
                llm_summary: None,
                tags_json: "[]".to_string(),
                price_e8s: 150,
            },
            5,
        )
        .expect("current revision should update listing");
    assert_eq!(updated.revision, 1);
    let stale = service
        .market_update_listing(
            "seller",
            MarketUpdateListingRequest {
                listing_id: listing.listing_id,
                expected_revision: 0,
                payout_principal: "aaaaa-aa".to_string(),
                title: "Stale team database".to_string(),
                description: "Stale reusable team knowledge base".to_string(),
                llm_summary: None,
                tags_json: "[]".to_string(),
                price_e8s: 200,
            },
            6,
        )
        .expect_err("stale revision should reject listing update");
    assert!(stale.contains("market listing revision mismatch"));
}

#[test]
fn market_publish_listing_reactivates_paused_listing() {
    let service = service();
    service
        .create_database("republish-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing("seller", market_listing_request("republish-market", 100), 2)
        .expect("listing should create active");
    assert_eq!(listing.status, MarketListingStatus::Active);

    let paused = service
        .market_pause_listing("seller", &listing.listing_id, 3)
        .expect("listing should pause");
    assert_eq!(paused.status, MarketListingStatus::Paused);
    assert!(
        service
            .market_list_listings(None, 10)
            .expect("paused listings should load")
            .listings
            .is_empty(),
        "paused listing should leave public marketplace"
    );

    let active = service
        .market_publish_listing("seller", &listing.listing_id, 4)
        .expect("paused listing should republish");
    assert_eq!(active.status, MarketListingStatus::Active);
    assert_eq!(
        service
            .market_list_listings(None, 10)
            .expect("active listings should load")
            .listings
            .len(),
        1
    );
}

#[test]
fn market_list_seller_listings_filters_by_seller_and_pages() {
    let service = service();
    for (database_id, seller, price) in [
        ("seller-a-one", "seller-a", 100),
        ("seller-a-two", "seller-a", 200),
        ("seller-b-one", "seller-b", 300),
        ("seller-a-paused", "seller-a", 400),
    ] {
        service
            .create_database(database_id, seller, 1)
            .expect("database should create");
        let listing = service
            .market_create_listing(seller, market_listing_request(database_id, price), 2)
            .expect("listing should create");
        if database_id == "seller-a-paused" {
            service
                .market_pause_listing(seller, &listing.listing_id, 3)
                .expect("listing should pause");
        }
    }
    service
        .create_database("seller-a-stale-owner", "seller-a", 4)
        .expect("stale owner database should create");
    let stale = service
        .market_create_listing(
            "seller-a",
            market_listing_request("seller-a-stale-owner", 500),
            5,
        )
        .expect("stale owner listing should create");
    service
        .grant_database_access(
            "seller-a-stale-owner",
            "seller-a",
            "successor",
            DatabaseRole::Owner,
            6,
        )
        .expect("successor should become owner");
    service
        .revoke_database_access("seller-a-stale-owner", "successor", "seller-a")
        .expect("seller-a should lose owner role");

    let first = service
        .market_list_seller_listings("seller-a", None, 1)
        .expect("seller listings should load");
    assert_eq!(first.listings.len(), 1);
    assert_eq!(first.listings[0].seller_principal, "seller-a");
    assert!(first.next_cursor.is_some());

    let second = service
        .market_list_seller_listings("seller-a", first.next_cursor, 10)
        .expect("second seller page should load");
    assert_eq!(second.listings.len(), 1);
    assert_eq!(second.listings[0].seller_principal, "seller-a");
    assert_ne!(second.listings[0].listing_id, stale.listing_id);
    assert!(second.next_cursor.is_none());

    let all = [first.listings, second.listings].concat();
    assert_eq!(all.len(), 2);
    assert!(
        all.iter()
            .all(|listing| listing.seller_principal == "seller-a")
    );
    assert!(
        all.iter()
            .all(|listing| listing.status == MarketListingStatus::Active)
    );
    assert!(
        !all.iter()
            .any(|listing| listing.database_id == "seller-b-one")
    );
    assert!(
        !all.iter()
            .any(|listing| listing.database_id == "seller-a-paused")
    );
    assert!(
        !all.iter()
            .any(|listing| listing.database_id == "seller-a-stale-owner")
    );
}

#[test]
fn market_listing_detail_returns_verified_preview() {
    let service = service();
    service
        .create_database("preview-market", "seller", 1)
        .expect("database should create");
    ensure_parent_folders(
        &service,
        "seller",
        "preview-market",
        "/Knowledge/alpha/a.md",
        2,
    );
    ensure_parent_folders(
        &service,
        "seller",
        "preview-market",
        "/Knowledge/beta/b.md",
        2,
    );
    ensure_parent_folders(
        &service,
        "seller",
        "preview-market",
        "/Sources/web/source.md",
        2,
    );
    service
        .write_node(
            "seller",
            WriteNodeRequest {
                database_id: "preview-market".to_string(),
                path: "/Knowledge/alpha/a.md".to_string(),
                kind: NodeKind::File,
                content: "Alpha paid insight links to [beta](/Knowledge/beta/b.md).".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("alpha node should write");
    service
        .write_node(
            "seller",
            WriteNodeRequest {
                database_id: "preview-market".to_string(),
                path: "/Knowledge/beta/b.md".to_string(),
                kind: NodeKind::File,
                content: "Beta paid body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            3,
        )
        .expect("beta node should write");
    service
        .write_node(
            "seller",
            WriteNodeRequest {
                database_id: "preview-market".to_string(),
                path: "/Sources/web/source.md".to_string(),
                kind: NodeKind::Source,
                content: "raw source body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            4,
        )
        .expect("source node should write");

    let listing = service
        .market_create_listing("seller", market_listing_request("preview-market", 100), 5)
        .expect("listing should create");
    let detail = service
        .market_get_listing("2vxsx-fae", &listing.listing_id)
        .expect("anonymous should read public listing preview");

    assert_eq!(detail.listing.listing_id, listing.listing_id);
    assert!(detail.verified_stats.total_nodes >= 5);
    assert!(detail.verified_stats.wiki_nodes >= 4);
    assert_eq!(detail.verified_stats.source_nodes, 1);
    assert!(detail.verified_stats.folder_nodes >= 3);
    assert!(detail.verified_stats.markdown_chars >= 64);
    assert_eq!(detail.verified_stats.source_chars, 15);
    assert_eq!(detail.verified_stats.link_edges, 1);
    assert!(
        detail
            .preview
            .excerpts
            .iter()
            .any(|excerpt| excerpt.path == "/Knowledge/alpha/a.md"
                && excerpt.excerpt == "Alpha paid insight links to [beta](/Knowledge/beta/b.md).")
    );
    assert!(detail.preview.excerpts.iter().any(
        |excerpt| excerpt.path == "/Knowledge/beta/b.md" && excerpt.excerpt == "Beta paid body"
    ));
    assert!(
        detail
            .preview
            .excerpts
            .iter()
            .all(|excerpt| !excerpt.path.starts_with("/Sources/"))
    );
    assert!(!detail.preview.preview_stale);
    assert!(
        detail
            .preview
            .top_level_paths
            .contains(&"/Knowledge/alpha".to_string())
    );
    assert!(
        detail
            .preview
            .top_level_paths
            .contains(&"/Knowledge/beta".to_string())
    );
    assert!(
        detail
            .preview
            .category_graph
            .nodes
            .iter()
            .any(|node| node.category == "/Knowledge/alpha")
    );
    assert!(
        detail
            .preview
            .category_graph
            .edges
            .iter()
            .any(|edge| edge.source_category == "/Knowledge/alpha"
                && edge.target_category == "/Knowledge/beta"
                && edge.link_count == 1)
    );
    assert!(
        detail
            .preview
            .graph_links
            .iter()
            .any(|edge| edge.source_path == "/Knowledge/alpha/a.md"
                && edge.target_path == "/Knowledge/beta/b.md")
    );
}

#[test]
fn market_listing_leaves_public_surface_when_seller_loses_owner_role() {
    let service = service();
    service
        .create_database("stale-owner-market", "seller", 1)
        .expect("database should create");
    let listing = service
        .market_create_listing(
            "seller",
            market_listing_request("stale-owner-market", 100),
            2,
        )
        .expect("listing should create");
    service
        .grant_database_access(
            "stale-owner-market",
            "seller",
            "successor",
            DatabaseRole::Owner,
            4,
        )
        .expect("successor owner should be granted");
    service
        .revoke_database_access("stale-owner-market", "successor", "seller")
        .expect("seller should lose owner access");

    assert!(
        service
            .market_list_listings(None, 10)
            .expect("public listings should load")
            .listings
            .is_empty(),
        "seller without owner role must not stay in public marketplace"
    );
    assert!(
        service
            .market_get_listing("buyer", &listing.listing_id)
            .expect_err("buyer should not read stale public listing")
            .contains("seller or admin required")
    );
    assert!(
        service
            .market_preview_purchase("buyer", &listing.listing_id)
            .expect_err("preview should reject stale seller")
            .contains("principal has no access to database")
    );
    assert!(
        service
            .market_purchase_access(
                "buyer",
                market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
                6,
            )
            .expect_err("purchase should reject stale seller")
            .contains("principal has no access to database")
    );
    service
        .market_get_listing("seller", &listing.listing_id)
        .expect("original seller should still manage stale listing");
    let paused = service
        .market_pause_listing("seller", &listing.listing_id, 7)
        .expect("original seller should pause stale listing");
    assert_eq!(paused.listing_id, listing.listing_id);
}

#[test]
fn market_listing_requires_active_database() {
    let service = service();
    let pending = service
        .reserve_pending_generated_database("Pending market", "owner", 1)
        .expect("pending database should reserve");
    let pending_error = service
        .market_create_listing(
            "owner",
            market_listing_request(&pending.database_id, 100),
            2,
        )
        .expect_err("pending database listing should reject");
    assert!(pending_error.contains("database is pending"));

    service
        .create_database("archive-market", "owner", 3)
        .expect("database should create");
    let listing = service
        .market_create_listing("owner", market_listing_request("archive-market", 100), 4)
        .expect("active database listing should create");
    assert_eq!(
        service
            .market_list_listings(None, 10)
            .expect("active listings should load")
            .listings
            .len(),
        1
    );

    let archive = service
        .begin_database_archive("archive-market", "owner", 6)
        .expect("archive should begin");
    assert!(
        service
            .market_list_listings(None, 10)
            .expect("archiving listings should load")
            .listings
            .is_empty(),
        "archiving database listing must leave public marketplace"
    );
    assert!(
        service
            .market_get_listing("buyer", &listing.listing_id)
            .expect_err("buyer should not read non-active database listing")
            .contains("seller or admin required")
    );
    service
        .market_get_listing("owner", &listing.listing_id)
        .expect("owner should still manage archived listing");

    let bytes = read_archive_in_chunks(&service, "archive-market", archive.size_bytes, 17);
    let snapshot_hash = sha256_bytes(&bytes);
    service
        .finalize_database_archive("archive-market", "owner", snapshot_hash.clone(), 7)
        .expect("archive should finalize");
    let preview_error = service
        .market_preview_purchase("buyer", &listing.listing_id)
        .expect_err("archived database preview should reject");
    assert!(preview_error.contains("database is archived"));
    let purchase_error = service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            9,
        )
        .expect_err("archived database purchase should reject");
    assert!(purchase_error.contains("database is archived"));
    service
        .begin_database_restore(
            "archive-market",
            "owner",
            snapshot_hash,
            archive.size_bytes,
            10,
        )
        .expect("restore should begin");
    assert!(
        service
            .market_list_listings(None, 10)
            .expect("restoring listings should load")
            .listings
            .is_empty(),
        "restoring database listing must stay hidden"
    );
    service
        .write_database_restore_chunk("archive-market", "owner", 0, &bytes)
        .expect("restore chunk should write");
    service
        .finalize_database_restore("archive-market", "owner", 11)
        .expect("restore should finalize");
    assert_eq!(
        service
            .market_list_listings(None, 10)
            .expect("restored listings should load")
            .listings
            .len(),
        1
    );
    service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            12,
        )
        .expect("restored active database purchase should succeed");
}

#[test]
fn delete_database_removes_marketplace_rows() {
    let (service, root) = service_with_root();
    service
        .create_database("market-delete", "seller", 1)
        .expect("database should create");
    service
        .write_node(
            "seller",
            WriteNodeRequest {
                database_id: "market-delete".to_string(),
                path: "/Knowledge/private.md".to_string(),
                kind: NodeKind::File,
                content: "paid body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("owner should write");
    let listing = service
        .market_create_listing("seller", market_listing_request("market-delete", 100), 3)
        .expect("listing should create");
    service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            6,
        )
        .expect("purchase should succeed");
    service
        .read_node(
            "market-delete",
            MARKET_BUYER_PRINCIPAL,
            "/Knowledge/private.md",
        )
        .expect("entitled buyer should read before delete");
    assert_eq!(
        market_row_count(&root, "market_listings", "market-delete"),
        1
    );
    assert_eq!(market_row_count(&root, "market_orders", "market-delete"), 1);
    assert_eq!(
        market_row_count(&root, "market_entitlements", "market-delete"),
        1
    );

    service
        .delete_database(delete_request("market-delete"), "seller", 7)
        .expect("delete should succeed");
    assert_eq!(
        market_row_count(&root, "market_listings", "market-delete"),
        0
    );
    assert_eq!(market_row_count(&root, "market_orders", "market-delete"), 1);
    assert_eq!(
        market_row_count(&root, "market_entitlements", "market-delete"),
        0
    );
    assert_eq!(
        service
            .market_list_orders(MARKET_BUYER_PRINCIPAL, None, 10)
            .expect("buyer order history should remain")
            .orders
            .len(),
        1
    );
    let deleted_read = service
        .read_node(
            "market-delete",
            MARKET_BUYER_PRINCIPAL,
            "/Knowledge/private.md",
        )
        .expect_err("deleted database should not remain readable");
    assert!(deleted_read.contains("database not found"));
}

#[test]
fn market_entitlement_allows_read_surface_but_not_export() {
    let service = service();
    service
        .create_database("read-market", "seller", 1)
        .expect("database should create");
    service
        .write_node(
            "seller",
            WriteNodeRequest {
                database_id: "read-market".to_string(),
                path: "/Knowledge/private.md".to_string(),
                kind: NodeKind::File,
                content: "paid body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            2,
        )
        .expect("owner should write");
    let listing = service
        .market_create_listing("seller", market_listing_request("read-market", 100), 3)
        .expect("listing should create");
    service
        .market_purchase_access(
            "buyer",
            market_purchase_request(&listing, MARKET_BUYER_PRINCIPAL),
            7,
        )
        .expect("purchase should succeed");

    let node = service
        .read_node(
            "read-market",
            MARKET_BUYER_PRINCIPAL,
            "/Knowledge/private.md",
        )
        .expect("entitled buyer should read")
        .expect("node should exist");
    assert_eq!(node.content, "paid body");
    let sql_result = service
        .query_database_sql_json(
            "read-market",
            MARKET_BUYER_PRINCIPAL,
            "SELECT json_object('path', path, 'content', content) FROM fs_nodes WHERE path = '/Knowledge/private.md' LIMIT 1",
            10,
        )
        .expect("entitled buyer should query database SQL");
    assert_eq!(
        sql_result.rows,
        vec![r#"{"path":"/Knowledge/private.md","content":"paid body"}"#]
    );
    assert!(
        service
            .export_fs_snapshot(
                "buyer",
                vfs_types::ExportSnapshotRequest {
                    database_id: "read-market".to_string(),
                    prefix: None,
                    limit: 10,
                    cursor: None,
                    snapshot_session_id: None,
                    snapshot_revision: None,
                },
            )
            .is_err(),
        "entitlement must not allow export"
    );
}
