//! One resolver for the CLI and its thin hook adapters. No filesystem writes or execution.
use crate::{learning::RecallOptions, learning_runner::RunnerConfig};
use anyhow::{Context, Result, anyhow, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub root: PathBuf,
    pub cwd: PathBuf,
    pub user_path: PathBuf,
    pub project_path: PathBuf,
    pub sources: BTreeMap<String, String>,
    values: Value,
    stdin_recall: Option<Value>,
}

fn merge(target: &mut Value, overlay: &Value) {
    if let (Some(target), Some(overlay)) = (target.as_object_mut(), overlay.as_object()) {
        for (key, value) in overlay {
            if let Some(existing) = target.get_mut(key) {
                merge(existing, value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    } else {
        *target = overlay.clone();
    }
}
fn sources(value: &Value, prefix: &str, source: &str, out: &mut BTreeMap<String, String>) {
    if let Some(fields) = value.as_object() {
        for (key, value) in fields {
            sources(
                value,
                &if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                },
                source,
                out,
            );
        }
    } else {
        out.insert(prefix.into(), source.into());
    }
}
fn path_value(value: &mut Value, key: &str, parent: &Path, executable: bool) {
    let Some(text) = value.get(key).and_then(Value::as_str) else {
        return;
    };
    let path = Path::new(text);
    if !path.is_absolute() && (!executable || path.components().count() > 1 || text.contains('/')) {
        value[key] = parent.join(path).to_string_lossy().into_owned().into();
    }
}
fn normalize(value: &mut Value, parent: &Path) {
    if let Some(learning) = value.get_mut("learning") {
        path_value(learning, "state_dir", parent, false);
        if let Some(reranker) = learning.get_mut("reranker") {
            path_value(reranker, "executable", parent, true);
        }
    }
    if let Some(agents) = value.get_mut("agents").and_then(Value::as_object_mut) {
        for config in agents.values_mut() {
            path_value(config, "executable", parent, true);
        }
    }
}
/// Do not propagate serde errors: JSON/TOML excerpts and enum values can contain credentials.
pub fn read_json_value(path: &Path) -> Result<Value> {
    use std::io::Read;
    let mut raw = Vec::new();
    let reader: Box<dyn Read> = if path == Path::new("-") {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::io::Cursor::new(
            vfs_cli::connection::read_local_config_bytes(path)?,
        ))
    };
    reader
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut raw)
        .context("cannot read explicit JSON configuration")?;
    ensure!(raw.len() <= 8 * 1024 * 1024, "configuration exceeds 8 MiB");
    serde_json::from_slice(&raw).map_err(|_| anyhow!("invalid JSON configuration"))
}

impl AgentConfig {
    pub fn at(cwd: &Path) -> Result<Self> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is required")?;
        Self::load(cwd, &home)
    }
    /// The CLI reads a legacy stdin configuration once before connection selection.
    pub fn with_stdin_recall(mut self, value: Option<Value>) -> Self {
        self.stdin_recall = value;
        self
    }
    fn recall_json(&self, path: &Path) -> Result<Value> {
        if path == Path::new("-") {
            self.stdin_recall
                .clone()
                .context("stdin recall configuration was not prepared")
        } else {
            read_json_value(path)
        }
    }
    /// Portable identity/policy stays in the parent's versioned project document.
    pub fn portable_project(
        &self,
        explicit: Option<&Path>,
    ) -> Result<Option<crate::learning::project::ProjectConfig>> {
        let path =
            if let Some(path) = explicit.filter(|p| p.extension().is_none_or(|e| e != "toml")) {
                if self.recall_json(path)?["version"] == 2 {
                    Some(path.to_path_buf())
                } else {
                    crate::learning::project::discover_config(&self.cwd)?
                }
            } else {
                crate::learning::project::discover_config(&self.cwd)?
            };
        let Some(path) = path else {
            return Ok(None);
        };
        let value = self.recall_json(&path)?;
        if value["version"] != 2 {
            return Ok(None);
        }
        ensure!(
            path != Path::new("-"),
            "portable project configuration requires an on-disk file"
        );
        crate::learning::project::load_project(&path)
            .map(Some)
            .map_err(|_| anyhow!("invalid portable project configuration"))
    }
    /// A source path for durable intake; all settings contributing to it are hashed separately.
    pub fn hook_path(&self) -> Result<Option<PathBuf>> {
        if let Some(path) = crate::learning::project::discover_config(&self.cwd)? {
            return Ok(Some(path));
        }
        if self.has_learning() {
            return Ok(Some(
                if self.sources.keys().any(|k| {
                    k.starts_with("learning.")
                        && self.sources[k] == self.project_path.to_string_lossy()
                }) {
                    self.project_path.clone()
                } else {
                    self.user_path.clone()
                },
            ));
        }
        Ok(None)
    }
    pub fn binding_digest(&self, explicit: Option<&Path>) -> Result<String> {
        let mut paths = vec![self.user_path.clone(), self.project_path.clone()];
        paths.extend(crate::learning::project::discover_config(&self.cwd)?);
        paths.extend(explicit.map(Path::to_path_buf));
        paths.sort();
        paths.dedup();
        let mut rows = Vec::new();
        for path in paths {
            if path.is_file() {
                rows.push((
                    path.clone(),
                    crate::learning::hash(&String::from_utf8_lossy(
                        &vfs_cli::connection::read_local_config_bytes(&path)?,
                    )),
                ));
            }
        }
        Ok(crate::learning::hash(&serde_json::to_string(&rows)?))
    }
    pub fn current() -> Result<Self> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is required")?;
        Self::load(&std::env::current_dir()?, &home)
    }
    pub fn load(cwd: &Path, home: &Path) -> Result<Self> {
        let cwd = cwd.canonicalize().context("target cwd is unavailable")?;
        let root = vfs_cli::connection::find_workspace_root_at(&cwd)?.unwrap_or(cwd.clone());
        let user_path = vfs_cli::connection::user_config_path_at(home);
        let project_path = root.join(".kinic/config.toml");
        let mut result = Self {
            root,
            cwd,
            user_path,
            project_path,
            sources: BTreeMap::new(),
            values: json!({}),
            stdin_recall: None,
        };
        for path in [result.user_path.clone(), result.project_path.clone()] {
            if !path.exists() {
                continue;
            }
            let raw = String::from_utf8(vfs_cli::connection::read_local_config_bytes(&path)?)
                .context("invalid TOML encoding")?;
            let table: toml::Table =
                toml::from_str(&raw).map_err(|_| anyhow!("invalid TOML configuration"))?;
            let mut value =
                serde_json::to_value(table).context("unsupported TOML configuration")?;
            ensure!(
                value.get("agents").is_none_or(Value::is_object),
                "agents must be a table"
            );
            ensure!(
                value.get("learning").is_none_or(Value::is_object),
                "learning must be a table"
            );
            for engine in ["codex", "dsh"] {
                ensure!(
                    value
                        .pointer(&format!("/agents/{engine}"))
                        .is_none_or(Value::is_object),
                    "agent settings must be a table"
                );
                ensure!(
                    value
                        .pointer(&format!("/agents/{engine}/environment"))
                        .is_none(),
                    "TOML runner environment values are unsupported; inherit credentials from the environment"
                );
            }
            normalize(&mut value, path.parent().unwrap());
            sources(&value, "", &path.to_string_lossy(), &mut result.sources);
            merge(&mut result.values, &value);
        }
        if let Some(path) = crate::learning::project::discover_config(&result.cwd)? {
            result.sources.insert(
                "portable_or_legacy_config".into(),
                path.to_string_lossy().into_owned(),
            );
        }
        Ok(result)
    }
    pub fn has_learning(&self) -> bool {
        self.values.get("learning").is_some()
    }
    pub fn configured_engines(&self) -> Vec<String> {
        let mut engines: Vec<String> = ["codex", "dsh"]
            .into_iter()
            .filter(|e| self.values.pointer(&format!("/agents/{e}")).is_some())
            .map(str::to_owned)
            .collect();
        if let Ok(Some(project)) = self.portable_project(None) {
            let engine = format!("{:?}", project.runner.engine).to_lowercase();
            if !engines.contains(&engine) {
                engines.push(engine);
            }
        }
        engines
    }
    pub fn state_dir(&self) -> Option<PathBuf> {
        self.values
            .pointer("/learning/state_dir")
            .and_then(Value::as_str)
            .map(PathBuf::from)
    }
    pub fn runner(&self, engine: Option<&str>, file: Option<&Path>) -> Result<RunnerConfig> {
        let explicit = file.map(read_json_value).transpose()?;
        let file_engine = explicit
            .as_ref()
            .and_then(|v| v.get("engine"))
            .and_then(Value::as_str);
        if let (Some(engine), Some(file_engine)) = (engine, file_engine) {
            ensure!(
                engine == file_engine,
                "--engine conflicts with runner JSON engine"
            );
        }
        // Legacy runner files defaulted to Codex, including when engine was omitted.
        let engine = engine
            .or(file_engine)
            .or(file.map(|_| "codex"))
            .context("specify --engine or --runner-file")?;
        ensure!(
            ["codex", "dsh"].contains(&engine),
            "unsupported agent engine"
        );
        let mut value = self
            .portable_project(None)?
            .filter(|p| format!("{:?}", p.runner.engine).to_lowercase() == engine)
            .map(|p| serde_json::to_value(p.runner))
            .transpose()?
            .unwrap_or(json!({}));
        if let Some(settings) = self.values.pointer(&format!("/agents/{engine}")) {
            merge(&mut value, settings);
        }
        ensure!(value.is_object(), "agent configuration must be a table");
        if let Some(explicit) = explicit.as_ref() {
            ensure!(explicit.is_object(), "runner JSON must be an object");
            merge(&mut value, explicit);
        }
        value["engine"] = engine.into();
        if file.is_none() && value.get("executable").is_none() {
            value["executable"] = engine.into();
        }
        serde_json::from_value(value)
            .map_err(|_| anyhow!("invalid runner configuration (check field types)"))
    }
    pub fn recall(&self, file: Option<&Path>) -> Result<Option<RecallOptions>> {
        let explicit = file.filter(|p| p.extension().is_none_or(|e| e != "toml"));
        let project = self.portable_project(explicit)?;
        let legacy = crate::learning::project::discover_config(&self.cwd)?;
        let mut value = if let Some(project) = &project {
            serde_json::to_value(&project.recall)?
        } else if let Some(path) = legacy {
            let value = read_json_value(&path)?;
            if value["version"] == 2 {
                json!({})
            } else {
                value
            }
        } else {
            json!({})
        };
        if let Some(settings) = self.values.get("learning") {
            merge(&mut value, settings);
        }
        ensure!(value.is_object(), "learning configuration must be a table");
        if let Some(file) = explicit {
            let explicit = self.recall_json(file)?;
            let explicit = if explicit["version"] == 2 {
                ensure!(
                    project.is_some(),
                    "portable project configuration requires an on-disk file"
                );
                explicit
                    .get("recall")
                    .cloned()
                    .context("portable recall settings missing")?
            } else {
                explicit
            };
            ensure!(explicit.is_object(), "recall JSON must be an object");
            merge(&mut value, &explicit);
        }
        if value.as_object().is_some_and(|v| v.is_empty()) {
            return Ok(None);
        }
        let mut recall: RecallOptions = serde_json::from_value(value).map_err(|_| {
            anyhow!("invalid recall configuration (budget_tokens and valid field types required)")
        })?;
        if let Some(project) = project {
            ensure!(
                recall.namespace == project.knowledge_scope(),
                "TOML namespace conflicts with portable project scope; keep scope policy in learn setup"
            );
            ensure!(
                recall
                    .project_id
                    .as_deref()
                    .is_none_or(|id| id == project.project_id),
                "project identity cannot be overridden by runtime settings"
            );
            ensure!(
                recall.read_scopes.is_empty() || recall.read_scopes == project.recall_scopes(),
                "runtime read scopes conflict with portable project policy"
            );
            recall.project_id = Some(project.project_id.clone());
            recall.read_scopes = project.recall_scopes();
        }
        Ok(Some(recall))
    }
}
