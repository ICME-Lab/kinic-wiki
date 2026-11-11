//! Strict and deterministic effective-manifest representation (content AAD remains v1).
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PackedEnvelope {
    pub version: u8,
    pub nonce: String,
    pub ciphertext: String,
}
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub dek: PackedEnvelope,
    pub metadata: PackedEnvelope,
    pub nonces: Vec<String>,
}
fn decode(s: &str) -> Result<Vec<u8>> {
    let b = B64.decode(s).map_err(|_| Error::InvalidInput)?;
    if B64.encode(&b) != s {
        return Err(Error::InvalidInput);
    }
    Ok(b)
}
pub fn parse(bytes: &[u8], chunks: usize) -> Result<Manifest> {
    if bytes.len() > 65536 {
        return Err(Error::InvalidInput);
    }
    // serde's typed struct rejects duplicate fields and trailing bytes.
    let m: Manifest = serde_json::from_slice(bytes).map_err(|_| Error::InvalidInput)?;
    if !matches!(m.version, 1 | 2)
        || m.dek.version != m.version
        || m.metadata.version != 1
        || m.nonces.len() != chunks
        || chunks == 0
        || chunks > 10
    {
        return Err(Error::InvalidInput);
    }
    if decode(&m.dek.nonce)?.len() != 12
        || decode(&m.dek.ciphertext)?.len() != 48
        || decode(&m.metadata.nonce)?.len() != 12
    {
        return Err(Error::InvalidInput);
    }
    let meta = decode(&m.metadata.ciphertext)?;
    if meta.len() < 16 || meta.len() > 8208 {
        return Err(Error::InvalidInput);
    }
    for n in &m.nonces {
        if decode(n)?.len() != 12 {
            return Err(Error::InvalidInput);
        }
    }
    Ok(m)
}
pub fn effective(bytes: &[u8], chunks: usize, wrapper: Option<PackedEnvelope>) -> Result<Vec<u8>> {
    let mut m = parse(bytes, chunks)?;
    if let Some(w) = wrapper {
        if w.version != 2 || decode(&w.nonce)?.len() != 12 || decode(&w.ciphertext)?.len() != 48 {
            return Err(Error::InvalidInput);
        }
        m.version = 2;
        m.dek = w;
    }
    serde_json::to_vec(&m).map_err(|_| Error::Storage)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_fields_and_bad_wrapper_are_rejected() {
        assert!(parse(br#"{"version":2,"version":1}"#, 1).is_err());
        assert!(parse(b"{}", 1).is_err());
    }
}
