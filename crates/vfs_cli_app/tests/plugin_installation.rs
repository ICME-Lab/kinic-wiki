#![cfg(unix)]
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Output},
};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    codex_home: PathBuf,
    executable: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let home = temp.path().join("home");
        let codex_home = temp.path().join("selected codex home");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(home.join(".agents/plugins")).unwrap();
        fs::write(home.join(".agents/plugins/marketplace.json"), json!({
            "name":"team-tools", "unrelated":{"keep":true}, "plugins":[
                {"name":"other-plugin","source":{"source":"local","path":"./other"}},
                {"name":"kinic-skill-recorder","custom":"keep","source":{"path":"old","custom_source":"keep"},"policy":{"custom_policy":"keep"}}
            ]
        }).to_string()).unwrap();
        let executable = temp.path().join("fake-codex");
        fs::write(&executable, r#"#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_PLUGIN_LOG"
case "$*" in
  'plugin list --marketplace team-tools --json')
    if [ -f "$FAKE_PLUGIN_STATE" ]; then
      printf '{"installed":[{"pluginId":"kinic-skill-recorder@team-tools","installed":true,"enabled":true,"version":"%s"}]}\n' "${FAKE_PLUGIN_VERSION:-0.2.1}"
    else
      printf '{"installed":[]}\n'
    fi ;;
  'plugin add kinic-skill-recorder@team-tools --json')
    : > "$FAKE_PLUGIN_STATE"
    printf '{"pluginId":"kinic-skill-recorder@team-tools"}\n' ;;
  *) printf 'unexpected command secret-marker\n' >&2; exit 42 ;;
esac
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            temp,
            root,
            home,
            codex_home,
            executable,
        }
    }
    fn invoke(&self, args: &[&str], version: Option<&str>) -> Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_kinic-vfs-cli"));
        cmd.current_dir(&self.root)
            .env("HOME", &self.home)
            .env("CODEX_HOME", &self.codex_home)
            .env("ICP_HOME", self.home.join("icp"))
            .env("FAKE_PLUGIN_LOG", self.temp.path().join("calls"))
            .env("FAKE_PLUGIN_STATE", self.temp.path().join("installed"))
            .env_remove("VFS_CANISTER_ID")
            .env_remove("VFS_DATABASE_ID")
            .env_remove("KINIC_LEARNING_CONFIG")
            .env_remove("KINIC_LEARNING_HOME")
            .args(["agent", "setup", "--engine", "codex", "--executable"])
            .arg(&self.executable)
            .args(["--install-plugin", "--json"])
            .args(args);
        if let Some(version) = version {
            cmd.env("FAKE_PLUGIN_VERSION", version);
        }
        cmd.output().unwrap()
    }
    fn report(&self, args: &[&str]) -> Value {
        let output = self.invoke(args, None);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn calls(&self) -> String {
        fs::read_to_string(self.temp.path().join("calls")).unwrap_or_default()
    }
}

#[test]
fn custom_marketplace_install_honors_codex_home_and_is_idempotent() {
    let f = Fixture::new();
    let first = f.report(&["--apply"]);
    assert_eq!(first["plugin_installation"]["changed"], true);
    assert_eq!(
        first["plugin_installation"]["plugin_id"],
        "kinic-skill-recorder@team-tools"
    );
    assert_eq!(
        first["plugin_directory"],
        json!(f.codex_home.join("plugins/kinic-skill-recorder"))
    );
    assert!(
        f.codex_home
            .join("plugins/kinic-skill-recorder/.codex-plugin/plugin.json")
            .is_file()
    );
    assert!(!f.home.join(".codex").exists());
    let market: Value =
        serde_json::from_slice(&fs::read(f.home.join(".agents/plugins/marketplace.json")).unwrap())
            .unwrap();
    assert_eq!(market["name"], "team-tools");
    assert_eq!(market["unrelated"], json!({"keep":true}));
    assert_eq!(market["plugins"][0]["name"], "other-plugin");
    assert_eq!(market["plugins"][1]["custom"], "keep");
    assert_eq!(market["plugins"][1]["source"]["custom_source"], "keep");
    assert_eq!(market["plugins"][1]["policy"]["custom_policy"], "keep");
    let source = market["plugins"][1]["source"]["path"].as_str().unwrap();
    assert_eq!(
        f.home.join(source).canonicalize().unwrap(),
        f.codex_home
            .join("plugins/kinic-skill-recorder")
            .canonicalize()
            .unwrap()
    );
    let second = f.report(&["--apply"]);
    assert_eq!(second["plugin_installation"]["changed"], false);
    assert_eq!(second["status"], "unchanged");
    assert_eq!(
        f.calls(),
        "plugin list --marketplace team-tools --json\nplugin add kinic-skill-recorder@team-tools --json\nplugin list --marketplace team-tools --json\nplugin list --marketplace team-tools --json\n"
    );
}

#[test]
fn plugin_preview_and_missing_apply_never_execute_codex() {
    let f = Fixture::new();
    let marketplace = f.home.join(".agents/plugins/marketplace.json");
    let before = fs::read(&marketplace).unwrap();
    let preview = f.report(&["--dry-run"]);
    assert_eq!(preview["plugin_installation"]["status"], "planned");
    assert_eq!(preview["marketplace_name"], "team-tools");
    assert_eq!(f.calls(), "");
    assert!(!f.codex_home.exists());
    assert!(!f.root.join(".kinic").exists());
    assert_eq!(fs::read(&marketplace).unwrap(), before);
    let unapplied = f.report(&[]);
    assert_eq!(unapplied["plugin_installation"]["status"], "apply_required");
    assert_eq!(f.calls(), "");
    assert_eq!(fs::read(&marketplace).unwrap(), before);
}

#[test]
fn plugin_install_does_not_accept_unconfirmed_version() {
    let f = Fixture::new();
    let output = f.invoke(&["--apply"], Some("0.0.0"));
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("did not confirm"), "{error}");
    assert!(!error.contains("secret-marker"));
}
