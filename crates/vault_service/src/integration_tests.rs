use super::*;
use candid::Principal;
use std::cell::{Cell, RefCell};
struct TestEnvironment {
    db: RefCell<Connection>,
    owner: Cell<Principal>,
    time: Cell<u64>,
    cancel_random: Cell<bool>,
    cancel_public: Cell<bool>,
    settled: Cell<Option<u64>>,
    change_config: Cell<bool>,
    public_names: RefCell<Vec<String>>,
    actual_payment: Cell<Option<u64>>,
    checkpoints: Cell<u64>,
}
impl TestEnvironment {
    fn new() -> Self {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&[store::SCHEMA, store::CONTENT_SCHEMA, store::RESTORE_SCHEMA].concat())
            .unwrap();
        let config = VaultConfig {
            origin: "http://localhost:5173".into(),
            rp_id: "localhost".into(),
            key_name: "test_key_1".into(),
            minimum_cycles: 100_000_000_000,
        };
        db.execute(
            "INSERT INTO global_settings VALUES('config',?1)",
            params![serde_json::to_string(&config).unwrap()],
        )
        .unwrap();
        Self {
            db: RefCell::new(db),
            owner: Cell::new(Principal::self_authenticating([1; 32])),
            time: Cell::new(1),
            cancel_random: Cell::new(false),
            cancel_public: Cell::new(false),
            settled: Cell::new(None),
            change_config: Cell::new(false),
            public_names: RefCell::new(vec![]),
            actual_payment: Cell::new(None),
            checkpoints: Cell::new(0),
        }
    }
    fn reserve(&self) {
        reserve_vault(
            self,
            Reserve {
                vault: vec![1; 16],
                operation: vec![2; 16],
            },
        )
        .unwrap();
    }
}
impl Environment for TestEnvironment {
    fn owner(&self) -> Principal {
        self.owner.get()
    }
    fn now(&self) -> u64 {
        self.time.get()
    }
    fn balance(&self) -> u128 {
        1_000_000_000_000
    }
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut db = self.db.borrow_mut();
        let tx = db.transaction().unwrap();
        let result = store::OwnerContext::authenticated(self.owner())?.run(&tx, f)?;
        tx.commit().unwrap();
        Ok(result)
    }
    fn require_spending(&self) -> Result<()> {
        let _read_guard = self.db.try_borrow().map_err(|_| Error::Storage)?;
        store::OwnerContext::authenticated(self.owner()).map(|_| ())
    }
    fn checkpoint_execution(&self) -> Result<()> {
        self.checkpoints.set(self.checkpoints.get() + 1);
        Ok(())
    }
    fn reserve_cycles(&self, _token: u64, _amount: u64) -> Result<()> {
        Ok(())
    }
    fn settle_cycles(&self, token: u64, actual: u64) -> Result<()> {
        self.settled.set(Some(actual));
        self.transaction(|db| store::keys::settle(db, token, self.now(), actual))
    }
    fn actual_derive_payment(&self, attached: u64) -> u64 {
        self.actual_payment.get().unwrap_or(attached)
    }
    fn required_derive_payment(&self, _key_name: &str) -> u64 {
        30_000_000_000
    }
    async fn random(&self) -> Result<Vec<u8>> {
        assert!(
            self.checkpoints.get() >= 1,
            "raw_rand must have a durable execution checkpoint"
        );
        if self.cancel_random.replace(false) {
            cancel_vault_setup(self, vec![1; 16], vec![2; 16])?;
        }
        Ok(vec![9; 32])
    }
    async fn public_key(&self, name: &str) -> Result<Vec<u8>> {
        assert!(
            self.checkpoints.get() >= 1,
            "public-key await must have a durable execution checkpoint"
        );
        self.public_names.borrow_mut().push(name.into());
        if self.change_config.replace(false) {
            self.db.borrow().execute("UPDATE global_settings SET value=json_set(value,'$.key_name','other_key') WHERE key='config'",params![]).unwrap();
        }
        if self.cancel_public.replace(false) {
            cancel_vault_setup(self, vec![1; 16], vec![2; 16])?;
        }
        Ok(vec![])
    }
    async fn derive_key(
        &self,
        _name: &str,
        _input: Vec<u8>,
        _transport: Vec<u8>,
    ) -> Result<Vec<u8>> {
        assert!(
            self.checkpoints.get() >= 2,
            "derive await must have an updated execution checkpoint"
        );
        Err(Error::KeyService)
    }
}
#[test]
fn same_vault_and_operation_ids_are_independent_for_authenticated_owners() {
    let env = TestEnvironment::new();
    env.reserve();
    assert_eq!(list_unfinished_vaults(&env).unwrap().len(), 1);
    let a = env.owner();
    env.owner.set(Principal::self_authenticating([2; 32]));
    assert!(list_unfinished_vaults(&env).unwrap().is_empty());
    env.reserve();
    cancel_vault_setup(&env, vec![1; 16], vec![2; 16]).unwrap();
    assert!(list_unfinished_vaults(&env).unwrap().is_empty());
    env.owner.set(a);
    assert_eq!(list_unfinished_vaults(&env).unwrap().len(), 1);
    env.owner.set(Principal::anonymous());
    assert!(list_unfinished_vaults(&env).is_err());
}
#[test]
fn cancelled_random_callback_cannot_recreate_owner_ceremony() {
    let env = TestEnvironment::new();
    env.reserve();
    env.cancel_random.set(true);
    let result = futures::executor::block_on(begin_unlock(
        &env,
        BeginUnlock {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            purpose: Purpose::Activate,
            transport: vec![0; 48],
            target: vec![],
        },
    ));
    assert_eq!(result.unwrap_err(), Error::Expired);
    assert!(
        env.transaction(|db| Ok(control(db)?.ceremony.is_none()))
            .unwrap()
    );
}
#[test]
fn cancelled_public_key_callback_refunds_and_settles_global_flight() {
    let env = TestEnvironment::new();
    env.reserve();
    env.cancel_public.set(true);
    let transport = ic_bls12_381::G1Affine::generator().to_compressed().to_vec();
    let result = futures::executor::block_on(derive_vault_key(
        &env,
        Derive {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            transport,
            assertion: None,
        },
    ));
    assert_eq!(result.unwrap_err(), Error::Expired);
    assert_eq!(env.settled.get(), Some(0));
    let pending: i64 = env
        .db
        .borrow()
        .query_row(
            "SELECT count(*) FROM key_flights WHERE settled IS NULL",
            params![],
            |r| kinic_sqlite_compat::row_get(r, 0),
        )
        .unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn imported_webauthn_verifies_real_signatures_exact_origin_uv_and_challenge() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/webauthn.json")).unwrap();
    let owner = Principal::self_authenticating([1; 32]);
    let config = Config {
        owner,
        origin: "http://localhost:5173".into(),
        rp_id: "localhost".into(),
        key_name: "test_key_1".into(),
        minimum_cycles: 100_000_000_000,
    };
    let mut ceremony = Ceremony {
        request: BeginUnlock {
            vault: vec![1; 16],
            attempt: None,
            epoch: 0,
            purpose: Purpose::Activate,
            transport: vec![0; 48],
            target: vec![],
        },
        challenge: Challenge {
            bytes: vec![9; 32],
            expires: 121,
            registration: true,
            credential_ids: vec![],
        },
        configuration: vec![],
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };
    let credential = auth::registration(
        &config,
        &ceremony,
        fixture["registration"].as_str().unwrap(),
    )
    .unwrap();
    ceremony.challenge.credential_ids = vec![credential.id.0.clone()];
    ceremony.challenge.registration = false;
    auth::assertion(
        &config,
        &ceremony,
        vec![credential.clone()],
        fixture["assertion"].as_str().unwrap(),
    )
    .unwrap();
    for field in ["wrongOrigin", "wrongRp", "noUv", "replay"] {
        assert!(
            auth::assertion(
                &config,
                &ceremony,
                vec![credential.clone()],
                fixture[field].as_str().unwrap()
            )
            .is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn existing_header_key_name_is_used_after_controller_changes_default() {
    let env = TestEnvironment::new();
    env.reserve();
    env.db.borrow().execute("UPDATE global_settings SET value=json_set(value,'$.key_name','other_key') WHERE key='config'",params![]).unwrap();
    let transport = ic_bls12_381::G1Affine::generator().to_compressed().to_vec();
    let result = futures::executor::block_on(derive_vault_key(
        &env,
        Derive {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            transport,
            assertion: None,
        },
    ));
    assert_eq!(result.unwrap_err(), Error::KeyService);
    assert_eq!(*env.public_names.borrow(), vec!["test_key_1"]);
}
#[test]
fn controller_configuration_change_fences_in_flight_key_response() {
    let env = TestEnvironment::new();
    env.reserve();
    env.change_config.set(true);
    let transport = ic_bls12_381::G1Affine::generator().to_compressed().to_vec();
    let result = futures::executor::block_on(derive_vault_key(
        &env,
        Derive {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            transport,
            assertion: None,
        },
    ));
    assert_eq!(result.unwrap_err(), Error::Expired);
    assert_eq!(env.settled.get(), Some(0));
}

#[test]
fn quota_full_setup_cancellation_uses_its_prepaid_housekeeping_slot() {
    let env = TestEnvironment::new();
    env.reserve();
    env.transaction(|db|{
        let remaining=TOTAL_MAX-store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),x'ff',x'ff',1,1,NULL,0,x'','[]',1,?1)",params![remaining as i64]).unwrap();Ok(())
    }).unwrap();
    cancel_vault_setup(&env, vec![1; 16], vec![2; 16]).unwrap();
    assert!(list_unfinished_vaults(&env).unwrap().is_empty());
}

#[test]
fn refunded_management_failure_settles_only_the_actual_payment() {
    let env = TestEnvironment::new();
    env.reserve();
    env.actual_payment.set(Some(0));
    let transport = ic_bls12_381::G1Affine::generator().to_compressed().to_vec();
    let result = futures::executor::block_on(derive_vault_key(
        &env,
        Derive {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            transport,
            assertion: None,
        },
    ));
    assert_eq!(result.unwrap_err(), Error::KeyService);
    assert_eq!(env.settled.get(), Some(0));
    let (cost, flight): (i64, i64) = env
        .db
        .borrow()
        .query_row("SELECT actual,in_flight FROM key_flights", params![], |r| {
            Ok((
                kinic_sqlite_compat::row_get(r, 0)?,
                kinic_sqlite_compat::row_get(r, 1)?,
            ))
        })
        .unwrap();
    assert_eq!((cost, flight), (0, 0));
}

#[test]
fn payer_admission_does_not_reenter_the_vault_sql_transaction() {
    let env = TestEnvironment::new();
    env.reserve();
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.state = VaultState::Active;
        store::put_header(db, &h)?;
        db.execute(
            "UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",
            params![],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    let result = begin_revision(
        &env,
        BeginRevision {
            vault: vec![1; 16],
            object: vec![2; 16],
            expected_revision: 0,
            operation: vec![3; 16],
            plain_size: 1,
            manifest: vec![1],
            chunk_hashes: vec![Sha256::digest(vec![7; 17]).to_vec()],
        },
    );
    assert!(result.is_ok(), "{result:?}");
}
