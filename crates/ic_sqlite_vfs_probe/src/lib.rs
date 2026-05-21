// Where: crates/ic_sqlite_vfs_probe/src/lib.rs
// What: Minimal compile/runtime probe for ic-sqlite-vfs DbHandle usage.
// Why: Validate MemoryManager-backed SQLite images before touching VFS storage.
use ic_sqlite_vfs::db::migrate::Migration;
use ic_sqlite_vfs::{DbError, DbHandle, DbMemory, params};

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: "CREATE TABLE probe_kv (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    );",
}];

pub fn init_probe(memory: DbMemory) -> Result<DbHandle, DbError> {
    let handle = DbHandle::init(memory)?;
    handle.migrate(MIGRATIONS)?;
    Ok(handle)
}

pub fn put(handle: DbHandle, key: &str, value: &str) -> Result<(), DbError> {
    handle.update(|connection| {
        connection.execute(
            "INSERT INTO probe_kv(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
    })
}

pub fn get(handle: DbHandle, key: &str) -> Result<Option<String>, DbError> {
    handle.query(|connection| {
        connection.query_optional_scalar::<String>(
            "SELECT value FROM probe_kv WHERE key = ?1",
            params![key],
        )
    })
}

#[cfg(target_arch = "wasm32")]
mod canister;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use ic_stable_structures::DefaultMemoryImpl;
    use ic_stable_structures::memory_manager::{MemoryId, MemoryManager};
    use proptest::prelude::*;
    use proptest::test_runner::{Config as ProptestConfig, FileFailurePersistence};

    fn get_from_update(handle: DbHandle, key: &str) -> Result<Option<String>, DbError> {
        handle.update(|connection| {
            connection.query_optional_scalar::<String>(
                "SELECT value FROM probe_kv WHERE key = ?1",
                params![key],
            )
        })
    }

    #[test]
    fn db_handles_are_isolated_by_memory_id() {
        let manager = MemoryManager::init(DefaultMemoryImpl::default());
        let first = init_probe(manager.get(MemoryId::new(120))).expect("first handle initializes");
        let second =
            init_probe(manager.get(MemoryId::new(121))).expect("second handle initializes");

        put(first, "shared-key", "first-value").expect("first write succeeds");
        put(second, "shared-key", "second-value").expect("second write succeeds");

        assert_eq!(
            get_from_update(first, "shared-key").expect("first read succeeds"),
            Some("first-value".to_string())
        );
        assert_eq!(
            get_from_update(second, "shared-key").expect("second read succeeds"),
            Some("second-value".to_string())
        );
    }

    #[derive(Clone, Debug)]
    enum Operation {
        Put {
            slot: u8,
            key: String,
            value: String,
        },
        FailedPut {
            slot: u8,
            key: String,
            value: String,
        },
        Reinitialize,
    }

    fn operation_strategy() -> impl Strategy<Value = Operation> {
        let slot = 0_u8..=1;
        let text = prop::collection::vec(any::<char>(), 0..32)
            .prop_map(|chars| chars.into_iter().collect::<String>());

        prop_oneof![
            7 => (slot.clone(), text.clone(), text.clone()).prop_map(|(slot, key, value)| {
                Operation::Put { slot, key, value }
            }),
            2 => (slot, text.clone(), text).prop_map(|(slot, key, value)| {
                Operation::FailedPut { slot, key, value }
            }),
            1 => Just(Operation::Reinitialize),
        ]
    }

    fn property_config() -> ProptestConfig {
        ProptestConfig {
            cases: 128,
            failure_persistence: Some(Box::new(FileFailurePersistence::Off)),
            ..ProptestConfig::default()
        }
    }

    fn init_handles(manager: &MemoryManager<DefaultMemoryImpl>) -> (DbHandle, DbHandle) {
        let first = init_probe(manager.get(MemoryId::new(120))).expect("first handle initializes");
        let second =
            init_probe(manager.get(MemoryId::new(121))).expect("second handle initializes");
        (first, second)
    }

    fn handle_for_slot(slot: u8, first: DbHandle, second: DbHandle) -> DbHandle {
        match slot {
            0 => first,
            1 => second,
            _ => unreachable!("strategy only generates known slots"),
        }
    }

    fn put_then_fail(handle: DbHandle, key: &str, value: &str) -> Result<(), DbError> {
        handle.update(|connection| {
            connection.execute(
                "INSERT INTO probe_kv(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            connection.execute(
                "INSERT INTO missing_table(value) VALUES (?1)",
                params![1_i64],
            )?;
            Ok(())
        })
    }

    fn assert_slot_matches_model(
        first: DbHandle,
        second: DbHandle,
        model: &BTreeMap<(u8, String), String>,
    ) {
        for ((slot, key), expected) in model {
            let handle = handle_for_slot(*slot, first, second);
            let actual = get_from_update(handle, key).expect("model key reads after operation");
            assert_eq!(actual.as_deref(), Some(expected.as_str()));
        }
    }

    proptest! {
        #![proptest_config(property_config())]

        #[test]
        fn random_operation_sequences_match_a_map_model(
            operations in prop::collection::vec(operation_strategy(), 1..80),
        ) {
            let manager = MemoryManager::init(DefaultMemoryImpl::default());
            let (mut first, mut second) = init_handles(&manager);
            let mut model = BTreeMap::<(u8, String), String>::new();

            for operation in operations {
                match operation {
                    Operation::Put { slot, key, value } => {
                        let handle = handle_for_slot(slot, first, second);
                        put(handle, &key, &value).expect("generated put succeeds");
                        model.insert((slot, key.clone()), value.clone());
                        let actual = get_from_update(handle, &key).expect("written key reads");
                        prop_assert_eq!(actual, Some(value));
                    }
                    Operation::FailedPut { slot, key, value } => {
                        let handle = handle_for_slot(slot, first, second);
                        let before = model.get(&(slot, key.clone())).cloned();
                        prop_assert!(put_then_fail(handle, &key, &value).is_err());
                        let actual = get_from_update(handle, &key).expect("rolled back key reads");
                        prop_assert_eq!(actual, before);
                    }
                    Operation::Reinitialize => {
                        (first, second) = init_handles(&manager);
                        assert_slot_matches_model(first, second, &model);
                    }
                }
            }

            (first, second) = init_handles(&manager);
            assert_slot_matches_model(first, second, &model);
        }
    }
}
