// Where: crates/vfs_cli_app/src/identity.rs
// What: Load the active icp-cli identity for authenticated canister calls.
// Why: kinic-vfs-cli updates must use the caller selected by `icp identity default`.
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use ic_agent::export::Principal;
use ic_agent::identity::{DelegatedIdentity, Delegation, SignedDelegation};
use serde::Deserialize;
use tokio::process::Command;

pub async fn load_default_identity(
    canister_id: &str,
    allow_non_ii_identity: bool,
) -> Result<Box<dyn ic_agent::Identity>> {
    let identity_name = command_stdout("icp", &["identity", "default"])
        .await
        .context("failed to read active icp-cli identity")?;
    let identity_name = identity_name.trim();
    if identity_name.is_empty() {
        bail!("active icp-cli identity is empty");
    }
    let identity_dir = default_identity_dir()?;
    let metadata = read_identity_metadata(&identity_dir, identity_name)?;
    match metadata.kind.as_str() {
        "internet-identity" => {
            let session_pem = export_identity_pem(identity_name).await?;
            load_internet_identity(&identity_dir, identity_name, &session_pem, canister_id)
        }
        "pending-delegation" => Err(refresh_required(identity_name)),
        "anonymous" => bail!("active icp-cli identity `{identity_name}` is anonymous"),
        kind => {
            ensure_identity_kind_allowed(kind, identity_name, allow_non_ii_identity)?;
            let identity_pem = export_identity_pem(identity_name).await?;
            vfs_client::identity_from_pem(&identity_pem)
        }
    }
}

fn ensure_identity_kind_allowed(
    kind: &str,
    identity_name: &str,
    allow_non_ii_identity: bool,
) -> Result<()> {
    if allow_non_ii_identity {
        return Ok(());
    }
    bail!(
        "active icp-cli identity `{identity_name}` is `{kind}`, but kinic-vfs-cli defaults to Internet Identity; run `icp identity link ii <name> --host https://<wiki-canister-id>.icp0.io` and `icp identity default <name>`, or pass `--allow-non-ii-identity`"
    )
}

async fn export_identity_pem(identity_name: &str) -> Result<Vec<u8>> {
    command_stdout_bytes("icp", &["identity", "export", identity_name])
        .await
        .with_context(|| format!("failed to export icp-cli identity `{identity_name}`"))
}

fn load_internet_identity(
    identity_dir: &Path,
    identity_name: &str,
    session_pem: &[u8],
    canister_id: &str,
) -> Result<Box<dyn ic_agent::Identity>> {
    let session_identity = vfs_client::identity_from_pem(session_pem)
        .with_context(|| format!("failed to parse session key for `{identity_name}`"))?;
    let delegation_path = identity_dir
        .join("delegations")
        .join(format!("{identity_name}.json"));
    let chain = std::fs::read_to_string(&delegation_path).map_err(|error| {
        let _ = error;
        refresh_required(identity_name)
    })?;
    let stored: StoredDelegationChain = serde_json::from_str(&chain)
        .with_context(|| format!("failed to parse {}", delegation_path.display()))?;
    let public_key = decode_hex_field(&stored.public_key, "publicKey")?;
    let now_nanos = now_nanos()?;
    let delegations = parse_signed_delegations(&stored, now_nanos, identity_name)?;
    ensure_delegation_matches_session_key(&*session_identity, &delegations, identity_name)?;
    let target_canister = Principal::from_text(canister_id)
        .with_context(|| format!("invalid target canister id `{canister_id}`"))?;
    ensure_delegation_targets_canister(&delegations, &target_canister, identity_name)?;
    let identity = DelegatedIdentity::new_unchecked(public_key, session_identity, delegations);
    Ok(Box::new(identity))
}

fn parse_signed_delegations(
    stored: &StoredDelegationChain,
    now_nanos: u64,
    identity_name: &str,
) -> Result<Vec<SignedDelegation>> {
    if stored.delegations.is_empty() {
        return Err(refresh_required(identity_name));
    }
    stored
        .delegations
        .iter()
        .enumerate()
        .map(|(index, signed)| {
            let expiration = parse_expiration(&signed.delegation.expiration)
                .with_context(|| format!("invalid delegation expiration at index {index}"))?;
            if expiration <= now_nanos {
                return Err(refresh_required(identity_name));
            }
            let targets = signed
                .delegation
                .targets
                .as_ref()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| {
                            Principal::from_text(value)
                                .with_context(|| format!("invalid delegation target `{value}`"))
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .transpose()?;
            Ok(SignedDelegation {
                delegation: Delegation {
                    pubkey: decode_hex_field(&signed.delegation.pubkey, "delegation.pubkey")?,
                    expiration,
                    targets,
                },
                signature: decode_hex_field(&signed.signature, "signature")?,
            })
        })
        .collect()
}

fn ensure_delegation_matches_session_key(
    session_identity: &dyn ic_agent::Identity,
    delegations: &[SignedDelegation],
    identity_name: &str,
) -> Result<()> {
    let session_public_key = session_identity
        .public_key()
        .ok_or_else(|| anyhow!("exported session key for `{identity_name}` has no public key"))?;
    let delegated_public_key = delegations
        .last()
        .ok_or_else(|| refresh_required(identity_name))?
        .delegation
        .pubkey
        .as_slice();
    if delegated_public_key != session_public_key.as_slice() {
        bail!(
            "icp-cli Internet Identity delegation for `{identity_name}` does not match the exported session key; run `icp identity login {identity_name}`"
        );
    }
    Ok(())
}

fn ensure_delegation_targets_canister(
    delegations: &[SignedDelegation],
    target_canister: &Principal,
    identity_name: &str,
) -> Result<()> {
    for (index, signed) in delegations.iter().enumerate() {
        let Some(targets) = &signed.delegation.targets else {
            continue;
        };
        if targets.iter().any(|target| target == target_canister) {
            continue;
        }
        let target_canister = target_canister.to_text();
        bail!(
            "icp-cli Internet Identity delegation for `{identity_name}` is target-limited and does not include canister `{target_canister}` at delegation index {index}"
        );
    }
    Ok(())
}

fn read_identity_metadata(identity_dir: &Path, identity_name: &str) -> Result<IdentityMetadata> {
    let list_path = identity_dir.join("identity_list.json");
    let list = std::fs::read_to_string(&list_path)
        .with_context(|| format!("failed to read {}", list_path.display()))?;
    let identities: IdentityList = serde_json::from_str(&list)
        .with_context(|| format!("failed to parse {}", list_path.display()))?;
    identities
        .identities
        .get(identity_name)
        .cloned()
        .ok_or_else(|| {
            anyhow!("icp-cli identity `{identity_name}` was not found in identity_list.json")
        })
}

fn default_identity_dir() -> Result<PathBuf> {
    if let Some(icp_home) = env::var_os("ICP_HOME") {
        return Ok(PathBuf::from(icp_home).join("identity"));
    }
    let home = env::var_os("HOME").map(PathBuf::from);
    identity_dir_from_env(home, env::var_os("APPDATA").map(PathBuf::from))
}

fn identity_dir_from_env(home: Option<PathBuf>, appdata: Option<PathBuf>) -> Result<PathBuf> {
    if cfg!(target_os = "windows") {
        let appdata = appdata.ok_or_else(|| anyhow!("APPDATA is not set"))?;
        return Ok(appdata.join("icp-cli").join("data").join("identity"));
    }
    let home = home.ok_or_else(|| anyhow!("HOME is not set"))?;
    if cfg!(target_os = "macos") {
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("org.dfinity.icp-cli")
            .join("identity"))
    } else {
        Ok(home
            .join(".local")
            .join("share")
            .join("icp-cli")
            .join("identity"))
    }
}

fn decode_hex_field(value: &str, field: &str) -> Result<Vec<u8>> {
    let hex_value = value.strip_prefix("0x").unwrap_or(value);
    hex::decode(hex_value).with_context(|| format!("invalid hex in {field}"))
}

fn parse_expiration(value: &str) -> Result<u64> {
    let hex_value = value.strip_prefix("0x").unwrap_or(value);
    u64::from_str_radix(hex_value, 16).context("expiration is not hex u64")
}

fn now_nanos() -> Result<u64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system time is before UNIX_EPOCH")?;
    u64::try_from(duration.as_nanos()).context("system time nanoseconds overflowed u64")
}

fn refresh_required(identity_name: &str) -> anyhow::Error {
    anyhow!(
        "icp-cli Internet Identity delegation for `{identity_name}` is missing, pending, or expired; run `icp identity login {identity_name}`"
    )
}

async fn command_stdout(command: &str, args: &[&str]) -> Result<String> {
    let bytes = command_stdout_bytes(command, args).await?;
    String::from_utf8(bytes).context("command output was not UTF-8")
}

async fn command_stdout_bytes(command: &str, args: &[&str]) -> Result<Vec<u8>> {
    let output = Command::new(command)
        .args(args)
        .output()
        .await
        .with_context(|| format!("failed to run `{}`", command_line(command, args)))?;
    if !output.status.success() {
        return Err(anyhow!(
            "`{}` failed: {}",
            command_line(command, args),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn command_line(command: &str, args: &[&str]) -> String {
    std::iter::once(command)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Debug, Clone, Deserialize)]
struct IdentityList {
    identities: HashMap<String, IdentityMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
struct IdentityMetadata {
    kind: String,
}

#[derive(Debug, Deserialize)]
struct StoredDelegationChain {
    #[serde(rename = "publicKey")]
    public_key: String,
    delegations: Vec<StoredSignedDelegation>,
}

#[derive(Debug, Deserialize)]
struct StoredSignedDelegation {
    signature: String,
    delegation: StoredDelegation,
}

#[derive(Debug, Deserialize)]
struct StoredDelegation {
    pubkey: String,
    expiration: String,
    targets: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ic_agent::Identity;

    const ROOT_SECP256K1_PEM: &str = "-----BEGIN EC PARAMETERS-----\nBgUrgQQACg==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIAgy7nZEcVHkQ4Z1Kdqby8SwyAiyKDQmtbEHTIM+WNeBoAcGBSuBBAAK\noUQDQgAEgO87rJ1ozzdMvJyZQ+GABDqUxGLvgnAnTlcInV3NuhuPv4O3VGzMGzeB\nN3d26cRxD99TPtm8uo2OuzKhSiq6EQ==\n-----END EC PRIVATE KEY-----\n";
    const ROOT_PUBLIC_KEY_HEX: &str = "3056301006072a8648ce3d020106052b8104000a0342000480ef3bac9d68cf374cbc9c9943e180043a94c462ef8270274e57089d5dcdba1b8fbf83b7546ccc1b3781377776e9c4710fdf533ed9bcba8d8ebb32a14a2aba11";
    const CANISTER_SIGNATURE_ROOT_PUBLIC_KEY_HEX: &str = "303c300c060a2b0601040183b8430102032c000a000000000000000701019e63ea315f972f402b1817d6cffacace890908573c288b3c3aae61ef799e5924";
    const SESSION_PRIME256V1_PEM: &str = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIL1ybmbwx+uKYsscOZcv71MmKhrNqfPP0ke1unET5AY4oAoGCCqGSM49\nAwEHoUQDQgAEUbbZV4NerZTPWfbQ749/GNLu8TaH8BUS/I7/+ipsu+MPywfnBFIZ\nSks4xGbA/ZbazsrMl4v446U5UIVxCGGaKw==\n-----END EC PRIVATE KEY-----\n";
    const SESSION_PUBLIC_KEY_HEX: &str = "3059301306072a8648ce3d020106082a8648ce3d0301070342000451b6d957835ead94cf59f6d0ef8f7f18d2eef13687f01512fc8efffa2a6cbbe30fcb07e70452194a4b38c466c0fd96dacecacc978bf8e3a53950857108619a2b";

    #[test]
    fn identity_dir_uses_macos_icp_cli_location() {
        if cfg!(target_os = "macos") {
            let path = identity_dir_from_env(Some(PathBuf::from("/Users/alice")), None).unwrap();
            assert_eq!(
                path,
                PathBuf::from(
                    "/Users/alice/Library/Application Support/org.dfinity.icp-cli/identity"
                )
            );
        }
    }

    #[test]
    fn reads_identity_kind_from_identity_list() {
        let temp_dir = tempfile::tempdir().unwrap();
        std::fs::write(
            temp_dir.path().join("identity_list.json"),
            r#"{"v":1,"identities":{"ii":{"kind":"internet-identity"},"pem":{"kind":"pem"}}}"#,
        )
        .unwrap();

        assert_eq!(
            read_identity_metadata(temp_dir.path(), "ii").unwrap().kind,
            "internet-identity"
        );
        assert!(read_identity_metadata(temp_dir.path(), "missing").is_err());
    }

    #[test]
    fn non_ii_identity_requires_explicit_opt_in() {
        let error = ensure_identity_kind_allowed("pem", "dev", false).unwrap_err();

        assert!(error.to_string().contains("--allow-non-ii-identity"));
        ensure_identity_kind_allowed("pem", "dev", true).unwrap();
    }

    #[test]
    fn builds_delegated_identity_from_icp_cli_json() {
        let root = vfs_client::identity_from_pem(ROOT_SECP256K1_PEM.as_bytes()).unwrap();
        let session = vfs_client::identity_from_pem(SESSION_PRIME256V1_PEM.as_bytes()).unwrap();
        let expiration = 4_102_444_800_000_000_000_u64;
        let delegation = Delegation {
            pubkey: hex::decode(SESSION_PUBLIC_KEY_HEX).unwrap(),
            expiration,
            targets: None,
        };
        let signature = root
            .sign_delegation(&delegation)
            .unwrap()
            .signature
            .unwrap();
        let stored = StoredDelegationChain {
            public_key: ROOT_PUBLIC_KEY_HEX.to_string(),
            delegations: vec![StoredSignedDelegation {
                signature: hex::encode(signature),
                delegation: StoredDelegation {
                    pubkey: SESSION_PUBLIC_KEY_HEX.to_string(),
                    expiration: format!("{expiration:x}"),
                    targets: None,
                },
            }],
        };
        let chain = parse_signed_delegations(&stored, 1, "ii").unwrap();
        ensure_delegation_matches_session_key(&*session, &chain, "ii").unwrap();
        let identity =
            DelegatedIdentity::new(hex::decode(ROOT_PUBLIC_KEY_HEX).unwrap(), session, chain)
                .unwrap();

        assert_eq!(identity.sender().unwrap(), root.sender().unwrap());
    }

    #[test]
    fn builds_unchecked_delegated_identity_from_canister_signature_root() {
        let session = vfs_client::identity_from_pem(SESSION_PRIME256V1_PEM.as_bytes()).unwrap();
        let public_key = hex::decode(CANISTER_SIGNATURE_ROOT_PUBLIC_KEY_HEX).unwrap();
        let stored = StoredDelegationChain {
            public_key: CANISTER_SIGNATURE_ROOT_PUBLIC_KEY_HEX.to_string(),
            delegations: vec![StoredSignedDelegation {
                signature: "d9d9f7a2".to_string(),
                delegation: StoredDelegation {
                    pubkey: SESSION_PUBLIC_KEY_HEX.to_string(),
                    expiration: "38fef81a76b80000".to_string(),
                    targets: None,
                },
            }],
        };
        let chain = parse_signed_delegations(&stored, 1, "ii").unwrap();

        assert!(
            DelegatedIdentity::new(
                public_key.clone(),
                vfs_client::identity_from_pem(SESSION_PRIME256V1_PEM.as_bytes()).unwrap(),
                chain.clone(),
            )
            .is_err()
        );
        ensure_delegation_matches_session_key(&*session, &chain, "ii").unwrap();
        let identity = DelegatedIdentity::new_unchecked(public_key.clone(), session, chain);

        assert_eq!(identity.public_key(), Some(public_key));
    }

    #[test]
    fn accepts_delegation_without_targets_for_any_canister() {
        let stored = stored_delegation_with_targets(None);
        let chain = parse_signed_delegations(&stored, 1, "kinic-ii").unwrap();
        let target = Principal::from_text("aaaaa-aa").unwrap();

        ensure_delegation_targets_canister(&chain, &target, "kinic-ii").unwrap();
    }

    #[test]
    fn accepts_delegation_targeted_to_connection_canister() {
        let stored = stored_delegation_with_targets(Some(vec!["aaaaa-aa".to_string()]));
        let chain = parse_signed_delegations(&stored, 1, "kinic-ii").unwrap();
        let target = Principal::from_text("aaaaa-aa").unwrap();

        ensure_delegation_targets_canister(&chain, &target, "kinic-ii").unwrap();
    }

    #[test]
    fn rejects_delegation_targeted_to_other_canister() {
        let stored =
            stored_delegation_with_targets(Some(vec!["ryjl3-tyaaa-aaaaa-aaaba-cai".to_string()]));
        let chain = parse_signed_delegations(&stored, 1, "kinic-ii").unwrap();
        let target = Principal::from_text("aaaaa-aa").unwrap();
        let error = ensure_delegation_targets_canister(&chain, &target, "kinic-ii")
            .expect_err("wrong target canister should be rejected");

        assert!(error.to_string().contains("does not include canister"));
        assert!(error.to_string().contains("aaaaa-aa"));
    }

    #[test]
    fn mismatched_delegation_requests_icp_identity_login() {
        let session = vfs_client::identity_from_pem(SESSION_PRIME256V1_PEM.as_bytes()).unwrap();
        let stored = StoredDelegationChain {
            public_key: CANISTER_SIGNATURE_ROOT_PUBLIC_KEY_HEX.to_string(),
            delegations: vec![StoredSignedDelegation {
                signature: "d9d9f7a2".to_string(),
                delegation: StoredDelegation {
                    pubkey: ROOT_PUBLIC_KEY_HEX.to_string(),
                    expiration: "38fef81a76b80000".to_string(),
                    targets: None,
                },
            }],
        };
        let chain = parse_signed_delegations(&stored, 1, "kinic-ii").unwrap();
        let error = ensure_delegation_matches_session_key(&*session, &chain, "kinic-ii")
            .expect_err("mismatched session key should be rejected");

        assert!(error.to_string().contains("icp identity login kinic-ii"));
    }

    #[test]
    fn expired_delegation_requests_icp_identity_login() {
        let stored = StoredDelegationChain {
            public_key: ROOT_PUBLIC_KEY_HEX.to_string(),
            delegations: vec![StoredSignedDelegation {
                signature: "00".to_string(),
                delegation: StoredDelegation {
                    pubkey: SESSION_PUBLIC_KEY_HEX.to_string(),
                    expiration: "1".to_string(),
                    targets: None,
                },
            }],
        };
        let error = parse_signed_delegations(&stored, 2, "kinic-ii").unwrap_err();

        assert!(error.to_string().contains("icp identity login kinic-ii"));
    }

    fn stored_delegation_with_targets(targets: Option<Vec<String>>) -> StoredDelegationChain {
        StoredDelegationChain {
            public_key: CANISTER_SIGNATURE_ROOT_PUBLIC_KEY_HEX.to_string(),
            delegations: vec![StoredSignedDelegation {
                signature: "d9d9f7a2".to_string(),
                delegation: StoredDelegation {
                    pubkey: SESSION_PUBLIC_KEY_HEX.to_string(),
                    expiration: "38fef81a76b80000".to_string(),
                    targets,
                },
            }],
        }
    }
}
