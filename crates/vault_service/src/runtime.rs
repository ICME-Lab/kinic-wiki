//! Injected integration boundary. Implementations authenticate owner before establishing SQL scope.
use candid::Principal;
use kinic_sqlite_compat::Connection;
use vault_types::{KeyReply, Result};
#[allow(async_fn_in_trait)]
pub trait Environment {
    /// Exact allocation accounting survives cancellation/runtime fencing. Read only.
    fn challenge_pending(&self, _db: &Connection, _token: u64) -> Result<bool> {
        Ok(false)
    }
    fn owner(&self) -> Principal;
    fn canister(&self) -> Principal {
        Principal::from_slice(&[1])
    }
    /// Private service wrappers alone mint this capability in production.
    fn mutation_authorized(&self) -> bool {
        false
    }
    fn now(&self) -> u64;
    fn balance(&self) -> u128;
    fn transaction<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T>;
    fn require_spending(&self) -> Result<()>;
    fn cleanup_existing_flights(
        &self,
        _db: &Connection,
        _targets: &[vault_types::Id],
        _cancel_live: bool,
    ) -> Result<bool> {
        Ok(true)
    }
    /// Called only for principals selected from server-owned completed key rows.
    /// Embedders with account tables settle old cached storage through now, then refresh usage.
    fn reconcile_key_gc(&self, _db: &Connection, _owners: &[Principal]) -> Result<()> {
        Ok(())
    }
    fn reserve_challenge(&self, _token: u64) -> Result<()> {
        Ok(())
    }
    fn settle_challenge(&self, _token: u64) -> Result<()> {
        Ok(())
    }
    fn checkpoint_execution(&self) -> Result<()> {
        Ok(())
    }
    fn reserve_cycles(&self, token: u64, amount: u64) -> Result<()>;
    fn settle_cycles(&self, token: u64, actual: u64) -> Result<()>;
    /// Bookkeeping only: settle this owner's exact token and release only its control flight.
    /// Private authorized wrappers delegate to the raw owner environment after publication expires.
    fn settle_key_reservation(&self, token: u64, actual: u64) -> Result<bool> {
        self.transaction(|db| settle_key_reservation_in(db, token, self.now(), actual))
    }

    fn actual_derive_payment(&self, attached: u64) -> u64 {
        attached
    }
    fn required_derive_payment(&self, key_name: &str) -> u64;
    async fn random(&self) -> Result<Vec<u8>>;
    async fn public_key(&self, key_name: &str) -> Result<Vec<u8>>;
    async fn derive_key(
        &self,
        key_name: &str,
        input: Vec<u8>,
        transport: Vec<u8>,
    ) -> Result<Vec<u8>>;
}
pub fn validate_key_reply(reply: KeyReply) -> Result<KeyReply> {
    ic_vetkeys::DerivedPublicKey::deserialize(&reply.public_key)
        .map_err(|_| vault_types::Error::KeyService)?;
    ic_vetkeys::EncryptedVetKey::deserialize(&reply.encrypted_key)
        .map_err(|_| vault_types::Error::KeyService)?;
    Ok(reply)
}

/// Narrow accounting-only callback; the embedding adapter supplies authenticated owner scope.
/// No key material, authorization, namespace initialization or arbitrary mutation is exposed.
pub fn settle_key_reservation_in(
    db: &Connection,
    token: u64,
    now: u64,
    actual: u64,
) -> Result<bool> {
    vault_store::keys::settle(db, token, now, actual)?;
    let mut c = crate::control(db)?;
    let current = c.derive.as_ref().is_some_and(|f| f.token == token);
    if current {
        c.derive = None;
        vault_store::save(db, "control", &c)?;
    }
    Ok(current)
}

pub(crate) fn collect_completed_key_rows(db: &Connection, env: &impl Environment) -> Result<()> {
    let owners = vault_store::keys::collect_completed(db, env.now())?;
    env.reconcile_key_gc(db, &owners)
}
