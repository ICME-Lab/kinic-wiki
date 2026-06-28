// Where: crates/vfs_runtime/tests/database_service_pbt_ext.rs
// What: Supplemental property tests for cycles suspension and mount history.
// Why: The main PBT covers common flows; these tests target branch-risky edge state.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};
use rusqlite::{Connection, params};
use tempfile::{TempDir, tempdir};
use vfs_runtime::{DEFAULT_MIN_UPDATE_CYCLES, VfsService, cycles_for_payment_amount_e8s};
use vfs_types::{DatabaseStatus, DeleteDatabaseRequest};

const OWNER: &str = "owner";
const DEPOSIT_PAYMENT_E8S: u64 = 1_000;

#[derive(Clone, Debug)]
enum CyclesOp {
    PurchaseDatabaseCycles { amount: u64 },
    Charge { cycles_delta: u128 },
}

#[derive(Clone, Debug)]
enum MountOp {
    Create { slot: usize },
    Delete { slot: usize },
}

struct TestService {
    service: VfsService,
    root: PathBuf,
    _dir: TempDir,
}

fn property_config() -> ProptestConfig {
    ProptestConfig {
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(128),
        failure_persistence: Some(Box::new(FileFailurePersistence::Off)),
        ..ProptestConfig::default()
    }
}

fn service_with_root() -> TestService {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.path().to_path_buf();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    TestService {
        service,
        root,
        _dir: dir,
    }
}

fn create_billed_database(service: &VfsService, name: &str, now: i64) -> (String, u64) {
    let database_id = service
        .create_generated_database(name, OWNER, now + 1)
        .expect("database should create")
        .database_id;
    let deposit_cycles = purchase_database_cycles(
        service,
        &database_id,
        OWNER,
        DEPOSIT_PAYMENT_E8S,
        now as u64,
        now + 2,
    )
    .expect("database seed should cycle");
    (database_id, deposit_cycles)
}

fn delete_request(database_id: &str) -> DeleteDatabaseRequest {
    DeleteDatabaseRequest {
        database_id: database_id.to_string(),
    }
}

fn purchase_database_cycles(
    service: &VfsService,
    database_id: &str,
    caller: &str,
    payment_amount_e8s: u64,
    block_index: u64,
    now: i64,
) -> Result<u64, String> {
    let operation_id =
        service.begin_database_cycles_purchase(database_id, caller, payment_amount_e8s, now)?;
    let config = service.cycles_billing_config()?;
    let cycles = cycles_for_payment_amount_e8s(payment_amount_e8s, &config)?;
    service.complete_database_cycles_purchase_ledger_transfer(
        operation_id,
        database_id,
        caller,
        cycles,
        block_index,
    )?;
    service.apply_database_cycles_purchase(
        operation_id,
        database_id,
        caller,
        cycles,
        block_index,
        now,
    )?;
    Ok(cycles)
}

fn db_account(root: &Path, database_id: &str) -> (u64, Option<i64>) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT balance_cycles, suspended_at_ms
         FROM database_cycle_accounts
         WHERE database_id = ?1",
        params![database_id],
        |row| {
            let balance: i64 = row.get(0)?;
            let suspended_at_ms: Option<i64> = row.get(1)?;
            Ok((balance.max(0) as u64, suspended_at_ms))
        },
    )
    .expect("cycle account should exist")
}

fn status_and_mount(service: &VfsService, database_id: &str) -> (DatabaseStatus, Option<u16>) {
    let info = service
        .list_database_infos()
        .expect("database infos should load")
        .into_iter()
        .find(|info| info.database_id == database_id)
        .expect("database info should exist");
    (info.status, info.mount_id)
}

fn charge_amount(cycles_delta: u128) -> u64 {
    u64::try_from(cycles_delta).expect("generated charge fits u64")
}

fn assert_database_ledger_chain(root: &Path, database_id: &str, expected_balance: u64) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let mut stmt = conn
        .prepare(
            "SELECT kind, amount_cycles, balance_after_cycles, method, cycles_delta
             FROM database_cycle_ledger
             WHERE database_id = ?1
             ORDER BY entry_id ASC",
        )
        .expect("database ledger query should prepare");
    let rows = stmt
        .query_map(params![database_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .expect("database ledger query should run")
        .collect::<Result<Vec<_>, _>>()
        .expect("database ledger rows should collect");
    let mut balance = 0_i64;
    for (kind, amount, balance_after, method, cycles_delta) in rows {
        balance += amount;
        assert_eq!(balance_after, balance, "database ledger chain broke");
        match kind.as_str() {
            "cycles_purchase" => assert!(amount > 0),
            "charge" => assert!(amount <= 0),
            "delete_cycle_discard" => assert!(amount <= 0),
            "suspend" => {
                assert_eq!(amount, 0);
                assert!(method.is_some());
                assert!(cycles_delta.is_some());
            }
            other => panic!("unexpected database ledger kind: {other}"),
        }
    }
    assert_eq!(balance.max(0) as u64, expected_balance);
}

fn mount_history(root: &Path) -> Vec<(String, u16, String)> {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let mut stmt = conn
        .prepare(
            "SELECT database_id, mount_id, reason
             FROM database_mount_history
             ORDER BY mount_id ASC",
        )
        .expect("mount history query should prepare");
    stmt.query_map(params![], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)? as u16,
            row.get::<_, String>(2)?,
        ))
    })
    .expect("mount history query should run")
    .collect::<Result<Vec<_>, _>>()
    .expect("mount history rows should collect")
}

fn assert_mount_history_unique(root: &Path, expected_len: usize) {
    let rows = mount_history(root);
    let ids = rows
        .iter()
        .map(|(_, mount_id, _)| *mount_id)
        .collect::<BTreeSet<_>>();
    assert_eq!(rows.len(), expected_len);
    assert_eq!(ids.len(), rows.len());
}

fn cycles_operation_strategy() -> impl Strategy<Value = CyclesOp> {
    prop_oneof![
        4 => (1_u64..=2_000_000).prop_map(|amount| CyclesOp::PurchaseDatabaseCycles { amount }),
        5 => (0_u128..=8_000_000_000_u128).prop_map(|cycles_delta| CyclesOp::Charge { cycles_delta }),
    ]
}

fn mount_operation_strategy() -> impl Strategy<Value = MountOp> {
    prop_oneof![
        5 => (0_usize..4).prop_map(|slot| MountOp::Create { slot }),
        3 => (0_usize..4).prop_map(|slot| MountOp::Delete { slot }),
    ]
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn database_service_pbt_cycles_suspension_and_ledger_chain(
        operations in prop::collection::vec(cycles_operation_strategy(), 1..50),
    ) {
        let env = service_with_root();
        let service = &env.service;
        let (database_id, deposit_cycles) = create_billed_database(service, "cycles-pbt", 1);
        let mut database_balance = deposit_cycles;

        for (index, operation) in operations.into_iter().enumerate() {
            let now = index as i64 + 100;
            match operation {
                CyclesOp::PurchaseDatabaseCycles { amount } => {
                    let purchased_cycles =
                        purchase_database_cycles(service, &database_id, OWNER, amount, now as u64, now)
                            .expect("cycle purchase should succeed");
                    database_balance += purchased_cycles;
                }
                CyclesOp::Charge { cycles_delta } => {
                    let before = database_balance;
                    let config = service
                        .cycles_billing_config()
                        .expect("cycles config should load");
                    let computed = charge_amount(cycles_delta);
                    service
                        .charge_database_update(
                            &config,
                            &database_id,
                            OWNER,
                            "pbt_charge",
                            cycles_delta,
                            now,
                        )
                        .expect("charge should record");
                    database_balance -= computed.min(before);
                }
            }

            let (stored_balance, suspended_at_ms) = db_account(&env.root, &database_id);
            assert_eq!(stored_balance, database_balance);
            assert_eq!(suspended_at_ms.is_some(), database_balance < DEFAULT_MIN_UPDATE_CYCLES);
            assert_eq!(
                service.require_database_write_cycles_available(&database_id).is_ok(),
                database_balance >= DEFAULT_MIN_UPDATE_CYCLES
            );
            assert_database_ledger_chain(&env.root, &database_id, database_balance);
        }
    }

    #[test]
    fn database_service_pbt_create_delete_mount_ids_are_unique(
        operations in prop::collection::vec(mount_operation_strategy(), 1..30),
    ) {
        let env = service_with_root();
        let service = &env.service;
        let mut slots = vec![None::<String>; 4];
        let mut expected_mount_events = 0_usize;

        for (index, operation) in operations.into_iter().enumerate() {
            let now = index as i64 * 10 + 10;
            match operation {
                MountOp::Create { slot } if slots[slot].is_none() => {
                    let id = service
                        .create_generated_database(&format!("mount-pbt-{slot}-{index}"), OWNER, now)
                        .expect("slot database should create")
                        .database_id;
                    slots[slot] = Some(id);
                    expected_mount_events += 1;
                }
                MountOp::Delete { slot } => {
                    if let Some(database_id) = slots[slot].take()
                        && status_and_mount(service, &database_id).0 == DatabaseStatus::Active
                    {
                        service
                            .delete_database(delete_request(&database_id), OWNER, now)
                            .expect("active slot database should delete");
                    }
                }
                _ => {}
            }
            assert_mount_history_unique(&env.root, expected_mount_events);
        }

        let history_mount_ids = mount_history(&env.root)
            .into_iter()
            .map(|(_, mount_id, _)| mount_id)
            .collect::<BTreeSet<_>>();
        for database_id in slots.into_iter().flatten() {
            let (_, active_mount_id) = status_and_mount(service, &database_id);
            if let Some(active_mount_id) = active_mount_id {
                assert!(history_mount_ids.contains(&active_mount_id));
            }
        }
    }
}
