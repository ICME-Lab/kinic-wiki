# Kinic Wiki for Codex

Connect any project to Kinic Wiki using the installed `kinic-vfs-cli`. The plugin transports hook events and context; the CLI owns project discovery, authentication, recall, evidence persistence, learning jobs, evaluation, publication, and rollback.

```bash
kinic-vfs-cli codex setup
cd /path/to/your-project
kinic-vfs-cli learn setup --help
```

Configure the project's learning connection and validation suite with `learn setup`, then inspect `learn status` before enabling learning. The project needs configuration, not Kinic source code. Install the CLI on `PATH`, or set `KINIC_VFS_CLI` to its installed executable. The plugin never falls back to this repository's development binary. `KINIC_LEARNING_RECALL_CONFIG` can select an explicit project configuration file; otherwise the CLI discovers `.kinic-learning.json` from the hook working directory.

`UserPromptSubmit` forwards the task to `agent hook --engine codex` and returns only the CLI's additional context. `PostToolUse` forwards observed tool evidence. `Stop` forwards the transcript path and terminal event so the CLI can inspect persisted evidence, queue learning, and launch a finite drain process. The adapter does not read transcripts, infer task success, maintain a learning database, choose a project, or run a separate learning loop. Its subprocess has a short timeout; failures produce a diagnostic without leaking CLI error text. Missing project configuration is handled by the CLI. If the CLI cannot acknowledge a hook, evidence may be incomplete; the adapter does not claim it was saved.

The existing `Stop` session recorder remains available. It saves turn transcripts to local pending storage before attempting a CLI write under `/Sources/sessions/codex/...`. The `kinic-record-skill-run` skill records evidence after a skill materially affects a task. These capture features retain their existing behavior independently of automatic learning.

Restart Codex after setup, then review and trust hooks with `/hooks`. Setup reports configuration, not verified activation. If your Codex version does not load plugin hooks, use the installed `hooks/hooks.json` with absolute script paths in the supported hook settings, or use `kinic-vfs-cli agent run`. The installation name remains `kinic-skill-recorder` so existing installations can upgrade; its visible name is Kinic Wiki.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`. See [continual learning](../../docs/CONTINUAL_LEARNING.md) for the CLI workflow and [Hermes](../hermes/README.md) for its separate adapter.

## Shared learning settings and diagnosis

The learning adapter supports `.kinic/config.toml` through the CLI in the event
working directory, plus the existing explicit recall JSON override. Use
`kinic-vfs-cli agent setup --engine codex --dry-run` to preview setup;
`--apply` is required before replacing existing files. `codex setup` uses the
same setup implementation. Placement does not establish enablement or trust.
Run `kinic-vfs-cli agent doctor --engine codex --json` for non-executing checks.
See [configuration and diagnostics](../../docs/AGENT_CONFIGURATION.md).
