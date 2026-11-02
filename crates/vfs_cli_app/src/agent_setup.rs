//! Reviewable setup plans shared by the generic and legacy engine setup commands.
use crate::{
    agent_config::AgentConfig,
    learning::cli::SetupArgs,
    plugin_payload::{CODEX_PLUGIN_FILES, RUNTIME_FILES},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

struct FilePlan {
    path: PathBuf,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    executable: bool,
}
fn plan(files: &mut Vec<FilePlan>, path: PathBuf, after: Vec<u8>, executable: bool) -> Result<()> {
    ensure!(
        !path.is_symlink(),
        "setup target is a symlink; choose a regular file"
    );
    let before = match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => anyhow::bail!("cannot read setup target"),
    };
    if before.as_deref() != Some(after.as_slice()) {
        files.push(FilePlan {
            path,
            before,
            after,
            executable,
        });
    }
    Ok(())
}
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
pub fn path_candidates(name: &Path) -> Vec<PathBuf> {
    if name.is_absolute() || name.components().count() > 1 {
        return is_executable(name)
            .then(|| name.to_path_buf())
            .into_iter()
            .collect();
    }
    let mut result = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if is_executable(&candidate) && !result.contains(&candidate) {
                result.push(candidate);
            }
        }
    }
    result
}
fn merge_marketplace_metadata(target: &mut Value, managed: &Value) {
    if let (Some(target), Some(managed)) = (target.as_object_mut(), managed.as_object()) {
        for (key, value) in managed {
            if let Some(existing) = target.get_mut(key) {
                merge_marketplace_metadata(existing, value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    } else {
        *target = managed.clone();
    }
}
fn marketplace(home: &Path, plugin_dir: &Path, files: &mut Vec<FilePlan>) -> Result<String> {
    let path = home.join(".agents/plugins/marketplace.json");
    let mut value = if path.exists() {
        serde_json::from_slice::<Value>(&fs::read(&path)?)
            .map_err(|_| anyhow::anyhow!("invalid marketplace JSON"))?
    } else {
        json!({"name":"personal-plugins","interface":{"displayName":"Personal Plugins"},"plugins":[]})
    };
    let name = value["name"]
        .as_str()
        .context("marketplace name is required")?
        .to_owned();
    ensure!(
        !name.is_empty()
            && name != "."
            && name != ".."
            && name.len() <= 128
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)),
        "marketplace name must be a safe plugin selector component"
    );
    let source_path = plugin_dir
        .strip_prefix(home)
        .map(|relative| format!("./{}", relative.to_string_lossy()))
        .unwrap_or_else(|_| plugin_dir.to_string_lossy().into_owned());
    let object = value
        .as_object_mut()
        .context("marketplace must be an object")?;
    let plugins = object
        .entry("plugins")
        .or_insert(json!([]))
        .as_array_mut()
        .context("marketplace plugins must be an array")?;
    let entry = json!({"name":"kinic-skill-recorder","display_name":"Kinic Skill Recorder","description":"Record Kinic Skill Registry run evidence from Codex.","source":{"source":"local","path":source_path},"policy":{"installation":"AVAILABLE","authentication":"ON_INSTALL"},"category":"Productivity"});
    if let Some(existing) = plugins
        .iter_mut()
        .find(|p| p["name"] == "kinic-skill-recorder")
    {
        // Preserve unknown metadata on our own entry as well as unrelated plugins.
        ensure!(existing.is_object(), "invalid marketplace entry");
        merge_marketplace_metadata(existing, &entry);
    } else {
        plugins.push(entry);
    }
    plan(files, path, serde_json::to_vec_pretty(&value)?, false)?;
    Ok(name)
}
pub fn run(args: &SetupArgs) -> Result<()> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is required")?;
    let value = prepare(args, &std::env::current_dir()?, &home)?;
    emit(args, &value)
}
fn emit(args: &SetupArgs, value: &Value) -> Result<()> {
    if args.json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!(
            "Setup {}: {}",
            args.engine,
            value["status"].as_str().unwrap()
        );
        for change in value["changes"].as_array().unwrap() {
            println!(
                "  {} {} ({} → {})",
                change["action"].as_str().unwrap(),
                change["path"].as_str().unwrap(),
                change["before_sha256"].as_str().unwrap_or("absent"),
                change["after_sha256"].as_str().unwrap()
            );
        }
        for note in value["notes"].as_array().unwrap() {
            println!("{}", note.as_str().unwrap());
        }
        for stage in ["identity_authorization", "plugin_installation"] {
            if !value[stage].is_null() {
                println!("{}: {}", stage, value[stage]["status"]);
            }
        }
        println!("Next: {}", value["next"].as_str().unwrap());
    }
    Ok(())
}
pub fn prepare(args: &SetupArgs, cwd: &Path, home: &Path) -> Result<Value> {
    ensure!(
        ["codex", "dsh"].contains(&args.engine.as_str()),
        "select codex or dsh"
    );
    let config = AgentConfig::load(cwd, home)?;
    let candidates = path_candidates(Path::new(&args.engine));
    let engine_path = format!("agents.{}.executable", args.engine);
    let project_wins = config
        .sources
        .get(&engine_path)
        .is_some_and(|p| p == &config.project_path.to_string_lossy());
    if args.executable.is_some() && project_wins && !args.project {
        anyhow::bail!("project executable takes precedence; pass --project to change that setting");
    }
    let executable = if let Some(path) = &args.executable {
        path.clone()
    } else if config.configured_engines().contains(&args.engine) {
        config.runner(Some(&args.engine), None)?.executable
    } else if args.engine == "dsh" {
        ensure!(
            candidates.len() == 1,
            "DSH executable is missing or ambiguous; choose --executable from PATH candidates: {}",
            serde_json::to_string(&candidates)?
        );
        candidates[0].clone()
    } else {
        PathBuf::from("codex")
    };
    // New setup paths are absolute when a path was given; bare names retain PATH lookup.
    let executable = if executable.components().count() > 1 && executable.is_relative() {
        cwd.join(executable)
    } else {
        executable
    };
    let mut files = Vec::new();
    let target = if args.project || project_wins {
        config.project_path.clone()
    } else {
        config.user_path.clone()
    };
    let mut project = vfs_cli::connection::read_config_document(&config.project_path)?;
    let mut user = vfs_cli::connection::read_config_document(&config.user_path)?;
    let doc = if target == config.project_path {
        &mut project
    } else {
        &mut user
    };
    let previous_executable = doc
        .get("agents")
        .and_then(|a| a.get(&args.engine))
        .and_then(|a| a.get("executable"))
        .and_then(toml_edit::Item::as_str)
        .map(str::to_owned);
    doc["agents"][&args.engine]["executable"] =
        toml_edit::value(executable.to_string_lossy().as_ref());
    let new_learning = !config.has_learning()
        && config.hook_path()?.is_none()
        && args.recall_config.is_none()
        && !config.cwd.join(".kinic-learning.json").is_file()
        && !config.root.join(".kinic-learning.json").is_file();
    if new_learning {
        project["learning"]["budget_tokens"] = toml_edit::value(4096);
    }
    if let Some(path) = &args.recall_config {
        config.recall(Some(path))?;
    }
    // Both documents may be changed; plan only nonempty or already-existing documents.
    for (path, doc) in [(&config.project_path, &project), (&config.user_path, &user)] {
        if !doc.as_table().is_empty() || path.exists() {
            plan(
                &mut files,
                path.clone(),
                doc.to_string().into_bytes(),
                false,
            )?;
        }
    }
    let mut marketplace_name = None;
    let plugin_dir = if args.engine == "codex" {
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let codex_home = if codex_home.is_absolute() {
            codex_home
        } else {
            cwd.join(codex_home)
        };
        let dir = codex_home.join("plugins/kinic-skill-recorder");
        for payload in [CODEX_PLUGIN_FILES, RUNTIME_FILES] {
            for file in payload {
                plan(
                    &mut files,
                    dir.join(file.path),
                    file.content.as_bytes().to_vec(),
                    file.executable,
                )?;
            }
        }
        plan(
            &mut files,
            dir.join(".kinic-managed-plugin"),
            b"kinic-vfs-cli\n".to_vec(),
            false,
        )?;
        marketplace_name = Some(marketplace(home, &dir, &mut files)?);
        dir
    } else {
        let dir = args
            .output
            .clone()
            .unwrap_or(config.root.join(".kinic/plugins/dsh"));
        for (name, content) in [
            ("index.js", include_str!("../../../plugins/dsh/index.js")),
            (
                "index.d.ts",
                include_str!("../../../plugins/dsh/index.d.ts"),
            ),
            (
                "package.json",
                include_str!("../../../plugins/dsh/package.json"),
            ),
        ] {
            plan(
                &mut files,
                dir.join(name),
                content.as_bytes().to_vec(),
                false,
            )?;
        }
        let mut options = json!({"cliExecutable":std::env::current_exe()?,"cliArgs":[]});
        if let Some(path) = &args.recall_config {
            options["recallConfig"] = path.canonicalize()?.to_string_lossy().as_ref().into();
        }
        let overlay = json!([{"name":"@kinic/dsh-learning","config":options}]);
        plan(
            &mut files,
            dir.join("kinic-learning.patch.yml"),
            serde_json::to_vec_pretty(&overlay)?,
            false,
        )?;
        dir
    };
    let pending = files.iter().any(|f| f.before.is_some()) && !args.apply;
    let status = if args.dry_run {
        "dry_run"
    } else if files.is_empty() {
        "unchanged"
    } else if pending {
        "changes_pending"
    } else {
        "prepared"
    };
    let changes:Vec<Value>=files.iter().map(|file| json!({"path":file.path,"action":if file.before.is_some(){"replace"}else{"create"},"before_sha256":file.before.as_ref().map(|v|crate::learning::hash(&String::from_utf8_lossy(v))),"after_sha256":crate::learning::hash(&String::from_utf8_lossy(&file.after))})).collect();
    if !args.dry_run && !pending {
        // Recheck all baselines before any write; do not silently overwrite concurrent edits.
        for file in &files {
            ensure!(
                fs::read(&file.path).ok() == file.before,
                "setup target changed during planning; rerun setup"
            );
        }
        for file in &files {
            if let Some(parent) = file.path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&file.path, &file.after)?;
            #[cfg(unix)]
            if file.executable {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&file.path, fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    Ok(
        json!({"status":status,"engine":args.engine,"plugin_directory":plugin_dir,"marketplace_name":marketplace_name,"executable":executable,"executable_candidates":candidates,"executable_settings_path":target,"changes":changes,"configuration_changes":{"executable":{"before":previous_executable,"after":executable,"source":target},"new_learning_budget_tokens":if new_learning{Some(4096)}else{None}},"activation":"unknown","observed_operation":"unknown","notes":["Existing replacements require --apply; --dry-run writes nothing.",if args.engine=="codex" {"Plugin placement and marketplace registration do not establish activation. Review installation, hook enablement and trust in Codex, then restart if required."}else{"Install the prepared package into the selected DSH profile and load its overlay. No active profile was modified."}],"next_argv":["kinic-vfs-cli","agent","doctor","--engine",args.engine,"--cwd",config.root],"next":format!("kinic-vfs-cli agent doctor --engine {} --cwd '{}'",args.engine,config.root.to_string_lossy().replace('\'', "'\"'\"'"))}),
    )
}

/// Explicit privileged setup stages are separate from non-executing file preparation.
pub async fn run_connected(
    args: &SetupArgs,
    connection: &vfs_cli::cli::ConnectionArgs,
) -> Result<()> {
    ensure!(
        !args.install_plugin || args.engine == "codex",
        "plugin installation supports Codex only"
    );
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .context("HOME is required")?;
    let cwd = std::env::current_dir()?;
    let mut value = prepare(args, &cwd, &home)?;
    let applying = args.apply && !args.dry_run && value["status"] != "changes_pending";
    if args.authorize_keyring {
        value["identity_authorization"] = json!({"status":if args.dry_run {"planned"} else {"apply_required"},"next":"agent setup --authorize-keyring --apply"});
        if applying {
            let c = vfs_cli::connection::resolve_connection(
                connection.local,
                connection.replica_host.clone(),
                connection.canister_id.clone(),
                connection.database_id.clone(),
            )?;
            let root = crate::identity_policy::project_root(&cwd)?;
            let grant=crate::identity::keyring_grant(&root,&c).await.map_err(|_| anyhow::anyhow!("cannot authorize selected keyring identity; check icp identity default and credential access"))?;
            crate::identity_policy::save(&home, &grant)?;
            value["identity_authorization"] = json!({"status":"authorized","binding":grant});
        }
    }
    if args.install_plugin {
        value["plugin_installation"] =
            json!({"status":if args.dry_run {"planned"} else {"apply_required"}});
        if applying {
            let executable = value["executable"]
                .as_str()
                .context("Codex executable missing")?;
            let marketplace = value["marketplace_name"]
                .as_str()
                .context("Codex marketplace name missing")?;
            value["plugin_installation"] =
                install_plugin(Path::new(executable), marketplace).await?;
        }
    }
    value["next"] = json!(
        "Check /hooks in Codex, then run kinic-vfs-cli agent doctor; automatic learning requires learn setup."
    );
    emit(args, &value)
}
async fn codex_json(executable: &Path, args: &[&str]) -> Result<Value> {
    let mut command = tokio::process::Command::new(executable);
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
        .await
        .map_err(|_| anyhow::anyhow!("Codex plugin command timed out"))?
        .map_err(|_| anyhow::anyhow!("Codex plugin command could not start"))?;
    ensure!(
        output.status.success(),
        "Codex plugin command failed; inspect Codex plugin settings"
    );
    ensure!(
        output.stdout.len() <= 4 * 1024 * 1024,
        "Codex plugin output exceeded limit"
    );
    serde_json::from_slice(&output.stdout)
        .map_err(|_| anyhow::anyhow!("Codex plugin command returned invalid JSON"))
}
fn matching_plugin(value: &Value, plugin_id: &str, expected: &str) -> bool {
    value["installed"].as_array().is_some_and(|rows| {
        rows.iter().any(|row| {
            row["pluginId"] == plugin_id
                && row["installed"] == true
                && row["enabled"] == true
                && row["version"] == expected
        })
    })
}
async fn install_plugin(executable: &Path, marketplace: &str) -> Result<Value> {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../plugins/codex/.codex-plugin/plugin.json"
    ))?;
    let version = manifest["version"]
        .as_str()
        .context("plugin version missing")?;
    let plugin_id = format!("kinic-skill-recorder@{marketplace}");
    let list_args = ["plugin", "list", "--marketplace", marketplace, "--json"];
    let before = codex_json(executable, &list_args).await?;
    let changed = !matching_plugin(&before, &plugin_id, version);
    if changed {
        codex_json(executable, &["plugin", "add", &plugin_id, "--json"]).await?;
        let after = codex_json(executable, &list_args).await?;
        ensure!(
            matching_plugin(&after, &plugin_id, version),
            "Codex did not confirm the expected plugin version and enablement"
        );
    }
    Ok(
        json!({"status":"installed_enabled","plugin_id":plugin_id,"version":version,"changed":changed,"hook_trust":"unknown","observed_operation":"unknown","next":"Review /hooks in Codex and restart if required"}),
    )
}
