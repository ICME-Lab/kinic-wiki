// Where: crates/vfs_cli_app/src/codex.rs
// What: Local Codex plugin setup for Kinic skill recording.
// Why: Binary installs must create a self-contained personal plugin without a repo checkout.
use crate::cli::CodexCommand;
use crate::plugin_payload::{CODEX_PLUGIN_FILES, RUNTIME_FILES, replace_dir_with_payload};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const PLUGIN_NAME: &str = "kinic-skill-recorder";
// Codex resolves personal marketplace paths from the marketplace root ($HOME),
// not from ~/.agents/plugins where marketplace.json is stored.
const MARKETPLACE_PLUGIN_PATH: &str = "./.codex/plugins/kinic-skill-recorder";

#[derive(Debug, Clone)]
struct CodexPaths {
    plugin_dir: PathBuf,
    marketplace_path: PathBuf,
}

#[derive(Debug, Serialize)]
struct CodexSetupStatus {
    plugin_installed: bool,
    plugin_dir: String,
    marketplace_path: String,
}

pub fn run_codex_command(command: CodexCommand) -> Result<()> {
    match command {
        CodexCommand::Setup { json } => {
            let result = codex_setup()?;
            print_result(result, json)?;
        }
    }
    Ok(())
}

fn codex_setup() -> Result<Value> {
    let home = home_dir()?;
    codex_setup_at_home(&home)
}

fn codex_setup_at_home(home: &Path) -> Result<Value> {
    let paths = CodexPaths::resolve(home);
    validate_marketplace_shape(&paths.marketplace_path)?;
    install_codex_plugin(&paths.plugin_dir)?;
    upsert_marketplace_entry(&paths.marketplace_path)?;
    let status = CodexSetupStatus {
        plugin_installed: paths
            .plugin_dir
            .join(".codex-plugin")
            .join("plugin.json")
            .is_file(),
        plugin_dir: paths.plugin_dir.display().to_string(),
        marketplace_path: paths.marketplace_path.display().to_string(),
    };
    Ok(json!({
        "status": "ready",
        "plugin_dir": paths.plugin_dir,
        "marketplace_path": paths.marketplace_path,
        "local": status,
    }))
}

fn install_codex_plugin(plugin_dir: &Path) -> Result<()> {
    replace_dir_with_payload(plugin_dir, &[CODEX_PLUGIN_FILES, RUNTIME_FILES])
}

fn validate_marketplace_shape(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let data = serde_json::from_str::<Value>(
        &fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?,
    )
    .with_context(|| format!("invalid marketplace JSON: {}", path.display()))?;
    if !data.is_object() {
        return Err(anyhow!(
            "Codex marketplace root must be an object: {}",
            path.display()
        ));
    }
    if let Some(plugins) = data.get("plugins")
        && !plugins.is_array()
    {
        return Err(anyhow!("Codex marketplace plugins must be an array"));
    }
    Ok(())
}

fn upsert_marketplace_entry(path: &Path) -> Result<()> {
    let mut data = if path.is_file() {
        serde_json::from_str::<Value>(
            &fs::read_to_string(path)
                .with_context(|| format!("failed to read {}", path.display()))?,
        )
        .with_context(|| format!("invalid marketplace JSON: {}", path.display()))?
    } else {
        json!({
            "name": "personal-plugins",
            "interface": { "displayName": "Personal Plugins" },
            "plugins": []
        })
    };
    if !data.is_object() {
        return Err(anyhow!(
            "Codex marketplace root must be an object: {}",
            path.display()
        ));
    }
    data.as_object_mut()
        .expect("object checked")
        .entry("name")
        .or_insert_with(|| json!("personal-plugins"));
    data.as_object_mut()
        .expect("object checked")
        .entry("interface")
        .or_insert_with(|| json!({ "displayName": "Personal Plugins" }));

    let entry = json!({
        "name": PLUGIN_NAME,
        "display_name": "Kinic Skill Recorder",
        "description": "Record Kinic Skill Registry run evidence and process skill evolution jobs from Codex.",
        "source": {
            "source": "local",
            "path": MARKETPLACE_PLUGIN_PATH
        },
        "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL"
        },
        "category": "Productivity"
    });
    let plugins = data
        .as_object_mut()
        .expect("object checked")
        .entry("plugins")
        .or_insert_with(|| json!([]));
    if !plugins.is_array() {
        return Err(anyhow!("Codex marketplace plugins must be an array"));
    }
    let entries = plugins.as_array_mut().expect("array checked");
    entries.retain(|value| value.get("name").and_then(Value::as_str) != Some(PLUGIN_NAME));
    entries.push(entry);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    backup_existing_file(path)?;
    fs::write(path, serde_json::to_string_pretty(&data)? + "\n")
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn backup_existing_file(path: &Path) -> Result<()> {
    if !path.is_file() {
        return Ok(());
    }
    let backup = unique_backup_path(path);
    fs::copy(path, &backup).with_context(|| {
        format!(
            "failed to backup {} to {}",
            path.display(),
            backup.display()
        )
    })?;
    eprintln!(
        "warning: backed up Codex marketplace before rewrite: {}",
        backup.display()
    );
    Ok(())
}

fn unique_backup_path(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("marketplace.json");
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let mut candidate = parent.join(format!("{name}.backup.{millis}"));
    let mut suffix = 1;
    while candidate.exists() {
        candidate = parent.join(format!("{name}.backup.{millis}.{suffix}"));
        suffix += 1;
    }
    candidate
}

impl CodexPaths {
    fn resolve(home: &Path) -> Self {
        Self {
            plugin_dir: home.join(".codex").join("plugins").join(PLUGIN_NAME),
            marketplace_path: home
                .join(".agents")
                .join("plugins")
                .join("marketplace.json"),
        }
    }
}

fn print_result(value: Value, json_output: bool) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "Codex plugin setup ready: plugin={} marketplace={}",
            value["plugin_dir"].as_str().unwrap_or(""),
            value["marketplace_path"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is required for Codex setup"))
}

#[cfg(test)]
mod tests {
    use super::{MARKETPLACE_PLUGIN_PATH, PLUGIN_NAME, codex_setup_at_home};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn codex_setup_installs_self_contained_plugin() {
        let temp = TempDir::new().unwrap();
        codex_setup_at_home(temp.path()).unwrap();
        let plugin = temp.path().join(".codex").join("plugins").join(PLUGIN_NAME);

        assert!(plugin.join(".codex-plugin/plugin.json").is_file());
        assert!(plugin.join(".kinic-managed-plugin").is_file());
        assert!(plugin.join("scripts/record-run.sh").is_file());
        assert!(plugin.join("scripts/record-session.sh").is_file());
        assert!(plugin.join("hooks/hooks.json").is_file());
        assert!(plugin.join("kinic_agent_runtime/evidence.py").is_file());
        assert!(plugin.join("kinic_agent_runtime/session.py").is_file());
        assert!(!plugin.join(".kinic-source-root").exists());
    }

    #[test]
    fn codex_setup_preserves_other_marketplace_entries_and_replaces_kinic() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        std::fs::write(
            &marketplace,
            serde_json::to_string_pretty(&json!({
                "name": "personal-plugins",
                "plugins": [
                    { "name": "keep", "source": { "type": "local", "path": "./keep" } },
                    { "name": PLUGIN_NAME, "source": { "type": "local", "path": "./old" } }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        codex_setup_at_home(temp.path()).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&marketplace).unwrap()).unwrap();
        let plugins = value["plugins"].as_array().unwrap();
        assert_eq!(
            plugins
                .iter()
                .filter(|entry| entry["name"] == "keep")
                .count(),
            1
        );
        let kinic: Vec<_> = plugins
            .iter()
            .filter(|entry| entry["name"] == PLUGIN_NAME)
            .collect();
        assert_eq!(kinic.len(), 1);
        assert_eq!(kinic[0]["source"]["source"], "local");
        assert_eq!(kinic[0]["source"]["path"], MARKETPLACE_PLUGIN_PATH);
        let resolved = temp
            .path()
            .join(MARKETPLACE_PLUGIN_PATH.strip_prefix("./").unwrap());
        assert_eq!(
            resolved,
            temp.path().join(".codex/plugins/kinic-skill-recorder")
        );
        assert_eq!(kinic[0]["policy"]["installation"], "AVAILABLE");
        assert_eq!(kinic[0]["policy"]["authentication"], "ON_INSTALL");
        assert_eq!(kinic[0]["category"], "Productivity");
        let backups: Vec<_> = std::fs::read_dir(marketplace.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("marketplace.json.backup.")
            })
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn codex_setup_is_idempotent() {
        let temp = TempDir::new().unwrap();

        codex_setup_at_home(temp.path()).unwrap();
        codex_setup_at_home(temp.path()).unwrap();

        let marketplace = temp.path().join(".agents/plugins/marketplace.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(marketplace).unwrap()).unwrap();
        let plugins = value["plugins"].as_array().unwrap();
        assert_eq!(
            plugins
                .iter()
                .filter(|entry| entry["name"] == PLUGIN_NAME)
                .count(),
            1
        );
    }

    #[test]
    fn codex_setup_rejects_non_object_marketplace_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        std::fs::write(&marketplace, "[]").unwrap();

        let error = codex_setup_at_home(temp.path()).unwrap_err();

        assert!(error.to_string().contains("root must be an object"));
        assert_eq!(std::fs::read_to_string(marketplace).unwrap(), "[]");
    }

    #[test]
    fn codex_setup_rejects_non_array_plugins_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let marketplace = temp.path().join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        let original = serde_json::to_string_pretty(&json!({
            "name": "personal-plugins",
            "plugins": {}
        }))
        .unwrap();
        std::fs::write(&marketplace, &original).unwrap();

        let error = codex_setup_at_home(temp.path()).unwrap_err();

        assert!(error.to_string().contains("plugins must be an array"));
        assert_eq!(std::fs::read_to_string(marketplace).unwrap(), original);
    }

    #[test]
    fn codex_setup_backs_up_unmanaged_plugin_directory_before_replace() {
        let temp = TempDir::new().unwrap();
        let plugin = temp.path().join(".codex").join("plugins").join(PLUGIN_NAME);
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("manual.txt"), "keep").unwrap();

        codex_setup_at_home(temp.path()).unwrap();

        assert!(plugin.join(".kinic-managed-plugin").is_file());
        let backups: Vec<_> = std::fs::read_dir(plugin.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("kinic-skill-recorder.backup.")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].path().join("manual.txt").is_file());
    }
}
