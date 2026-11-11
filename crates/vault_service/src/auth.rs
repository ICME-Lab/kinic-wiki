use super::Ceremony;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use passkey_auth::*;
use vault_types::{Config, Error, Result};
fn verifier(c: &Config) -> Webauthn {
    Webauthn::new(&c.rp_id, "Kinic Vault", &c.origin)
        .require_user_verification(true)
        .strict_base64(true)
}
fn precheck(json: &str) -> Result<()> {
    if json.len() > 65536 {
        return Err(Error::InvalidInput);
    }
    let v: serde_json::Value = serde_json::from_str(json).map_err(|_| Error::InvalidProof)?;
    let encoded = v
        .get("clientDataJSON")
        .and_then(|x| x.as_str())
        .ok_or(Error::InvalidProof)?;
    let raw = B64.decode(encoded).map_err(|_| Error::InvalidProof)?;
    let data: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| Error::InvalidProof)?;
    if data.get("crossOrigin").is_some_and(|x| x != false) || data.get("topOrigin").is_some() {
        return Err(Error::InvalidProof);
    }
    Ok(())
}
pub fn registration(cfg: &Config, ch: &Ceremony, json: &str) -> Result<PasskeyCredential> {
    precheck(json)?;
    let response: RegistrationResponse =
        serde_json::from_str(json).map_err(|_| Error::InvalidProof)?;
    let state = RegistrationState {
        challenge: Challenge(ch.challenge.bytes.clone()),
        user_id: cfg.owner.as_slice().to_vec(),
        created_at: ch.created,
    };
    let result = verifier(cfg)
        .finish_registration(&state, &response)
        .map_err(|_| Error::InvalidProof)?;
    if result.public_key_cose.0.len() > 1024
        || result.transports.len() > 8
        || result.transports.iter().any(|x| x.len() > 32)
        || result.id.0.is_empty()
        || result.id.0.len() > 1024
        || B64.decode(&response.id).map_err(|_| Error::InvalidProof)? != result.id.0
    {
        return Err(Error::InvalidProof);
    }
    Ok(result)
}
pub fn assertion(
    cfg: &Config,
    ch: &Ceremony,
    creds: Vec<PasskeyCredential>,
    json: &str,
) -> Result<PasskeyCredential> {
    precheck(json)?;
    let response: AuthenticationResponse =
        serde_json::from_str(json).map_err(|_| Error::InvalidProof)?;
    let id = B64.decode(&response.id).map_err(|_| Error::InvalidProof)?;
    let mut credential = creds
        .into_iter()
        .find(|c| c.id.0 == id)
        .ok_or(Error::InvalidProof)?;
    let state = AuthenticationState {
        challenge: Challenge(ch.challenge.bytes.clone()),
        allow_credentials: ch
            .challenge
            .credential_ids
            .iter()
            .cloned()
            .map(CredentialId)
            .collect(),
        created_at: ch.created,
        user_handle: Some(cfg.owner.as_slice().to_vec()),
    };
    let outcome = verifier(cfg)
        .finish_authentication(&state, &response, &credential)
        .map_err(|_| Error::InvalidProof)?;
    if !outcome.user_verified {
        return Err(Error::InvalidProof);
    }
    credential.counter = outcome.new_counter;
    Ok(credential)
}
