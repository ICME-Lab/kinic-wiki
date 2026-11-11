//! Injected integration boundary. Implementations authenticate owner before establishing SQL scope.
use candid::Principal;
use kinic_sqlite_compat::Connection;
use vault_types::{KeyReply, Result};
#[allow(async_fn_in_trait)]
pub trait Environment {
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
