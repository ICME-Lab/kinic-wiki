use super::*;
use candid::Principal;
use futures::{FutureExt, executor::block_on};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use store::kinic_sqlite_compat::Connection;
type Hook = Box<dyn FnOnce(&Env)>;
struct Env {
    db: RefCell<Connection>,
    owner: Cell<Principal>,
    now: Cell<u64>,
    funded: Cell<bool>,
    randoms: Cell<u64>,
    derives: Cell<u64>,
    paid: Cell<u64>,
    fail_public: Cell<bool>,
    hook: RefCell<Option<Hook>>,
    random_hook: RefCell<Option<Hook>>,
    public_hook: RefCell<Option<Hook>>,
}
impl Env {
    fn new() -> Self {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&[store::SCHEMA, store::CONTENT_SCHEMA, store::EXPIRY_SCHEMA].concat())
            .unwrap();
        db.execute(
            "INSERT INTO global_settings VALUES('config',?1)",
            params![
                serde_json::to_string(&VaultConfig {
                    key_name: "test_key_1".into(),
                    minimum_cycles: 100_000_000_000
                })
                .unwrap()
            ],
        )
        .unwrap();
        Self {
            db: RefCell::new(db),
            owner: Cell::new(Principal::from_slice(&[1])),
            now: Cell::new(100),
            funded: Cell::new(true),
            randoms: Cell::new(0),
            derives: Cell::new(0),
            paid: Cell::new(0),
            fail_public: Cell::new(false),
            hook: RefCell::new(None),
            random_hook: RefCell::new(None),
            public_hook: RefCell::new(None),
        }
    }
    fn create(&self) -> Header {
        block_on(create_vault(
            self,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16],
            },
        ))
        .unwrap()
    }
    fn change(&self, n: u8, action: Action) -> Result<MutationResult> {
        mutate(
            self,
            Mutation {
                operation: vec![n; 16],
                action,
            },
        )
    }
    fn begin(&self) -> BeginRevision {
        let bytes = vec![7; 17];
        let r = BeginRevision {
            vault: vec![1; 16],
            object: vec![3; 16],
            operation: vec![4; 16],
            expected_revision: 0,
            plain_size: 1,
            manifest: vec![1; 64],
            chunk_hashes: vec![Sha256::digest(&bytes).to_vec()],
        };
        self.change(5, Action::BeginRevision(r.clone())).unwrap();
        r
    }
}
fn public() -> Vec<u8> {
    hex::decode("93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8").unwrap()
}
impl Environment for Env {
    fn owner(&self) -> Principal {
        self.owner.get()
    }
    fn canister(&self) -> Principal {
        Principal::from_slice(&[9])
    }
    fn now(&self) -> u64 {
        self.now.get()
    }
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut db = self.db.borrow_mut();
        let tx = db.transaction().unwrap();
        let v = store::OwnerContext::authenticated(self.owner())?.run(&tx, f)?;
        tx.commit().unwrap();
        Ok(v)
    }
    fn require_spending(&self) -> Result<()> {
        if self.funded.get() {
            Ok(())
        } else {
            Err(Error::QuotaExceeded)
        }
    }
    fn reserve_cycles(&self, _token: u64, amount: u64) -> Result<()> {
        self.paid.set(amount);
        Ok(())
    }
    fn settle_cycles(&self, _token: u64, actual: u64) -> Result<()> {
        self.paid.set(actual);
        Ok(())
    }
    fn checkpoint_execution(&self) -> Result<()> {
        Ok(())
    }
    fn required_derive_payment(&self, _: &str) -> u64 {
        20
    }
    fn actual_derive_payment(&self, _: u64) -> u64 {
        12
    }
    fn recover_pending(&self, db: &Connection, target: Option<&[u8]>) -> Result<bool> {
        if target.is_some_and(|v| {
            store::load::<(u64, Id)>(db, "derive")
                .unwrap()
                .is_some_and(|(_, id)| id == v)
        }) {
            store::keys::cancel_pending(db, self.now())?;
            db.execute("DELETE FROM settings WHERE key='derive' AND owner=(SELECT owner FROM owner_scope WHERE slot=1)",[]).unwrap();
        }
        Ok(true)
    }
    fn reconcile_key_gc(&self, _: &Connection, _: &[Principal]) -> Result<()> {
        Ok(())
    }
    fn settle_key_reservation(&self, token: u64, actual: u64) -> Result<bool> {
        self.transaction(|db| runtime::settle_key_reservation_in(db, token, self.now(), actual))
    }
    async fn random(&self) -> Result<Vec<u8>> {
        self.randoms.set(self.randoms.get() + 1);
        let nonce = vec![self.randoms.get() as u8; 32];
        let hook = self.random_hook.borrow_mut().take();
        if let Some(h) = hook {
            h(self)
        }
        Ok(nonce)
    }
    async fn public_key(&self, _: &str) -> Result<Vec<u8>> {
        let hook = self.public_hook.borrow_mut().take();
        if let Some(h) = hook {
            h(self)
        }
        if self.fail_public.replace(false) {
            Err(Error::KeyService)
        } else {
            Ok(public())
        }
    }
    async fn derive_key(&self, _: &str, _: Vec<u8>, transport: Vec<u8>) -> Result<Vec<u8>> {
        self.derives.set(self.derives.get() + 1);
        if let Some(h) = self.hook.borrow_mut().take() {
            h(self)
        }
        Ok([transport.clone(), public(), transport].concat())
    }
}
#[test]
fn creation_retry_keeps_nonce_and_owner_key_input_isolated() {
    let e = Env::new();
    e.fail_public.set(true);
    assert!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        ))
        .is_err()
    );
    let h = e.create();
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(e.create(), h);
    assert_eq!(e.randoms.get(), 1);
    let input = key_input(e.canister(), e.owner(), &h).unwrap();
    e.owner.set(Principal::from_slice(&[2]));
    assert!(e.transaction(store::list).unwrap().is_empty());
    let other = e.create();
    assert_ne!(key_input(e.canister(), e.owner(), &other).unwrap(), input);
    e.owner.set(Principal::anonymous());
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Unauthorized)
    ));
}
#[test]
fn three_vault_limit_and_changed_create_payload_conflict() {
    let e = Env::new();
    e.create();
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![9; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Conflict)
    ));
    for n in 2..=3 {
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![n; 16],
                operation: vec![n + 10; 16],
            },
        ))
        .unwrap();
    }
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![4; 16],
                operation: vec![14; 16]
            }
        )),
        Err(Error::QuotaExceeded)
    ));
}
#[test]
fn key_replay_is_transport_bound_and_callback_deletion_discards_key() {
    let e = Env::new();
    e.create();
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    let r = DeriveKey {
        vault: vec![1; 16],
        operation: vec![8; 16],
        transport: transport.clone(),
    };
    let first = block_on(derive_vault_key(&e, r.clone())).unwrap();
    assert_eq!(e.paid.get(), 12);
    assert_eq!(block_on(derive_vault_key(&e, r.clone())).unwrap(), first);
    assert_eq!(e.derives.get(), 1);
    let mut different = r.clone();
    different.transport = ic_vetkeys::TransportSecretKey::from_seed(vec![9; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(&e, different)),
        Err(Error::Conflict)
    );
    e.hook.replace(Some(Box::new(|e| {
        e.change(40, Action::DeleteVault { vault: vec![1; 16] })
            .unwrap();
    })));
    let mut next = r;
    next.operation = vec![9; 16];
    assert_eq!(block_on(derive_vault_key(&e, next)), Err(Error::Expired));
    assert_eq!(e.paid.get(), 12);
    let pending = e
        .transaction(|db| {
            db.query_row(
                "SELECT count(*) FROM key_flights WHERE in_flight=1",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|_| Error::Storage)
        })
        .unwrap();
    assert_eq!(pending, 0);
}
#[test]
fn upload_lost_replies_commit_and_expected_revision_are_atomic() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    let put = Action::PutChunk {
        upload: r.operation.clone(),
        index: 0,
        bytes: vec![7; 17],
    };
    e.change(6, put.clone()).unwrap();
    e.change(6, put).unwrap();
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![8; 17]
            }
        ),
        Err(Error::Conflict)
    ));
    let action = Action::CommitRevision {
        upload: r.operation.clone(),
    };
    let first = e.change(7, action.clone()).unwrap();
    let retry = e.change(7, action).unwrap();
    assert_eq!(
        candid::encode_one(first).unwrap(),
        candid::encode_one(retry).unwrap()
    );
    assert!(matches!(
        e.transaction(|db| store::content::upload_status(db, &r.operation, e.now()))
            .unwrap(),
        UploadStatus::Committed(_)
    ));
    assert!(matches!(
        e.change(
            8,
            Action::DeleteObject {
                vault: r.vault.clone(),
                object: r.object.clone(),
                expected_revision: 0
            }
        ),
        Err(Error::Conflict)
    ));
    e.owner.set(Principal::from_slice(&[2]));
    assert!(matches!(
        e.transaction(|db| store::content::manifest(db, &r.vault, &r.object, 0)),
        Err(Error::NotFound)
    ));
}
#[test]
fn zero_balance_cancel_retries_are_bounded_even_when_capacity_is_full() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    e.funded.set(false);
    e.transaction(|db| {
        db.execute("UPDATE uploads SET reserved=?1", params![TOTAL_MAX as i64])
            .unwrap();
        Ok(())
    })
    .unwrap();
    let action = Action::CancelUpload {
        vault: r.vault.clone(),
        upload: r.operation.clone(),
        job: vec![22; 16],
    };
    assert!(matches!(
        e.change(23, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(23, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(24, action),
        Ok(MutationResult::Progress(true))
    ));
    assert!(matches!(
        e.transaction(|db| store::content::upload_status(db, &r.operation, e.now()))
            .unwrap(),
        UploadStatus::Cancelled
    ));
}
#[test]
fn deleting_other_vault_does_not_cancel_this_key_flight() {
    let e = Env::new();
    e.create();
    block_on(create_vault(
        &e,
        CreateVault {
            vault: vec![2; 16],
            operation: vec![12; 16],
        },
    ))
    .unwrap();
    e.hook.replace(Some(Box::new(|e| {
        e.change(40, Action::DeleteVault { vault: vec![2; 16] })
            .unwrap();
    })));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    assert!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![8; 16],
                transport
            }
        ))
        .is_ok()
    );
}
#[test]
fn expired_creation_random_and_public_callbacks_cannot_replace_resumed_attempt() {
    for at_public in [false, true] {
        let e = Env::new();
        let hook: Hook = Box::new(|e| {
            e.now.set(e.now() + 301);
            create_vault(
                e,
                CreateVault {
                    vault: vec![1; 16],
                    operation: vec![2; 16],
                },
            )
            .now_or_never()
            .unwrap()
            .unwrap();
        });
        if at_public {
            e.public_hook.replace(Some(hook));
        } else {
            e.random_hook.replace(Some(hook));
        }
        let r = CreateVault {
            vault: vec![1; 16],
            operation: vec![2; 16],
        };
        assert_eq!(block_on(create_vault(&e, r.clone())), Err(Error::Expired));
        let final_header = block_on(create_vault(&e, r)).unwrap();
        assert_eq!(final_header.nonce, vec![if at_public { 1 } else { 2 }; 32]);
        assert_eq!(final_header.state, VaultState::Active);
        assert_eq!(e.transaction(store::list).unwrap().len(), 1);
    }
}
#[test]
fn disabling_configuration_during_callbacks_retains_accounting_but_withholds_keys() {
    let e = Env::new();
    e.public_hook.replace(Some(Box::new(|e| {
        e.db.borrow()
            .execute("DELETE FROM global_settings WHERE key='config'", [])
            .unwrap();
    })));
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Unauthorized)
    );
    assert_eq!(
        e.transaction(|db| store::header(db, &[1; 16]))
            .unwrap()
            .state,
        VaultState::Pending
    );
    let e = Env::new();
    e.create();
    e.hook.replace(Some(Box::new(|e| {
        e.db.borrow()
            .execute("DELETE FROM global_settings WHERE key='config'", [])
            .unwrap();
    })));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![8; 16],
                transport
            }
        )),
        Err(Error::Unauthorized)
    );
    assert_eq!(e.paid.get(), 12);
    assert_eq!(
        e.transaction(|db| store::load::<(u64, Id)>(db, "derive"))
            .unwrap(),
        None
    );
}
#[test]
fn changing_default_key_does_not_change_existing_vault_context() {
    let e = Env::new();
    let h = e.create();
    e.hook.replace(Some(Box::new(|e|{e.db.borrow().execute("UPDATE global_settings SET value=json_set(value,'$.key_name','next-key') WHERE key='config'",[]).unwrap();})));
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    let reply = block_on(derive_vault_key(
        &e,
        DeriveKey {
            vault: vec![1; 16],
            operation: vec![8; 16],
            transport,
        },
    ))
    .unwrap();
    assert_eq!(reply.input, key_input(e.canister(), e.owner(), &h).unwrap());
    assert_eq!(e.transaction(|db| store::header(db, &h.id)).unwrap(), h);
}
#[test]
fn vault_deletion_batches_small_chunks_and_metadata_with_bounded_work() {
    let e = Env::new();
    e.create();
    e.transaction(|db|{for n in 0u8..20 {let object=vec![n;16];db.execute("INSERT INTO objects VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",params![vec![1u8;16],object]).unwrap();db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,4096)",params![vec![1u8;16],object,vec![0u8;64]]).unwrap();db.execute("INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,0,?3)",params![vec![1u8;16],object,vec![0u8;17]]).unwrap();}Ok(())}).unwrap();
    for n in 40..43 {
        assert!(matches!(
            e.change(n, Action::DeleteVault { vault: vec![1; 16] }),
            Ok(MutationResult::Progress(false))
        ));
    }
    assert!(matches!(
        e.change(43, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
    assert!(e.transaction(store::list).unwrap().is_empty());
    assert!(matches!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![45; 16]
            }
        )),
        Err(Error::Conflict)
    ));
}
#[test]
fn admitted_upload_can_finish_when_other_work_consumes_shared_headroom() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.transaction(|db|{let fill=TOTAL_MAX-store::content::global_usage(db)?;db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![99u8;16],vec![0u8;64],fill as i64]).unwrap();assert_eq!(store::content::global_usage(db)?,TOTAL_MAX);Ok(())}).unwrap();
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(
            8,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Err(Error::QuotaExceeded)
    ));
    assert!(matches!(
        e.change(
            6,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17]
            }
        ),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(
            7,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}
#[test]
fn fresh_id_duplicate_chunk_preserves_all_remaining_prepaid_receipts() {
    let e = Env::new();
    e.create();
    let first = vec![7u8; CHUNK_MAX];
    let last = vec![8u8; 17];
    let r = BeginRevision {
        vault: vec![1; 16],
        object: vec![3; 16],
        operation: vec![4; 16],
        expected_revision: 0,
        plain_size: 1024 * 1024 + 1,
        manifest: vec![1; 64],
        chunk_hashes: vec![
            Sha256::digest(&first).to_vec(),
            Sha256::digest(&last).to_vec(),
        ],
    };
    e.change(5, Action::BeginRevision(r.clone())).unwrap();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: first.clone(),
        },
    )
    .unwrap();
    e.change(
        8,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: first,
        },
    )
    .unwrap();
    e.transaction(|db|{assert_eq!(db.query_row("SELECT receipt_budget FROM uploads",[],|r|r.get::<_,i64>(0)).unwrap(),2*ops::CHARGE as i64);let fill=TOTAL_MAX-store::content::global_usage(db)?;db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![99u8;16],vec![0u8;64],fill as i64]).unwrap();Ok(())}).unwrap();
    e.change(
        9,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 1,
            bytes: last,
        },
    )
    .unwrap();
    assert!(matches!(
        e.change(
            10,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}
#[test]
fn admitted_upload_receipt_slots_survive_full_journal() {
    let e = Env::new();
    e.create();
    let r = e.begin();
    e.transaction(|db|{let used:i64=db.query_row("SELECT (SELECT count(*) FROM operations WHERE cleanup=0)+(SELECT COALESCE(sum(1+receipt_budget/131072),0) FROM uploads)",[],|r|r.get(0)).unwrap();db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?1) INSERT INTO receipts SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(printf('%016d',x) AS BLOB),zeroblob(32),'true',?2 FROM n",params![10000-used,(e.now()+DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.change(
        6,
        Action::PutChunk {
            upload: r.operation.clone(),
            index: 0,
            bytes: vec![7; 17],
        },
    )
    .unwrap();
    assert!(matches!(
        e.change(
            7,
            Action::CommitRevision {
                upload: r.operation
            }
        ),
        Ok(MutationResult::Revision(_))
    ));
}
