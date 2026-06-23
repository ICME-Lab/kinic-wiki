// Where: crates/vfs_cli_app/src/claude.rs
// What: Local Claude Code plugin marketplace setup for Kinic skill recording.
// Why: Claude Code installs plugins through marketplaces, while Kinic ships a self-contained local payload.
use crate::cli::ClaudeCommand;
use crate::plugin_payload::{CLAUDE_PLUGIN_FILES, RUNTIME_FILES, replace_dir_with_payload};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const MARKETPLACE_NAME: &str = "kinic";
const PLUGIN_NAME: &str = "kinic-skill-recorder";
const ENABLED_PLUGIN_KEY: &str = "kinic-skill-recorder@kinic";

#[derive(Debug, Clone)]
struct ClaudePaths {
    marketplace_dir: PathBuf,
    plugin_dir: PathBuf,
    marketplace_manifest: PathBuf,
    settings_path: PathBuf,
}

#[derive(Debug, Serialize)]
struct ClaudeSetupStatus {
    plugin_installed: bool,
    marketplace_dir: String,
    plugin_dir: String,
    marketplace_manifest: String,
    settings_path: String,
}

pub fn run_claude_command(command: ClaudeCommand) -> Result<()> {
    match command {
        ClaudeCommand::Setup { json } => {
            let result = claude_setup()?;
            print_result(result, json)?;
        }
    }
    Ok(())
}

fn claude_setup() -> Result<Value> {
    let home = home_dir()?;
    claude_setup_at_home(&home)
}

fn claude_setup_at_home(home: &Path) -> Result<Value> {
    let paths = ClaudePaths::resolve(home);
    install_claude_plugin(&paths.plugin_dir)?;
    write_marketplace_manifest(&paths)?;
    upsert_claude_settings(&paths)?;
    let status = ClaudeSetupStatus {
        plugin_installed: paths
            .plugin_dir
            .join(".claude-plugin")
            .join("plugin.json")
            .is_file(),
        marketplace_dir: paths.marketplace_dir.display().to_string(),
        plugin_dir: paths.plugin_dir.display().to_string(),
        marketplace_manifest: paths.marketplace_manifest.display().to_string(),
        settings_path: paths.settings_path.display().to_string(),
    };
    Ok(json!({
        "status": "ready",
        "marketplace_dir": paths.marketplace_dir,
        "plugin_dir": paths.plugin_dir,
        "marketplace_manifest": paths.marketplace_manifest,
        "settings_path": paths.settings_path,
        "local": status,
    }))
}

fn install_claude_plugin(plugin_dir: &Path) -> Result<()> {
    replace_dir_with_payload(plugin_dir, &[CLAUDE_PLUGIN_FILES, RUNTIME_FILES])
}

fn write_marketplace_manifest(paths: &ClaudePaths) -> Result<()> {
    let parent = paths
        .marketplace_manifest
        .parent()
        .ok_or_else(|| anyhow!("invalid marketplace path"))?;
    fs::create_dir_all(parent).with_context(|| format!("failed to create {}", parent.display()))?;
    let manifest = json!({
        "name": MARKETPLACE_NAME,
        "owner": {
            "name": "Kinic"
        },
        "plugins": [
            {
                "name": PLUGIN_NAME,
                "displayName": "Kinic Skill Recorder",
                "description": "Record Kinic Skill Registry run evidence and process skill evolution jobs from Claude Code.",
                "version": "0.1.2",
                "source": "./plugins/kinic-skill-recorder",
                "category": "Productivity",
                "tags": ["kinic", "skills", "evidence"]
            }
        ]
    });
    fs::write(
        &paths.marketplace_manifest,
        serde_json::to_string_pretty(&manifest)? + "\n",
    )
    .with_context(|| format!("failed to write {}", paths.marketplace_manifest.display()))?;
    Ok(())
}

fn upsert_claude_settings(paths: &ClaudePaths) -> Result<()> {
    let mut data = read_json_object_or_default(&paths.settings_path)?;
    let root = data.as_object_mut().expect("object checked");

    let marketplaces = object_entry(root, "extraKnownMarketplaces")?;
    marketplaces.insert(
        MARKETPLACE_NAME.to_string(),
        json!({
            "source": {
                "source": "directory",
                "path": paths.marketplace_dir
            }
        }),
    );

    let enabled = object_entry(root, "enabledPlugins")?;
    enabled.insert(ENABLED_PLUGIN_KEY.to_string(), json!(true));

    if let Some(parent) = paths.settings_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    fs::write(
        &paths.settings_path,
        serde_json::to_string_pretty(&data)? + "\n",
    )
    .with_context(|| format!("failed to write {}", paths.settings_path.display()))?;
    Ok(())
}

fn read_json_object_or_default(path: &Path) -> Result<Value> {
    if !path.is_file() {
        return Ok(json!({}));
    }
    let value = serde_json::from_str::<Value>(
        &fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?,
    )
    .with_context(|| format!("invalid Claude settings JSON: {}", path.display()))?;
    if !value.is_object() {
        return Err(anyhow!(
            "Claude settings root must be an object: {}",
            path.display()
        ));
    }
    Ok(value)
}

fn object_entry<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    let entry = root.entry(key.to_string()).or_insert_with(|| json!({}));
    if !entry.is_object() {
        return Err(anyhow!("Claude settings {key} must be an object"));
    }
    Ok(entry.as_object_mut().expect("object checked"))
}

impl ClaudePaths {
    fn resolve(home: &Path) -> Self {
        let marketplace_dir = home.join(".claude").join("plugins").join(MARKETPLACE_NAME);
        let plugin_dir = marketplace_dir.join("plugins").join("kinic-skill-recorder");
        Self {
            marketplace_manifest: marketplace_dir
                .join(".claude-plugin")
                .join("marketplace.json"),
            settings_path: home.join(".claude").join("settings.json"),
            marketplace_dir,
            plugin_dir,
        }
    }
}

fn print_result(value: Value, json_output: bool) -> Result<()> {
    if json_output {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "Claude Code plugin setup ready: marketplace={} plugin={} settings={}",
            value["marketplace_dir"].as_str().unwrap_or(""),
            value["plugin_dir"].as_str().unwrap_or(""),
            value["settings_path"].as_str().unwrap_or("")
        );
    }
    Ok(())
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is required for Claude setup"))
}

#[cfg(test)]
mod tests {
    use super::{ENABLED_PLUGIN_KEY, MARKETPLACE_NAME, PLUGIN_NAME, claude_setup_at_home};
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn claude_setup_installs_self_contained_plugin_and_marketplace() {
        let temp = TempDir::new().unwrap();
        claude_setup_at_home(temp.path()).unwrap();
        let marketplace = temp.path().join(".claude/plugins").join(MARKETPLACE_NAME);
        let plugin = marketplace.join("plugins").join(PLUGIN_NAME);

        assert!(
            marketplace
                .join(".claude-plugin/marketplace.json")
                .is_file()
        );
        assert!(plugin.join(".claude-plugin/plugin.json").is_file());
        assert!(plugin.join("scripts/record-run.sh").is_file());
        assert!(plugin.join("scripts/record-session.sh").is_file());
        assert!(plugin.join("hooks/hooks.json").is_file());
        assert!(plugin.join("kinic_agent_runtime/evidence.py").is_file());
        assert!(plugin.join("kinic_agent_runtime/session.py").is_file());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let record_session_mode = std::fs::metadata(plugin.join("scripts/record-session.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let hooks_mode = std::fs::metadata(plugin.join("hooks/hooks.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111;

            assert_eq!(record_session_mode, 0o755);
            assert_eq!(hooks_mode, 0);
        }
    }

    #[test]
    fn claude_setup_preserves_settings_and_enables_plugin() {
        let temp = TempDir::new().unwrap();
        let settings = temp.path().join(".claude/settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "theme": "dark",
                "enabledPlugins": {
                    "keep@tools": true
                },
                "extraKnownMarketplaces": {
                    "keep-tools": {
                        "source": {
                            "source": "github",
                            "repo": "acme/tools"
                        }
                    }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        claude_setup_at_home(temp.path()).unwrap();

        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["enabledPlugins"]["keep@tools"], true);
        assert_eq!(value["enabledPlugins"][ENABLED_PLUGIN_KEY], true);
        assert_eq!(
            value["extraKnownMarketplaces"]["keep-tools"]["source"]["repo"],
            "acme/tools"
        );
        assert_eq!(
            value["extraKnownMarketplaces"][MARKETPLACE_NAME]["source"]["source"],
            "directory"
        );
    }

    #[test]
    fn claude_setup_is_idempotent() {
        let temp = TempDir::new().unwrap();

        claude_setup_at_home(temp.path()).unwrap();
        claude_setup_at_home(temp.path()).unwrap();

        let settings = temp.path().join(".claude/settings.json");
        let value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
        assert_eq!(value["enabledPlugins"][ENABLED_PLUGIN_KEY], true);
        assert_eq!(
            value["extraKnownMarketplaces"][MARKETPLACE_NAME]["source"]["source"],
            "directory"
        );
    }

    #[test]
    fn claude_setup_rejects_non_object_settings_fields_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let settings = temp.path().join(".claude/settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let original = serde_json::to_string_pretty(&json!({
            "enabledPlugins": ["old"],
            "extraKnownMarketplaces": "old"
        }))
        .unwrap();
        std::fs::write(&settings, &original).unwrap();

        let error = claude_setup_at_home(temp.path()).unwrap_err();

        assert!(error.to_string().contains("extraKnownMarketplaces"));
        assert_eq!(std::fs::read_to_string(settings).unwrap(), original);
    }

    #[test]
    fn claude_setup_rejects_non_object_enabled_plugins_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let settings = temp.path().join(".claude/settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let original = serde_json::to_string_pretty(&json!({
            "extraKnownMarketplaces": {},
            "enabledPlugins": ["old"]
        }))
        .unwrap();
        std::fs::write(&settings, &original).unwrap();

        let error = claude_setup_at_home(temp.path()).unwrap_err();

        assert!(error.to_string().contains("enabledPlugins"));
        assert_eq!(std::fs::read_to_string(settings).unwrap(), original);
    }

    #[test]
    fn claude_setup_rejects_non_object_settings_root_without_rewrite() {
        let temp = TempDir::new().unwrap();
        let settings = temp.path().join(".claude/settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        let original = "[]";
        std::fs::write(&settings, original).unwrap();

        let error = claude_setup_at_home(temp.path()).unwrap_err();

        assert!(error.to_string().contains("root must be an object"));
        assert_eq!(std::fs::read_to_string(settings).unwrap(), original);
    }
}
