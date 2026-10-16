//! Legacy Codex setup entrypoint uses the same reviewable setup plan as agent setup.
use crate::{cli::CodexCommand, learning::cli::SetupArgs};
use anyhow::Result;
pub fn run_codex_command(command: CodexCommand) -> Result<()> {
    let CodexCommand::Setup {
        json,
        executable,
        project,
        apply,
        dry_run,
    } = command;
    crate::agent_setup::run(&SetupArgs {
        engine: "codex".into(),
        json,
        executable,
        project,
        apply,
        dry_run,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use crate::{agent_setup::prepare, learning::cli::SetupArgs};
    use serde_json::json;
    #[test]
    fn codex_setup_prepares_self_contained_payload_and_leaves_activation_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let args = SetupArgs {
            engine: "codex".into(),
            ..Default::default()
        };
        let result = prepare(&args, temp.path(), &home).unwrap();
        assert_eq!(result["status"], "prepared");
        assert_eq!(result["activation"], "unknown");
        let dir = home.join(".codex/plugins/kinic-skill-recorder");
        for file in [
            ".codex-plugin/plugin.json",
            "scripts/record-run.sh",
            "scripts/record-session.sh",
            "scripts/learning-hook.sh",
            "hooks/hooks.json",
            "kinic_agent_runtime/session.py",
            "kinic_agent_runtime/learning_hook.py",
        ] {
            assert!(dir.join(file).is_file(), "{file}");
        }
        assert!(!dir.join(".kinic-source-root").exists());
        assert_eq!(
            prepare(&args, temp.path(), &home).unwrap()["status"],
            "unchanged"
        );
    }
    #[test]
    fn codex_setup_preserves_unmanaged_files_and_marketplace_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let marketplace = home.join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
        std::fs::write(&marketplace,serde_json::to_vec(&json!({"name":"custom","extra":"keep","plugins":[{"name":"keep"},{"name":"kinic-skill-recorder","custom":"keep","source":{"path":"old"}}]})).unwrap()).unwrap();
        let dir = home.join(".codex/plugins/kinic-skill-recorder");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manual.txt"), "keep").unwrap();
        let args = SetupArgs {
            engine: "codex".into(),
            ..Default::default()
        };
        let before = std::fs::read(&marketplace).unwrap();
        assert_eq!(
            prepare(&args, temp.path(), &home).unwrap()["status"],
            "changes_pending"
        );
        assert_eq!(std::fs::read(&marketplace).unwrap(), before);
        prepare(
            &SetupArgs {
                apply: true,
                ..args
            },
            temp.path(),
            &home,
        )
        .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(marketplace).unwrap()).unwrap();
        assert_eq!(value["extra"], "keep");
        assert_eq!(value["plugins"][0]["name"], "keep");
        assert_eq!(value["plugins"][1]["custom"], "keep");
        assert_eq!(
            std::fs::read_to_string(dir.join("manual.txt")).unwrap(),
            "keep"
        );
    }
    #[test]
    fn codex_setup_rejects_invalid_marketplace_without_partial_writes() {
        for content in ["[]", r#"{"plugins":{}}"#] {
            let temp = tempfile::tempdir().unwrap();
            let home = temp.path().join("home");
            let marketplace = home.join(".agents/plugins/marketplace.json");
            std::fs::create_dir_all(marketplace.parent().unwrap()).unwrap();
            std::fs::write(&marketplace, content).unwrap();
            assert!(
                prepare(
                    &SetupArgs {
                        engine: "codex".into(),
                        ..Default::default()
                    },
                    temp.path(),
                    &home
                )
                .is_err()
            );
            assert_eq!(std::fs::read_to_string(marketplace).unwrap(), content);
            assert!(!home.join(".codex").exists());
            assert!(!temp.path().join(".kinic").exists());
        }
    }
}
