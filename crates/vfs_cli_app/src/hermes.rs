// Where: crates/vfs_cli_app/src/hermes.rs
// What: Local Hermes setup, status, pending replay, and projection sync.
// Why: Hermes owns skill evolution LLM calls while Kinic owns registry state.
use crate::cli::HermesCommand;
use crate::plugin_payload::{HERMES_PLUGIN_FILES, RUNTIME_FILES, replace_dir_with_payload};
use crate::skill_registry::{SkillRunEvidenceInput, export_skill, record_skill_run_evidence};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use vfs_client::VfsApi;
use vfs_types::{ListNodesRequest, NodeEntryKind};

const PRIVATE_SKILL_ROOT: &str = "/Wiki/skills";
const JOB_ROOT: &str = "/Wiki/skill-evolution-jobs";

#[derive(Debug, Clone)]
struct HermesPaths {
    kinic_home: PathBuf,
    hermes_config: PathBuf,
    plugin_dir: PathBuf,
    projection_dir: PathBuf,
    pending_dir: PathBuf,
    setup_config: PathBuf,
}

#[derive(Debug, Serialize)]
struct HermesLocalStatus {
    plugin_installed: bool,
    plugin_dir: String,
    projection_dir: String,
    projected_skills: usize,
    pending_runs: usize,
}

pub async fn run_hermes_command(
    client: &impl VfsApi,
    database_id: Option<&str>,
    command: HermesCommand,
) -> Result<()> {
    match command {
        HermesCommand::Setup { json } => {
            let database_id = require_database_id(database_id)?;
            let result = hermes_setup(client, database_id).await?;
            print_result(result, json)?;
        }
        HermesCommand::Pull { json } => {
            let database_id = require_database_id(database_id)?;
            let result = hermes_pull(client, database_id).await?;
            print_result(result, json)?;
        }
        HermesCommand::Status { json } => {
            let result = hermes_status(client, database_id).await?;
            print_result(result, json)?;
        }
        HermesCommand::FlushPending { json } => {
            let database_id = require_database_id(database_id)?;
            let result = flush_pending_runs(client, database_id).await?;
            print_result(result, json)?;
        }
        HermesCommand::Shadows { json } => {
            let result = hermes_shadows()?;
            print_result(result, json)?;
        }
    }
    Ok(())
}

async fn hermes_setup(client: &impl VfsApi, database_id: &str) -> Result<serde_json::Value> {
    let paths = HermesPaths::resolve()?;
    install_plugin(&paths)?;
    enable_hermes_plugin(&paths.hermes_config)?;
    let projected = sync_projection(client, database_id, &paths.projection_dir).await?;
    write_setup_config(&paths, database_id)?;
    let status = local_status(&paths)?;
    Ok(json!({
        "status": "ready",
        "plugin_dir": paths.plugin_dir,
        "projection_dir": paths.projection_dir,
        "projected_skills": projected,
        "local": status,
    }))
}

async fn hermes_pull(client: &impl VfsApi, database_id: &str) -> Result<serde_json::Value> {
    let paths = HermesPaths::resolve()?;
    let projected = sync_projection(client, database_id, &paths.projection_dir).await?;
    let status = local_status(&paths)?;
    Ok(json!({
        "status": "pulled",
        "projection_dir": paths.projection_dir,
        "projected_skills": projected,
        "local": status,
    }))
}

async fn hermes_status(
    client: &impl VfsApi,
    database_id: Option<&str>,
) -> Result<serde_json::Value> {
    let paths = HermesPaths::resolve()?;
    let local = local_status(&paths)?;
    let jobs = if let Some(database_id) = database_id {
        Some(job_counts(client, database_id).await?)
    } else {
        None
    };
    Ok(json!({ "local": local, "jobs": jobs }))
}

async fn flush_pending_runs(client: &impl VfsApi, database_id: &str) -> Result<serde_json::Value> {
    let paths = HermesPaths::resolve()?;
    let flushed_dir = paths.pending_dir.join("flushed");
    fs::create_dir_all(&flushed_dir)
        .with_context(|| format!("failed to create {}", flushed_dir.display()))?;
    let mut flushed = Vec::new();
    let mut failed = Vec::new();
    for entry in pending_json_files(&paths.pending_dir)? {
        let file_name = entry
            .file_name()
            .ok_or_else(|| anyhow!("invalid pending path: {}", entry.display()))?
            .to_owned();
        let result = match pending_skill_id(&entry) {
            Ok(skill_id) => record_skill_run_evidence(
                client,
                SkillRunEvidenceInput {
                    database_id,
                    id: &skill_id,
                    evidence_json: &entry,
                    public: false,
                },
            )
            .await
            .map(|_| ()),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {
                let target = unique_target(&flushed_dir, &file_name);
                fs::rename(&entry, &target).with_context(|| {
                    format!(
                        "failed to move flushed pending run {} to {}",
                        entry.display(),
                        target.display()
                    )
                })?;
                flushed.push(target.display().to_string());
            }
            Err(error) => {
                failed.push(
                    json!({ "path": entry.display().to_string(), "error": error.to_string() }),
                );
            }
        }
    }
    Ok(json!({ "flushed": flushed, "failed": failed }))
}

fn hermes_shadows() -> Result<serde_json::Value> {
    let paths = HermesPaths::resolve()?;
    let shadow_files = shadow_files(&paths.kinic_home)?;
    Ok(json!({ "shadow_files": shadow_files }))
}

async fn sync_projection(
    client: &impl VfsApi,
    database_id: &str,
    projection_dir: &Path,
) -> Result<Vec<serde_json::Value>> {
    fs::create_dir_all(projection_dir)
        .with_context(|| format!("failed to create {}", projection_dir.display()))?;
    let mut exported = Vec::new();
    for skill in approved_skill_ids(client, database_id, PRIVATE_SKILL_ROOT).await? {
        let target = projection_dir.join(&skill);
        let result = export_skill(client, database_id, &skill, &target, false).await?;
        exported.push(result);
    }
    Ok(exported)
}

async fn approved_skill_ids(
    client: &impl VfsApi,
    database_id: &str,
    root: &str,
) -> Result<Vec<String>> {
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: root.to_string(),
            recursive: true,
        })
        .await?;
    let mut ids = Vec::new();
    for entry in entries {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(skill_id) = skill_id_from_manifest_path(root, &entry.path) else {
            continue;
        };
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        if approved_manifest(&node.content)? {
            ids.push(skill_id);
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn install_plugin(paths: &HermesPaths) -> Result<()> {
    replace_dir_with_payload(&paths.plugin_dir, &[HERMES_PLUGIN_FILES, RUNTIME_FILES])
}

fn enable_hermes_plugin(config_path: &Path) -> Result<()> {
    let mut config = if config_path.is_file() {
        serde_yaml::from_str::<serde_yaml::Value>(
            &fs::read_to_string(config_path)
                .with_context(|| format!("failed to read {}", config_path.display()))?,
        )
        .with_context(|| format!("invalid Hermes config YAML: {}", config_path.display()))?
    } else {
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new())
    };
    if !config.is_mapping() {
        config = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let root = config.as_mapping_mut().expect("mapping checked");
    let plugins_key = serde_yaml::Value::String("plugins".to_string());
    let plugins = root
        .entry(plugins_key)
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !plugins.is_mapping() {
        *plugins = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    let plugins_map = plugins.as_mapping_mut().expect("mapping checked");
    let enabled_key = serde_yaml::Value::String("enabled".to_string());
    let enabled = plugins_map
        .entry(enabled_key)
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()));
    if !enabled.is_sequence() {
        *enabled = serde_yaml::Value::Sequence(Vec::new());
    }
    let enabled_list = enabled.as_sequence_mut().expect("sequence checked");
    if !enabled_list
        .iter()
        .any(|value| value.as_str() == Some("kinic"))
    {
        enabled_list.push(serde_yaml::Value::String("kinic".to_string()));
    }
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(config_path, serde_yaml::to_string(&config)?)
        .with_context(|| format!("failed to write {}", config_path.display()))?;
    Ok(())
}

fn write_setup_config(paths: &HermesPaths, database_id: &str) -> Result<()> {
    if let Some(parent) = paths.setup_config.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(&json!({
        "schema_version": 1,
        "database_id": database_id,
        "plugin_dir": paths.plugin_dir,
        "projection_dir": paths.projection_dir,
        "hermes_command": "/kinic_evolve_job",
    }))?;
    fs::write(&paths.setup_config, content)
        .with_context(|| format!("failed to write {}", paths.setup_config.display()))?;
    Ok(())
}

fn local_status(paths: &HermesPaths) -> Result<HermesLocalStatus> {
    Ok(HermesLocalStatus {
        plugin_installed: paths
            .plugin_dir
            .join("kinic_hermes")
            .join("__init__.py")
            .is_file(),
        plugin_dir: paths.plugin_dir.display().to_string(),
        projection_dir: paths.projection_dir.display().to_string(),
        projected_skills: projected_skill_count(&paths.projection_dir)?,
        pending_runs: pending_json_files(&paths.pending_dir)?.len(),
    })
}

async fn job_counts(client: &impl VfsApi, database_id: &str) -> Result<serde_json::Value> {
    let mut queued = 0;
    let mut running = 0;
    let mut done = 0;
    let mut conflict = 0;
    let mut failed = 0;
    for entry in client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: JOB_ROOT.to_string(),
            recursive: true,
        })
        .await?
    {
        if entry.kind != NodeEntryKind::File {
            continue;
        }
        let Some(node) = client.read_node(database_id, &entry.path).await? else {
            continue;
        };
        match frontmatter_scalar(&node.content, "status").as_deref() {
            Some("queued") => queued += 1,
            Some("running") => running += 1,
            Some("done") => done += 1,
            Some("conflict") => conflict += 1,
            Some("failed") => failed += 1,
            _ => {}
        }
    }
    Ok(json!({
        "queued": queued,
        "running": running,
        "done": done,
        "conflict": conflict,
        "failed": failed,
        "active": queued + running,
    }))
}

impl HermesPaths {
    fn resolve() -> Result<Self> {
        let kinic_home = env_path("KINIC_HOME")?.unwrap_or(home_dir()?.join(".kinic"));
        let hermes_home = env_path("HERMES_HOME")?.unwrap_or(home_dir()?.join(".hermes"));
        let projection_dir = kinic_home.join("hermes-current").join("skills");
        Ok(Self {
            hermes_config: hermes_home.join("config.yaml"),
            plugin_dir: hermes_home.join("plugins").join("kinic"),
            pending_dir: kinic_home.join("pending-runs"),
            setup_config: kinic_home.join("hermes-current").join("kinic.json"),
            kinic_home,
            projection_dir,
        })
    }
}

fn env_path(name: &str) -> Result<Option<PathBuf>> {
    match std::env::var_os(name) {
        Some(value) if !value.is_empty() => Ok(Some(PathBuf::from(value))),
        _ => Ok(None),
    }
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is required for Hermes setup"))
}

fn approved_manifest(content: &str) -> Result<bool> {
    Ok(matches!(
        frontmatter_scalar(content, "status").as_deref(),
        Some("reviewed" | "promoted")
    ))
}

fn skill_id_from_manifest_path(root: &str, path: &str) -> Option<String> {
    let relative = path.strip_prefix(&format!("{root}/"))?;
    let mut parts = relative.split('/');
    let skill_id = parts.next()?;
    match (parts.next(), parts.next()) {
        (Some("manifest.md"), None) => Some(skill_id.to_string()),
        _ => None,
    }
}

fn frontmatter_scalar(content: &str, key: &str) -> Option<String> {
    if !content.starts_with("---\n") {
        return None;
    }
    let end = content[4..].find("\n---")? + 4;
    for line in content[4..end].lines() {
        if line.starts_with(' ') || !line.contains(':') {
            continue;
        }
        let (field, value) = line.split_once(':')?;
        if field.trim() == key {
            return Some(value.trim().trim_matches('"').to_string());
        }
    }
    None
}

fn pending_json_files(pending_dir: &Path) -> Result<Vec<PathBuf>> {
    if !pending_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(pending_dir)
        .with_context(|| format!("failed to read {}", pending_dir.display()))?
    {
        let path = entry?.path();
        if path.is_file() && path.extension().and_then(|value| value.to_str()) == Some("json") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn pending_skill_id(path: &Path) -> Result<String> {
    let content =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .with_context(|| format!("invalid pending JSON: {}", path.display()))?;
    value
        .get("skill_id")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("pending run is missing skill_id: {}", path.display()))
}

fn projected_skill_count(projection_dir: &Path) -> Result<usize> {
    if !projection_dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(projection_dir)
        .with_context(|| format!("failed to read {}", projection_dir.display()))?
    {
        if entry?.path().join("SKILL.md").is_file() {
            count += 1;
        }
    }
    Ok(count)
}

fn shadow_files(root: &Path) -> Result<Vec<String>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_shadow_files(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_shadow_files(path: &Path, files: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            collect_shadow_files(&path, files)?;
        } else if let Some(name) = path.file_name().and_then(|value| value.to_str())
            && (name.contains("shadow") || name.contains("correction"))
        {
            files.push(path.display().to_string());
        }
    }
    Ok(())
}

fn unique_target(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let mut target = dir.join(file_name);
    if !target.exists() {
        return target;
    }
    for index in 1.. {
        target = dir.join(format!("{}.{index}", file_name.to_string_lossy()));
        if !target.exists() {
            return target;
        }
    }
    unreachable!("unique target loop always returns");
}

fn print_result(value: serde_json::Value, json_output: bool) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else if value.get("status").and_then(|status| status.as_str()) == Some("ready") {
        println!(
            "Hermes setup ready: plugin={} projection={} projected_skills={}",
            value["plugin_dir"].as_str().unwrap_or(""),
            value["projection_dir"].as_str().unwrap_or(""),
            value["projected_skills"].as_array().map_or(0, Vec::len)
        );
    } else if value.get("status").and_then(|status| status.as_str()) == Some("pulled") {
        println!(
            "Hermes projection pulled: projection={} projected_skills={}",
            value["projection_dir"].as_str().unwrap_or(""),
            value["projected_skills"].as_array().map_or(0, Vec::len)
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

fn require_database_id(database_id: Option<&str>) -> Result<&str> {
    database_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("database id is required; set --database-id, VFS_DATABASE_ID, or run database link <database-id>"))
}

#[cfg(test)]
mod tests {
    use super::{
        HermesPaths, approved_manifest, enable_hermes_plugin, frontmatter_scalar, install_plugin,
        skill_id_from_manifest_path,
    };
    use tempfile::TempDir;

    #[test]
    fn parses_approved_manifest_status() {
        assert!(approved_manifest("---\nstatus: reviewed\n---\n# Manifest\n").unwrap());
        assert!(approved_manifest("---\nstatus: promoted\n---\n# Manifest\n").unwrap());
        assert!(!approved_manifest("---\nstatus: draft\n---\n# Manifest\n").unwrap());
    }

    #[test]
    fn only_direct_manifest_paths_select_skill_id() {
        assert_eq!(
            skill_id_from_manifest_path("/Wiki/skills", "/Wiki/skills/legal-review/manifest.md"),
            Some("legal-review".to_string())
        );
        assert_eq!(
            skill_id_from_manifest_path(
                "/Wiki/skills",
                "/Wiki/skills/legal-review/versions/v1/manifest.md"
            ),
            None
        );
    }

    #[test]
    fn frontmatter_scalar_ignores_nested_fields() {
        let content = "---\nprovenance:\n  status: upstream\nstatus: queued\n---\n# Job\n";
        assert_eq!(
            frontmatter_scalar(content, "status"),
            Some("queued".to_string())
        );
    }

    #[test]
    fn install_plugin_writes_self_contained_payload() {
        let temp = TempDir::new().unwrap();
        let paths = HermesPaths {
            kinic_home: temp.path().join("kinic"),
            hermes_config: temp.path().join("hermes/config.yaml"),
            plugin_dir: temp.path().join("hermes/plugins/kinic"),
            projection_dir: temp.path().join("kinic/hermes-current/skills"),
            pending_dir: temp.path().join("kinic/pending-runs"),
            setup_config: temp.path().join("kinic/hermes-current/kinic.json"),
        };

        install_plugin(&paths).unwrap();

        assert!(paths.plugin_dir.join("plugin.yaml").is_file());
        assert!(paths.plugin_dir.join("kinic_hermes/__init__.py").is_file());
        assert!(
            paths
                .plugin_dir
                .join("kinic_agent_runtime/evolve.py")
                .is_file()
        );
        assert!(!paths.plugin_dir.join("agent-runtime").exists());
    }

    #[test]
    fn enable_hermes_plugin_preserves_config_and_deduplicates_enabled() {
        let temp = TempDir::new().unwrap();
        let config = temp.path().join("config.yaml");
        std::fs::write(
            &config,
            "model:\n  provider: openrouter\nplugins:\n  enabled:\n    - other\n    - kinic\n",
        )
        .unwrap();

        enable_hermes_plugin(&config).unwrap();

        let value: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(config).unwrap()).unwrap();
        assert_eq!(value["model"]["provider"].as_str(), Some("openrouter"));
        let enabled = value["plugins"]["enabled"].as_sequence().unwrap();
        assert_eq!(
            enabled
                .iter()
                .filter(|entry| entry.as_str() == Some("kinic"))
                .count(),
            1
        );
        assert!(enabled.iter().any(|entry| entry.as_str() == Some("other")));
    }
}
