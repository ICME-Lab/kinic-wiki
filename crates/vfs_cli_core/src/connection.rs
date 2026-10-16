// Where: crates/vfs_cli_core/src/connection.rs
// What: Shared connection resolution for VFS consumers.
// Why: Generic VFS crates should not depend on the app-facing CLI package for host and canister selection.
use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const CANISTER_ID_ENV: &str = "VFS_CANISTER_ID";
const DATABASE_ID_ENV: &str = "VFS_DATABASE_ID";
const LOCAL_REPLICA_HOST: &str = "http://127.0.0.1:8000";
const MAINNET_REPLICA_HOST: &str = "https://icp0.io";
const MAINNET_CANISTER_ID: &str = "6emaw-iyaaa-aaaay-aacka-cai";
const WORKSPACE_CONFIG_PATH: &str = ".kinic/config.toml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnection {
    pub replica_host: String,
    pub canister_id: String,
    pub database_id: Option<String>,
    pub replica_host_source: String,
    pub canister_id_source: String,
    pub database_id_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedConnectionPreview {
    pub replica_host: String,
    pub canister_id: Option<String>,
    pub database_id: Option<String>,
    pub replica_host_source: String,
    pub canister_id_source: Option<String>,
    pub database_id_source: Option<String>,
}

impl From<&ResolvedConnection> for ResolvedConnectionPreview {
    fn from(connection: &ResolvedConnection) -> Self {
        Self {
            replica_host: connection.replica_host.clone(),
            canister_id: Some(connection.canister_id.clone()),
            database_id: connection.database_id.clone(),
            replica_host_source: connection.replica_host_source.clone(),
            canister_id_source: Some(connection.canister_id_source.clone()),
            database_id_source: connection.database_id_source.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
struct UserConfig {
    replica_host: Option<String>,
    canister_id: Option<String>,
    database_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ConnectionSources {
    local: bool,
    replica_host_arg: Option<String>,
    canister_id_arg: Option<String>,
    database_id_arg: Option<String>,
    canister_id_env: Option<String>,
    database_id_env: Option<String>,
    workspace: Option<UserConfig>,
    config: Option<UserConfig>,
}

pub fn resolve_connection(
    local: bool,
    replica_host_arg: Option<String>,
    canister_id_arg: Option<String>,
    database_id_arg: Option<String>,
) -> Result<ResolvedConnection> {
    let config = load_user_config()?;
    let workspace = load_workspace_config()?;
    resolve_connection_from_sources(ConnectionSources {
        local,
        replica_host_arg,
        canister_id_arg,
        database_id_arg,
        canister_id_env: env::var(CANISTER_ID_ENV).ok(),
        database_id_env: env::var(DATABASE_ID_ENV).ok(),
        workspace,
        config,
    })
}

pub fn resolve_connection_optional_canister(
    local: bool,
    replica_host_arg: Option<String>,
    canister_id_arg: Option<String>,
    database_id_arg: Option<String>,
) -> Result<ResolvedConnectionPreview> {
    let config = load_user_config()?;
    let workspace = load_workspace_config()?;
    Ok(resolve_connection_preview_from_sources(ConnectionSources {
        local,
        replica_host_arg,
        canister_id_arg,
        database_id_arg,
        canister_id_env: env::var(CANISTER_ID_ENV).ok(),
        database_id_env: env::var(DATABASE_ID_ENV).ok(),
        workspace,
        config,
    }))
}

fn resolve_connection_from_sources(sources: ConnectionSources) -> Result<ResolvedConnection> {
    let preview = resolve_connection_preview_from_sources(sources);
    if preview.canister_id.is_none() {
        bail!(
            "missing connection setting: canister_id; set --canister-id, {}, .kinic/config.toml, ~/.config/kinic-vfs-cli/config.toml, or ~/.kinic-vfs-cli.toml",
            CANISTER_ID_ENV
        );
    }
    Ok(ResolvedConnection {
        replica_host: preview.replica_host,
        replica_host_source: preview.replica_host_source,
        canister_id: preview.canister_id.expect("checked above"),
        canister_id_source: preview.canister_id_source.expect("checked above"),
        database_id: preview.database_id,
        database_id_source: preview.database_id_source,
    })
}

fn resolve_connection_preview_from_sources(
    sources: ConnectionSources,
) -> ResolvedConnectionPreview {
    let ConnectionSources {
        local,
        replica_host_arg,
        canister_id_arg,
        database_id_arg,
        canister_id_env,
        database_id_env,
        workspace,
        config,
    } = sources;
    let (replica_host, replica_host_source) = if local {
        (LOCAL_REPLICA_HOST.to_string(), "--local".to_string())
    } else if let Some(value) = replica_host_arg {
        (value, "--replica-host".to_string())
    } else {
        workspace
            .as_ref()
            .and_then(|value| value.replica_host.clone())
            .map(|value| (value, WORKSPACE_CONFIG_PATH.to_string()))
            .or_else(|| {
                config
                    .as_ref()
                    .and_then(|value| value.replica_host.clone())
                    .map(|value| (value, "user config".to_string()))
            })
            .unwrap_or_else(|| (MAINNET_REPLICA_HOST.to_string(), "default".to_string()))
    };
    let (canister_id, canister_id_source) = canister_id_arg
        .map(|value| (value, "--canister-id".to_string()))
        .or_else(|| canister_id_env.map(|value| (value, CANISTER_ID_ENV.to_string())))
        .or_else(|| {
            workspace
                .as_ref()
                .and_then(|value| value.canister_id.clone())
                .map(|value| (value, WORKSPACE_CONFIG_PATH.to_string()))
        })
        .or_else(|| {
            config
                .as_ref()
                .and_then(|value| value.canister_id.clone())
                .map(|value| (value, "user config".to_string()))
        })
        .or_else(|| {
            if !local && replica_host == MAINNET_REPLICA_HOST {
                Some((
                    MAINNET_CANISTER_ID.to_string(),
                    "mainnet default".to_string(),
                ))
            } else {
                None
            }
        })
        .unzip();
    let (database_id, database_id_source) = database_id_arg
        .map(|value| (value, "--database-id".to_string()))
        .or_else(|| database_id_env.map(|value| (value, DATABASE_ID_ENV.to_string())))
        .or_else(|| {
            workspace
                .as_ref()
                .and_then(|value| value.database_id.clone())
                .map(|value| (value, WORKSPACE_CONFIG_PATH.to_string()))
        })
        .or_else(|| {
            config
                .as_ref()
                .and_then(|value| value.database_id.clone())
                .map(|value| (value, "user config".to_string()))
        })
        .unzip();
    ResolvedConnectionPreview {
        replica_host,
        replica_host_source,
        canister_id,
        canister_id_source,
        database_id,
        database_id_source,
    }
}

pub fn link_workspace_database(
    connection: &ResolvedConnection,
    database_id: &str,
) -> Result<PathBuf> {
    let root = find_workspace_root()?.unwrap_or(env::current_dir()?);
    link_workspace_database_at(&root, connection, database_id)
}

fn link_workspace_database_at(
    root: &Path,
    connection: &ResolvedConnection,
    database_id: &str,
) -> Result<PathBuf> {
    let path = root.join(WORKSPACE_CONFIG_PATH);
    let mut config = read_config_document(&path)?;
    config["replica_host"] = toml_edit::value(&connection.replica_host);
    config["canister_id"] = toml_edit::value(&connection.canister_id);
    config["database_id"] = toml_edit::value(database_id);
    write_config_document(&path, &config)?;
    Ok(path)
}

pub fn unlink_workspace_database() -> Result<Option<PathBuf>> {
    let Some(root) = find_workspace_root()? else {
        return Ok(None);
    };
    unlink_workspace_database_at(&root)
}

fn unlink_workspace_database_at(root: &Path) -> Result<Option<PathBuf>> {
    let path = root.join(WORKSPACE_CONFIG_PATH);
    if !path.is_file() {
        return Ok(None);
    }
    let mut config = read_config_document(&path)?;
    config.remove("database_id");
    if config.as_table().is_empty() {
        fs::remove_file(&path)?;
    } else {
        write_config_document(&path, &config)?;
    }
    Ok(Some(path))
}

pub fn workspace_config_path() -> Result<PathBuf> {
    let root = find_workspace_root()?.unwrap_or(env::current_dir()?);
    Ok(root.join(WORKSPACE_CONFIG_PATH))
}

fn load_user_config() -> Result<Option<UserConfig>> {
    let Some(path) = find_user_config_path() else {
        return Ok(None);
    };
    load_user_config_from_path(&path)
}

fn load_workspace_config() -> Result<Option<UserConfig>> {
    let Some(root) = find_workspace_root()? else {
        return Ok(None);
    };
    load_config_from_path_optional(&root.join(WORKSPACE_CONFIG_PATH))
}

fn find_workspace_root() -> Result<Option<PathBuf>> {
    find_workspace_root_at(&env::current_dir()?)
}

pub fn find_workspace_root_at(cwd: &Path) -> Result<Option<PathBuf>> {
    let mut dir = cwd.canonicalize()?;
    loop {
        if dir.join(".git").exists() || dir.join(WORKSPACE_CONFIG_PATH).is_file() {
            return Ok(Some(dir));
        }
        if !dir.pop() {
            return Ok(None);
        }
    }
}

pub fn find_user_config_path() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from)?;
    Some(user_config_path_at(&home))
}

pub fn user_config_path_at(home: &Path) -> PathBuf {
    let primary = home
        .join(".config")
        .join("kinic-vfs-cli")
        .join("config.toml");
    if primary.is_file() {
        return primary;
    }
    let fallback = home.join(".kinic-vfs-cli.toml");
    if fallback.is_file() {
        fallback
    } else {
        primary
    }
}

fn load_user_config_from_path(path: &Path) -> Result<Option<UserConfig>> {
    load_config_from_path_optional(path)
}

/// Bounded regular-file reads for local configuration and credential consumers.
/// Checking the type before opening avoids waiting on explicitly supplied pipes.
pub fn read_local_config_bytes(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    const LIMIT: usize = 8 * 1024 * 1024;
    let metadata = fs::metadata(path).context("cannot inspect local configuration")?;
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        bail!("local configuration must be a regular file of at most 8 MiB");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        bail!("local configuration exceeds 8 MiB");
    }
    Ok(bytes)
}

fn load_config_from_path_optional(path: &Path) -> Result<Option<UserConfig>> {
    if !path.is_file() {
        return Ok(None);
    }
    let raw = String::from_utf8(read_local_config_bytes(path)?)
        .context("invalid configuration encoding")?;
    let config = toml::from_str::<UserConfig>(&raw)
        .map_err(|_| anyhow!("invalid TOML connection configuration"))?;
    Ok(Some(config))
}

pub fn read_config_document(path: &Path) -> Result<toml_edit::DocumentMut> {
    if !path.exists() {
        return Ok(toml_edit::DocumentMut::new());
    }
    // Parser errors can embed input lines containing credentials. Never forward them.
    let raw = String::from_utf8(read_local_config_bytes(path)?)
        .context("invalid configuration encoding")?;
    raw.parse()
        .map_err(|_| anyhow!("invalid TOML configuration"))
}

pub fn write_config_document(path: &Path, config: &toml_edit::DocumentMut) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, config.to_string()).context("cannot write configuration file")
}

#[cfg(test)]
mod tests {
    use super::{
        CANISTER_ID_ENV, ConnectionSources, DATABASE_ID_ENV, LOCAL_REPLICA_HOST,
        MAINNET_CANISTER_ID, MAINNET_REPLICA_HOST, ResolvedConnection, ResolvedConnectionPreview,
        UserConfig, load_user_config_from_path, resolve_connection_from_sources,
        resolve_connection_preview_from_sources,
    };
    use std::path::PathBuf;
    use tempfile::tempdir;

    #[test]
    fn args_override_env_and_config() {
        let resolved = resolve_connection_from_sources(ConnectionSources {
            local: true,
            canister_id_arg: Some("arg-canister".to_string()),
            database_id_arg: Some("arg-db".to_string()),
            canister_id_env: Some("env-canister".to_string()),
            database_id_env: Some("env-db".to_string()),
            workspace: Some(UserConfig {
                replica_host: Some("http://workspace-host".to_string()),
                canister_id: Some("workspace-canister".to_string()),
                database_id: Some("workspace-db".to_string()),
            }),
            config: Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
                database_id: Some("config-db".to_string()),
            }),
            ..ConnectionSources::default()
        })
        .expect("args should win");
        assert_eq!(
            resolved,
            ResolvedConnection {
                replica_host: LOCAL_REPLICA_HOST.to_string(),
                canister_id: "arg-canister".to_string(),
                database_id: Some("arg-db".to_string()),
                replica_host_source: "--local".to_string(),
                canister_id_source: "--canister-id".to_string(),
                database_id_source: Some("--database-id".to_string()),
            }
        );
    }

    #[test]
    fn env_and_workspace_override_user_config_for_database() {
        let resolved = resolve_connection_from_sources(ConnectionSources {
            database_id_env: Some("env-db".to_string()),
            workspace: Some(UserConfig {
                replica_host: Some("http://workspace-host".to_string()),
                canister_id: Some("workspace-canister".to_string()),
                database_id: Some("workspace-db".to_string()),
            }),
            config: Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
                database_id: Some("config-db".to_string()),
            }),
            ..ConnectionSources::default()
        })
        .expect("workspace should provide canister");
        assert_eq!(resolved.replica_host, "http://workspace-host");
        assert_eq!(resolved.canister_id, "workspace-canister");
        assert_eq!(resolved.database_id.as_deref(), Some("env-db"));
        assert_eq!(
            resolved.database_id_source.as_deref(),
            Some(DATABASE_ID_ENV)
        );
    }

    #[test]
    fn config_parser_reads_expected_keys() {
        let dir = tempdir().expect("temp dir should exist");
        let path = dir.path().join("config.toml");
        std::fs::write(
            &path,
            "replica_host = \"http://config-host\"\ncanister_id = \"config-canister\"\ndatabase_id = \"config-db\"\n",
        )
        .expect("config should write");
        let parsed = load_user_config_from_path(&path)
            .expect("config should parse")
            .expect("config should exist");
        assert_eq!(parsed.replica_host.as_deref(), Some("http://config-host"));
        assert_eq!(parsed.canister_id.as_deref(), Some("config-canister"));
        assert_eq!(parsed.database_id.as_deref(), Some("config-db"));
    }

    #[test]
    fn mainnet_default_supplies_canister_id() {
        let resolved = resolve_connection_from_sources(ConnectionSources::default())
            .expect("mainnet default should provide canister id");
        assert_eq!(resolved.replica_host, MAINNET_REPLICA_HOST);
        assert_eq!(resolved.canister_id, MAINNET_CANISTER_ID);
        assert_eq!(resolved.canister_id_source, "mainnet default");
    }

    #[test]
    fn local_missing_canister_id_returns_actionable_error() {
        let error = resolve_connection_from_sources(ConnectionSources {
            local: true,
            ..ConnectionSources::default()
        })
        .expect_err("missing canister id should fail");
        let message = error.to_string();
        assert!(message.contains("canister_id"));
        assert!(message.contains(CANISTER_ID_ENV));
    }

    #[test]
    fn preview_allows_missing_canister_id() {
        let resolved = resolve_connection_preview_from_sources(ConnectionSources::default());
        assert_eq!(
            resolved,
            ResolvedConnectionPreview {
                replica_host: MAINNET_REPLICA_HOST.to_string(),
                canister_id: Some(MAINNET_CANISTER_ID.to_string()),
                database_id: None,
                replica_host_source: "default".to_string(),
                canister_id_source: Some("mainnet default".to_string()),
                database_id_source: None,
            }
        );
    }

    #[test]
    fn preview_reads_database_without_canister() {
        let resolved = resolve_connection_preview_from_sources(ConnectionSources {
            workspace: Some(UserConfig {
                replica_host: None,
                canister_id: None,
                database_id: Some("workspace-db".to_string()),
            }),
            ..ConnectionSources::default()
        });
        assert_eq!(resolved.canister_id.as_deref(), Some(MAINNET_CANISTER_ID));
        assert_eq!(resolved.database_id.as_deref(), Some("workspace-db"));
        assert_eq!(
            resolved.database_id_source.as_deref(),
            Some(".kinic/config.toml")
        );
    }

    #[test]
    fn replica_host_arg_overrides_config() {
        let resolved = resolve_connection_from_sources(ConnectionSources {
            replica_host_arg: Some("http://arg-host".to_string()),
            canister_id_arg: Some("arg-canister".to_string()),
            workspace: Some(UserConfig {
                replica_host: Some("http://workspace-host".to_string()),
                canister_id: Some("workspace-canister".to_string()),
                database_id: None,
            }),
            config: Some(UserConfig {
                replica_host: Some("http://config-host".to_string()),
                canister_id: Some("config-canister".to_string()),
                database_id: None,
            }),
            ..ConnectionSources::default()
        })
        .expect("arg host should win");
        assert_eq!(resolved.replica_host, "http://arg-host");
        assert_eq!(resolved.replica_host_source, "--replica-host");
    }

    #[test]
    fn config_path_prefers_xdg_location_over_home_file() {
        let dir = tempdir().expect("temp dir should exist");
        let home = dir.path();
        let xdg = home.join(".config").join("kinic-vfs-cli");
        std::fs::create_dir_all(&xdg).expect("xdg dir should exist");
        std::fs::write(xdg.join("config.toml"), "replica_host = \"http://xdg\"\n")
            .expect("xdg config should write");
        std::fs::write(
            home.join(".kinic-vfs-cli.toml"),
            "replica_host = \"http://home\"\n",
        )
        .expect("home config should write");
        let found = find_user_config_path_with_home(home).expect("config path should exist");
        assert_eq!(found, xdg.join("config.toml"));
    }

    #[test]
    fn link_and_unlink_workspace_database_updates_config() {
        let dir = tempdir().expect("temp dir should exist");
        let connection = ResolvedConnection {
            replica_host: "https://icp0.io".to_string(),
            canister_id: "aaaaa-aa".to_string(),
            database_id: None,
            replica_host_source: "test".to_string(),
            canister_id_source: "test".to_string(),
            database_id_source: None,
        };

        let path = super::link_workspace_database_at(dir.path(), &connection, "team-db")
            .expect("link should write workspace config");
        let linked = load_user_config_from_path(&path)
            .expect("config should parse")
            .expect("config should exist");
        assert_eq!(linked.canister_id.as_deref(), Some("aaaaa-aa"));
        assert_eq!(linked.database_id.as_deref(), Some("team-db"));

        let removed = super::unlink_workspace_database_at(dir.path())
            .expect("unlink should update workspace config")
            .expect("workspace config path should return");
        assert_eq!(removed, path);
        let unlinked = load_user_config_from_path(&removed)
            .expect("config should parse")
            .expect("config should remain because canister is linked");
        assert_eq!(unlinked.canister_id.as_deref(), Some("aaaaa-aa"));
        assert_eq!(unlinked.database_id.as_deref(), None);
    }

    fn find_user_config_path_with_home(home: &std::path::Path) -> Option<PathBuf> {
        let path = super::user_config_path_at(home);
        path.is_file().then_some(path)
    }

    #[test]
    fn link_unlink_preserves_learning_unknown_tables_and_comments() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".kinic/config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(&config, "# retain this comment\n[learning]\nbudget_tokens = 2048\n[other]\ncustom = 'retained'\n").unwrap();
        let connection = ResolvedConnection {
            replica_host: "https://icp0.io".into(),
            canister_id: "test".into(),
            database_id: None,
            replica_host_source: "test".into(),
            canister_id_source: "test".into(),
            database_id_source: None,
        };
        super::link_workspace_database_at(dir.path(), &connection, "db-test").unwrap();
        super::unlink_workspace_database_at(dir.path()).unwrap();
        let text = std::fs::read_to_string(config).unwrap();
        assert!(
            text.contains("budget_tokens = 2048"),
            "learning setting lost: {text}"
        );
        assert!(text.contains("custom = 'retained'"), "unknown setting lost");
        assert!(text.contains("# retain this comment"));
        assert!(!text.contains("database_id"));
    }

    #[test]
    fn unlink_does_not_remove_learning_only_config() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".kinic/config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            "database_id='db-test'\n[learning]\nbudget_tokens=2048\n",
        )
        .unwrap();
        super::unlink_workspace_database_at(dir.path()).unwrap();
        assert!(config.is_file(), "unlink removed learning configuration");
    }
}
