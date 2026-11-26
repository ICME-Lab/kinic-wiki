use super::*;
use kinic_sqlite_compat::Connection;

const COMMON: &str = include_str!("schema_contracts/common.sql");
const V8: &str = include_str!("schema_contracts/accounts_v8.sql");
const V9: &str = include_str!("schema_contracts/accounts_v9.sql");
const TEAM: &str = include_str!("schema_contracts/team_v11.sql");
const GRANT: &str = include_str!("schema_contracts/grant_v10.sql");
const SUBSIDY: &str = include_str!("schema_contracts/subsidy_v11.sql");

fn predecessor(version: i64, extra: &[&str]) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(if version == 8 { V8 } else { V9 })
        .unwrap();
    db.execute_batch(COMMON).unwrap();
    for script in extra {
        db.execute_batch(script).unwrap();
    }
    db.pragma_update(None, "user_version", version).unwrap();
    db
}

fn version(db: &Connection) -> i64 {
    db.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn integration_all_frozen_predecessors_migrate_and_reopen_at_fifteen() {
    for (v, extra) in [
        (8, &[][..]),
        (9, &[]),
        (10, &[]),
        (11, &[TEAM]),
        (10, &[GRANT]),
        (11, &[GRANT, SUBSIDY]),
        (12, &[GRANT, SUBSIDY]),
        (13, &[TEAM, GRANT, SUBSIDY]),
    ] {
        let db = predecessor(v, extra);
        db.execute_batch("INSERT INTO accounts(owner,balance_cycles,storage_charged_at_ms) VALUES('before',123,99)").unwrap();
        if extra.contains(&GRANT) {
            db.execute_batch(
                "INSERT INTO initial_cycle_grants VALUES('before','vault',50000000000,22)",
            )
            .unwrap();
        }
        if extra.contains(&SUBSIDY) {
            db.execute_batch("INSERT INTO key_subsidies VALUES('before',2,'derive:3',100,97)")
                .unwrap();
        }
        schema::initialize_vault_schema(&db).unwrap();
        assert_eq!(version(&db), 15, "predecessor {v}");
        assert_eq!(
            db.query_row(
                "SELECT balance_cycles FROM accounts WHERE owner='before'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            123
        );
        assert_eq!(
            kinic_cycle_grants::recorded(&db, kinic_cycle_grants::Scope::Vault, "before").unwrap(),
            Some(if extra.contains(&GRANT) {
                50_000_000_000
            } else {
                0
            })
        );
        assert!(!key_subsidy::available_in(&db, "before").unwrap());
        if extra.contains(&SUBSIDY) {
            assert_eq!(db.query_row("SELECT actual FROM key_subsidies WHERE owner='before' AND token='derive:3' AND state=2 AND attached=100",[],|r|r.get::<_,i64>(0)).unwrap(),97);
        }
        let changes = db.total_changes();
        schema::initialize_vault_schema(&db).unwrap();
        assert_eq!(db.total_changes(), changes);
    }
}

#[test]
fn integration_schema_thirteen_reserves_space_only_for_unsettled_payments() {
    let db = predecessor(13, &[TEAM, GRANT, SUBSIDY]);
    for (operation, status) in [(1u8, "InFlight"), (2, "Unknown"), (3, "Quoted")] {
        let record = serde_json::json!({"status": status, "request": {"beneficiary": "pending"}, "credits": 100*operation as u64});
        db.execute(
            "INSERT INTO payments VALUES('wallet',?1,?2,?3)",
            kinic_sqlite_compat::params![&[operation; 16][..], record.to_string(), i64::MAX],
        )
        .unwrap();
    }
    let bridge = serde_json::json!({"bridge_v1":{"Credit":{"status":"Prepared","offer":{"vault_owner":"pending","amount_cycles":150}}}});
    db.execute(
        "INSERT INTO payments VALUES('pending',zeroblob(16),?1,9223372036854775807)",
        [bridge.to_string()],
    )
    .unwrap();
    let accepted = serde_json::json!({"bridge_v1":{"Credit":{"status":"Accepted","day":4,"offer":{"vault_owner":"pending","amount_cycles":40}}}});
    db.execute(
        "INSERT INTO payments VALUES('pending',?1,?2,9223372036854775807)",
        kinic_sqlite_compat::params![vec![9u8; 16], accepted.to_string()],
    )
    .unwrap();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(
        crate::payment_holds::beneficiary(&db, "pending", None).unwrap(),
        450
    );
    assert_eq!(crate::payment_holds::bridge_day(&db, 4).unwrap(), 190);
    let stored: String = db.query_row(
        "SELECT group_concat(hex(operation)) FROM
         (SELECT operation FROM payment_completion_reservations WHERE length(spare)=1048576 ORDER BY operation)",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(
        stored,
        "01010101010101010101010101010101,02020202020202020202020202020202"
    );
    assert_eq!(version(&db), 15);
    schema::initialize_vault_schema(&db).unwrap();
}

#[test]
fn integration_schema_fourteen_with_full_global_settings_migrates_and_admits_cycles_refill_source()
{
    use kinic_sqlite_compat::params;
    let db = Connection::open_in_memory().unwrap();
    schema::legacy_v14_for_test(&db);
    let legacy_keys = [
        "config",
        "funding",
        "generation",
        "quote_fee_serial",
        "gc-owner",
        "serial",
        "bridge",
    ];
    for key in legacy_keys {
        db.execute(
            "INSERT INTO global_settings(key,value) VALUES(?1,?2)",
            params![key, format!("val:{key}")],
        )
        .unwrap();
    }
    assert!(
        db.execute(
            "INSERT INTO global_settings(key,value) VALUES('cycles_refill_source','6emaw-iyaaa-aaaay-aacka-cai')",
            params![],
        )
        .is_err(),
        "schema 14 rejects the eighth global setting slot"
    );

    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(version(&db), 15);
    for key in legacy_keys {
        let value: String = db
            .query_row(
                "SELECT value FROM global_settings WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(value, format!("val:{key}"));
    }
    db.execute(
        "INSERT INTO global_settings(key,value) VALUES('cycles_refill_source','6emaw-iyaaa-aaaay-aacka-cai')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![],
    )
    .unwrap();
    assert!(
        db.execute(
            "INSERT INTO global_settings(key,value) VALUES('ninth','x')",
            params![],
        )
        .is_err(),
        "schema 15 still bounds global_settings at eight slots"
    );
    let changes = db.total_changes();
    schema::initialize_vault_schema(&db).unwrap();
    assert_eq!(db.total_changes(), changes);
}

#[test]
fn integration_damaged_schema_fourteen_is_rejected_atomically() {
    for damage in [
        "DROP TRIGGER accounting_global_settings_count",
        "ALTER TABLE global_settings ADD COLUMN extra TEXT",
    ] {
        let db = Connection::open_in_memory().unwrap();
        schema::legacy_v14_for_test(&db);
        db.execute(
            "INSERT INTO global_settings(key,value) VALUES('config','kept')",
            [],
        )
        .unwrap();
        db.execute_batch(damage).unwrap();
        assert_eq!(
            schema::initialize_vault_schema(&db),
            Err(Error::Storage),
            "damaged schema 14: {damage}"
        );
        assert_eq!(version(&db), 14);
        assert_eq!(
            db.query_row(
                "SELECT value FROM global_settings WHERE key='config'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "kept"
        );
    }
}

#[test]
fn integration_team_provenance_and_journal_survive_schema_fifteen() {
    use kinic_sqlite_compat::params;
    use vault_store::{OwnerContext, operations, sharing};
    let db = predecessor(11, &[TEAM]);
    let owner = Principal::from_slice(&[1]);
    let member = Principal::from_slice(&[31]);
    let vault = (1u128).to_be_bytes().to_vec();
    let header = serde_json::json!({"id":vault,"nonce":vec![2;32],"state":"Active","sequence":0,
        "key_name":"k","public_key":vec![3;96]});
    let pending = vec![4; 16];
    let terminal = vec![5; 16];
    let upload = sharing::scoped_id(b"upload", member, &vault, &pending).unwrap();
    let finished = sharing::scoped_id(b"upload", member, &vault, &terminal).unwrap();
    let request = serde_json::json!({"vault":vault,"object":vec![6;16],"operation":upload,"expected_revision":0,
        "plain_size":1,"manifest":vec![7;64],"chunk_hashes":[vec![8;32]]});
    let outcome = serde_json::json!({"origin":{"caller":member,"wire":terminal},"outcome":{"Cancelled":{"vault":vault,"job":vec![9;16]}}});
    db.execute(
        "INSERT INTO vaults(owner,id,operation,header) VALUES(?1,?2,zeroblob(16),?3)",
        params![owner.as_slice(), vault, header.to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO vault_members VALUES(?1,?2,?3,1)",
        params![owner.as_slice(), vault, member.as_slice()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO shared_upload_handles VALUES(?1,?2,?3,?4,?5)",
        params![owner.as_slice(), vault, upload, member.as_slice(), pending],
    )
    .unwrap();
    db.execute(
        "INSERT INTO uploads VALUES(?1,?2,?3,?4,0,99,zeroblob(32),?5,111,2,1,NULL)",
        params![
            owner.as_slice(),
            upload,
            vault,
            vec![6u8; 16],
            request.to_string()
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO upload_outcomes VALUES(?1,?2,zeroblob(32),?3,99)",
        params![owner.as_slice(), finished, outcome.to_string()],
    )
    .unwrap();
    let operation = sharing::scoped_id(b"operation", member, &vault, &[44; 16]).unwrap();
    let digest = [17u8; 32];
    db.execute(
        "INSERT INTO operations VALUES(?1,?2,?3,?4,99,3,4,0)",
        params![
            owner.as_slice(),
            operation,
            digest.as_slice(),
            candid::encode_one(MutationResult::Done).unwrap()
        ],
    )
    .unwrap();

    schema::initialize_vault_schema(&db).unwrap();
    let access = sharing::access(&db, member, &vault).unwrap();
    assert_eq!(access.owner, owner);
    assert_eq!(access.role, AccessRole::Editor);
    assert_eq!(access.header.name, None);
    OwnerContext::authenticated(owner)
        .unwrap()
        .run(&db, |db| {
            let status = sharing::upload_status(db, member, &vault, &pending, 1)?;
            assert!(matches!(status,UploadStatus::Pending(p) if p.request.operation==pending));
            assert!(matches!(
                sharing::upload_status(db, member, &vault, &terminal, 1)?,
                UploadStatus::Cancelled
            ));
            assert!(matches!(
                operations::replay(db, &operation, &digest, 1)?,
                Some(MutationResult::Done)
            ));
            Ok(())
        })
        .unwrap();
}

#[test]
fn integration_unknown_ddl_and_failed_unique_index_leave_predecessor_intact() {
    let db = predecessor(10, &[GRANT]);
    db.execute_batch("INSERT INTO vaults(owner,id,operation,header) VALUES(X'01',zeroblob(16),zeroblob(16),'{}'),(X'02',zeroblob(16),zeroblob(16),'{}');").unwrap();
    assert_eq!(schema::initialize_vault_schema(&db), Err(Error::Storage));
    assert_eq!(version(&db), 10);
    assert_eq!(db.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('key_subsidies','vault_members','vault_global_id')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        db.query_row("SELECT count(*) FROM vaults", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );

    let db = predecessor(11, &[TEAM, GRANT]);
    assert_eq!(schema::initialize_vault_schema(&db), Err(Error::Storage));
    assert_eq!(version(&db), 11);
}

#[test]
fn integration_predecessor_contract_distinguishes_sql_tokens() {
    let db = predecessor(10, &[GRANT]);
    db.execute_batch("DROP TABLE initial_cycle_grants").unwrap();
    // INTEGERNOT is a valid declared type with different nullability.
    db.execute_batch(&GRANT.replace(
        "grant_cycles INTEGER NOT NULL",
        "grant_cycles INTEGERNOT NULL",
    ))
    .unwrap();
    assert_eq!(schema::initialize_vault_schema(&db), Err(Error::Storage));
    assert_eq!(version(&db), 10);
}
