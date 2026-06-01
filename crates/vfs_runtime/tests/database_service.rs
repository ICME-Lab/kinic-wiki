// Where: crates/vfs_runtime/tests/database_service.rs
// What: Multi-database service tests over local SQLite files.
// Why: The canister mount layer depends on runtime index and role semantics being deterministic.
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use vfs_runtime::{
    CyclesPendingLedgerDetailsInput, DEFAULT_LLM_WRITER_PRINCIPAL,
    DatabaseCyclesPurchaseWithLedgerDetails, MAX_ARCHIVE_CHUNK_BYTES, MAX_DATABASE_SIZE_BYTES,
    MAX_RESTORE_CHUNK_BYTES, VfsService,
};
use vfs_types::{
    AppendNodeRequest, CyclesBillingConfigUpdate, DatabaseRole, DatabaseStatus,
    DeleteDatabaseRequest, DeleteNodeRequest, KINIC_LEDGER_FEE_E8S, MkdirNodeRequest, NodeKind,
    OpsAnswerSessionCheckRequest, OpsAnswerSessionRequest, SearchNodesRequest, SearchPreviewMode,
    SourceRunSessionCheckRequest, UrlIngestTriggerSessionCheckRequest,
    UrlIngestTriggerSessionRequest, WriteNodeRequest, WriteSourceForGenerationRequest,
};

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

fn delete_request(database_id: &str) -> DeleteDatabaseRequest {
    DeleteDatabaseRequest {
        database_id: database_id.to_string(),
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
    assert_eq!(balance, 0);
    assert_eq!(suspended_at_ms, Some(0));
    assert_eq!(storage_columns, 1);
    assert_eq!(removed_storage_columns, 0);
    assert_eq!(pending_details_columns, 6);
    assert_eq!(ledger_cycles_column_count, 0);
    assert_eq!(usage_table_count, 0);
    assert_eq!(
        schema_migration_count(&root, "database_index:020_cycles_billing_config_version"),
        1
    );
    assert_eq!(cycles_billing_config_version(&root), 1);
}

fn write_mainnet_011_index_schema(index_path: &std::path::Path, status: &str) {
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
           ('db_existing', 'Existing', 'db_existing.sqlite3', 11, 11, ?1,
            'vfs_store:current', 0, 1, 1)",
        params![status],
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

    assert!(error.contains("unsupported partial billing index schema"));
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

    assert!(error.contains("unsupported partial billing index schema"));
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

fn cycles_billing_config_version(root: &std::path::Path) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT value FROM cycles_billing_config WHERE key = 'config_version'",
        params![],
        |row| row.get::<_, String>(0),
    )
    .expect("cycles config version should load")
    .parse()
    .expect("cycles config version should be numeric")
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
    let preview = service
        .preview_database_cycles_purchase(database_id, payment_amount_e8s)
        .expect("database cycle purchase preview should load");
    let operation_id = service
        .begin_database_cycles_purchase(database_id, caller, payment_amount_e8s, now)
        .expect("database cycle purchase should begin");
    service
        .mark_database_cycles_purchase_completed(operation_id, database_id, caller, preview.cycles)
        .expect("database cycle purchase should be marked completed");
    service
        .apply_database_cycles_purchase(
            operation_id,
            database_id,
            caller,
            preview.cycles,
            block_index,
            now,
        )
        .expect("database cycle purchase should cycle")
}

fn cycles_for_payment(service: &VfsService, database_id: &str, payment_amount_e8s: u64) -> u64 {
    service
        .preview_database_cycles_purchase(database_id, payment_amount_e8s)
        .expect("database cycle purchase preview should load")
        .cycles
}

fn default_cycles_for_payment(payment_amount_e8s: u64) -> u64 {
    payment_amount_e8s * 10_000
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
            url_ingest_session_check_request("alpha", "/Wiki/not-request.md", "session-owner"),
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
    let path = "/Sources/raw/web/abc.md";
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
                "/Sources/raw/other/other.md",
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
            write_source_for_generation_request("alpha", "/Sources/raw/web/def.md", "session-2"),
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
                "/Sources/raw/web/def.md",
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
    let path = "/Sources/raw/web/abc.md";
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
    let path = "/Sources/raw/web/abc.md";
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
            write_source_for_generation_request("alpha", "/Sources/raw/web/def.md", "session-2"),
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
            .read_node(&pending.database_id, "owner", "/Wiki/a.md")
            .expect_err("pending DB should reject VFS reads")
            .contains("database is pending")
    );
    service
        .validate_database_cycles_purchase(&pending.database_id, 500)
        .expect("anonymous preview should accept pending DB cycle purchase");

    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 1_000_000, 2)
        .expect("cycle purchase should begin");
    assert_eq!(mount_history_count(&root), 0);
    assert_eq!(
        database_index_row(&root, &pending.database_id),
        ("pending".to_string(), None, 0, None)
    );
    let meta = service
        .activate_pending_database_for_cycles_purchase(&pending.database_id, 2)
        .expect("pending activation should prepare")
        .expect("pending activation should allocate mount");
    assert_eq!(meta.mount_id, 11);
    service
        .run_pending_database_migrations(&pending.database_id)
        .expect("pending migrations should run");
    let purchased_cycles = default_cycles_for_payment(1_000_000);
    service
        .mark_database_cycles_purchase_completed(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
        )
        .expect("cycle purchase should be marked completed");
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
        mount_history_row(&root, 11),
        (pending.database_id.clone(), "activate".to_string())
    );
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
fn direct_cycles_purchase_cancel_rejects_non_in_flight_operations() {
    let (service, root) = service_with_root();
    for database_id in ["completed-cancel", "ambiguous-cancel"] {
        service
            .create_database(database_id, "owner", 1)
            .expect("database should create");
    }

    let completed = service
        .begin_database_cycles_purchase("completed-cancel", "payer", 500, 2)
        .expect("completed operation should begin");
    let completed_cycles = cycles_for_payment(&service, "completed-cancel", 500);
    service
        .mark_database_cycles_purchase_completed(
            completed,
            "completed-cancel",
            "payer",
            completed_cycles,
        )
        .expect("completed operation should be marked completed");
    let completed_error = service
        .cancel_database_cycles_purchase(completed, "completed-cancel", "payer", completed_cycles)
        .expect_err("completed operation should not be directly cancellable");
    assert!(completed_error.contains("cycle purchase operation is completed"));
    assert_eq!(
        database_pending_operation_count(&root, "completed-cancel"),
        1
    );

    let ambiguous = service
        .begin_database_cycles_purchase("ambiguous-cancel", "payer", 700, 3)
        .expect("ambiguous operation should begin");
    let ambiguous_cycles = cycles_for_payment(&service, "ambiguous-cancel", 700);
    service
        .mark_database_cycles_purchase_ambiguous(
            ambiguous,
            "ambiguous-cancel",
            "payer",
            ambiguous_cycles,
            4,
        )
        .expect("ambiguous operation should be marked ambiguous");
    let ambiguous_error = service
        .cancel_database_cycles_purchase(ambiguous, "ambiguous-cancel", "payer", ambiguous_cycles)
        .expect_err("ambiguous operation should not be directly cancellable");
    assert!(ambiguous_error.contains("cycle purchase operation is ambiguous"));
    assert_eq!(
        database_pending_operation_count(&root, "ambiguous-cancel"),
        1
    );
    service
        .repair_database_cycles_purchase_cancel(
            "ambiguous-cancel",
            ambiguous,
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
            5,
        )
        .expect("ambiguous operation should remain repair cancellable by authority");
    assert_eq!(
        database_pending_operation_count(&root, "ambiguous-cancel"),
        0
    );
}

#[test]
fn pending_database_cycles_purchase_cancel_rejects_after_activation_started() {
    let (service, root) = service_with_root();
    let pending = service
        .reserve_pending_generated_database("Started", "owner", 1)
        .expect("pending database should create");
    let operation_id = service
        .begin_database_cycles_purchase(&pending.database_id, "payer", 500, 2)
        .expect("cycle purchase should begin");
    let purchased_cycles = default_cycles_for_payment(500);
    service
        .mark_database_cycles_purchase_ambiguous(
            operation_id,
            &pending.database_id,
            "payer",
            purchased_cycles,
            3,
        )
        .expect("cycle purchase ambiguity should record");
    let meta = service
        .activate_pending_database_for_cycles_purchase(&pending.database_id, 4)
        .expect("pending activation should prepare")
        .expect("activation should allocate mount");
    assert_eq!(meta.mount_id, 11);

    let error = service
        .repair_database_cycles_purchase_cancel(
            &pending.database_id,
            operation_id,
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
            5,
        )
        .expect_err("started activation should require complete repair");

    assert!(error.contains("complete cycle purchase repair"));
    assert_eq!(
        database_pending_operation_count(&root, &pending.database_id),
        1
    );
    assert_eq!(mount_history_count(&root), 1);
    assert_eq!(
        database_index_row(&root, &pending.database_id),
        ("pending".to_string(), Some(11), 0, None)
    );
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
fn cycles_billing_config_version_changes_only_for_effective_rate_updates() {
    let (service, root) = service_with_root();
    assert_eq!(cycles_billing_config_version(&root), 1);

    service
        .update_cycles_billing_config(
            CyclesBillingConfigUpdate {
                cycles_per_kinic: 1_000_000_000_000,
                min_update_cycles: 1_000_000,
            },
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
        )
        .expect("same config should update without version bump");
    assert_eq!(cycles_billing_config_version(&root), 1);

    service
        .update_cycles_billing_config(
            CyclesBillingConfigUpdate {
                cycles_per_kinic: 2_000_000_000_000,
                min_update_cycles: 1_000_000,
            },
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
        )
        .expect("changed config should update");
    assert_eq!(cycles_billing_config_version(&root), 2);
}

#[test]
fn cycles_purchase_preview_returns_fixed_payment_inputs() {
    let (service, _root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let preview = service
        .preview_database_cycles_purchase("alpha", 50_000)
        .expect("preview should succeed");

    assert_eq!(preview.payment_amount_e8s, 50_000);
    assert_eq!(preview.cycles, 500_000_000);
    assert_eq!(preview.ledger_fee_e8s, KINIC_LEDGER_FEE_E8S);
    assert_eq!(preview.cycles_per_kinic, 1_000_000_000_000);
    assert_eq!(preview.config_version, 1);
}

#[test]
fn cycles_purchase_begin_rejects_stale_expected_values_before_pending_create() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");

    let stale_amount = service
        .begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id: "alpha",
                caller: "payer",
                payment_amount_e8s: 50_000,
                expected_cycles: 500_000_001,
                expected_config_version: 1,
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
        .expect_err("stale amount should reject");
    assert!(stale_amount.contains("cycles purchase amount changed"));
    assert_eq!(database_pending_operation_count(&root, "alpha"), 0);

    let stale_version = service
        .begin_database_cycles_purchase_with_ledger_details(
            DatabaseCyclesPurchaseWithLedgerDetails {
                database_id: "alpha",
                caller: "payer",
                payment_amount_e8s: 50_000,
                expected_cycles: 500_000_000,
                expected_config_version: 2,
                ledger: CyclesPendingLedgerDetailsInput {
                    from_owner: "payer",
                    from_subaccount: None,
                    to_owner: "canister",
                    to_subaccount: None,
                    ledger_fee_e8s: KINIC_LEDGER_FEE_E8S,
                    ledger_created_at_time_ns: 3_000_000,
                },
                now: 3,
            },
        )
        .expect_err("stale version should reject");
    assert!(stale_version.contains("cycles billing config changed"));
    assert_eq!(database_pending_operation_count(&root, "alpha"), 0);
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
        .mark_database_cycles_purchase_completed(operation_id, "alpha", "owner", purchased_cycles)
        .expect("cycle purchase should be marked completed");

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
    for database_id in ["complete", "cancel", "ambiguous"] {
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
    let ambiguous = service
        .begin_database_cycles_purchase("ambiguous", "owner", 500, 2)
        .expect("cycle purchase should begin");
    let purchased_cycles = cycles_for_payment(&service, "complete", 500);

    for database_id in ["complete", "cancel", "ambiguous"] {
        let error = service
            .delete_database(delete_request(database_id), "owner", 3)
            .expect_err("pending cycle purchase should block delete");
        assert!(error.contains("pending cycle operation"));
        assert_eq!(database_pending_operation_count(&root, database_id), 1);
    }

    service
        .mark_database_cycles_purchase_completed(complete, "complete", "owner", purchased_cycles)
        .expect("cycle purchase should be marked completed");
    service
        .apply_database_cycles_purchase(complete, "complete", "owner", purchased_cycles, 10, 4)
        .expect("cycle purchase should complete");
    service
        .cancel_database_cycles_purchase(cancel, "cancel", "owner", purchased_cycles)
        .expect("cycle purchase should cancel");
    service
        .mark_database_cycles_purchase_ambiguous(
            ambiguous,
            "ambiguous",
            "owner",
            purchased_cycles,
            4,
        )
        .expect("ambiguous cycle purchase should record");

    for database_id in ["complete", "cancel"] {
        assert_eq!(database_pending_operation_count(&root, database_id), 0);
        service
            .delete_database(delete_request(database_id), "owner", 5)
            .expect("resolved cycle purchase should allow delete");
    }
    assert_eq!(database_pending_operation_count(&root, "ambiguous"), 1);
    let error = service
        .delete_database(delete_request("ambiguous"), "owner", 5)
        .expect_err("ambiguous cycle purchase should keep delete blocked");
    assert!(error.contains("pending cycle operation"));
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
fn pending_cycles_operations_are_visible_to_owner_and_authority_only() {
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
    service
        .begin_database_cycles_purchase("alpha", "payer", 500, 3)
        .expect("cycle purchase should begin");

    let owner_page = service
        .list_database_cycle_pending_operations("alpha", "owner", None, 10)
        .expect("owner should list pending operations");
    assert_eq!(owner_page.entries.len(), 1);
    assert_eq!(owner_page.entries[0].kind, "cycles_purchase");
    assert_eq!(owner_page.entries[0].caller, "payer");

    let billing_authority_page = service
        .list_database_cycle_pending_operations("alpha", "rrkah-fqaaa-aaaaa-aaaaq-cai", None, 10)
        .expect("billing authority should list pending operations");
    assert_eq!(billing_authority_page.entries.len(), 1);

    for caller in ["writer", "reader", "2vxsx-fae"] {
        let error = service
            .list_database_cycle_pending_operations("alpha", caller, None, 10)
            .expect_err("non-owner should not list pending operations");
        assert!(
            error.contains("principal lacks required database role")
                || error.contains("principal has no access")
        );
    }
}

#[test]
fn repair_cycles_purchase_cancel_allows_configured_authority_only() {
    let (service, root) = service_with_root();
    for database_id in ["payer-reject", "owner-reject", "authority-cancel"] {
        service
            .create_database(database_id, "owner", 1)
            .expect("database should create");
        service
            .grant_database_access(database_id, "owner", "writer", DatabaseRole::Writer, 2)
            .expect("writer should be granted");
        service
            .grant_database_access(database_id, "owner", "reader", DatabaseRole::Reader, 3)
            .expect("reader should be granted");
    }

    let payer_reject = service
        .begin_database_cycles_purchase("payer-reject", "payer", 500, 4)
        .expect("payer reject operation should begin");
    let payer_reject_cycles = cycles_for_payment(&service, "payer-reject", 500);
    service
        .mark_database_cycles_purchase_ambiguous(
            payer_reject,
            "payer-reject",
            "payer",
            payer_reject_cycles,
            5,
        )
        .expect("payer reject should mark ambiguous");
    let error = service
        .repair_database_cycles_purchase_cancel("payer-reject", payer_reject, "payer", 6)
        .expect_err("payer should not cancel own ambiguous purchase");
    assert!(error.contains("not cycles purchase cancel authority"));
    assert_eq!(database_pending_operation_count(&root, "payer-reject"), 1);

    let owner_reject = service
        .begin_database_cycles_purchase("owner-reject", "payer", 700, 7)
        .expect("owner reject operation should begin");
    let owner_reject_cycles = cycles_for_payment(&service, "owner-reject", 700);
    service
        .mark_database_cycles_purchase_ambiguous(
            owner_reject,
            "owner-reject",
            "payer",
            owner_reject_cycles,
            8,
        )
        .expect("owner reject should mark ambiguous");
    let error = service
        .repair_database_cycles_purchase_cancel("owner-reject", owner_reject, "owner", 9)
        .expect_err("owner should not cancel ambiguous purchase");
    assert!(error.contains("not cycles purchase cancel authority"));
    assert_eq!(database_pending_operation_count(&root, "owner-reject"), 1);

    let authority_cancel = service
        .begin_database_cycles_purchase("authority-cancel", "payer", 900, 10)
        .expect("authority cancel operation should begin");
    let authority_cancel_cycles = cycles_for_payment(&service, "authority-cancel", 900);
    service
        .mark_database_cycles_purchase_ambiguous(
            authority_cancel,
            "authority-cancel",
            "payer",
            authority_cancel_cycles,
            11,
        )
        .expect("authority cancel should mark ambiguous");
    service
        .repair_database_cycles_purchase_cancel(
            "authority-cancel",
            authority_cancel,
            "rrkah-fqaaa-aaaaa-aaaaq-cai",
            12,
        )
        .expect("authority should cancel pending purchase");
    assert_eq!(
        database_ledger_kinds(&root, "authority-cancel"),
        vec![
            "cycles_purchase_ambiguous",
            "cycles_purchase_repair_cancelled"
        ]
    );
}

#[test]
fn cycles_history_redacts_principals_for_non_owner_readers() {
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

    let reader_entry = service
        .list_database_cycle_entries("alpha", "reader", None, 10)
        .expect("reader should list history")
        .entries
        .remove(0);
    assert_eq!(reader_entry.caller, "redacted");
    assert_eq!(reader_entry.ledger_block_index, Some(42));

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
fn verified_complete_allows_authenticated_caller_and_authority_cancel() {
    let (service, root) = service_with_root();
    service
        .create_database("complete", "owner", 1)
        .expect("database should create");
    service
        .create_database("cancel", "owner", 1)
        .expect("database should create");
    let complete = service
        .begin_database_cycles_purchase("complete", "payer", 500, 2)
        .expect("cycle purchase should begin");
    let cancel = service
        .begin_database_cycles_purchase("cancel", "payer", 700, 2)
        .expect("cycle purchase should begin");
    let complete_cycles = cycles_for_payment(&service, "complete", 500);
    let cancel_cycles = cycles_for_payment(&service, "cancel", 700);
    service
        .mark_database_cycles_purchase_ambiguous(complete, "complete", "payer", complete_cycles, 3)
        .expect("cycle purchase ambiguity should record");
    service
        .mark_database_cycles_purchase_ambiguous(cancel, "cancel", "payer", cancel_cycles, 3)
        .expect("cycle purchase ambiguity should record");

    let balance = service
        .repair_database_cycles_purchase_complete("complete", complete, 77, 4)
        .expect("authenticated caller should complete verified cycle purchase");
    assert_eq!(balance, complete_cycles);
    service
        .repair_database_cycles_purchase_cancel("cancel", cancel, "rrkah-fqaaa-aaaaa-aaaaq-cai", 4)
        .expect("authority should cancel ambiguous cycle purchase after verification");

    assert_eq!(
        database_cycles_balance(&root, "complete"),
        complete_cycles as i64
    );
    assert_eq!(database_cycles_balance(&root, "cancel"), 0);
    assert_eq!(database_pending_operation_count(&root, "complete"), 0);
    assert_eq!(database_pending_operation_count(&root, "cancel"), 0);
    assert_eq!(
        database_ledger_kinds(&root, "complete"),
        vec![
            "cycles_purchase_ambiguous",
            "cycles_purchase_repair_complete"
        ]
    );
    assert_eq!(
        database_ledger_kinds(&root, "cancel"),
        vec![
            "cycles_purchase_ambiguous",
            "cycles_purchase_repair_cancelled"
        ]
    );
    let entries = service
        .list_database_cycle_entries("complete", "owner", None, 10)
        .expect("cycles entries should load")
        .entries;
    assert_eq!(entries[0].caller, "payer");
    assert_eq!(entries[1].caller, "payer");
    assert_eq!(entries[1].ledger_block_index, Some(77));

    let cancel_entries = service
        .list_database_cycle_entries("cancel", "owner", None, 10)
        .expect("cancel entries should load")
        .entries;
    assert_eq!(cancel_entries[1].caller, "rrkah-fqaaa-aaaaa-aaaaq-cai");
    assert_eq!(cancel_entries[1].payment_amount_e8s, Some(700));
    assert_eq!(cancel_entries[1].balance_after_cycles, 0);
    assert_eq!(cancel_entries[1].ledger_block_index, None);
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
    cycle_database(&service, "alpha", "owner", 500, 7, 2);
    let config = service
        .cycles_billing_config()
        .expect("cycles config should load");

    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 0, 3)
        .expect("zero-cycle update should skip charge");

    assert_eq!(database_cycles_balance(&root, "alpha"), 5_000_000);
    assert_eq!(
        database_ledger_kinds(&root, "alpha"),
        vec!["cycles_purchase"]
    );

    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 1_000_000, 4)
        .expect("charged update should record cycle ledger");

    assert_eq!(database_cycles_balance(&root, "alpha"), 4_000_000);
    service
        .charge_database_update(&config, "alpha", "owner", "write_node", 1_000_001, 5)
        .expect("raw update cycle charge should record cycle ledger");

    assert_eq!(database_cycles_balance(&root, "alpha"), 2_999_999);
    let entries = service
        .list_database_cycle_entries("alpha", "owner", None, 10)
        .expect("cycle entries should load")
        .entries;
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[1].kind, "charge");
    assert_eq!(entries[1].amount_cycles, -1_000_000);
    assert_eq!(entries[2].kind, "charge");
    assert_eq!(entries[2].amount_cycles, -1_000_001);
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
                    path: "/Wiki/shared.md".to_string(),
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
        .read_node("alpha", "owner", "/Wiki/shared.md")
        .expect("alpha read should succeed")
        .expect("alpha node should exist");
    let beta_hits = service
        .search_nodes(
            "owner",
            SearchNodesRequest {
                database_id: "beta".to_string(),
                query_text: "alpha".to_string(),
                prefix: Some("/Wiki".to_string()),
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
                path: "/Wiki/a.md".to_string(),
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
        .read_node("alpha", "owner", "/Wiki/a.md")
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
            .read_node("alpha", "owner", "/Wiki/a.md")
            .expect_err("archiving DB should reject reads")
            .contains("database is archiving")
    );
    assert!(
        service
            .write_node(
                "owner",
                WriteNodeRequest {
                    database_id: "alpha".to_string(),
                    path: "/Wiki/b.md".to_string(),
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
                    path: "/Wiki/a.md".to_string(),
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
                    path: "/Wiki/a.md".to_string(),
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
        ("archived".to_string(), None, archive.size_bytes, None)
    );
    assert!(
        service
            .read_node("alpha", "owner", "/Wiki/a.md")
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
            .read_node("alpha", "owner", "/Wiki/a.md")
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
        .read_node("alpha", "owner", "/Wiki/a.md")
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
fn restored_mount_id_is_not_reused_after_rearchive() {
    let (service, root) = service_with_root();
    service
        .create_database("alpha", "owner", 1)
        .expect("alpha should create");
    service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Wiki/a.md".to_string(),
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
        ("alpha".to_string(), "restore".to_string())
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/b.md".to_string(),
                kind: NodeKind::File,
                content: "beta body".to_string(),
                metadata_json: "{}".to_string(),
                expected_etag: None,
            },
            4,
        )
        .expect("write should succeed after cancel");
    let node = service
        .read_node("alpha", "owner", "/Wiki/b.md")
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
        .read_node("alpha", "owner", "/Wiki/a.md")
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
        .read_node("alpha", "owner", "/Wiki/a.md")
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
                path: "/Wiki/a.md".to_string(),
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
        ("archived".to_string(), None, archive.size_bytes, None)
    );
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
    assert!(!restoring_file.exists());
    assert_eq!(
        mount_history_row(&root, restore.meta.mount_id),
        ("alpha".to_string(), "restore".to_string())
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
                path: "/Wiki/a.md".to_string(),
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
                path: "/Wiki/a.md".to_string(),
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
        ("archived".to_string(), None, archive.size_bytes, None)
    );
    assert_eq!(database_restore_chunk_count(&root, "alpha"), 0);
    assert_eq!(database_restore_session_count(&root, "alpha"), 0);
    assert_eq!(
        mount_history_row(&root, failed_mount_id),
        ("alpha".to_string(), "restore".to_string())
    );

    let retry = service
        .begin_database_restore_session("alpha", "owner", snapshot_hash, archive.size_bytes, 7)
        .expect("restore should retry");
    assert_ne!(retry.meta.mount_id, failed_mount_id);
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
            .read_node("shared", "reader", "/Wiki/missing.md")
            .expect("reader read should be authorized")
            .is_none()
    );
    assert!(
        service
            .write_node(
                "reader",
                WriteNodeRequest {
                    database_id: "shared".to_string(),
                    path: "/Wiki/nope.md".to_string(),
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
                path: "/Wiki/ok.md".to_string(),
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
            .read_node("shared", "reader", "/Wiki/missing.md")
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
                path: "/Sources/raw/bad.md".to_string(),
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
                path: "/Sources/raw/bad/bad.md".to_string(),
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

    ensure_parent_folders(&service, "owner", "alpha", "/Sources/raw/good/good.md", 3);
    let source = service
        .write_node(
            "owner",
            WriteNodeRequest {
                database_id: "alpha".to_string(),
                path: "/Sources/raw/good/good.md".to_string(),
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
                path: "/Sources/raw/good/good.md".to_string(),
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
                path: "/Wiki/new.md".to_string(),
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
