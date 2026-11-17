use super::*;
use candid::Principal;
use futures::{FutureExt, executor::block_on};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use store::kinic_sqlite_compat::Connection;
fn vault_id(serial: u64) -> Id {
    (serial as u128).to_be_bytes().to_vec()
}
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
    fail_random: Cell<bool>,
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
            fail_random: Cell::new(false),
            hook: RefCell::new(None),
            random_hook: RefCell::new(None),
            public_hook: RefCell::new(None),
        }
    }
    fn create(&self) -> Header {
        block_on(create_vault(
            self,
            CreateVault {
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
            vault: vault_id(1),
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
            store::keys::current(db)
                .unwrap()
                .is_some_and(|(_, id)| id == v)
        }) {
            store::keys::cancel_pending(db, self.now())?;
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
        if self.fail_random.replace(false) {
            return Err(Error::KeyService);
        }
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

mod cleanup;
mod creation;
mod keys;
mod uploads;

mod inline;
