// Where: crates/vfs_runtime/tests/database_service_pbt.rs
// What: Property tests for database cycles operation sequences.
// Why: Randomized state-machine checks catch partial updates across balances and mounts.
use proptest::prelude::*;
use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};
use tempfile::{TempDir, tempdir};
use vfs_runtime::{VfsService, cycles_for_payment_amount_e8s};
use vfs_types::DatabaseStatus;

const OWNER: &str = "owner";
const INITIAL_DATABASE_PAYMENT_E8S: u64 = 1_000;

#[derive(Clone, Debug)]
enum RuntimeOp {
    PurchaseDatabaseCycles { amount: u64 },
    Charge { cycles_delta: u128 },
}

#[derive(Debug)]
struct Model {
    database_cycles: u64,
    status: DatabaseStatus,
}

struct TestService {
    service: VfsService,
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

fn operation_strategy() -> impl Strategy<Value = RuntimeOp> {
    prop_oneof![
        4 => (1_u64..=250_000).prop_map(|amount| RuntimeOp::PurchaseDatabaseCycles { amount }),
        4 => (0_u128..=20_000_u128).prop_map(|cycles_delta| RuntimeOp::Charge { cycles_delta }),
    ]
}

fn service_with_root() -> TestService {
    let dir = tempdir().expect("tempdir should create");
    let root = dir.path().to_path_buf();
    let service = VfsService::new(root.join("index.sqlite3"), root.join("databases"));
    service
        .run_index_migrations()
        .expect("index migrations should run");
    let _ = root;
    TestService { service, _dir: dir }
}

fn create_seeded_database(service: &VfsService) -> (String, u64) {
    let meta = service
        .create_generated_database("PBT database", OWNER, 2)
        .expect("database should create");
    let initial_cycles = purchase_database_cycles(
        service,
        &meta.database_id,
        OWNER,
        INITIAL_DATABASE_PAYMENT_E8S,
        1,
        3,
    )
    .expect("database seed should cycle");
    (meta.database_id, initial_cycles)
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

fn assert_invariants(service: &VfsService, database_id: &str, model: &Model) {
    let database_entries = service
        .list_database_cycle_entries(database_id, OWNER, None, 100)
        .expect("database ledger should load")
        .entries;
    let database_after = database_entries
        .last()
        .expect("database ledger should not be empty")
        .balance_after_cycles;
    assert_eq!(database_after, model.database_cycles);

    let (status, mount_id) = status_and_mount(service, database_id);
    assert_eq!(status, model.status);
    assert!(mount_id.is_some());

    let infos = service.list_database_infos().expect("infos should load");
    let mut mount_ids = infos
        .iter()
        .filter_map(|info| info.mount_id)
        .collect::<Vec<_>>();
    mount_ids.sort_unstable();
    mount_ids.dedup();
    assert_eq!(
        mount_ids.len(),
        infos.iter().filter(|info| info.mount_id.is_some()).count()
    );
}

fn apply_operation(
    service: &VfsService,
    database_id: &str,
    model: &mut Model,
    operation: RuntimeOp,
    step: i64,
) {
    match operation {
        RuntimeOp::PurchaseDatabaseCycles { amount } => {
            let result = purchase_database_cycles(
                service,
                database_id,
                OWNER,
                amount,
                step as u64 + 10,
                step,
            );
            if model.status == DatabaseStatus::Active {
                model.database_cycles += result.expect("database cycle purchase should succeed");
            } else {
                assert!(result.is_err());
            }
        }
        RuntimeOp::Charge { cycles_delta } => {
            let config = service
                .cycles_billing_config()
                .expect("cycles config should load");
            let result = service.charge_database_update(
                &config,
                database_id,
                OWNER,
                "pbt_write",
                cycles_delta,
                step,
            );
            result.expect("database charge should record against cycle account");
            let charge = model.database_cycles.min(charge_amount(cycles_delta));
            model.database_cycles -= charge;
        }
    }
}

proptest! {
    #![proptest_config(property_config())]

    #[test]
    fn database_service_pbt(operations in prop::collection::vec(operation_strategy(), 1..40)) {
        let env = service_with_root();
        let service = &env.service;
        let (database_id, initial_cycles) = create_seeded_database(service);
        let mut model = Model {
            database_cycles: initial_cycles,
            status: DatabaseStatus::Active,
        };

        assert_invariants(service, &database_id, &model);
        for (index, operation) in operations.into_iter().enumerate() {
            apply_operation(
                service,
                &database_id,
                &mut model,
                operation,
                index as i64 + 100,
            );
            assert_invariants(service, &database_id, &model);
        }
    }
}
