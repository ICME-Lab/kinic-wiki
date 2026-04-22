// Where: crates/wiki_cli/src/connection.rs
// What: Resolve replica host and canister id from CLI flags, env, and user config.
// Why: Host choice should be explicit and simple, while canister id can still come from durable config.
use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const CANISTER_ID_ENV: &str = "WIKI_CANISTER_ID";
const LOCAL_REPLICA_HOST: &str = "http://127.0.0.1:8000";
const MAINNET_REPLICA_HOST: &str = "https://icp0.io";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnection {
    pub replica_host: String,
    pub canister_id: String,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
struct UserConfig {
    replica_host: Option<String>,
    canister_id: Option<String>,
}

pub fn resolve_connection(
    local: bool,
    canister_id_arg: Option<String>,
) -> Result<ResolvedConnection> {
    let config = load_user_config()?;
    resolve_connection_from_sources(
        local,
        canister_id_arg,
        env::var(CANISTER_ID_ENV).ok(),
        config,
    )
}

fn resolve_connection_from_sources(
    local: bool,
    canister_id_arg: Option<String>,
    canister_id_env: Option<String>,
    config: Option<UserConfig>,
) -> Result<ResolvedConnection> {
    let replica_host = if local {
        LOCAL_REPLICA_HOST.to_string()
    } else {
        MAINNET_REPLICA_HOST.to_string()
    };
    let canister_id = canister_id_arg
        .or(canister_id_env)
        .or_else(|| config.as_ref().and_then(|value| value.canister_id.clone()));
    if canister_id.is_none() {
        bail!(
            "missing connection setting: canister_id; set --canister-id, {}, or ~/.config/wiki-cli/config.toml or ~/.wiki-cli.toml",
            CANISTER_ID_ENV
        );
    }
    Ok(ResolvedConnection {
        replica_host,
        canister_id: canister_id.expect("checked above"),
    })
}

fn load_user_config() -> Result<Option<UserConfig>> {
    let Some(path) = find_user_config_path() else {
        return Ok(None);
    };
    load_user_config_from_path(&path)
}

fn find_user_config_path() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from)?;
    let primary = home.join(".config").join("wiki-cli").join("config.toml");
    if primary.is_file() {
        return Some(primary);
    }
    let fallback = home.join(".wiki-cli.toml");
    fallback.is_file().then_some(fallback)
}

fn load_user_config_from_path(path: &Path) -> Result<Option<UserConfig>> {
    let raw = fs::read_to_string(path)
        .map_err(|error| anyhow!("failed to read config {}: {error}", path.display()))?;
    let config = toml::from_str::<UserConfig>(&raw)
        .map_err(|error| anyhow!("failed to parse config {}: {error}", path.display()))?;
    Ok(Some(config))
}

#[cfg(test)]
mod tests {
    use super::{
        CANISTER_ID_ENV, LOCAL_REPLICA_HOST, MAINNET_REPLICA_HOST, ResolvedConnection, UserConfig,
        load_user_config_from_path, resolve_connection_from_sources,
    };
    use std::path::PathBuf;
    use tempfile::tempdir;

    #[test]
    fn args_override_env_and_config() {
        let resolved = resolve_connection_from_sources(
            true,
            Some("arg-canister".to_string()),
            Some("env-canister".to_string()),
            Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
            }),
        )
        .expect("args should win");
        assert_eq!(
            resolved,
            ResolvedConnection {
                replica_host: LOCAL_REPLICA_HOST.to_string(),
                canister_id: "arg-canister".to_string(),
            }
        );
    }

    #[test]
    fn local_flag_picks_local_host() {
        let resolved = resolve_connection_from_sources(
            true,
            None,
            Some("env-canister".to_string()),
            Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
            }),
        )
        .expect("local host should resolve");
        assert_eq!(resolved.replica_host, LOCAL_REPLICA_HOST);
        assert_eq!(resolved.canister_id, "env-canister");
    }

    #[test]
    fn default_host_is_mainnet() {
        let resolved = resolve_connection_from_sources(
            false,
            None,
            None,
            Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
            }),
        )
        .expect("default host should resolve");
        assert_eq!(resolved.replica_host, MAINNET_REPLICA_HOST);
        assert_eq!(resolved.canister_id, "config-canister");
    }

    #[test]
    fn canister_id_uses_env_before_config() {
        let resolved = resolve_connection_from_sources(
            false,
            None,
            Some("env-canister".to_string()),
            Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
            }),
        )
        .expect("env should win for canister id");
        assert_eq!(resolved.canister_id, "env-canister");
    }

    #[test]
    fn missing_canister_id_returns_actionable_error() {
        let error = resolve_connection_from_sources(false, None, None, None)
            .expect_err("missing canister id should fail");
        let message = error.to_string();
        assert!(message.contains("canister_id"));
        assert!(message.contains(CANISTER_ID_ENV));
    }

    #[test]
    fn config_parser_reads_expected_keys() {
        let dir = tempdir().expect("temp dir should exist");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "replica_host = \"http://config-host\"\ncanister_id = \"config-canister\"\n",
        )
        .expect("config should write");
        let parsed = load_user_config_from_path(&path)
            .expect("config should parse")
            .expect("config should exist");
        assert_eq!(parsed.replica_host.as_deref(), Some("http://config-host"));
        assert_eq!(parsed.canister_id.as_deref(), Some("config-canister"));
    }

    #[test]
    fn invalid_toml_returns_error() {
        let dir = tempdir().expect("temp dir should exist");
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "replica_host = [").expect("config should write");
        let error = load_user_config_from_path(&path).expect_err("invalid toml should fail");
        assert!(error.to_string().contains("failed to parse config"));
    }

    #[test]
    fn config_path_prefers_xdg_location_over_home_file() {
        let dir = tempdir().expect("temp dir should exist");
        let home = dir.path();
        let xdg = home.join(".config").join("wiki-cli");
        std::fs::create_dir_all(&xdg).expect("xdg dir should exist");
        std::fs::write(xdg.join("config.toml"), "replica_host = \"http://xdg\"\n")
            .expect("xdg config should write");
        std::fs::write(
            home.join(".wiki-cli.toml"),
            "replica_host = \"http://home\"\n",
        )
        .expect("home config should write");
        let found = find_user_config_path_with_home(home).expect("config path should exist");
        assert_eq!(found, xdg.join("config.toml"));
    }

    #[test]
    fn config_replica_host_is_ignored() {
        let resolved = resolve_connection_from_sources(
            false,
            None,
            Some("env-canister".to_string()),
            Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
            }),
        )
        .expect("config replica host should be ignored");
        assert_eq!(resolved.replica_host, MAINNET_REPLICA_HOST);
    }

    fn find_user_config_path_with_home(home: &std::path::Path) -> Option<PathBuf> {
        let primary = home.join(".config").join("wiki-cli").join("config.toml");
        if primary.is_file() {
            return Some(primary);
        }
        let fallback = home.join(".wiki-cli.toml");
        fallback.is_file().then_some(fallback)
    }
}
