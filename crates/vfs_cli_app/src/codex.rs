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

const PLUGIN_NAME: &str = "kinic-skill-recorder";
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
        data = json!({
            "name": "personal-plugins",
            "interface": { "displayName": "Personal Plugins" },
            "plugins": []
        });
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
            "type": "local",
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
        *plugins = json!([]);
    }
    let entries = plugins.as_array_mut().expect("array checked");
    entries.retain(|value| value.get("name").and_then(Value::as_str) != Some(PLUGIN_NAME));
    entries.push(entry);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(path, serde_json::to_string_pretty(&data)? + "\n")
        .with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
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
    use super::{PLUGIN_NAME, codex_setup_at_home};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn codex_setup_installs_self_contained_plugin() {
        let temp = TempDir::new().unwrap();
        codex_setup_at_home(temp.path()).unwrap();
        let plugin = temp.path().join(".codex").join("plugins").join(PLUGIN_NAME);

        assert!(plugin.join(".codex-plugin/plugin.json").is_file());
        assert!(plugin.join("scripts/record-run.sh").is_file());
        assert!(plugin.join("kinic_agent_runtime/evidence.py").is_file());
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
            serde_json::from_str(&std::fs::read_to_string(marketplace).unwrap()).unwrap();
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
        assert_eq!(
            kinic[0]["source"]["path"],
            "./.codex/plugins/kinic-skill-recorder"
        );
        assert_eq!(kinic[0]["policy"]["installation"], "AVAILABLE");
        assert_eq!(kinic[0]["policy"]["authentication"], "ON_INSTALL");
        assert_eq!(kinic[0]["category"], "Productivity");
    }
}
