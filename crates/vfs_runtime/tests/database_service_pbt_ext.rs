// Where: crates/vfs_runtime/tests/database_service_pbt_ext.rs
// What: Supplemental property tests for credits suspension, mount history, and restore chunks.
// Why: The main PBT covers common flows; these tests target branch-risky edge state.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use tempfile::{TempDir, tempdir};
use vfs_runtime::{DEFAULT_CYCLES_PER_CREDIT, DEFAULT_MIN_UPDATE_CREDITS, VfsService};
use vfs_types::{DatabaseStatus, DeleteDatabaseRequest, NodeKind, WriteNodeRequest};

const OWNER: &str = "owner";
const DEPOSIT_CREDITS: u64 = 1_000;

#[derive(Clone, Debug)]
enum CreditsOp {
    PurchaseDatabaseCredits { amount: u64 },
    Charge { cycles_delta: u128 },
}

#[derive(Clone, Debug)]
enum MountOp {
    Create { slot: usize },
    Delete { slot: usize },
    ArchiveRestore { slot: usize },
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

fn create_billed_database(service: &VfsService, name: &str, now: i64) -> String {
    let database_id = service
        .create_generated_database(name, OWNER, now + 1)
        .expect("database should create")
        .database_id;
    credit_database(
        service,
        &database_id,
        OWNER,
        DEPOSIT_CREDITS,
        now as u64,
        now + 2,
    )
    .expect("database seed should credit");
    database_id
}

fn delete_request(database_id: &str) -> DeleteDatabaseRequest {
    DeleteDatabaseRequest {
        database_id: database_id.to_string(),
    }
}

fn credit_database(
    service: &VfsService,
    database_id: &str,
    caller: &str,
    credits: u64,
    block_index: u64,
    now: i64,
) -> Result<u64, String> {
    let operation_id = service.begin_database_credit_purchase(database_id, caller, credits, now)?;
    service.credit_database_purchase(operation_id, database_id, caller, credits, block_index, now)
}

fn db_account(root: &Path, database_id: &str) -> (u64, Option<i64>) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    conn.query_row(
        "SELECT balance_credits, suspended_at_ms
         FROM database_credit_accounts
         WHERE database_id = ?1",
        params![database_id],
        |row| {
            let balance: i64 = row.get(0)?;
            let suspended_at_ms: Option<i64> = row.get(1)?;
            Ok((balance.max(0) as u64, suspended_at_ms))
        },
    )
    .expect("credit account should exist")
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
    let variable = cycles_delta.div_ceil(u128::from(DEFAULT_CYCLES_PER_CREDIT));
    u64::try_from(variable).expect("generated charge fits u64")
}

fn assert_database_ledger_chain(root: &Path, database_id: &str, expected_balance: u64) {
    let conn = Connection::open(root.join("index.sqlite3")).expect("index should open");
    let mut stmt = conn
        .prepare(
            "SELECT kind, amount_credits, balance_after_credits, method, cycles_delta
             FROM database_credit_ledger
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
            "credit_purchase" => assert!(amount > 0),
            "charge" => assert!(amount <= 0),
            "delete_credit_discard" => assert!(amount <= 0),
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

fn read_archive(service: &VfsService, database_id: &str, now: i64) -> (Vec<u8>, Vec<u8>, u64) {
    let archive = service
        .begin_database_archive(database_id, OWNER, now)
        .expect("archive should begin");
    let bytes = service
        .read_database_archive_chunk(database_id, OWNER, 0, archive.size_bytes as u32)
        .expect("archive bytes should read");
    let hash = Sha256::digest(&bytes).to_vec();
    (bytes, hash, archive.size_bytes)
}

fn finalize_restore_from_bytes(
    service: &VfsService,
    database_id: &str,
    bytes: &[u8],
    hash: Vec<u8>,
    size: u64,
    split: usize,
    now: i64,
) {
    service
        .begin_database_restore(database_id, OWNER, hash, size, now)
        .expect("restore should begin");
    assert!(
        service
            .write_database_restore_chunk(database_id, OWNER, size, &[1])
            .is_err(),
        "out-of-range restore chunk must fail"
    );
    assert!(
        service
            .finalize_database_restore(database_id, OWNER, now + 1)
            .is_err(),
        "empty restore must fail"
    );
    let split = split.min(bytes.len());
    service
        .write_database_restore_chunk(database_id, OWNER, split as u64, &bytes[split..])
        .expect("tail chunk should write");
    if split > 0 {
        assert!(
            service
                .finalize_database_restore(database_id, OWNER, now + 2)
                .is_err(),
            "gapped restore must fail"
        );
    }
    service
        .write_database_restore_chunk(database_id, OWNER, split as u64, &bytes[split..])
        .expect("duplicate tail chunk should replace");
    service
        .write_database_restore_chunk(database_id, OWNER, 0, &bytes[..split])
        .expect("head chunk should write");
    service
        .finalize_database_restore(database_id, OWNER, now + 3)
        .expect("complete restore should finalize");
}

fn credits_operation_strategy() -> impl Strategy<Value = CreditsOp> {
    prop_oneof![
        4 => (1_u64..=2_000_000).prop_map(|amount| CreditsOp::PurchaseDatabaseCredits { amount }),
        5 => (0_u128..=8_000_000_000_u128).prop_map(|cycles_delta| CreditsOp::Charge { cycles_delta }),
    ]
}

fn mount_operation_strategy() -> impl Strategy<Value = MountOp> {
    prop_oneof![
        5 => (0_usize..4).prop_map(|slot| MountOp::Create { slot }),
        3 => (0_usize..4).prop_map(|slot| MountOp::Delete { slot }),
        4 => (0_usize..4).prop_map(|slot| MountOp::ArchiveRestore { slot }),
    ]
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn database_service_pbt_credits_suspension_and_ledger_chain(
        operations in prop::collection::vec(credits_operation_strategy(), 1..50),
    ) {
        let env = service_with_root();
        let service = &env.service;
        let database_id = create_billed_database(service, "credits-pbt", 1);
        let mut database_balance = DEPOSIT_CREDITS;

        for (index, operation) in operations.into_iter().enumerate() {
            let now = index as i64 + 100;
            match operation {
                CreditsOp::PurchaseDatabaseCredits { amount } => {
                    credit_database(service, &database_id, OWNER, amount, now as u64, now)
                        .expect("credit purchase should succeed");
                    database_balance += amount;
                }
                CreditsOp::Charge { cycles_delta } => {
                    let before = database_balance;
                    service
                        .charge_database_update(&database_id, OWNER, "pbt_charge", cycles_delta, Some(now as u64), now)
                        .expect("charge should record");
                    let computed = charge_amount(cycles_delta);
                    database_balance = database_balance.saturating_sub(computed);
                    let entries = service
                        .list_database_credit_entries(&database_id, OWNER, None, 100)
                        .expect("database credits entries should load")
                        .entries;
                    if computed > before {
                        assert_eq!(entries[entries.len() - 2].kind, "charge");
                        assert_eq!(entries[entries.len() - 1].kind, "suspend");
                    }
                }
            }

            let (stored_balance, suspended_at_ms) = db_account(&env.root, &database_id);
            assert_eq!(stored_balance, database_balance);
            assert_eq!(suspended_at_ms.is_some(), database_balance < DEFAULT_MIN_UPDATE_CREDITS);
            assert_eq!(
                service.require_database_write_credits_available(&database_id).is_ok(),
                database_balance >= DEFAULT_MIN_UPDATE_CREDITS
            );
            assert_database_ledger_chain(&env.root, &database_id, database_balance);
        }
    }

    #[test]
    fn database_service_pbt_restore_chunks_cancel_and_content(
        split_bias in 0_usize..4,
        restore_deleted in any::<bool>(),
        cancel_first in any::<bool>(),
    ) {
        let env = service_with_root();
        let service = &env.service;
        let database_id = create_billed_database(service, "restore-pbt", 1);
        let content = format!("restore body split={split_bias} deleted={restore_deleted} cancel={cancel_first}");
        service
            .write_node(
                OWNER,
                WriteNodeRequest {
                    database_id: database_id.clone(),
                    path: "/Wiki/restore-pbt.md".to_string(),
                    kind: NodeKind::File,
                    content: content.clone(),
                    metadata_json: "{}".to_string(),
                    expected_etag: None,
                },
                10,
            )
            .expect("node should write before archive");

        let (bytes, hash, size) = read_archive(service, &database_id, 20);
        assert!(
            service
                .finalize_database_archive(&database_id, OWNER, vec![9_u8; 32], 21)
                .is_err(),
            "wrong archive hash must fail"
        );

        if restore_deleted {
            service
                .cancel_database_archive(&database_id, OWNER, 22)
                .expect("archive should cancel");
            service
                .delete_database(delete_request(&database_id), OWNER, 23)
                .expect("active database should delete");
            assert!(
                service
                    .list_database_infos()
                    .expect("database infos should load")
                    .iter()
                    .all(|info| info.database_id != database_id)
            );
            return Ok(());
        } else {
            service
                .finalize_database_archive(&database_id, OWNER, hash.clone(), 22)
                .expect("archive should finalize");
            assert_eq!(status_and_mount(service, &database_id).0, DatabaseStatus::Archived);
        }

        let bad_hash = vec![8_u8; 32];
        if bad_hash != hash {
            service
                .begin_database_restore(&database_id, OWNER, bad_hash, size, 30)
                .expect("restore with wrong expected hash can begin");
            service
                .write_database_restore_chunk(&database_id, OWNER, 0, &bytes)
                .expect("restore bytes should write");
            assert!(
                service
                    .finalize_database_restore(&database_id, OWNER, 31)
                    .is_err(),
                "wrong expected hash must fail finalize"
            );
            service
                .cancel_database_restore(&database_id, OWNER, 32)
                .expect("failed hash restore should cancel");
        }

        if cancel_first {
            service
                .begin_database_restore(&database_id, OWNER, hash.clone(), size, 40)
                .expect("restore should begin");
            let split = (bytes.len() / 2).max(1).min(bytes.len());
            service
                .write_database_restore_chunk(&database_id, OWNER, 0, &bytes[..split])
                .expect("partial chunk should write");
            service
                .cancel_database_restore(&database_id, OWNER, 41)
                .expect("partial restore should cancel");
            assert!(matches!(
                status_and_mount(service, &database_id).0,
                DatabaseStatus::Archived
            ));
        }

        let split = match split_bias {
            0 => 0,
            1 => bytes.len() / 3,
            2 => bytes.len() / 2,
            _ => bytes.len().saturating_sub(1),
        };
        finalize_restore_from_bytes(service, &database_id, &bytes, hash, size, split, 50);
        assert_eq!(status_and_mount(service, &database_id).0, DatabaseStatus::Active);
        let restored = service
            .read_node(&database_id, OWNER, "/Wiki/restore-pbt.md")
            .expect("restored node should read")
            .expect("restored node should exist");
        assert_eq!(restored.content, content);
    }

    #[test]
    fn database_service_pbt_mount_history_never_reuses_ids(
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
                MountOp::ArchiveRestore { slot } => {
                    if let Some(database_id) = slots[slot].as_ref()
                        && status_and_mount(service, database_id).0 == DatabaseStatus::Active
                    {
                        let (bytes, hash, size) = read_archive(service, database_id, now);
                        service
                            .finalize_database_archive(database_id, OWNER, hash.clone(), now + 1)
                            .expect("archive should finalize");
                        finalize_restore_from_bytes(service, database_id, &bytes, hash, size, bytes.len() / 2, now + 2);
                        expected_mount_events += 1;
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
