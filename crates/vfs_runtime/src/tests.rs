use tempfile::tempdir;

use super::*;
use crate::billing::{
    StorageChargeInput, compute_storage_charge_cycles, load_active_databases_for_storage_billing,
    load_storage_cycle_account, settle_database_storage_charge_in_tx,
};
use crate::sessions::{is_canister_accepted_source_capture_request_path, parse_frontmatter_fields};

#[test]
fn canister_accepted_source_capture_paths_match_shared_contract_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/source-capture-contract.json"
    ))
    .expect("source capture contract fixture should parse");
    for entry in fixture["canisterAcceptedRequestPaths"]
        .as_array()
        .expect("canisterAcceptedRequestPaths should be an array")
    {
        let path = entry["value"]
            .as_str()
            .expect("path value should be a string");
        let expected = entry["valid"].as_bool().expect("valid should be a boolean");
        assert_eq!(
            is_canister_accepted_source_capture_request_path(path),
            expected,
            "{path}"
        );
    }
}

#[test]
fn source_capture_frontmatter_requires_whole_line_terminator() {
    let fields = parse_frontmatter_fields(
        "---\nkind: \"kinic.source_capture_request\"\nstatus: queued\nnote: ---not-a-terminator\nrequested_by: alice\n---\n# Body\n",
    )
    .expect("frontmatter should parse at the real terminator");

    assert_eq!(
        fields.get("kind").and_then(|value| value.as_deref()),
        Some("kinic.source_capture_request")
    );
    assert_eq!(
        fields
            .get("requested_by")
            .and_then(|value| value.as_deref()),
        Some("alice")
    );
}

#[test]
fn source_capture_frontmatter_unescapes_json_quoted_scalars() {
    let fields = parse_frontmatter_fields(
        "---\nkind: kinic.source_capture_request\nrequested_by: \"principal-\\\"1\\\"-\\uD83D\\uDE00\"\n---\n# Body\n",
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
fn source_capture_frontmatter_rejects_invalid_json_quoted_scalars() {
    let error = parse_frontmatter_fields(
        "---\nkind: kinic.source_capture_request\nrequested_by: \"principal-\\q\"\n---\n# Body\n",
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
        top_up: default_cycles_top_up_config(),
    }
}

fn index_versions(index_path: &std::path::Path) -> Vec<String> {
    let conn = Connection::open(index_path).expect("index DB should reopen");
    conn.prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .expect("version query should prepare")
        .query_map(params![], |row| row.get(0))
        .expect("version query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("versions should collect")
}

#[test]
fn index_migrations_create_current_schema_once() {
    let dir = tempdir().expect("tempdir should create");
    let index_path = dir.path().join("index.sqlite3");
    let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
    let config = test_cycles_billing_config();

    service
        .run_index_migrations_with_config(config.clone())
        .expect("fresh index schema should create");
    service
        .run_index_migrations()
        .expect("current index schema should validate");

    assert_eq!(
        index_versions(&index_path),
        vec![
            INDEX_SCHEMA_VERSION_INITIAL.to_string(),
            INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS.to_string(),
            INDEX_SCHEMA_VERSION_CURRENT.to_string()
        ]
    );
    assert_eq!(
        service.cycles_billing_config().expect("config should load"),
        config
    );
}

#[test]
fn index_migrations_apply_node_publications_once() {
    let dir = tempdir().expect("tempdir should create");
    let index_path = dir.path().join("index.sqlite3");
    let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
    service
        .run_index_migrations()
        .expect("fresh index schema should create");
    let conn = Connection::open(&index_path).expect("index DB should reopen");
    conn.execute("DROP TABLE publication_mutation_recovery_items", params![])
        .expect("recovery items table should drop");
    conn.execute(
        "DROP TABLE publication_mutation_recovery_batches",
        params![],
    )
    .expect("recovery batches table should drop");
    conn.execute("DROP TABLE node_publications", params![])
        .expect("new table should drop");
    conn.execute(
        "DELETE FROM schema_migrations WHERE version IN (?1, ?2)",
        params![
            INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS,
            INDEX_SCHEMA_VERSION_CURRENT
        ],
    )
    .expect("new migration marker should delete");
    drop(conn);

    service
        .run_index_migrations()
        .expect("pending migration should apply");
    service
        .run_index_migrations()
        .expect("applied migration should remain idempotent");

    assert_eq!(
        index_versions(&index_path),
        vec![
            INDEX_SCHEMA_VERSION_INITIAL.to_string(),
            INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS.to_string(),
            INDEX_SCHEMA_VERSION_CURRENT.to_string()
        ]
    );
}

#[test]
fn index_migrations_apply_publication_recovery_from_002_once() {
    let dir = tempdir().expect("tempdir should create");
    let index_path = dir.path().join("index.sqlite3");
    let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
    service
        .run_index_migrations()
        .expect("fresh index schema should create");
    let conn = Connection::open(&index_path).expect("index DB should reopen");
    conn.execute("DROP TABLE publication_mutation_recovery_items", params![])
        .expect("recovery items table should drop");
    conn.execute(
        "DROP TABLE publication_mutation_recovery_batches",
        params![],
    )
    .expect("recovery batches table should drop");
    conn.execute(
        "DELETE FROM schema_migrations WHERE version = ?1",
        params![INDEX_SCHEMA_VERSION_CURRENT],
    )
    .expect("recovery migration marker should delete");
    drop(conn);

    service
        .run_index_migrations()
        .expect("002 to 003 migration should apply");
    service
        .run_index_migrations()
        .expect("003 migration should apply only once");

    assert_eq!(
        index_versions(&index_path),
        vec![
            INDEX_SCHEMA_VERSION_INITIAL.to_string(),
            INDEX_SCHEMA_VERSION_NODE_PUBLICATIONS.to_string(),
            INDEX_SCHEMA_VERSION_CURRENT.to_string()
        ]
    );
}

#[test]
fn current_upgrade_migrations_accept_no_config() {
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
        .expect("current schema upgrade should not need config");

    assert_eq!(
        service.cycles_billing_config().expect("config should load"),
        config
    );
}

#[test]
fn old_index_schema_marker_is_rejected_for_upgrade() {
    let dir = tempdir().expect("tempdir should create");
    let index_path = dir.path().join("index.sqlite3");
    let conn = Connection::open(&index_path).expect("index DB should open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at INTEGER NOT NULL
         );
         INSERT INTO schema_migrations (version, applied_at)
         VALUES ('database_index:000_initial', 0);",
    )
    .expect("old marker should insert");
    drop(conn);
    let service = VfsService::new(index_path, dir.path().join("databases"));

    let error = service
        .run_index_migrations_for_upgrade(Some(test_cycles_billing_config()))
        .expect_err("old schema marker should reject");

    assert!(error.contains("unsupported index schema version"));
    assert!(error.contains("database_index:000_initial"));
}

#[test]
fn current_index_schema_missing_required_table_is_rejected() {
    let dir = tempdir().expect("tempdir should create");
    let index_path = dir.path().join("index.sqlite3");
    let service = VfsService::new(index_path.clone(), dir.path().join("databases"));
    service
        .run_index_migrations()
        .expect("fresh index schema should create");
    let conn = Connection::open(&index_path).expect("index DB should reopen");
    conn.execute("DROP TABLE market_orders", params![])
        .expect("required table should drop");
    drop(conn);

    let error = service
        .run_index_migrations()
        .expect_err("missing current table should reject");

    assert!(error.contains("missing table market_orders"));
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

    assert!(error.contains("exactly one non-null valid JSON object TEXT column"));
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
        ("deleted", "deleted", None),
    ] {
        service
            .write_index(|tx| {
                tx.execute(
                    "INSERT INTO databases
                     (database_id, name, description, llm_summary, tags_json, db_file_name,
                      mount_id, active_mount_id, status, schema_version, logical_size_bytes,
                      created_at_ms, updated_at_ms)
                     VALUES (?1, ?1, '', NULL, '[]', 'workspace', COALESCE(?3, 0), ?3, ?2,
                             ?4, 0, 0, 0)",
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
        ("deleted", "deleted", 101_i64),
    ] {
        service
            .write_index(|tx| {
                tx.execute(
                    "INSERT INTO databases
                     (database_id, name, description, llm_summary, tags_json, db_file_name,
                      mount_id, active_mount_id, status, schema_version, logical_size_bytes,
                      created_at_ms, updated_at_ms)
                     VALUES (?1, ?1, '', NULL, '[]', 'workspace', ?3, ?3, ?2, ?4, 0, 0, 0)",
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
    let expected = compute_storage_charge_cycles(cached_size as u64, STORAGE_BILLING_INTERVAL_MS)
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
        .settle_database_storage_charges_timer_batch("canister", STORAGE_BILLING_INTERVAL_MS * 10)
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

fn storage_test_account_and_ledger(service: &VfsService) -> (i64, Option<i64>, Vec<String>, i64) {
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
                path: "/Knowledge/storage.md".to_string(),
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
                 (database_id, name, description, llm_summary, tags_json, db_file_name,
                  mount_id, active_mount_id, status, schema_version, logical_size_bytes,
                  created_at_ms, updated_at_ms)
                 VALUES (?1, ?1, '', NULL, '[]', 'workspace', ?2, ?2, 'active', ?3, ?4, 0, 0)",
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
