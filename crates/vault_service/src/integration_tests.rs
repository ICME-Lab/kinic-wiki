use super::*;
use candid::Principal;
use std::cell::{Cell, RefCell};
type TestHook = Box<dyn FnOnce(&TestEnvironment)>;
struct TestEnvironment {
    authorized: Cell<bool>,
    funded: Cell<bool>,
    db: RefCell<Connection>,
    owner: Cell<Principal>,
    time: Cell<u64>,
    cancel_random: Cell<bool>,
    fail_random: Cell<bool>,
    cleanup_settled: Cell<bool>,
    challenge_pending: Cell<bool>,
    upgrade_random: Cell<bool>,
    cancel_public: Cell<bool>,
    replace_flight: Cell<bool>,
    settled: Cell<Option<u64>>,
    change_config: Cell<bool>,
    public_names: RefCell<Vec<String>>,
    public_hook: RefCell<Option<TestHook>>,
    random_hook: RefCell<Option<TestHook>>,
    derive_hook: RefCell<Option<TestHook>>,
    derive_calls: Cell<u64>,
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
            authorized: Cell::new(true),
            funded: Cell::new(true),
            db: RefCell::new(db),
            owner: Cell::new(Principal::self_authenticating([1; 32])),
            time: Cell::new(1),
            cancel_random: Cell::new(false),
            fail_random: Cell::new(false),
            cleanup_settled: Cell::new(true),
            challenge_pending: Cell::new(false),
            upgrade_random: Cell::new(false),
            cancel_public: Cell::new(false),
            replace_flight: Cell::new(false),
            settled: Cell::new(None),
            change_config: Cell::new(false),
            public_names: RefCell::new(vec![]),
            public_hook: RefCell::new(None),
            random_hook: RefCell::new(None),
            derive_hook: RefCell::new(None),
            derive_calls: Cell::new(0),
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
        self.transaction(|db| {
            let mut h = store::header(db, &[1; 16])?;
            h.generation = Some(Generation {
                version: 2,
                canister: self.canister(),
                owner: self.owner(),
                vault: h.id.clone(),
                epoch: 0,
                nonce: vec![6; 32],
                key_name: h.key_name.clone(),
            });
            store::put_header(db, &h)
        })
        .unwrap();
    }
}
impl Environment for TestEnvironment {
    fn challenge_pending(&self, _db: &Connection, _token: u64) -> Result<bool> {
        Ok(self.challenge_pending.get())
    }
    fn reserve_challenge(&self, _token: u64) -> Result<()> {
        self.challenge_pending.set(true);
        Ok(())
    }
    fn settle_challenge(&self, _token: u64) -> Result<()> {
        self.challenge_pending.set(false);
        Ok(())
    }
    fn cleanup_existing_flights(
        &self,
        _db: &Connection,
        _targets: &[Id],
        _cancel_live: bool,
    ) -> Result<bool> {
        Ok(self.cleanup_settled.get())
    }
    fn mutation_authorized(&self) -> bool {
        self.authorized.get()
    }
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
        if !self.funded.get() {
            return Err(Error::QuotaExceeded);
        }
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
        let _ = token;
        Ok(())
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
        if let Some(hook) = self.random_hook.borrow_mut().take() {
            hook(self);
        }
        if self.cancel_random.replace(false) {
            cancel_vault_setup(self, vec![1; 16], vec![2; 16])?;
        }
        if self.fail_random.replace(false) {
            return Err(Error::KeyService);
        }
        if self.upgrade_random.replace(false) {
            self.db
                .borrow()
                .execute(
                    "INSERT INTO global_settings VALUES('generation','1')",
                    params![],
                )
                .unwrap();
        }
        Ok(vec![9; 32])
    }
    async fn public_key(&self, name: &str) -> Result<Vec<u8>> {
        assert!(
            self.checkpoints.get() >= 1,
            "public-key await must have a durable execution checkpoint"
        );
        self.public_names.borrow_mut().push(name.into());
        if let Some(hook) = self.public_hook.borrow_mut().take() {
            hook(self);
        }
        if self.replace_flight.replace(false) {
            self.transaction(|db| {
                let mut c = control(db)?;
                let f = c.derive.as_mut().ok_or(Error::NotFound)?;
                f.token += 1;
                store::save(db, "control", &c)
            })?;
        }
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
        self.derive_calls.set(self.derive_calls.get() + 1);
        if let Some(hook) = self.derive_hook.borrow_mut().take() {
            hook(self);
        }
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

fn signed_fixture(
    purpose: GrantPurpose,
) -> (TestEnvironment, ed25519_dalek::SigningKey, GrantInfo) {
    let env = TestEnvironment::new();
    env.reserve();
    env.authorized.set(false);
    let signing = ed25519_dalek::SigningKey::from_bytes(&[31; 32]);
    let info=env.transaction(|db|{
        let mut h=store::header(db,&[1;16])?;h.state=VaultState::Active;h.sequence=1;store::put_header(db,&h)?;
        db.execute("UPDATE vaults SET expires=0 WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1)",params![]).unwrap();
        store::save(db,"authorities",&authorization::Authorities{credentials:vec![authorization::Authority{id:vec![41],version:0,revoked:false,scope:CredentialScope::Global}]})?;
        cleanup::save(db,&cleanup::Namespace{identity:vec![51;32],seed:Some(vec![52;32]),serial:0,pending:None,grant:None,job:None,action:vec![],deleted:vec![],budget:Default::default(),cancelled:None})?;
        let g=grants::Grant{info:GrantInfo{id:vec![53;32],expires:301,next_counter:0,purpose,generations:vec![h.generation.unwrap()]},owner:env.owner(),canister:env.canister(),public_key:signing.verifying_key().to_bytes().to_vec(),credential:vec![41],credential_version:0,fence:grants::fence(db)?,revoked:false,restore_binding:None,last_digest:vec![],last_result:None,work:None};
        grants::save(db,&g)?;Ok(g.info)
    }).unwrap();
    (env, signing, info)
}
fn signed_call(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    g: &GrantInfo,
    counter: u64,
    operation: MutationOperation,
) -> Result<MutationResult> {
    use ed25519_dalek::Signer;
    let m = Mutation {
        version: 2,
        owner: env.owner(),
        canister: env.canister(),
        grant: g.id.clone(),
        counter,
        operation,
    };
    let payload = candid::encode_one(m).unwrap();
    let signature = key
        .sign(&[MUTATION_DOMAIN, &payload].concat())
        .to_bytes()
        .to_vec();
    // Management futures in this fixture are ready; polling directly also permits
    // a signed cleanup interleaving from an injected callback without nesting executors.
    futures::FutureExt::now_or_never(mutations::mutate(env, payload, signature))
        .expect("TestEnvironment management futures must complete synchronously")
}
#[test]
fn signed_dispatch_rolls_back_effect_and_counter_and_rejects_stale_scope() {
    let (env, key, g) = signed_fixture(GrantPurpose::Normal);
    assert_eq!(
        reserve_vault(
            &env,
            Reserve {
                vault: vec![3; 16],
                operation: vec![4; 16]
            }
        )
        .unwrap_err(),
        Error::Unauthorized
    );
    let op = MutationOperation::BeginRevision(BeginRevision {
        vault: vec![1; 16],
        object: vec![2; 16],
        expected_revision: 0,
        operation: vec![3; 16],
        plain_size: 1,
        manifest: test_manifest(),
        chunk_hashes: vec![vec![0; 32]],
    });
    let first = signed_call(&env, &key, &g, 0, op.clone()).unwrap();
    let retry = signed_call(&env, &key, &g, 0, op.clone()).unwrap();
    assert_eq!(
        candid::encode_one(first).unwrap(),
        candid::encode_one(retry).unwrap()
    );
    assert_eq!(
        signed_call(
            &env,
            &key,
            &g,
            0,
            MutationOperation::PurgeObject {
                vault: vec![1; 16],
                object: vec![2; 16]
            }
        )
        .unwrap_err(),
        Error::Conflict
    );
    assert_eq!(
        signed_call(
            &env,
            &ed25519_dalek::SigningKey::from_bytes(&[32; 32]),
            &g,
            1,
            op.clone()
        )
        .unwrap_err(),
        Error::InvalidProof
    );
    assert_eq!(
        env.transaction(|db| Ok(grants::load(db, &g.id)?.info.next_counter))
            .unwrap(),
        1
    );
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.generation.as_mut().unwrap().nonce[0] ^= 1;
        store::put_header(db, &h)
    })
    .unwrap();
    assert_eq!(
        signed_call(&env, &key, &g, 1, op).unwrap_err(),
        Error::Unauthorized
    );
}
#[test]
fn cleanup_challenge_works_at_zero_balance_with_normal_pool_full_and_counts_bad_proofs() {
    let (env, key, g) = signed_fixture(GrantPurpose::Normal);
    env.transaction(|db| {
        let base = grants::load(db, &g.id)?;
        for n in 0..5 {
            let mut x = base.clone();
            x.info.id = vec![60 + n; 32];
            grants::save(db, &x)?;
        }
        Ok(())
    })
    .unwrap();
    env.funded.set(false);
    let r = GrantRequest {
        operation: vec![7; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: GrantPurpose::Cleanup { job: vec![8; 16] },
        generations: g.generations,
    };
    let ch = cleanup::begin(&env, r.clone()).unwrap();
    assert_eq!(cleanup::begin(&env, r.clone()).unwrap().bytes, ch.bytes);
    assert_eq!(env.checkpoints.get(), 0);
    for _ in 0..100 {
        assert_eq!(
            cleanup::finish(&env, r.operation.clone(), "{}".into()).unwrap_err(),
            Error::InvalidProof
        );
    }
    assert_eq!(
        cleanup::finish(&env, r.operation.clone(), "{}".into()).unwrap_err(),
        Error::RateLimited { retry_after: DAY }
    );
    env.time.set(DAY + 1);
    let next = cleanup::begin(&env, r).unwrap();
    assert_ne!(ch.bytes, next.bytes);
}
#[test]
fn cleanup_signed_purge_has_replay_cursor_and_terminal_receipt() {
    let (env, key, g) = signed_fixture(GrantPurpose::Cleanup { job: vec![8; 16] });
    env.transaction(|db| {
        let grant = grants::load(db, &g.id)?;
        let mut n = cleanup::namespace(db)?;
        n.grant = Some(grant);
        cleanup::save(db, &n)
    })
    .unwrap();
    env.funded.set(false);
    let op = MutationOperation::Cleanup {
        job: vec![8; 16],
        cursor: 0,
        action: CleanupAction::Purge,
    };
    let first = signed_call(&env, &key, &g, 0, op.clone()).unwrap();
    assert!(matches!(
        first,
        MutationResult::Cleanup(CleanupProgress { complete: true, .. })
    ));
    assert!(signed_call(&env, &key, &g, 0, op).is_ok());
    assert_eq!(
        signed_call(
            &env,
            &key,
            &g,
            1,
            MutationOperation::Create(Reserve {
                vault: vec![9; 16],
                operation: vec![10; 16]
            })
        )
        .unwrap_err(),
        Error::Unauthorized
    );
}

fn install_test_passkey(env: &TestEnvironment) -> ed25519_dalek::SigningKey {
    let key = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    // COSE OKP/Ed25519: {1:1,3:-8,-1:6,-2:bytes32}.
    let cose = [
        vec![0xa4, 1, 1, 3, 0x27, 0x20, 6, 0x21, 0x58, 0x20],
        key.verifying_key().to_bytes().to_vec(),
    ]
    .concat();
    env.transaction(|db| {
        insert_credential(
            db,
            &passkey_auth::PasskeyCredential {
                id: passkey_auth::CredentialId(vec![41]),
                public_key_cose: passkey_auth::CosePublicKey(cose),
                counter: 0,
                transports: vec![],
                aaguid: [0; 16],
            },
        )
    })
    .unwrap();
    key
}
fn passkey_assertion(
    env: &TestEnvironment,
    key: &ed25519_dalek::SigningKey,
    ch: &Challenge,
) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    use ed25519_dalek::Signer;
    let client=serde_json::to_vec(&serde_json::json!({"type":"webauthn.get","challenge":B64.encode(&ch.bytes),"origin":"http://localhost:5173","crossOrigin":false})).unwrap();
    let auth = [
        Sha256::digest(b"localhost").to_vec(),
        vec![5],
        0u32.to_be_bytes().to_vec(),
    ]
    .concat();
    let sig = key.sign(&[auth.clone(), Sha256::digest(&client).to_vec()].concat());
    serde_json::json!({"id":B64.encode([41]),"clientDataJSON":B64.encode(client),"authenticatorData":B64.encode(auth),"signature":B64.encode(sig.to_bytes()),"userHandle":B64.encode(env.owner().as_slice())}).to_string()
}
#[test]
fn cleanup_fresh_passkey_expiry_upgrade_and_replacement_are_fenced() {
    let (env, key, g) = signed_fixture(GrantPurpose::Normal);
    let passkey = install_test_passkey(&env);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    env.time.set(now);
    env.funded.set(false);
    let r = GrantRequest {
        operation: vec![7; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: GrantPurpose::Cleanup { job: vec![8; 16] },
        generations: g.generations,
    };
    let ch = cleanup::begin(&env, r.clone()).unwrap();
    let proof = passkey_assertion(&env, &passkey, &ch);
    let grant = cleanup::finish(&env, r.operation.clone(), proof).unwrap();
    env.time.set(now + 301);
    assert_eq!(
        signed_call(
            &env,
            &key,
            &grant,
            0,
            MutationOperation::Cleanup {
                job: vec![8; 16],
                cursor: 0,
                action: CleanupAction::Purge
            }
        )
        .unwrap_err(),
        Error::Expired
    );
    let next = cleanup::begin(&env, r.clone()).unwrap();
    assert_ne!(ch.bytes, next.bytes);
    env.db
        .borrow()
        .execute(
            "INSERT INTO global_settings VALUES('generation','1')",
            params![],
        )
        .unwrap();
    assert_eq!(
        cleanup::finish(
            &env,
            r.operation.clone(),
            passkey_assertion(&env, &passkey, &next)
        )
        .unwrap_err(),
        Error::Expired
    );
    let after_upgrade = cleanup::begin(&env, r.clone()).unwrap();
    let renewed = cleanup::finish(
        &env,
        r.operation,
        passkey_assertion(&env, &passkey, &after_upgrade),
    )
    .unwrap();
    assert_ne!(grant.id, renewed.id);
    assert!(
        signed_call(
            &env,
            &key,
            &renewed,
            0,
            MutationOperation::Cleanup {
                job: vec![8; 16],
                cursor: 0,
                action: CleanupAction::Purge
            }
        )
        .is_ok()
    );
}

fn test_manifest() -> Vec<u8> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
    serde_json::to_vec(&serde_json::json!({"version":2,"dek":{"version":2,"nonce":B64.encode([0;12]),"ciphertext":B64.encode([0;48])},"metadata":{"version":1,"nonce":B64.encode([1;12]),"ciphertext":B64.encode([0;16])},"nonces":[B64.encode([2;12])]})).unwrap()
}

#[test]
fn javascript_candid_signatures_all_variants_and_generation_aad_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/mutation-v2.json")).unwrap();
    let public = hex::decode(fixture["public_key"].as_str().unwrap()).unwrap();
    for v in fixture["vectors"].as_array().unwrap() {
        let bytes = hex::decode(v["payload"].as_str().unwrap()).unwrap();
        let sig = hex::decode(v["signature"].as_str().unwrap()).unwrap();
        let m = grants::decode(&bytes).unwrap_or_else(|e| panic!("{}: {e:?}", v["name"]));
        assert_eq!(m.version, 2);
        grants::verify(&public, &[MUTATION_DOMAIN, &bytes].concat(), &sig).unwrap();
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(grants::decode(&trailing).is_err());
    }
    let g = Generation {
        version: 2,
        canister: Principal::from_slice(&[1]),
        owner: Principal::from_slice(&[2]),
        vault: vec![3; 16],
        epoch: 7,
        nonce: vec![4; 32],
        key_name: "key_1".into(),
    };
    let seed = store::restore::target_seed(&g).unwrap();
    let tombstone = Revision {
        vault: g.vault.clone(),
        object: vec![5; 16],
        revision: 1,
        sequence: 1,
        plain_size: 0,
        manifest: vec![],
        chunk_hashes: vec![],
        deleted: true,
    };
    let leaf = store::restore::leaf(&tombstone);
    assert_eq!(
        hex::encode(&seed),
        fixture["commitments"]["empty"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(Sha256::digest([seed, leaf.clone()].concat())),
        fixture["commitments"]["tombstone"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(Sha256::digest([vec![0; 32], leaf].concat())),
        fixture["commitments"]["v1_tombstone"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(g.bytes().unwrap()),
        fixture["generation"].as_str().unwrap()
    );
    assert_eq!(
        hex::encode(g.aad(&[5; 16], 9, "dek").unwrap()),
        fixture["aad"].as_str().unwrap()
    );
}

#[test]
fn failed_cleanup_signatures_are_bounded_without_consuming_replay_counter() {
    let (env, _, g) = signed_fixture(GrantPurpose::Cleanup { job: vec![8; 16] });
    env.transaction(|db| {
        let grant = grants::load(db, &g.id)?;
        let mut n = cleanup::namespace(db)?;
        n.grant = Some(grant);
        cleanup::save(db, &n)
    })
    .unwrap();
    env.funded.set(false);
    let wrong = ed25519_dalek::SigningKey::from_bytes(&[99; 32]);
    let op = MutationOperation::Cleanup {
        job: vec![8; 16],
        cursor: 0,
        action: CleanupAction::Purge,
    };
    for _ in 0..1000 {
        assert_eq!(
            signed_call(&env, &wrong, &g, 0, op.clone()).unwrap_err(),
            Error::InvalidProof
        );
    }
    assert_eq!(
        signed_call(&env, &wrong, &g, 0, op).unwrap_err(),
        Error::RateLimited { retry_after: DAY }
    );
    assert_eq!(
        env.transaction(|db| Ok(cleanup::namespace(db)?.grant.unwrap().info.next_counter))
            .unwrap(),
        0
    );
    assert_eq!(list_vaults(&env).unwrap().len(), 1);
}

#[test]
fn stale_derive_completion_cannot_take_a_newer_flight() {
    let env = TestEnvironment::new();
    env.reserve();
    env.replace_flight.set(true);
    let result = futures::executor::block_on(derive_vault_key(
        &env,
        Derive {
            vault: vec![1; 16],
            attempt: Some(vec![2; 16]),
            epoch: 0,
            transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
            assertion: None,
        },
    ));
    assert_eq!(result.unwrap_err(), Error::Expired);
    assert_eq!(
        env.transaction(|db| Ok(control(db)?.derive.unwrap().token))
            .unwrap(),
        2
    );
}
#[test]
fn unregister_preserves_generation_and_last_usable_scope_and_revokes_grant() {
    let (env, key, g) = signed_fixture(GrantPurpose::Credentials);
    let passkey = install_test_passkey(&env);
    env.transaction(|db| {
        let mut c = credentials(db)?.remove(0);
        c.id.0 = vec![42];
        authorization::insert(db, &c, CredentialScope::Global)
    })
    .unwrap();
    let before = env
        .transaction(|db| hash(&store::header(db, &[1; 16])?))
        .unwrap();
    signed_call(
        &env,
        &key,
        &g,
        0,
        MutationOperation::RemoveCredential {
            credential: vec![41],
        },
    )
    .unwrap();
    assert_eq!(
        env.transaction(|db| hash(&store::header(db, &[1; 16])?))
            .unwrap(),
        before
    );
    assert_eq!(
        signed_call(
            &env,
            &key,
            &g,
            1,
            MutationOperation::RemoveCredential {
                credential: vec![42]
            }
        )
        .unwrap_err(),
        Error::Unauthorized
    );
    env.transaction(|db| {
        let remaining = authorization::authority(db, &[42])?;
        assert_eq!(
            authorization::remove(db, &remaining, &[42]),
            Err(Error::Conflict)
        );
        let mut all = authorization::authorities(db)?;
        let own = all
            .credentials
            .iter_mut()
            .find(|c| c.id == vec![42])
            .unwrap();
        own.scope = CredentialScope::Instances(vec![Instance {
            vault: vec![1; 16],
            nonce: vec![6; 32],
        }]);
        store::save(db, "authorities", &all)?;
        let r = GrantRequest {
            operation: vec![3; 16],
            public_key: passkey.verifying_key().to_bytes().to_vec(),
            credential: vec![42],
            purpose: GrantPurpose::Credentials,
            generations: g.generations.clone(),
        };
        assert_eq!(
            ceremonies::validate_request(db, &env, &r),
            Err(Error::Unauthorized)
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn current_recovery_verifier_never_trusts_source_kit_or_reused_vault_id() {
    use ed25519_dalek::Signer;
    let (env, _, g) = signed_fixture(GrantPurpose::Normal);
    let recovery = ed25519_dalek::SigningKey::from_bytes(&[88; 32]);
    env.transaction(|db| {
        let mut h = store::header(db, &[1; 16])?;
        h.recovery_verifier = recovery.verifying_key().to_bytes().to_vec();
        store::put_header(db, &h)?;
        let source = g.generations[0].clone();
        let mut target = source.clone();
        target.epoch = next_epoch(source.epoch)?;
        target.nonce = vec![99; 32];
        let b = recovery::RecoveryBinding {
            owner: env.owner(),
            canister: env.canister(),
            source,
            target,
            operation: vec![1; 16],
            action: "restore-replace".into(),
            candidate_digest: vec![2; 32],
            payload_digest: vec![3; 32],
            expires: 100,
            random: vec![4; 32],
            fence: grants::fence(db)?,
        };
        let bytes = candid::encode_one(&b).unwrap();
        let signature = recovery
            .sign(&[b"kinic-vault/recovery-proof/v2\0".as_slice(), &bytes].concat())
            .to_bytes();
        recovery::verify_current(db, &env, &b, &signature)?;
        h.generation.as_mut().unwrap().nonce = vec![7; 32];
        store::put_header(db, &h)?;
        assert_eq!(
            recovery::verify_current(db, &env, &b, &signature),
            Err(Error::Unauthorized)
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn review_purging_denies_completed_key_result_and_cached_replay() {
    for cached in [false, true] {
        let (env, key, info) = signed_fixture(GrantPurpose::Normal);
        let handle = vec![81; 32];
        env.transaction(|db| {
            let mut grant = grants::load(db, &info.id)?;
            grant.work = Some(grants::Work {
                handle: handle.clone(),
                expires: 100,
                request: grants::WorkRequest::Derive(Derive {
                    vault: vec![1; 16],
                    attempt: None,
                    epoch: 0,
                    transport: vec![8; 48],
                    assertion: None,
                }),
                result: Some(Ok(MutationResult::Key(KeyReply {
                    encrypted_key: vec![7],
                    public_key: vec![8],
                }))),
            });
            grants::save(db, &grant)
        })
        .unwrap();
        let operation = MutationOperation::KeyResult { handle };
        if cached {
            signed_call(&env, &key, &info, 0, operation.clone()).unwrap();
        }
        env.transaction(|db| {
            db.execute("INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,0,?3)", params![vec![1u8;16], vec![2u8;16], vec![3u8]]).unwrap();
            assert!(!store::cleanup::purge_batch(db, &[vec![1;16]])?);
            Ok(())
        }).unwrap();
        assert_eq!(
            signed_call(&env, &key, &info, 0, operation.clone()).unwrap_err(),
            Error::Unauthorized
        );
        if cached {
            assert_eq!(
                signed_call(&env, &key, &info, 1, operation).unwrap_err(),
                Error::Unauthorized
            );
        }
    }
}

#[test]
fn review_cleanup_owner_budget_survives_recreation_same_day() {
    let (env, _, _) = signed_fixture(GrantPurpose::Normal);
    env.transaction(|db| {
        for _ in 0..100 {
            cleanup::budget(db, env.now(), 0)?;
        }
        for _ in 0..100 {
            cleanup::budget(db, env.now(), 1)?;
        }
        for _ in 0..1000 {
            cleanup::budget(db, env.now(), 2)?;
        }
        let mut replacement = cleanup::namespace(db)?;
        assert!(store::cleanup::purge_batch(db, &[vec![1; 16]])?);
        cleanup::reclaim_empty(db, 500)?;
        replacement.seed = Some(vec![77; 32]);
        replacement.identity = vec![78; 32];
        replacement.serial = 0;
        replacement.budget = Default::default();
        cleanup::save(db, &replacement)?;
        for kind in 0..3 {
            assert_eq!(
                cleanup::budget(db, 500, kind),
                Err(Error::RateLimited { retry_after: DAY })
            );
        }
        for kind in 0..3 {
            cleanup::budget(db, DAY + 1, kind)?;
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn review_cancel_nonce_less_creation_requires_fresh_global_exact_attempt() {
    for upgrade in [false, true] {
        let (env, key, mut creation) = signed_fixture(GrantPurpose::Create);
        let passkey = install_test_passkey(&env);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        env.time.set(now);
        env.transaction(|db| {
            let mut grant = grants::load(db, &creation.id)?;
            grant.info.expires = now + 300;
            creation = grant.info.clone();
            grants::save(db, &grant)
        })
        .unwrap();
        env.fail_random.set(!upgrade);
        env.upgrade_random.set(upgrade);
        let work = signed_call(
            &env,
            &key,
            &creation,
            0,
            MutationOperation::Create(Reserve {
                vault: vec![71; 16],
                operation: vec![72; 16],
            }),
        )
        .unwrap();
        assert!(matches!(work, MutationResult::Handle(_)));
        assert!(
            env.transaction(|db| store::header(db, &[71; 16]))
                .unwrap()
                .generation
                .is_none()
        );
        env.funded.set(false);
        assert_eq!(
            cancel_vault_setup(&env, vec![71; 16], vec![72; 16]),
            Err(Error::Unauthorized)
        );
        let target = PendingCreation {
            namespace: vec![51; 32],
            vault: vec![71; 16],
            attempt: vec![72; 16],
        };
        let request = GrantRequest {
            operation: vec![73; 16],
            public_key: key.verifying_key().to_bytes().to_vec(),
            credential: vec![41],
            purpose: GrantPurpose::CancelCreation {
                job: vec![74; 16],
                target: target.clone(),
            },
            generations: vec![],
        };
        assert_eq!(
            list_unfinished_vaults(&env).unwrap()[0].namespace,
            Some(target.namespace.clone())
        );
        for bad in [
            PendingCreation {
                namespace: vec![50; 32],
                ..target.clone()
            },
            PendingCreation {
                attempt: vec![70; 16],
                ..target.clone()
            },
            PendingCreation {
                vault: vec![1; 16],
                ..target.clone()
            },
        ] {
            let mut r = request.clone();
            r.purpose = GrantPurpose::CancelCreation {
                job: vec![74; 16],
                target: bad,
            };
            assert!(cleanup::begin(&env, r).is_err());
        }
        env.transaction(|db| {
            let mut a = authorization::authorities(db)?;
            a.credentials[0].scope = CredentialScope::Instances(vec![]);
            store::save(db, "authorities", &a)
        })
        .unwrap();
        assert!(cleanup::begin(&env, request.clone()).is_err());
        env.transaction(|db| {
            let mut a = authorization::authorities(db)?;
            a.credentials[0].scope = CredentialScope::Global;
            store::save(db, "authorities", &a)
        })
        .unwrap();
        let challenge = cleanup::begin(&env, request.clone()).unwrap();
        let grant = cleanup::finish(
            &env,
            request.operation,
            passkey_assertion(&env, &passkey, &challenge),
        )
        .unwrap();
        for action in [
            CleanupAction::Purge,
            CleanupAction::CancelSetup {
                attempt: vec![70; 16],
            },
        ] {
            assert!(
                signed_call(
                    &env,
                    &key,
                    &grant,
                    0,
                    MutationOperation::Cleanup {
                        job: vec![74; 16],
                        cursor: 0,
                        action
                    }
                )
                .is_err()
            );
        }
        let mut operation = MutationOperation::Cleanup {
            job: vec![74; 16],
            cursor: 0,
            action: CleanupAction::CancelSetup {
                attempt: target.attempt.clone(),
            },
        };
        env.cleanup_settled.set(false);
        assert!(matches!(
            signed_call(&env, &key, &grant, 0, operation.clone()),
            Ok(MutationResult::Cleanup(CleanupProgress {
                complete: false,
                ..
            }))
        ));
        env.funded.set(true);
        assert!(
            signed_call(
                &env,
                &key,
                &creation,
                1,
                MutationOperation::Create(Reserve {
                    vault: target.vault.clone(),
                    operation: target.attempt.clone()
                })
            )
            .is_err()
        );
        env.funded.set(false);
        env.cleanup_settled.set(true);
        if let MutationOperation::Cleanup { cursor, .. } = &mut operation {
            *cursor = 1;
        }
        assert!(matches!(
            signed_call(&env, &key, &grant, 1, operation.clone()),
            Ok(MutationResult::Cleanup(CleanupProgress {
                complete: true,
                ..
            }))
        ));
        assert!(signed_call(&env, &key, &grant, 1, operation.clone()).is_ok());
        assert!(
            env.transaction(|db| store::header(db, &target.vault))
                .is_err()
        );
        assert!(env.transaction(|db| store::header(db, &[1; 16])).is_ok());
        assert!(
            env.transaction(|db| Ok(control(db)?.random.is_none()))
                .unwrap()
        );
        env.transaction(|db| {
            store::reserve(
                db,
                env.owner(),
                Reserve {
                    vault: target.vault.clone(),
                    operation: vec![75; 16],
                },
                now,
            )
        })
        .unwrap();
        assert_eq!(
            signed_call(&env, &key, &grant, 1, operation).unwrap_err(),
            Error::Unauthorized
        );
    }
}

#[test]
fn review_cancel_pending_creation_survives_nonce_publication_at_every_proof_boundary() {
    for publication in 0..3 {
        let (env, key, original) = signed_fixture(GrantPurpose::Normal);
        let passkey = install_test_passkey(&env);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        env.time.set(now);
        env.transaction(|db| {
            store::reserve(
                db,
                env.owner(),
                Reserve {
                    vault: vec![71; 16],
                    operation: vec![72; 16],
                },
                now,
            )
        })
        .unwrap();
        env.funded.set(false);
        let publish = || {
            env.transaction(|db| {
                let mut h = store::header(db, &[71; 16])?;
                let mut g = original.generations[0].clone();
                g.vault = h.id.clone();
                g.nonce = vec![73; 32];
                h.generation = Some(g);
                store::put_header(db, &h)
            })
            .unwrap()
        };
        let request = GrantRequest {
            operation: vec![74; 16],
            public_key: key.verifying_key().to_bytes().to_vec(),
            credential: vec![41],
            purpose: GrantPurpose::CancelCreation {
                job: vec![75; 16],
                target: PendingCreation {
                    namespace: vec![51; 32],
                    vault: vec![71; 16],
                    attempt: vec![72; 16],
                },
            },
            generations: vec![],
        };
        if publication == 0 {
            publish();
        }
        let challenge = cleanup::begin(&env, request.clone()).unwrap();
        if publication == 1 {
            publish();
        }
        let grant = cleanup::finish(
            &env,
            request.operation,
            passkey_assertion(&env, &passkey, &challenge),
        )
        .unwrap();
        if publication == 2 {
            publish();
        }
        // Even an erroneous phase rollback must not relabel a previously activated Vault as setup.
        env.transaction(|db| {
            let mut h = store::header(db, &[71; 16])?;
            h.sequence = 1;
            store::put_header(db, &h)
        })
        .unwrap();
        let op = MutationOperation::Cleanup {
            job: vec![75; 16],
            cursor: 0,
            action: CleanupAction::CancelSetup {
                attempt: vec![72; 16],
            },
        };
        assert_eq!(
            signed_call(&env, &key, &grant, 0, op.clone()).unwrap_err(),
            Error::Unauthorized
        );
        env.transaction(|db| {
            let mut h = store::header(db, &[71; 16])?;
            h.sequence = 0;
            store::put_header(db, &h)
        })
        .unwrap();
        assert!(matches!(
            signed_call(&env, &key, &grant, 0, op.clone()),
            Ok(MutationResult::Cleanup(CleanupProgress {
                complete: true,
                ..
            }))
        ));
        assert!(signed_call(&env, &key, &grant, 0, op).is_ok());
    }
}

fn cancelling_generated_fixture(
    full_generation: bool,
) -> (
    TestEnvironment,
    ed25519_dalek::SigningKey,
    GrantInfo,
    GrantInfo,
    GrantInfo,
    GrantRequest,
) {
    let (env, key, mut unrelated) = signed_fixture(GrantPurpose::Normal);
    let passkey = install_test_passkey(&env);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    env.time.set(now);
    let normal = env
        .transaction(|db| {
            let mut old = grants::load(db, &unrelated.id)?;
            old.info.expires = now + 300;
            unrelated = old.info.clone();
            grants::save(db, &old)?;
            let mut h = store::reserve(
                db,
                env.owner(),
                Reserve {
                    vault: vec![81; 16],
                    operation: vec![82; 16],
                },
                now,
            )?;
            let mut generation = old.info.generations[0].clone();
            generation.vault = h.id.clone();
            generation.nonce = vec![83; 32];
            h.generation = Some(generation.clone());
            store::put_header(db, &h)?;
            old.info.id = vec![84; 32];
            old.info.generations = vec![generation];
            grants::save(db, &old)?;
            Ok(old.info)
        })
        .unwrap();
    let target = PendingCreation {
        namespace: vec![51; 32],
        vault: vec![81; 16],
        attempt: vec![82; 16],
    };
    let request = GrantRequest {
        operation: vec![85; 16],
        public_key: key.verifying_key().to_bytes().to_vec(),
        credential: vec![41],
        purpose: if full_generation {
            GrantPurpose::Cleanup { job: vec![86; 16] }
        } else {
            GrantPurpose::CancelCreation {
                job: vec![86; 16],
                target,
            }
        },
        generations: if full_generation {
            normal.generations.clone()
        } else {
            vec![]
        },
    };
    let challenge = cleanup::begin(&env, request.clone()).unwrap();
    let cleanup = cleanup::finish(
        &env,
        request.operation.clone(),
        passkey_assertion(&env, &passkey, &challenge),
    )
    .unwrap();
    env.cleanup_settled.set(false);
    (env, key, normal, unrelated, cleanup, request)
}
fn cancellation_operation(cursor: u64) -> MutationOperation {
    MutationOperation::Cleanup {
        job: vec![86; 16],
        cursor,
        action: CleanupAction::CancelSetup {
            attempt: vec![82; 16],
        },
    }
}
fn pending_activation() -> MutationOperation {
    MutationOperation::Activate {
        request: Activate {
            vault: vec![81; 16],
            attempt: Some(vec![82; 16]),
            operation: vec![87; 16],
            normal: Envelope {
                version: 2,
                nonce: vec![1; 12],
                ciphertext: vec![2; 48],
            },
            recovery: Envelope {
                version: 2,
                nonce: vec![3; 12],
                ciphertext: vec![4; 48],
            },
            registration: None,
            assertion: None,
        },
        recovery_verifier: ed25519_dalek::SigningKey::from_bytes(&[88; 32])
            .verifying_key()
            .to_bytes()
            .to_vec(),
    }
}
fn pending_derive() -> Derive {
    Derive {
        vault: vec![81; 16],
        attempt: Some(vec![82; 16]),
        epoch: 0,
        transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
        assertion: None,
    }
}
#[test]
fn review2_incomplete_cancellation_freezes_activation_and_preserves_cleanup_and_other_vault() {
    for full_generation in [false, true] {
        let (env, key, normal, unrelated, cleanup_grant, request) =
            cancelling_generated_fixture(full_generation);
        let passkey = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
        let normal_request = GrantRequest {
            purpose: GrantPurpose::Normal,
            generations: normal.generations.clone(),
            ..request.clone()
        };
        let before =
            futures::executor::block_on(ceremonies::begin(&env, normal_request.clone())).unwrap();
        assert!(matches!(
            signed_call(&env, &key, &cleanup_grant, 0, cancellation_operation(0)),
            Ok(MutationResult::Cleanup(CleanupProgress {
                complete: false,
                ..
            }))
        ));
        assert_eq!(
            ceremonies::finish(
                &env,
                normal_request.operation.clone(),
                passkey_assertion(&env, &passkey, &before)
            )
            .unwrap_err(),
            Error::Unauthorized
        );
        assert_eq!(
            futures::executor::block_on(ceremonies::begin(&env, normal_request)).unwrap_err(),
            Error::Unauthorized
        );
        let mut alternate = request.clone();
        alternate.purpose = GrantPurpose::Cleanup { job: vec![95; 16] };
        alternate.generations = unrelated.generations.clone();
        assert_eq!(cleanup::begin(&env, alternate).unwrap_err(), Error::Busy);
        let rejected = MutationOperation::Cleanup {
            job: vec![86; 16],
            cursor: 1,
            action: CleanupAction::CancelSetup {
                attempt: vec![94; 16],
            },
        };
        assert_eq!(
            signed_call(&env, &key, &cleanup_grant, 1, rejected).unwrap_err(),
            Error::Unauthorized
        );
        env.transaction(|db| {
            let n = cleanup::namespace(db)?;
            assert_eq!(
                n.cancelled,
                Some(PendingCreation {
                    namespace: vec![51; 32],
                    vault: vec![81; 16],
                    attempt: vec![82; 16]
                })
            );
            assert_eq!(n.job.unwrap().cursor, 1);
            assert_eq!(n.grant.unwrap().info.next_counter, 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            signed_call(&env, &key, &normal, 0, pending_activation()).unwrap_err(),
            Error::Unauthorized
        );
        assert_eq!(
            signed_call(
                &env,
                &key,
                &normal,
                0,
                MutationOperation::Derive(pending_derive())
            )
            .unwrap_err(),
            Error::Unauthorized
        );
        assert!(env.public_names.borrow().is_empty());
        assert_eq!(
            env.transaction(|db| store::header(db, &[81; 16]))
                .unwrap()
                .state,
            VaultState::Pending
        );
        // A distinct Active target can still use its already-issued grant.
        assert!(
            signed_call(
                &env,
                &key,
                &unrelated,
                0,
                MutationOperation::BeginRevision(BeginRevision {
                    vault: vec![1; 16],
                    object: vec![89; 16],
                    expected_revision: 0,
                    operation: vec![90; 16],
                    plain_size: 1,
                    manifest: test_manifest(),
                    chunk_hashes: vec![vec![99; 32]],
                })
            )
            .is_ok()
        );
        let unrelated_handle = vec![96; 32];
        env.transaction(|db| {
            let mut g = grants::load(db, &unrelated.id)?;
            let mut derive = pending_derive();
            derive.vault = vec![1; 16];
            derive.attempt = None;
            g.work = Some(grants::Work {
                handle: unrelated_handle.clone(),
                expires: env.now() + 120,
                request: grants::WorkRequest::Derive(derive),
                result: Some(Ok(MutationResult::Key(KeyReply {
                    encrypted_key: vec![5],
                    public_key: vec![6],
                }))),
            });
            grants::save(db, &g)
        })
        .unwrap();
        assert!(matches!(
            signed_call(
                &env,
                &key,
                &unrelated,
                1,
                MutationOperation::KeyResult {
                    handle: unrelated_handle
                }
            ),
            Ok(MutationResult::Key(_))
        ));
        let passkey = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
        let ch = cleanup::begin(&env, request.clone()).unwrap();
        let renewed = cleanup::finish(
            &env,
            request.operation,
            passkey_assertion(&env, &passkey, &ch),
        )
        .unwrap();
        env.cleanup_settled.set(true);
        env.funded.set(false);
        let terminal = signed_call(&env, &key, &renewed, 0, cancellation_operation(1)).unwrap();
        assert!(matches!(
            terminal,
            MutationResult::Cleanup(CleanupProgress { complete: true, .. })
        ));
        assert!(signed_call(&env, &key, &renewed, 0, cancellation_operation(1)).is_ok());
        assert!(env.transaction(|db| store::header(db, &[81; 16])).is_err());
    }
}
#[test]
fn review2_incomplete_cancellation_fences_unread_and_cached_key_results() {
    for full_generation in [false, true] {
        for cached in [false, true] {
            let (env, key, normal, _, cleanup_grant, _) =
                cancelling_generated_fixture(full_generation);
            let handle = vec![91; 32];
            env.transaction(|db| {
                let mut g = grants::load(db, &normal.id)?;
                g.work = Some(grants::Work {
                    handle: handle.clone(),
                    expires: env.now() + 120,
                    request: grants::WorkRequest::Derive(pending_derive()),
                    result: Some(Ok(MutationResult::Key(KeyReply {
                        encrypted_key: vec![7],
                        public_key: vec![8],
                    }))),
                });
                grants::save(db, &g)
            })
            .unwrap();
            let op = MutationOperation::KeyResult { handle };
            if cached {
                signed_call(&env, &key, &normal, 0, op.clone()).unwrap();
            }
            signed_call(&env, &key, &cleanup_grant, 0, cancellation_operation(0)).unwrap();
            assert_eq!(
                signed_call(&env, &key, &normal, 0, op.clone()).unwrap_err(),
                Error::Unauthorized
            );
            if cached {
                assert_eq!(
                    signed_call(&env, &key, &normal, 1, op).unwrap_err(),
                    Error::Unauthorized
                );
            }
            assert_eq!(
                env.transaction(|db| Ok(grants::load(db, &normal.id)?.info.next_counter))
                    .unwrap(),
                u64::from(cached)
            );
        }
    }
}

#[test]
fn review2_incomplete_cancellation_fences_each_key_callback_but_settles_its_cost() {
    for after_derive in [false, true] {
        let (env, key, normal, _, cleanup_grant, _) = cancelling_generated_fixture(false);
        let cleanup_key = key.clone();
        let hook: TestHook = Box::new(move |env| {
            assert!(matches!(
                signed_call(
                    env,
                    &cleanup_key,
                    &cleanup_grant,
                    0,
                    cancellation_operation(0)
                ),
                Ok(MutationResult::Cleanup(CleanupProgress {
                    complete: false,
                    ..
                }))
            ));
        });
        if after_derive {
            *env.derive_hook.borrow_mut() = Some(hook);
        } else {
            *env.public_hook.borrow_mut() = Some(hook);
        }
        assert!(matches!(
            signed_call(
                &env,
                &key,
                &normal,
                0,
                MutationOperation::Derive(pending_derive())
            ),
            Ok(MutationResult::Handle(_))
        ));
        assert_eq!(env.derive_calls.get(), u64::from(after_derive));
        assert_eq!(
            env.settled.get(),
            Some(if after_derive { 30_000_000_000 } else { 0 })
        );
        let work = env
            .transaction(|db| Ok(grants::load(db, &normal.id)?.work.unwrap()))
            .unwrap();
        assert!(matches!(work.result, Some(Err(Error::Expired))));
        assert_eq!(
            signed_call(
                &env,
                &key,
                &normal,
                1,
                MutationOperation::KeyResult {
                    handle: work.handle
                }
            )
            .unwrap_err(),
            Error::Unauthorized
        );
    }
}

#[test]
fn review2_completed_cancellation_marker_does_not_freeze_a_new_creation_attempt() {
    let (env, key, _, _, cleanup_grant, mut request) = cancelling_generated_fixture(false);
    signed_call(&env, &key, &cleanup_grant, 0, cancellation_operation(0)).unwrap();
    env.cleanup_settled.set(true);
    signed_call(&env, &key, &cleanup_grant, 1, cancellation_operation(1)).unwrap();
    let generation = env
        .transaction(|db| {
            let mut h = store::reserve(
                db,
                env.owner(),
                Reserve {
                    vault: vec![81; 16],
                    operation: vec![97; 16],
                },
                env.now(),
            )?;
            let mut g = store::header(db, &[1; 16])?.generation.unwrap();
            g.vault = h.id.clone();
            g.nonce = vec![98; 32];
            h.generation = Some(g.clone());
            store::put_header(db, &h)?;
            Ok(g)
        })
        .unwrap();
    request.operation = vec![99; 16];
    request.purpose = GrantPurpose::Normal;
    request.generations = vec![generation];
    let ch = futures::executor::block_on(ceremonies::begin(&env, request.clone())).unwrap();
    let passkey = ed25519_dalek::SigningKey::from_bytes(&[71; 32]);
    let normal = ceremonies::finish(
        &env,
        request.operation,
        passkey_assertion(&env, &passkey, &ch),
    )
    .unwrap();
    let mut activation = pending_activation();
    if let MutationOperation::Activate { request, .. } = &mut activation {
        request.attempt = Some(vec![97; 16]);
    }
    assert!(matches!(
        signed_call(&env, &key, &normal, 0, activation),
        Ok(MutationResult::Header(Header {
            state: VaultState::Active,
            ..
        }))
    ));
    assert_eq!(
        signed_call(&env, &key, &cleanup_grant, 1, cancellation_operation(1)).unwrap_err(),
        Error::Unauthorized
    );
}

#[test]
fn signed_derivation_settles_own_global_reservation_after_revocation_at_each_await() {
    for invalidation in ["revocation", "expiry", "runtime", "cancel", "newer-flight"] {
        for after_public in [true, false] {
            let (env, key, grant) = signed_fixture(GrantPurpose::Normal);
            let hook: TestHook = Box::new(move |env| {
                env.transaction(|db| {
                    match invalidation {
                        "revocation" => {
                            let mut all = authorization::authorities(db)?;
                            all.credentials[0].revoked = true;
                            store::save(db, "authorities", &all)?;
                        }
                        "expiry" => env.time.set(302),
                        "runtime" => {
                            db.execute(
                                "INSERT INTO global_settings VALUES('generation','1')",
                                params![],
                            )
                            .map_err(|_| Error::Storage)?;
                        }
                        "cancel" => {
                            let mut c = control(db)?;
                            c.derive = None;
                            store::save(db, "control", &c)?;
                        }
                        "newer-flight" => {
                            let mut c = control(db)?;
                            c.derive.as_mut().unwrap().token += 1;
                            store::save(db, "control", &c)?;
                        }
                        _ => unreachable!(),
                    }
                    Ok(())
                })
                .unwrap();
            });
            if after_public {
                *env.public_hook.borrow_mut() = Some(hook);
            } else {
                *env.derive_hook.borrow_mut() = Some(hook);
            }
            let result = signed_call(
                &env,
                &key,
                &grant,
                0,
                MutationOperation::Derive(Derive {
                    vault: vec![1; 16],
                    attempt: None,
                    epoch: 0,
                    transport: ic_bls12_381::G1Affine::generator().to_compressed().to_vec(),
                    assertion: None,
                }),
            );
            assert!(
                matches!(result, Ok(MutationResult::Handle(_))),
                "{invalidation}: {result:?}"
            );
            let expected = if after_public { 0 } else { 30_000_000_000 };
            let token = env
                .transaction(|db| {
                    let (token, actual, flight): (i64, Option<i64>, i64) = db
                        .query_row(
                            "SELECT token,actual,in_flight FROM key_flights",
                            params![],
                            |r| {
                                Ok((
                                    kinic_sqlite_compat::row_get(r, 0)?,
                                    kinic_sqlite_compat::row_get(r, 1)?,
                                    kinic_sqlite_compat::row_get(r, 2)?,
                                ))
                            },
                        )
                        .map_err(|_| Error::Storage)?;
                    assert_eq!(flight, 0, "{invalidation}");
                    assert_eq!(actual, Some(expected), "{invalidation}");
                    if invalidation == "newer-flight" {
                        assert_eq!(control(db)?.derive.unwrap().token, token as u64 + 1);
                    } else {
                        assert!(control(db)?.derive.is_none());
                    }
                    // The physical service slot is available after the old callback settles.
                    store::keys::reserve(db, token as u64 + 10, env.now(), 30_000_000_000)?;
                    store::keys::settle(db, token as u64 + 10, env.now(), 0)?;
                    Ok(token as u64)
                })
                .unwrap();
            assert!(!env.settle_key_reservation(token, expected as u64).unwrap());
            assert_eq!(
                env.settle_key_reservation(
                    token,
                    if expected == 0 {
                        1
                    } else {
                        expected as u64 - 1
                    }
                ),
                Err(Error::Conflict)
            );
            let owner = env.owner();
            env.owner.set(Principal::self_authenticating([99; 32]));
            assert_eq!(
                env.settle_key_reservation(token, expected as u64),
                Err(Error::NotFound)
            );
            env.owner.set(owner);
        }
    }
}

#[test]
fn incident_admission_freezes_atomically_and_invalidates_global_empty_grants() {
    let (env, key, normal) = signed_fixture(GrantPurpose::Normal);
    env.transaction(|db| {
        grants::prepay(db)?;
        let mut all = authorization::authorities(db)?;
        all.credentials.push(authorization::Authority {
            id: vec![42],
            version: 1,
            revoked: false,
            scope: CredentialScope::Global,
        });
        store::save(db, "authorities", &all)
    })
    .unwrap();
    let request = IncidentPreparation {
        job: vec![70; 16],
        namespace: vec![51; 32],
        compromised: vec![CredentialRevocation {
            credential: vec![42],
            version: 1,
        }],
        sources: normal.generations.clone(),
        targets: vec![PendingCreation {
            namespace: vec![51; 32],
            vault: vec![1; 16],
            attempt: vec![71; 16],
        }],
    };
    let pre = env
        .transaction(|db| {
            let mut g = grants::load(db, &normal.id)?;
            g.info.id = vec![72; 32];
            g.info.purpose = GrantPurpose::IncidentPrepare(request.clone());
            grants::save(db, &g)?;
            Ok(g.info)
        })
        .unwrap();
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
    let job = incident::status(&env).unwrap().unwrap();
    assert!(!job.complete);
    assert_eq!(job.targets.len(), 1);
    env.transaction(|db| {
        assert!(authorization::authority(db, &[42])?.revoked);
        assert_eq!(
            store::header(db, &[1; 16])?.state,
            VaultState::IncidentRequired
        );
        assert!(grants::current(db, &env, &grants::load(db, &normal.id)?).is_err());
        let mut old = grants::load(db, &normal.id)?;
        old.info.generations.clear();
        old.revoked = false;
        assert!(grants::current(db, &env, &old).is_err());
        assert!(
            store::reserve(
                db,
                env.owner(),
                Reserve {
                    vault: vec![2; 16],
                    operation: vec![3; 16]
                },
                env.now()
            )
            .is_err()
        );
        Ok(())
    })
    .unwrap();
    signed_call(&env, &key, &pre, 0, MutationOperation::IncidentStart).unwrap();
}

#[path = "incident_tests.rs"]
mod incident_tests;

#[path = "restore_admission_tests.rs"]
mod restore_admission_tests;
