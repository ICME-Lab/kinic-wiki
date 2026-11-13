//! The production adapter binds this environment to the authenticated caller.
use candid::Principal;
use kinic_sqlite_compat::Connection;
use vault_types::*;
#[allow(async_fn_in_trait)]
pub trait Environment {
    fn owner(&self) -> Principal;
    fn canister(&self) -> Principal;
    fn now(&self) -> u64;
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T>;
    fn require_spending(&self) -> Result<()>;
    fn reserve_cycles(&self, token: u64, amount: u64) -> Result<()>;
    fn settle_cycles(&self, token: u64, actual: u64) -> Result<()>;
    fn checkpoint_execution(&self) -> Result<()>;
    fn required_derive_payment(&self, name: &str) -> u64;
    fn actual_derive_payment(&self, attached: u64) -> u64;
    fn recover_pending(&self, db: &Connection, target: Option<&[u8]>) -> Result<bool>;
    fn reconcile_key_gc(&self, db: &Connection, owners: &[Principal]) -> Result<()>;
    fn settle_key_reservation(&self, token: u64, actual: u64) -> Result<bool>;
    async fn random(&self) -> Result<Vec<u8>>;
    async fn public_key(&self, name: &str) -> Result<Vec<u8>>;
    async fn derive_key(&self, name: &str, input: Vec<u8>, transport: Vec<u8>) -> Result<Vec<u8>>;
}
pub fn settle_key_reservation_in(
    db: &Connection,
    token: u64,
    now: u64,
    actual: u64,
) -> Result<bool> {
    let current = vault_store::keys::current(db)?.is_some_and(|(t, _)| t == token);
    vault_store::keys::settle(db, token, now, actual)?;
    Ok(current)
}
