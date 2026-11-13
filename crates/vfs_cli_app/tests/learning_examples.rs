//! Keep the published learning examples loadable by the CLI's own types.
use std::path::Path;
use vfs_cli_app::learning_evaluation::SuiteManifest;
use vfs_cli_app::learning_runner::{AgentEngine, RunnerConfig};

fn example(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/learning")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn runner_examples_parse_as_runner_config() {
    for (name, engine) in [
        ("runner.codex.json", AgentEngine::Codex),
        ("runner.claude.json", AgentEngine::Claude),
        ("runner.dsh.json", AgentEngine::Dsh),
    ] {
        let runner: RunnerConfig = serde_json::from_str(&example(name)).expect(name);
        assert_eq!(runner.engine, engine, "{name}");
        assert!(
            runner.environment.is_empty(),
            "{name} must not embed environment values"
        );
    }
}

#[test]
fn validation_suite_example_passes_suite_validation_once_commits_are_filled_in() {
    let text = example("validation-suite.example.json").replace(
        "REPLACE_WITH_A_COMMIT_WHERE_THE_TASK_IS_UNSOLVED",
        &"a".repeat(40),
    );
    let suite: SuiteManifest = serde_json::from_str(&text).unwrap();
    suite.validate().unwrap();
    let families: std::collections::BTreeSet<_> = suite
        .tasks
        .iter()
        .map(|task| task.family.as_str())
        .collect();
    assert!(
        families.len() >= 3,
        "promotion needs at least three validation families"
    );
}
