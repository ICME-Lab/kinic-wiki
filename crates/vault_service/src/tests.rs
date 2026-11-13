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
    e.transaction(|db|{for n in 0u8..20 {let object=vec![n;16];db.execute("INSERT INTO objects(owner,vault,object,head) VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1)",params![vec![1u8;16],object]).unwrap();db.execute("INSERT INTO revisions VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,1,NULL,1,?3,'[]',0,4096)",params![vec![1u8;16],object,vec![0u8;64]]).unwrap();db.execute("INSERT INTO revision_chunks VALUES((SELECT owner FROM owner_scope WHERE slot=1),?1,?2,1,0,?3)",params![vec![1u8;16],object,vec![0u8;17]]).unwrap();}db.execute("UPDATE vaults SET cleanup_budget=61",[]).unwrap();Ok(())}).unwrap();
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

#[test]
fn review_creation_failure_keeps_cross_vault_and_cross_method_binding() {
    let e = Env::new();
    let r = CreateVault {
        vault: vec![1; 16],
        operation: vec![2; 16],
    };
    e.fail_public.set(true);
    assert_eq!(
        block_on(create_vault(&e, r.clone())),
        Err(Error::KeyService)
    );
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![3; 16],
                operation: r.operation.clone()
            }
        )),
        Err(Error::Conflict)
    );
    assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
    let h = block_on(create_vault(&e, r)).unwrap();
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(e.transaction(store::list).unwrap().len(), 1);
}
#[test]
fn review_creation_lease_gc_keeps_binding_and_saved_nonce() {
    let e = Env::new();
    e.public_hook.replace(Some(Box::new(|e| {
        e.now.set(e.now() + 301);
        e.transaction(|db| ops::collect(db, e.now())).unwrap();
        assert!(matches!(e.change(2, Action::Collect), Err(Error::Conflict)));
        assert_eq!(
            create_vault(
                e,
                CreateVault {
                    vault: vec![3; 16],
                    operation: vec![2; 16]
                }
            )
            .now_or_never()
            .unwrap(),
            Err(Error::Conflict)
        );
    })));
    assert_eq!(
        block_on(create_vault(
            &e,
            CreateVault {
                vault: vec![1; 16],
                operation: vec![2; 16]
            }
        )),
        Err(Error::Expired)
    );
    let h = e.create();
    assert_eq!(h.nonce, vec![1; 32]);
    assert_eq!(e.randoms.get(), 1);
    assert_eq!(e.transaction(store::list).unwrap().len(), 1);
}
#[test]
fn review_empty_unfunded_collect_cannot_allocate_cleanup_receipts() {
    let e = Env::new();
    e.funded.set(false);
    for owner in 80..82 {
        e.owner.set(Principal::from_slice(&[owner + 10]));
        for n in 0u16..512 {
            let mut operation = vec![0; 16];
            operation[..2].copy_from_slice(&n.to_be_bytes());
            assert!(
                mutate(
                    &e,
                    Mutation {
                        operation,
                        action: Action::Collect
                    }
                )
                .is_err()
            );
        }
    }
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM operations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn review_resource_cleanup_survives_other_owners_full_cleanup_pool() {
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
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,cleanup) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+DAY) as i64]).unwrap();db.execute("UPDATE uploads SET reserved=?1",params![TOTAL_MAX as i64]).unwrap();Ok(())}).unwrap();
    e.funded.set(false);
    let action = Action::CancelUpload {
        vault: r.vault.clone(),
        upload: r.operation,
        job: vec![30; 16],
    };
    assert!(matches!(
        e.change(31, action.clone()),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(32, action.clone()),
        Ok(MutationResult::Progress(true))
    ));
    assert!(matches!(
        e.change(32, action.clone()),
        Ok(MutationResult::Progress(true))
    ));
    assert!(e.change(33, action).is_err());
    assert!(matches!(
        e.change(
            34,
            Action::DeleteVault {
                vault: r.vault.clone()
            }
        ),
        Ok(MutationResult::Progress(true))
    ));
    assert!(
        e.change(35, Action::DeleteVault { vault: r.vault })
            .is_err()
    );
}

#[test]
fn review_no_work_collect_preserves_vault_completion_budget() {
    let e = Env::new();
    e.create();
    e.funded.set(false);
    for n in 30..100 {
        assert!(matches!(e.change(n, Action::Collect), Err(Error::NotFound)));
    }
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT cleanup_budget FROM vaults", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM operations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        Ok(())
    })
    .unwrap();
    assert!(matches!(
        e.change(100, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
}
#[test]
fn review_expired_upload_collection_survives_full_unreserved_pool() {
    let e = Env::new();
    e.create();
    e.begin();
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,cleanup) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+3*DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.now.set(e.now() + DAY);
    e.funded.set(false);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(0))
    ));
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM uploads", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn review_cleanup_credits_follow_commit_retirement_tombstone_and_deletion() {
    let e = Env::new();
    e.create();
    for n in 0u8..11 {
        let id = 20 + n * 3;
        let r = BeginRevision {
            vault: vec![1; 16],
            object: vec![3; 16],
            operation: vec![id; 16],
            expected_revision: n as u64,
            plain_size: 1,
            manifest: vec![1; 64],
            chunk_hashes: vec![Sha256::digest([7; 17]).to_vec()],
        };
        e.change(id, Action::BeginRevision(r.clone())).unwrap();
        e.change(
            id + 1,
            Action::PutChunk {
                upload: r.operation.clone(),
                index: 0,
                bytes: vec![7; 17],
            },
        )
        .unwrap();
        e.change(
            id + 2,
            Action::CommitRevision {
                upload: r.operation,
            },
        )
        .unwrap();
    }
    let budget = || {
        e.transaction(|db| {
            db.query_row("SELECT cleanup_budget FROM vaults", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|_| Error::Storage)
        })
        .unwrap()
    };
    assert_eq!(budget(), 24);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(1))
    ));
    assert_eq!(budget(), 22);
    e.change(
        61,
        Action::DeleteObject {
            vault: vec![1; 16],
            object: vec![3; 16],
            expected_revision: 11,
        },
    )
    .unwrap();
    assert_eq!(budget(), 23);
    e.funded.set(false);
    for (id, remaining) in [(70, 13), (71, 2), (72, 1), (73, 0)] {
        assert!(
            matches!(e.change(id,Action::DeleteVault{vault:vec![1;16]}),Ok(MutationResult::Progress(done)) if done==(remaining==0))
        );
        assert_eq!(budget(), remaining);
    }
    assert!(matches!(
        e.change(73, Action::DeleteVault { vault: vec![1; 16] }),
        Ok(MutationResult::Progress(true))
    ));
    let count = || {
        e.transaction(|db| {
            db.query_row("SELECT count(*) FROM operations WHERE cleanup=2", [], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|_| Error::Storage)
        })
        .unwrap()
    };
    let before = count();
    assert!(
        e.change(74, Action::DeleteVault { vault: vec![1; 16] })
            .is_err()
    );
    assert_eq!(count(), before);
    assert_eq!(budget(), 0);
}

fn committed_document(e: &Env) -> BeginRevision {
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
    e.change(
        7,
        Action::CommitRevision {
            upload: r.operation.clone(),
        },
    )
    .unwrap();
    r
}
#[test]
fn review_purge_hides_history_and_reclaims_boundedly_without_credit() {
    let e = Env::new();
    let r = committed_document(&e);
    for revision in 1u8..11 {
        let id = 100 + revision * 3;
        let mut next = r.clone();
        next.operation = vec![id; 16];
        next.expected_revision = revision as u64;
        e.change(id, Action::BeginRevision(next.clone())).unwrap();
        e.change(
            id + 1,
            Action::PutChunk {
                upload: next.operation.clone(),
                index: 0,
                bytes: vec![7; 17],
            },
        )
        .unwrap();
        e.change(
            id + 2,
            Action::CommitRevision {
                upload: next.operation,
            },
        )
        .unwrap();
    }
    let action = Action::PurgeObject {
        vault: r.vault.clone(),
        object: r.object.clone(),
        expected_revision: 11,
    };
    e.transaction(|db|{db.execute("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1024) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,cleanup) SELECT X'50',CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',?1,x,0,1 FROM n",params![(e.now()+DAY) as i64]).unwrap();Ok(())}).unwrap();
    e.funded.set(false);
    assert!(matches!(
        e.change(60, action.clone()),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(
        e.change(60, action.clone()),
        Ok(MutationResult::Done)
    ));
    assert!(matches!(e.change(61, action), Err(Error::Conflict)));
    e.transaction(|db| {
        for revision in 1..=11 {
            assert!(matches!(
                store::content::manifest(db, &r.vault, &r.object, revision),
                Err(Error::NotFound)
            ));
        }
        assert!(matches!(
            store::content::chunk(db, &r.vault, &r.object, 1, 0),
            Err(Error::NotFound)
        ));
        assert!(
            store::content::history(db, &r.vault, &r.object, u64::MAX)?
                .entries
                .is_empty()
        );
        assert!(
            store::content::objects(db, &r.vault, &[])?
                .entries
                .is_empty()
        );
        assert_eq!(store::content::quota(db, &r.vault)?.current, 0);
        Ok(())
    })
    .unwrap();
    let before = e.transaction(store::content::usage).unwrap();
    assert!(matches!(
        e.change(62, Action::Collect),
        Ok(MutationResult::Collected(1))
    ));
    assert!(e.transaction(store::content::usage).unwrap() < before);
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM revisions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            10
        );
        Ok(())
    })
    .unwrap();
    for id in 150..160 {
        assert!(matches!(
            e.change(id, Action::Collect),
            Ok(MutationResult::Collected(1))
        ));
    }
    e.funded.set(true);
    for expected in [0, 11] {
        let mut next = r.clone();
        next.operation = vec![80; 16];
        next.expected_revision = expected;
        assert!(matches!(
            e.change(80, Action::BeginRevision(next)),
            Err(Error::Conflict)
        ));
    }
    e.transaction(|db| {
        assert_eq!(
            db.query_row("SELECT count(*) FROM revision_chunks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT head FROM objects", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            11
        );
        Ok(())
    })
    .unwrap();
    e.funded.set(false);
    assert!(matches!(
        e.change(
            90,
            Action::DeleteVault {
                vault: r.vault.clone()
            }
        ),
        Ok(MutationResult::Progress(false))
    ));
    assert!(matches!(
        e.change(91, Action::DeleteVault { vault: r.vault }),
        Ok(MutationResult::Progress(true))
    ));
}
#[test]
fn review_purge_fences_revision_owner_and_active_upload() {
    let e = Env::new();
    let r = committed_document(&e);
    let action = Action::PurgeObject {
        vault: r.vault.clone(),
        object: r.object.clone(),
        expected_revision: 1,
    };
    assert!(matches!(
        e.change(
            60,
            Action::PurgeObject {
                vault: r.vault.clone(),
                object: r.object.clone(),
                expected_revision: 0
            }
        ),
        Err(Error::Conflict)
    ));
    e.owner.set(Principal::from_slice(&[2]));
    assert!(e.change(61, action.clone()).is_err());
    e.owner.set(Principal::from_slice(&[1]));
    let mut next = r.clone();
    next.operation = vec![70; 16];
    next.expected_revision = 1;
    e.change(71, Action::BeginRevision(next.clone())).unwrap();
    assert!(matches!(e.change(62, action.clone()), Err(Error::Conflict)));
    e.change(
        72,
        Action::CancelUpload {
            vault: r.vault.clone(),
            upload: next.operation,
            job: vec![73; 16],
        },
    )
    .unwrap();
    assert!(matches!(e.change(62, action), Ok(MutationResult::Done)));
    assert!(matches!(
        e.change(
            62,
            Action::PurgeObject {
                vault: r.vault,
                object: r.object,
                expected_revision: 2
            }
        ),
        Err(Error::Conflict)
    ));
}

#[test]
fn review_collect_records_progress_when_only_expired_receipt_remains() {
    let e = Env::new();
    e.create();
    e.now.set(e.now() + DAY + 1);
    e.funded.set(false);
    assert!(matches!(
        e.change(60, Action::Collect),
        Ok(MutationResult::Collected(0))
    ));
    assert!(matches!(
        e.change(61, Action::Collect),
        Err(Error::NotFound)
    ));
}

#[test]
fn fresh_key_admission_at_full_shared_content_and_ordinary_receipts() {
    let e = Env::new();
    e.create();
    e.owner.set(Principal::from_slice(&[2]));
    e.create();
    e.owner.set(Principal::from_slice(&[1]));
    e.transaction(|db| {
        // Fill both the owner's and global ordinary row limit; the other owner's
        // live revision below consumes the shared content headroom independently.
        db.execute("DELETE FROM operations WHERE owner=X'02'", []).unwrap();
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999) INSERT INTO operations(owner,operation,digest,result,expires,token,runtime,cleanup) SELECT (SELECT owner FROM owner_scope WHERE slot=1),CAST(printf('%016d',x) AS BLOB),zeroblob(32),X'00',999999,x+100,0,0 FROM n", []).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND cleanup=0",[],|r|r.get::<_,i64>(0)).unwrap(),10000);
        assert_eq!(store::content::check_receipt_capacity(db, e.now()), Err(Error::QuotaExceeded));
        let extra = TOTAL_MAX - store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![3u8;16],vec![0u8;64],extra as i64]).unwrap();
        assert_eq!(store::content::global_usage(db)?, TOTAL_MAX);
        assert!(store::load::<(u64, Id)>(db, "derive")?.is_none());
        Ok(())
    }).unwrap();
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![99; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    let first = block_on(derive_vault_key(&e, request.clone())).unwrap();
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())).unwrap(),
        first
    );
    assert_eq!(e.derives.get(), 1);
    assert_eq!(e.paid.get(), 12);
    let mut changed = request;
    changed.transport = ic_vetkeys::TransportSecretKey::from_seed(vec![9; 32])
        .unwrap()
        .public_key();
    assert_eq!(
        block_on(derive_vault_key(&e, changed)),
        Err(Error::Conflict)
    );
    e.transaction(|db| {
        assert_eq!(store::content::global_usage(db)?, TOTAL_MAX);
        assert!(store::content::usage(db)? <= TOTAL_MAX);
        Ok(())
    })
    .unwrap();
}

#[test]
fn normal_key_admission_preserves_rates_and_reuses_transient_control_across_owners() {
    let e = Env::new();
    let transport = ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
        .unwrap()
        .public_key();
    for owner in 1..=9 {
        e.owner.set(Principal::from_slice(&[owner + 10]));
        e.create();
        for n in 0..if owner == 1 { 100 } else { 1 } {
            block_on(derive_vault_key(
                &e,
                DeriveKey {
                    vault: vec![1; 16],
                    operation: vec![n + 20; 16],
                    transport: transport.clone(),
                },
            ))
            .unwrap();
            assert!(
                e.transaction(|db| store::load::<(u64, Id)>(db, "derive"))
                    .unwrap()
                    .is_none()
            );
        }
    }
    e.owner.set(Principal::from_slice(&[11]));
    assert_eq!(
        block_on(derive_vault_key(
            &e,
            DeriveKey {
                vault: vec![1; 16],
                operation: vec![200; 16],
                transport
            }
        )),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM operations WHERE cleanup=3", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn protected_key_callback_is_bounded_and_cannot_publish_after_cancellation() {
    let e = Env::new();
    e.create();
    e.transaction(|db| {
        let extra = TOTAL_MAX - store::content::global_usage(db)?;
        db.execute(
            "INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",
            params![vec![1u8; 16], vec![3u8; 16], vec![0u8; 64], extra as i64],
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    e.hook.replace(Some(Box::new(|e| {
        e.transaction(|db| {
            assert_eq!(store::content::global_usage(db)?,TOTAL_MAX);
            let (token,_)=store::load::<(u64,Id)>(db,"derive")?.unwrap();
            assert_eq!(store::keys::cancel_pending(db,e.now())?,Some((token,20,false)));
            db.execute("DELETE FROM settings WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND key='derive'",[]).unwrap();
            Ok(())
        }).unwrap();
    })));
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![90; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::Expired)
    );
    assert_eq!(e.paid.get(), 12);
    assert_eq!(
        e.transaction(|db| ops::replay::<KeyReply>(
            db,
            &request.operation,
            &ops::digest(b"derive-vault-key/v1", &request)?,
            e.now()
        ))
        .unwrap(),
        None
    );
}

#[test]
fn protected_key_admission_keeps_combined_rates_inflight_credit_and_owner_checks_atomic() {
    let e = Env::new();
    e.create();
    e.transaction(|db| {
        db.execute("WITH RECURSIVE n(x) AS (SELECT 1000 UNION ALL SELECT x+1 FROM n WHERE x<1098) INSERT INTO key_flights(owner,token,day,reserved,actual,created,settled,in_flight) SELECT X'01',x,0,30000000000,0,100,100,0 FROM n",[]).unwrap();
        let extra=TOTAL_MAX-store::content::global_usage(db)?;
        db.execute("INSERT INTO revisions VALUES(X'02',?1,?2,1,1,NULL,1,?3,'[]',0,?4)",params![vec![1u8;16],vec![3u8;16],vec![0u8;64],extra as i64]).unwrap();
        Ok(())
    }).unwrap();
    let request = DeriveKey {
        vault: vec![1; 16],
        operation: vec![90; 16],
        transport: ic_vetkeys::TransportSecretKey::from_seed(vec![8; 32])
            .unwrap()
            .public_key(),
    };
    e.funded.set(false);
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::QuotaExceeded)
    );
    e.funded.set(true);
    e.owner.set(Principal::from_slice(&[2]));
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::NotFound)
    );
    e.owner.set(Principal::anonymous());
    assert_eq!(
        block_on(derive_vault_key(&e, request.clone())),
        Err(Error::Unauthorized)
    );
    e.owner.set(Principal::from_slice(&[1]));
    let mut invalid = request.clone();
    invalid.transport = vec![0; 48];
    assert_eq!(
        block_on(derive_vault_key(&e, invalid)),
        Err(Error::InvalidInput)
    );
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM operations WHERE cleanup=3", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    let mut next = request.clone();
    next.operation = vec![91; 16];
    let competing = next.clone();
    e.hook.replace(Some(Box::new(move |e| {
        assert_eq!(
            derive_vault_key(e, competing).now_or_never().unwrap(),
            Err(Error::Busy)
        );
        assert_eq!(
            e.db.borrow()
                .query_row("SELECT count(*) FROM operations WHERE cleanup=3", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    })));
    block_on(derive_vault_key(&e, request)).unwrap();
    assert_eq!(
        block_on(derive_vault_key(&e, next)),
        Err(Error::QuotaExceeded)
    );
    assert_eq!(e.derives.get(), 1);
    assert_eq!(
        e.db.borrow()
            .query_row("SELECT count(*) FROM operations WHERE cleanup=3", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(
        e.transaction(|db| store::load::<(u64, Id)>(db, "derive"))
            .unwrap()
            .is_none()
    );
}
