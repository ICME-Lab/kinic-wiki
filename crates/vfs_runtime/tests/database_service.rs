// Where: crates/vfs_runtime/tests/database_service.rs
// What: Multi-database service tests over local SQLite files.
// Why: The canister mount layer depends on runtime index and role semantics being deterministic.
use std::path::PathBuf;

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use vfs_runtime::{
    MAX_ARCHIVE_CHUNK_BYTES, MAX_DATABASE_SIZE_BYTES, MAX_RESTORE_CHUNK_BYTES,
    USAGE_EVENTS_RETENTION_LIMIT, UsageEvent, VfsService,
};
use vfs_types::{
    AppendNodeRequest, BillingConfig, BillingConfigUpdate, DatabaseRole, DatabaseStatus,
    DeleteNodeRequest, NodeKind, SearchNodesRequest, SearchPreviewMode, WriteNodeRequest,
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

fn billing_config() -> BillingConfig {
    BillingConfig {
        kinic_ledger_canister_id: "2vxsx-fae".to_string(),
        sns_governance_id: "2vxsx-fae".to_string(),
        rate_numerator_e8s: 200,
        rate_denominator_cycles: 1_000_000,
        fixed_update_fee_e8s: 100,
        min_update_balance_e8s: 10_000,
        min_initial_deposit_e8s: 1_000_000,
    }
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

fn database_updated_at_ms(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT updated_at_ms FROM databases WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("database updated_at_ms should load")
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

fn assert_generated_database_id(database_id: &str) {
    assert!(database_id.starts_with("db_"));
    assert_eq!(database_id.len(), 15);
    assert!(database_id.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_')
    }));
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

fn database_restore_chunk_count(root: &std::path::Path, database_id: &str) -> i64 {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT COUNT(*) FROM database_restore_chunks WHERE database_id = ?1",
        params![database_id],
        |row| row.get(0),
    )
    .expect("restore chunk count should load")
}

type UsageEventTuple = (
    String,
    Option<String>,
    String,
    i64,
    i64,
    Option<String>,
    i64,
);

fn usage_event_rows(root: &std::path::Path) -> Vec<UsageEventTuple> {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.prepare(
        "SELECT method, database_id, caller, success, cycles_delta, error, created_at_ms
         FROM usage_events
         ORDER BY event_id ASC",
    )
    .expect("usage query should prepare")
    .query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
        ))
    })
    .expect("usage query should run")
    .collect::<Result<Vec<_>, _>>()
    .expect("usage rows should collect")
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
fn index_migrations_create_billing_schema_once() {
    let (service, root) = service_with_root();

    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    for table_name in [
        "usage_events",
        "database_mount_history",
        "principal_billing_accounts",
        "database_billing_accounts",
        "billing_config",
    ] {
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table_name],
                |row| row.get(0),
            )
            .expect("table lookup should work");
        assert_eq!(table_exists, 1);
    }
    assert_eq!(
        schema_migration_count(&root, "database_index:100_billing_initial"),
        1
    );

    service
        .run_index_migrations()
        .expect("index migrations should be idempotent");
    assert_eq!(
        schema_migration_count(&root, "database_index:100_billing_initial"),
        1
    );
}

#[test]
fn old_index_schema_requires_fresh_index() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let index_path = root.join("index.sqlite3");
    let conn = Connection::open(&index_path).expect("index should open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );
         INSERT INTO schema_migrations (version, applied_at)
         VALUES ('database_index:005_mount_history', 1);",
    )
    .expect("old migration marker should insert");
    drop(conn);

    let service = VfsService::new(index_path, root.join("databases"));
    let error = service
        .run_index_migrations()
        .expect_err("old index should be rejected");
    assert!(error.contains("fresh index required"));
}

#[test]
fn display_name_validation_and_owner_only_rename() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .grant_database_access("alpha", "owner", "reader", DatabaseRole::Reader, 2)
        .expect("reader grant should succeed");

    let reader_error = service
        .rename_database("alpha", "Reader Name", "reader", 3)
        .expect_err("reader cannot rename");
    assert!(reader_error.contains("lacks required database role"));

    let name_error = service
        .rename_database("alpha", "\n", "owner", 4)
        .expect_err("blank display name should fail");
    assert!(name_error.contains("display_name"));

    service
        .rename_database("alpha", " Alpha Wiki ", "owner", 5)
        .expect("owner rename should succeed");
    let summaries = service
        .list_database_summaries_for_caller("owner")
        .expect("summaries should load");
    assert_eq!(summaries[0].display_name, "Alpha Wiki");
}

#[test]
fn billing_balance_moves_between_principal_and_database() {
    let service = service();
    service
        .credit_principal_top_up("owner", 2_000_000, 1, 1)
        .expect("owner top-up should credit");
    let meta = service
        .create_generated_database_with_initial_deposit("Team Wiki", "owner", 1_000_000, 2)
        .expect("database should reserve with initial deposit");
    service
        .credit_principal_top_up("donor", 500_000, 2, 3)
        .expect("donor top-up should credit");
    service
        .top_up_database(&meta.database_id, "donor", 250_000, 4)
        .expect("non-member can top up database");
    service
        .withdraw_database_balance(&meta.database_id, "owner", 300_000, 5)
        .expect("owner can withdraw database balance internally");

    let owner = service
        .principal_billing_summary("owner")
        .expect("owner billing should load");
    let donor = service
        .principal_billing_summary("donor")
        .expect("donor billing should load");
    let summary = service
        .list_database_summaries_for_caller("owner")
        .expect("database summary should load")
        .into_iter()
        .find(|summary| summary.database_id == meta.database_id)
        .expect("database should be listed");
    assert_eq!(owner.balance_e8s, 1_300_000);
    assert_eq!(donor.balance_e8s, 250_000);
    assert_eq!(summary.billing_balance_e8s, 950_000);
    assert!(summary.billing_suspended_at_ms.is_none());

    let principal_entries = service
        .list_principal_billing_entries("owner", None, 100)
        .expect("principal ledger should load");
    assert!(
        principal_entries
            .entries
            .iter()
            .any(|entry| entry.kind == "database_withdraw")
    );
    let database_entries = service
        .list_database_billing_entries(&meta.database_id, "owner", None, 100)
        .expect("database ledger should load");
    assert!(
        database_entries
            .entries
            .iter()
            .any(|entry| entry.kind == "top_up_from_principal")
    );
}

#[test]
fn billing_ledger_pagination_does_not_skip_boundary_entries() {
    let service = service();
    service
        .credit_principal_top_up("owner", 3_000_000, 1, 1)
        .expect("owner top-up should credit");
    let meta = service
        .create_generated_database_with_initial_deposit("Team Wiki", "owner", 1_000_000, 2)
        .expect("database should reserve with initial deposit");
    service
        .top_up_database(&meta.database_id, "owner", 100_000, 3)
        .expect("owner can top up database");
    service
        .withdraw_database_balance(&meta.database_id, "owner", 50_000, 4)
        .expect("owner can withdraw database balance internally");

    let all_principal_entry_ids: Vec<u64> = service
        .list_principal_billing_entries("owner", None, 100)
        .expect("principal ledger should load")
        .entries
        .into_iter()
        .map(|entry| entry.entry_id)
        .collect();
    assert!(all_principal_entry_ids.len() >= 3);

    let first_principal_page = service
        .list_principal_billing_entries("owner", None, 2)
        .expect("first principal page should load");
    let second_principal_page = service
        .list_principal_billing_entries("owner", first_principal_page.next_cursor, 2)
        .expect("second principal page should load");
    let paged_principal_entry_ids: Vec<u64> = first_principal_page
        .entries
        .into_iter()
        .chain(second_principal_page.entries)
        .map(|entry| entry.entry_id)
        .collect();
    assert_eq!(paged_principal_entry_ids, all_principal_entry_ids);

    let all_database_entry_ids: Vec<u64> = service
        .list_database_billing_entries(&meta.database_id, "owner", None, 100)
        .expect("database ledger should load")
        .entries
        .into_iter()
        .map(|entry| entry.entry_id)
        .collect();
    assert!(all_database_entry_ids.len() >= 3);

    let first_database_page = service
        .list_database_billing_entries(&meta.database_id, "owner", None, 2)
        .expect("first database page should load");
    let second_database_page = service
        .list_database_billing_entries(
            &meta.database_id,
            "owner",
            first_database_page.next_cursor,
            2,
        )
        .expect("second database page should load");
    let paged_database_entry_ids: Vec<u64> = first_database_page
        .entries
        .into_iter()
        .chain(second_database_page.entries)
        .map(|entry| entry.entry_id)
        .collect();
    assert_eq!(paged_database_entry_ids, all_database_entry_ids);
}

#[test]
fn deleted_database_rejects_top_up_but_allows_owner_withdraw() {
    let service = service();
    service
        .credit_principal_top_up("owner", 2_000_000, 1, 1)
        .expect("owner top-up should credit");
    let meta = service
        .create_generated_database_with_initial_deposit("Team Wiki", "owner", 1_000_000, 2)
        .expect("database should reserve");
    service
        .delete_database(&meta.database_id, "owner", 3)
        .expect("delete should succeed");

    let top_up_error = service
        .top_up_database(&meta.database_id, "owner", 100_000, 4)
        .expect_err("deleted database should reject top-up");
    assert!(top_up_error.contains("deleted"));

    service
        .withdraw_database_balance(&meta.database_id, "owner", 400_000, 5)
        .expect("deleted database should still allow owner withdraw");
    let owner = service
        .principal_billing_summary("owner")
        .expect("owner billing should load");
    assert_eq!(owner.balance_e8s, 1_400_000);
}

#[test]
fn failed_database_create_reversal_restores_principal_and_records_db_ledger() {
    let (service, root) = service_with_root();
    service
        .credit_principal_top_up("owner", 1_000_000, 1, 1)
        .expect("owner top-up should credit");
    let meta = service
        .create_generated_database_with_initial_deposit("Team Wiki", "owner", 1_000_000, 2)
        .expect("database should reserve");
    service
        .reverse_failed_database_create(&meta.database_id, "owner", 1_000_000, 3)
        .expect("failed create should reverse");

    let owner = service
        .principal_billing_summary("owner")
        .expect("owner billing should load");
    assert_eq!(owner.balance_e8s, 1_000_000);

    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let reversal_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM database_billing_ledger
             WHERE database_id = ?1 AND kind = 'create_database_reversal'",
            params![meta.database_id],
            |row| row.get(0),
        )
        .expect("database reversal ledger count should load");
    assert_eq!(reversal_count, 1);
}

#[test]
fn metered_charge_consumes_remaining_balance_and_suspends() {
    let service = service();
    service
        .create_database("alpha", "owner", 1)
        .expect("database should create");
    service
        .require_database_billable("alpha")
        .expect("fresh test database should be billable");

    service
        .charge_database_update("alpha", "owner", "write_node", 10_000_000_000, Some(7), 2)
        .expect("charge should succeed");
    let summary = service
        .list_database_summaries_for_caller("owner")
        .expect("summary should load")
        .remove(0);
    assert_eq!(summary.billing_balance_e8s, 0);
    assert!(summary.billing_suspended_at_ms.is_some());
    let error = service
        .require_database_billable("alpha")
        .expect_err("suspended database should reject metered updates");
    assert!(error.contains("suspended"));
}

#[test]
fn billing_config_validation_rejects_invalid_init_and_updates() {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.keep();
    let invalid_service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    let invalid = BillingConfig {
        kinic_ledger_canister_id: "not a principal".to_string(),
        ..billing_config()
    };
    let error = invalid_service
        .run_index_migrations_with_config(invalid)
        .expect_err("invalid principal should be rejected");
    assert!(error.contains("principal text is invalid"));

    let service = service();
    let update = BillingConfigUpdate {
        rate_numerator_e8s: 200,
        rate_denominator_cycles: 0,
        fixed_update_fee_e8s: 100,
        min_update_balance_e8s: 10_000,
        min_initial_deposit_e8s: 1_000_000,
    };
    let error = service
        .validate_billing_config_update(&update)
        .expect_err("zero denominator should fail");
    assert!(error.contains("rate_denominator_cycles"));

    let update = BillingConfigUpdate {
        rate_denominator_cycles: 1_000_000,
        min_update_balance_e8s: 10_000,
        min_initial_deposit_e8s: 9_999,
        ..update
    };
    let error = service
        .validate_billing_config_update(&update)
        .expect_err("initial deposit below update minimum should fail");
    assert!(error.contains("min_initial_deposit_e8s"));
}

#[test]
fn generated_database_create_returns_hash_id_and_owner_member() {
    let (service, root) = service_with_root();

    let meta = service
        .create_generated_database("owner", 1)
        .expect("generated database should create");

    assert_generated_database_id(&meta.database_id);
    assert_eq!(meta.mount_id, 11);
    assert_eq!(database_member_count(&root, &meta.database_id), 1);
    let row = database_index_row(&root, &meta.database_id);
    assert_eq!(row.0, "hot");
    assert_eq!(row.1, Some(11));
    assert!(row.2 > 0);
    assert_eq!(row.3, None);
}

#[test]
fn generated_database_create_avoids_same_input_collision_by_mount_id() {
    let service = service();

    let first = service
        .create_generated_database("owner", 1)
        .expect("first generated database should create");
    let second = service
        .create_generated_database("owner", 1)
        .expect("second generated database should create");

    assert_generated_database_id(&first.database_id);
    assert_generated_database_id(&second.database_id);
    assert_ne!(first.database_id, second.database_id);
    assert_eq!(first.mount_id, 11);
    assert_eq!(second.mount_id, 12);
}

#[test]
fn records_minimal_usage_events() {
    let (service, root) = service_with_root();

    service
        .record_usage_event(UsageEvent {
            method: "write_node",
            database_id: Some("alpha"),
            caller: "owner",
            success: true,
            cycles_delta: 12,
            error: None,
            now: 10,
        })
        .expect("success event should record");
    service
        .record_usage_event(UsageEvent {
            method: "create_database",
            database_id: None,
            caller: "owner",
            success: false,
            cycles_delta: 34,
            error: Some("database already exists"),
            now: 11,
        })
        .expect("failure event should record");

    let rows = usage_event_rows(&root);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows[0],
        (
            "write_node".to_string(),
            Some("alpha".to_string()),
            "owner".to_string(),
            1,
            12,
            None,
            10
        )
    );
    assert_eq!(
        rows[1],
        (
            "create_database".to_string(),
            None,
            "owner".to_string(),
            0,
            34,
            Some("database already exists".to_string()),
            11
        )
    );
}

#[test]
fn usage_events_keep_recent_retention_window() {
    let (service, root) = service_with_root();
    let mut conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let tx = conn.transaction().expect("transaction should start");

    for index in 0..USAGE_EVENTS_RETENTION_LIMIT + 98 {
        tx.execute(
            "INSERT INTO usage_events
             (method, database_id, caller, success, cycles_delta, error, created_at_ms)
             VALUES ('write_node', 'alpha', 'owner', 1, 1, NULL, ?1)",
            params![i64::try_from(index).expect("index should fit")],
        )
        .expect("usage event should insert");
    }
    tx.commit().expect("transaction should commit");

    service
        .record_usage_event(UsageEvent {
            method: "write_node",
            database_id: Some("alpha"),
            caller: "owner",
            success: true,
            cycles_delta: 1,
            error: None,
            now: i64::try_from(USAGE_EVENTS_RETENTION_LIMIT + 98).expect("index should fit"),
        })
        .expect("usage event should record");
    assert_eq!(
        service
            .usage_event_count()
            .expect("usage count should load"),
        USAGE_EVENTS_RETENTION_LIMIT + 99
    );

    service
        .record_usage_event(UsageEvent {
            method: "write_node",
            database_id: Some("alpha"),
            caller: "owner",
            success: true,
            cycles_delta: 1,
            error: None,
            now: i64::try_from(USAGE_EVENTS_RETENTION_LIMIT + 99).expect("index should fit"),
        })
        .expect("usage event should record");

    assert_eq!(
        service
            .usage_event_count()
            .expect("usage count should load"),
        USAGE_EVENTS_RETENTION_LIMIT
    );
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
    assert_eq!(owner_a_summaries[0].status, DatabaseStatus::Hot);

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
        .reserve_database("retryable", "owner", 1)
        .expect("reservation should create");
    assert_eq!(database_member_count(&root, "retryable"), 1);

    service
        .discard_database_reservation("retryable")
        .expect("reservation should discard");
    assert_eq!(database_member_count(&root, "retryable"), 0);

    let meta = service
        .create_database("retryable", "owner", 2)
        .expect("same database_id should create after discard");
    assert_eq!(meta.database_id, "retryable");
    assert_eq!(database_member_count(&root, "retryable"), 1);
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
            "INSERT INTO databases
             (database_id, display_name, db_file_name, mount_id, active_mount_id, status, schema_version,
              logical_size_bytes, created_at_ms, updated_at_ms)
             VALUES (?1, ?1, ?2, ?3, ?3, 'hot', 'vfs_store:current', 0, 1, 1)",
            params![
                format!("reserved_{mount_id}"),
                format!("reserved_{mount_id}.sqlite3"),
                i64::from(mount_id)
            ],
        )
        .expect("reserved mount_id should insert");
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
    assert_eq!(alpha_info.status, DatabaseStatus::Hot);
    assert!(alpha_info.logical_size_bytes > 0);

    service
        .delete_database("alpha", "owner", 3)
        .expect("delete should succeed");
    assert_restore_size(&root, "alpha", None);
    assert!(
        service
            .read_node("alpha", "owner", "/Wiki/a.md")
            .expect_err("deleted DB should reject reads")
            .contains("database is deleted")
    );

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
        .delete_database("missing_file", "owner", 2)
        .expect("missing file should not block delete");
    assert_eq!(database_index_row(&root, "missing_file").0, "deleted");

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
        .delete_database("remove_error", "owner", 4)
        .expect_err("non-NotFound remove error should fail");
    assert!(!error.is_empty());
    assert_eq!(database_index_row(&root, "remove_error").0, "hot");
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
            .expect_err("hot DB should reject archive chunk reads")
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
    service
        .finalize_database_restore("alpha", "owner", 5)
        .expect("restore should finalize");

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
    assert_eq!(info.status, DatabaseStatus::Hot);
    assert_eq!(info.snapshot_hash, Some(snapshot_hash));
    assert_eq!(info.archived_at_ms, None);
    assert_eq!(info.deleted_at_ms, None);
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
fn cancel_database_archive_returns_archiving_database_to_hot() {
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
    assert_eq!(after.0, "hot");
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
    assert_eq!(after.0, "hot");
    assert_eq!(after.1, before.1);
}

#[test]
fn cancel_database_archive_rejects_invalid_statuses_and_non_owner() {
    let service = service();
    service
        .create_database("hot_db", "owner", 1)
        .expect("hot_db should create");
    assert!(
        service
            .cancel_database_archive("hot_db", "owner", 2)
            .expect_err("hot cancel should fail")
            .contains("database is hot")
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
        .delete_database("deleted_db", "owner", 13)
        .expect("delete should succeed");
    assert!(
        service
            .cancel_database_archive("deleted_db", "owner", 14)
            .expect_err("deleted cancel should fail")
            .contains("database is deleted")
    );
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
    let node = service
        .read_node("alpha", "owner", "/Wiki/a.md")
        .expect("restored read should succeed")
        .expect("restored node should exist");
    assert_eq!(node.content, "alpha body");
}

#[test]
fn archive_and_restore_reject_snapshot_hash_mismatch() {
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
    assert_eq!(database_index_row(&_root, "alpha").0, "archiving");

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
    service
        .finalize_database_restore("alpha", "owner", 5)
        .expect("out-of-order restore should finalize");

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
    assert_eq!(members.len(), 3);

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
