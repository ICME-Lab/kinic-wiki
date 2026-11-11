//! Portable v2 identity. All integers are big endian; variable fields are u32 length prefixed.
use super::*;
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Generation {
    pub version: u8,
    pub canister: Principal,
    pub owner: Principal,
    pub vault: Id,
    pub epoch: u64,
    pub nonce: Vec<u8>,
    pub key_name: String,
}
pub const GENERATION_DOMAIN: &[u8] = b"kinic-vault/generation/v2";
pub const KEY_CONTEXT_V2: &[u8] = b"kinic-vault/kek/v2";
pub fn next_epoch(epoch: u64) -> Result<u64> {
    epoch
        .checked_add(1)
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(Error::QuotaExceeded)
}
pub fn sized(out: &mut Vec<u8>, part: &[u8]) {
    out.extend_from_slice(&(part.len() as u32).to_be_bytes());
    out.extend_from_slice(part);
}
impl Generation {
    pub fn bytes(&self) -> Result<Vec<u8>> {
        id(&self.vault)?;
        if self.version != 2
            || self.nonce.len() != 32
            || self.key_name.is_empty()
            || self.key_name.len() > 64
            || self.epoch > i64::MAX as u64
            || self.owner == Principal::anonymous()
            || self.owner == Principal::management_canister()
            || self.canister == Principal::anonymous()
            || self.canister == Principal::management_canister()
        {
            return Err(Error::InvalidInput);
        }
        let mut out = Vec::new();
        sized(&mut out, GENERATION_DOMAIN);
        out.push(self.version);
        sized(&mut out, self.canister.as_slice());
        sized(&mut out, self.owner.as_slice());
        out.extend_from_slice(&self.vault);
        out.extend_from_slice(&self.epoch.to_be_bytes());
        out.extend_from_slice(&self.nonce);
        sized(&mut out, self.key_name.as_bytes());
        Ok(out)
    }
    pub fn key_input(&self) -> Result<Vec<u8>> {
        let mut out = b"kinic-vault/key-input/v2".to_vec();
        out.extend_from_slice(&self.bytes()?);
        Ok(out)
    }
    pub fn aad(&self, object: &[u8], revision: u64, purpose: &str) -> Result<Vec<u8>> {
        id(object)?;
        if !matches!(purpose, "normal" | "recovery" | "dek") {
            return Err(Error::InvalidInput);
        }
        let mut out = Vec::new();
        sized(&mut out, b"kinic-vault/envelope/v2");
        sized(&mut out, &self.bytes()?);
        sized(&mut out, object);
        sized(&mut out, &revision.to_be_bytes());
        sized(&mut out, purpose.as_bytes());
        Ok(out)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_is_complete_and_epoch_is_sql_safe() {
        let a = Generation {
            version: 2,
            canister: Principal::from_slice(&[1]),
            owner: Principal::from_slice(&[2]),
            vault: vec![3; 16],
            epoch: 7,
            nonce: vec![4; 32],
            key_name: "key_1".into(),
        };
        let bytes = a.bytes().unwrap();
        let mut b = a.clone();
        b.nonce[0] ^= 1;
        assert_ne!(bytes, b.bytes().unwrap());
        b = a.clone();
        b.canister = Principal::from_slice(&[5]);
        assert_ne!(bytes, b.bytes().unwrap());
        b = a.clone();
        b.owner = Principal::from_slice(&[6]);
        assert_ne!(bytes, b.bytes().unwrap());
        assert_eq!(next_epoch(i64::MAX as u64), Err(Error::QuotaExceeded));
        assert_eq!(next_epoch(7), Ok(8));
    }
}
