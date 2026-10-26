//! Explicitly enabled live transport smoke; this does not measure task-quality improvement.
use vfs_cli_app::learning_runner::{AgentEngine, RunnerConfig, execute};

#[tokio::test]
#[ignore = "requires explicitly selected authenticated external agent"]
async fn actual_codex_and_dsh_transport() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/learning-live");
    std::fs::create_dir_all(&root).unwrap();
    let workspace = tempfile::tempdir_in(&root).unwrap();
    assert!(
        std::process::Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(workspace.path())
            .status()
            .unwrap()
            .success()
    );
    let mut failures = vec![];
    for (name, engine) in [("CODEX", AgentEngine::Codex), ("DSH", AgentEngine::Dsh)] {
        let path = std::env::var(format!("KINIC_LIVE_{name}_EXECUTABLE"))
            .expect("explicit executable required");
        let mut config = RunnerConfig {
            engine,
            executable: path.into(),
            timeout_seconds: 60,
            read_only: true,
            ..RunnerConfig::default()
        };
        if name == "DSH" {
            config.model = Some("deepseek-official/deepseek-flash".into());
            config
                .environment
                .insert("DSH_TELEMETRY_MODE".into(), "DISABLED".into());
        }
        let result = execute(
            &config,
            workspace.path(),
            "Reply exactly KINIC_LIVE_OK. Do not use any tools.",
        )
        .await;
        match result {
            Ok(result) => {
                println!(
                    "{name}: complete={}, reason={}, marker={}, elapsed_ms={}",
                    result.complete,
                    result.exit_reason,
                    result.output.contains("KINIC_LIVE_OK"),
                    result.elapsed_ms
                );
                if !result.complete || !result.output.contains("KINIC_LIVE_OK") {
                    failures.push(name);
                }
            }
            Err(_) => {
                println!("{name}: launch/transport error");
                failures.push(name);
            }
        }
    }
    assert!(failures.is_empty(), "live transports failed: {failures:?}");
}
