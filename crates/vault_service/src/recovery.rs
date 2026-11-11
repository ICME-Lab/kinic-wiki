//! Current-live-instance recovery authority. Task7 supplies the resumable transition ceremony.
use super::*;
#[derive(candid::CandidType, Serialize, Deserialize, Clone)]
pub struct RecoveryBinding {
    pub owner: candid::Principal,
    pub canister: candid::Principal,
    pub source: Generation,
    pub target: Generation,
    pub operation: Id,
    pub action: String,
    pub candidate_digest: Vec<u8>,
    pub payload_digest: Vec<u8>,
    pub expires: u64,
    pub random: Vec<u8>,
    pub fence: Vec<u8>,
}
/// Call only with a server-persisted challenge. The request cannot supply its own verifier.
pub fn verify_current(
    db: &Connection,
    env: &impl Environment,
    binding: &RecoveryBinding,
    signature: &[u8],
) -> Result<()> {
    if binding.owner != env.owner()
        || binding.canister != env.canister()
        || binding.expires <= env.now()
        || binding.fence != grants::fence(db)?
        || binding.random.len() != 32
        || binding.candidate_digest.len() != 32
        || binding.payload_digest.len() != 32
    {
        return Err(Error::Unauthorized);
    }
    id(&binding.operation)?;
    binding.source.bytes()?;
    binding.target.bytes()?;
    if binding.source.owner != env.owner()
        || binding.target.owner != env.owner()
        || binding.source.canister != env.canister()
        || binding.target.canister != env.canister()
        || binding.source.vault != binding.target.vault
        || binding.source.nonce == binding.target.nonce
    {
        return Err(Error::Unauthorized);
    }
    let h = store::header(db, &binding.source.vault)?;
    if h.generation.as_ref() != Some(&binding.source) || h.recovery_verifier.len() != 32 {
        return Err(Error::Unauthorized);
    }
    let bytes = candid::encode_one(binding).map_err(|_| Error::InvalidInput)?;
    grants::verify(
        &h.recovery_verifier,
        &[b"kinic-vault/recovery-proof/v2\0".as_slice(), &bytes].concat(),
        signature,
    )
}
