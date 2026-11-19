# Kinic Claude Code Plugin

Claude Code adapter for Skill Registry/session evidence and CLI-owned continual learning in explicitly configured projects.
Install through the CLI:

```bash
kinic-vfs-cli claude setup
```

Skills:

- `kinic-record-skill-run`: records run evidence after a skill materially affects a task.

Session capture:

- The `SessionEnd` hook first saves the current transcript to local pending storage, then writes session evidence under `/Sources/sessions/claudecode/...`.
- Session recording requires `kinic-vfs-cli` version 2.0.2 or newer for batched folder and source writes. Older versions leave failed captures in local pending storage; upgrade the CLI to retry them.
- CLI writes and older pending flushes are best-effort because Claude Code does not raise the SessionEnd budget for plugin-provided hook timeouts.
- Set `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` only when explicitly allowing more SessionEnd time; do not rely on it for session retention.
- Session capture currently targets macOS and Linux bash environments, matching the supported CLI release platforms.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`.
Hermes-specific setup lives in [`../hermes/README.md`](../hermes/README.md).


## Continual learning

This source revision adds `kinic-vfs-cli agent setup --engine claude` as the shared
engine setup entry point. It prepares the plugin and marketplace without changing
Claude settings or enrolling automatic learning. Run `--dry-run --json` to inspect
changes and `--apply` to replace existing managed files. Install the prepared local
marketplace/plugin in Claude Code and review `/hooks` separately. The older
`claude setup` command retains its recorder-installation behavior.

After explicit `learn setup --runner-file ...`, UserPromptSubmit recalls authorized
knowledge, PostToolUse captures compact tool metadata and Stop queues redacted
current-turn evidence for the existing candidate/evaluation/revision pipeline.
Stop never asserts task success. Identical Stop retries deduplicate. A genuine continuation retains an additional
immutable snapshot and refreshes the same job from the new evidence; old candidate
artifacts remain available. A changed snapshot during inference invalidates the
stale attempt. Existing operator/failure pauses and publication reconciliation
remain explicit. SessionEnd remains session archival and does not enqueue a
second job.
Unconfigured projects skip learning; disabling learning preserves evidence and
blocks new learning jobs under the existing shared policy.

Interactive sessions use their existing Claude login. CLI-owned agent runs and
learning inference use Claude Code >=2.1.286 in bare print mode and need separate
API/provider credentials, because bare mode does not read subscription login.
They disable hooks/MCP and do not recursively enqueue learning. Read-only inference
exposes only read tools; writable coding tasks can use shell commands. These are
tool permissions, not an additional OS sandbox. No credentials are copied or
installed by setup.

See [configuration and diagnostics](../../docs/AGENT_CONFIGURATION.md#claude-code)
and [continual learning](../../docs/CONTINUAL_LEARNING.md) for runner JSON,
activation, validation requirements, policy limits and credential inheritance.
