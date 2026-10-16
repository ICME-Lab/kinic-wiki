//! Portable project identity and explicit learning setup; secrets remain in the CLI identity store.
use super::{RecallOptions, cli::LearnCommand};
use crate::learning_runner::RunnerConfig;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use vfs_cli::connection::ResolvedConnection;
use vfs_client::VfsApi;
use vfs_types::MkdirNodeRequest;

pub const CONFIG_FILE: &str = ".kinic-learning.json";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectConfig {
    pub version: u32,
    pub project_id: String,
    pub enabled: bool,
    pub replica_host: String,
    pub canister_id: String,
    pub database_id: String,
    #[serde(default)]
    pub principal: Option<String>,
    pub recall: RecallOptions,
    pub runner: RunnerConfig,
    #[serde(default)]
    pub validation_suite: Option<PathBuf>,
    #[serde(default)]
    pub shared_scopes: Vec<String>,
}
impl ProjectConfig {
    pub fn validate_connection(&self, c: &ResolvedConnection) -> Result<()> {
        ensure!(
            self.replica_host.trim_end_matches('/') == c.replica_host.trim_end_matches('/')
                && self.canister_id == c.canister_id
                && Some(self.database_id.as_str()) == c.database_id.as_deref(),
            "project connection differs from resolved CLI connection"
        );
        Ok(())
    }
    pub fn private_scopes(&self) -> Vec<String> {
        ["Knowledge", "Memory", "Skills"]
            .into_iter()
            .map(|s| format!("/{s}/projects/{}", self.project_id))
            .collect()
    }
    pub fn knowledge_scope(&self) -> String {
        self.private_scopes().remove(0)
    }
    pub fn recall_scopes(&self) -> Vec<String> {
        let mut scopes = self.private_scopes();
        scopes.extend(self.shared_scopes.clone());
        scopes
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 2,
            "unsupported project configuration version"
        );
        ensure!(
            self.project_id.len() == 32 && self.project_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid project_id"
        );
        ensure!(
            !self.replica_host.is_empty()
                && !self.canister_id.is_empty()
                && !self.database_id.is_empty(),
            "project connection binding required"
        );
        validate_scopes(&self.shared_scopes)?;
        validate_runner_secrets(&self.runner)?;
        if let Some(reranker) = &self.recall.reranker {
            validate_runner_secrets(reranker)?;
        }
        ensure!(
            self.recall.namespace == self.knowledge_scope(),
            "project recall namespace must be its dedicated Knowledge scope"
        );
        ensure!(
            self.runner.executable.is_absolute(),
            "runner executable must be absolute"
        );
        ensure!(
            self.validation_suite
                .as_ref()
                .is_none_or(|p| p.is_absolute()),
            "validation suite must be absolute"
        );
        Ok(())
    }
}
fn validate_runner_secrets(runner: &RunnerConfig) -> Result<()> {
    for key in runner.environment.keys() {
        let key = key.to_ascii_lowercase();
        ensure!(
            !["token", "password", "secret", "api_key", "credential"]
                .iter()
                .any(|word| key.contains(word)),
            "runner secrets must be inherited through the environment, not copied into project configuration"
        );
    }
    Ok(())
}
/// A complete backup appears atomically and is never replaced. A retry after
/// backup creation accepts only the exact original bytes.
fn preserve_legacy(path: &Path) -> Result<()> {
    let backup = path.with_extension("json.legacy");
    let original = std::fs::read(path)?;
    if backup.exists() {
        ensure!(
            std::fs::read(&backup)? == original,
            "legacy backup differs from current configuration; preserve both and reconcile before migration"
        );
        return Ok(());
    }
    let temporary = path.with_extension(format!("json.{}.legacy.tmp", unique_id()?));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&original)?;
        file.sync_all()?;
        if let Err(error) = std::fs::hard_link(&temporary, &backup) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
            ensure!(
                std::fs::read(&backup)? == original,
                "legacy backup changed concurrently; preserve both and reconcile before migration"
            );
        }
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    let _ = std::fs::remove_file(&temporary);
    result
}

fn validate_scopes(scopes: &[String]) -> Result<()> {
    ensure!(
        scopes.len() <= 7,
        "at most seven shared scopes are supported"
    );
    for p in scopes {
        let parts: Vec<_> = p.split('/').collect();
        ensure!(
            parts.len() >= 2
                && parts[0].is_empty()
                && matches!(parts[1], "Knowledge" | "Memory" | "Skills")
                && parts[1..].iter().all(|s| !s.is_empty()
                    && *s != "."
                    && *s != ".."
                    && !s.chars().any(char::is_control)),
            "shared scope must be a normalized Knowledge, Memory or Skills path: {p}"
        );
    }
    let mut unique = scopes.to_vec();
    unique.sort();
    unique.dedup();
    ensure!(unique.len() == scopes.len(), "duplicate shared scopes");
    Ok(())
}
pub fn load_project(path: &Path) -> Result<ProjectConfig> {
    let raw = vfs_cli::connection::read_local_config_bytes(path)?;
    let value: Value = serde_json::from_slice(&raw)?;
    ensure!(
        value["version"] == 2,
        "legacy recall configuration requires explicit learn setup migration"
    );
    let config: ProjectConfig = serde_json::from_value(value)?;
    config.validate()?;
    Ok(config)
}
/// Read-only discovery, including shared primary-checkout configuration. No git process is needed.
pub fn discover_config(cwd: &Path) -> Result<Option<PathBuf>> {
    let cwd = cwd.canonicalize()?;
    let mut dir = cwd.as_path();
    loop {
        let config = dir.join(CONFIG_FILE);
        if config.is_file() {
            return Ok(Some(config));
        }
        let marker = dir.join(".git");
        if marker.exists() {
            let git_dir = if marker.is_file() {
                let raw =
                    String::from_utf8(vfs_cli::connection::read_local_config_bytes(&marker)?)?;
                let raw = raw
                    .trim()
                    .strip_prefix("gitdir:")
                    .context("invalid Git worktree marker")?
                    .trim();
                dir.join(raw).canonicalize()?
            } else {
                marker
            };
            let common_file = git_dir.join("commondir");
            let common = if common_file.is_file() {
                git_dir
                    .join(
                        String::from_utf8(vfs_cli::connection::read_local_config_bytes(
                            &common_file,
                        )?)?
                        .trim(),
                    )
                    .canonicalize()?
            } else {
                git_dir
            };
            if common.file_name().is_some_and(|n| n == ".git") {
                let primary = common
                    .parent()
                    .context("Git common directory has no parent")?
                    .join(CONFIG_FILE);
                if primary.is_file() {
                    return Ok(Some(primary));
                }
            }
            return Ok(None);
        }
        let Some(parent) = dir.parent() else {
            return Ok(None);
        };
        dir = parent;
    }
}
fn unique_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(hex::encode(bytes))
}
/// All config replacements are same-directory atomic renames with private modes.
pub fn save_project(path: &Path, config: &ProjectConfig) -> Result<()> {
    config.validate()?;
    let temp = path.with_extension(format!("json.{}.tmp", unique_id()?));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(config)?)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn resolve_executable(executable: &Path, base: &Path) -> Result<PathBuf> {
    if executable.is_absolute() || executable.components().count() > 1 {
        return std::fs::canonicalize(if executable.is_absolute() {
            executable.to_path_buf()
        } else {
            base.join(executable)
        })
        .context("runner executable missing");
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = directory.join(executable);
        if path.is_file() {
            return Ok(std::fs::canonicalize(path)?);
        }
    }
    anyhow::bail!(
        "runner executable {} not found on PATH",
        executable.display()
    )
}
async fn ensure_roots(client: &impl VfsApi, config: &ProjectConfig) -> Result<()> {
    for scope in config.private_scopes() {
        let mut current = String::new();
        for part in scope.split('/').filter(|s| !s.is_empty()) {
            current.push('/');
            current.push_str(part);
            client
                .mkdir_node(MkdirNodeRequest {
                    database_id: config.database_id.clone(),
                    path: current.clone(),
                })
                .await?;
        }
    }
    Ok(())
}
pub async fn handle_project_command(
    client: &impl VfsApi,
    c: &ResolvedConnection,
    cmd: &LearnCommand,
) -> Result<Option<Value>> {
    match cmd {
        LearnCommand::Setup {
            project_root,
            runner_file,
            validation_suite,
            shared_scope,
            ..
        } => {
            validate_scopes(shared_scope)?;
            let root = std::fs::canonicalize(project_root)?;
            ensure!(root.is_dir(), "project root must be a directory");
            let path = discover_config(&root)?.unwrap_or_else(|| root.join(CONFIG_FILE));
            let legacy = if path.exists() {
                let raw: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
                if raw.get("version").is_some() {
                    let config = load_project(&path)?;
                    config.validate_connection(c)?;
                    ensure!(
                        config
                            .principal
                            .as_deref()
                            .is_none_or(|p| Some(p.to_string()) == client.caller_principal()),
                        "project identity differs from CLI identity"
                    );
                    client.status(&config.database_id).await?;
                    ensure_roots(client, &config).await?;
                    return Ok(Some(
                        json!({"config_path":path,"project":config,"created":false}),
                    ));
                }
                Some(raw)
            } else {
                None
            };
            let runner_path = std::fs::canonicalize(runner_file)?;
            let mut runner: RunnerConfig = serde_json::from_slice(&std::fs::read(&runner_path)?)?;
            runner.executable = resolve_executable(
                &runner.executable,
                runner_path.parent().context("runner parent required")?,
            )?;
            validate_runner_secrets(&runner)?;
            let id = unique_id()?;
            let recall: RecallOptions = if let Some(raw) = legacy.as_ref() {
                serde_json::from_value(raw.clone())
                    .context("legacy configuration is not RecallOptions")?
            } else {
                serde_json::from_value(json!({"budget_tokens":4096}))?
            };
            let mut shared_scopes = shared_scope.clone();
            if legacy.is_some() && !shared_scopes.contains(&recall.namespace) {
                shared_scopes.push(recall.namespace.clone());
            }
            validate_scopes(&shared_scopes)?;
            let mut config = ProjectConfig {
                version: 2,
                project_id: id,
                enabled: true,
                replica_host: c.replica_host.clone(),
                canister_id: c.canister_id.clone(),
                database_id: c.database_id.clone().context("database required")?,
                principal: client.caller_principal(),
                recall,
                runner,
                validation_suite: validation_suite
                    .as_ref()
                    .map(std::fs::canonicalize)
                    .transpose()?,
                shared_scopes,
            };
            ensure!(
                config.principal.is_some(),
                "authenticated identity required"
            );
            config.recall.project_id = Some(config.project_id.clone());
            config.recall.namespace = config.knowledge_scope();
            config.recall.read_scopes = config.recall_scopes();
            config.recall.endpoint = format!("{}:{}", c.replica_host, c.canister_id);
            config.recall.principal = config.principal.clone().unwrap();
            config.validate()?;
            client.status(&config.database_id).await?;
            ensure_roots(client, &config).await?;
            if legacy.is_some() {
                preserve_legacy(&path)?;
            }
            save_project(&path, &config)?;
            Ok(Some(
                json!({"config_path":path,"project":config,"created":true,"publication":if config.validation_suite.is_some(){"validation_required"}else{"candidate_only"},"hook_activation":"unverified"}),
            ))
        }
        LearnCommand::Status { project_root, .. }
        | LearnCommand::Enable { project_root, .. }
        | LearnCommand::Disable { project_root, .. } => {
            let path = discover_config(project_root)?
                .context("project is not configured; run learn setup")?;
            let mut config = load_project(&path)?;
            config.validate_connection(c)?;
            ensure!(
                config
                    .principal
                    .as_deref()
                    .is_none_or(|p| Some(p.to_string()) == client.caller_principal()),
                "project identity differs from CLI identity"
            );
            if matches!(cmd, LearnCommand::Enable { .. }) {
                client.status(&config.database_id).await?;
                config.enabled = true;
                save_project(&path, &config)?;
            }
            if matches!(cmd, LearnCommand::Disable { .. }) {
                config.enabled = false;
                save_project(&path, &config)?;
            }
            Ok(Some(
                json!({"config_path":path,"project":config,"hook_activation":"unverified","publication":if config.validation_suite.is_some(){"validation_required"}else{"candidate_only"}}),
            ))
        }
        _ => Ok(None),
    }
}

/// Resolve the effective project file before selecting a connection or identity.
pub fn config_for_command(command: &crate::cli::Command, cwd: &Path) -> Result<Option<PathBuf>> {
    use super::cli::AgentCommand;
    use crate::cli::Command as AppCommand;
    let (explicit, root) = match command {
        AppCommand::Agent {
            command: AgentCommand::Hook { recall_config, .. },
        } => (recall_config.as_ref(), cwd),
        AppCommand::Agent {
            command: AgentCommand::Recall { recall_config, .. },
        } => (recall_config.as_ref(), cwd),
        AppCommand::Agent {
            command:
                AgentCommand::Run {
                    recall_config,
                    cwd: workdir,
                    ..
                },
        } => (recall_config.as_ref(), workdir.as_deref().unwrap_or(cwd)),
        AppCommand::Learn {
            command: LearnCommand::Evaluate { recall_config, .. },
        } => (Some(recall_config), cwd),
        AppCommand::Learn {
            command:
                LearnCommand::Drain {
                    recall_config,
                    project_root,
                    ..
                },
        } => (recall_config.as_ref(), project_root.as_path()),
        AppCommand::Learn {
            command:
                LearnCommand::Setup { project_root, .. }
                | LearnCommand::Status { project_root, .. }
                | LearnCommand::Enable { project_root, .. }
                | LearnCommand::Disable { project_root, .. },
        } => (None, project_root.as_path()),
        AppCommand::Agent { .. } | AppCommand::Learn { .. } => (None, cwd),
        _ => return Ok(None),
    };
    if let Some(path) = explicit {
        // Legacy stdin has no project file or durable policy to discover.
        if path == Path::new("-") {
            return Ok(None);
        }
        return Ok(Some(path.canonicalize()?));
    }
    discover_config(root)
}
