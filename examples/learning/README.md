# Continual learning examples

Starting points for [the continual learning quickstart](../../docs/LEARNING_QUICKSTART.md).
Copy a file into your project and adjust it; do not point setup at this directory.

| File | Use |
|---|---|
| `runner.codex.json` | Runner for Codex. |
| `runner.claude.json` | Runner for Claude Code 2.1.286 or newer. Needs `ANTHROPIC_API_KEY` or supported provider credentials. |
| `runner.dsh.json` | Runner for DeepSeek Harness. Replace the executable path. |
| `validation-suite.example.json` | Shape of a validation suite with three task families on the `validation` split, the minimum for publication. Replace the repository path, commits, prompts, verifiers and allowed paths with real tasks from your project. |

Runner files hold no credentials. Put credential variable names in
`inherited_environment`. `crates/vfs_cli_app/tests/learning_examples.rs` checks that
these files still parse with the CLI's own types.
