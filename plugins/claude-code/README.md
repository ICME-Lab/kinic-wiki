# Kinic Claude Code Plugin

Claude Code adapter for recording Skill Registry run evidence and processing skill evolution jobs.
Install through the CLI:

```bash
kinic-vfs-cli claude setup
```

Skills:

- `kinic-record-skill-run`: records run evidence after a skill materially affects a task.
- `kinic-evolve-skill-job`: processes queued improvement jobs with Claude Code.

Session capture:

- The `SessionEnd` hook first saves the current transcript to local pending storage.
- CLI writes and older pending flushes are best-effort because Claude Code does not raise the SessionEnd budget for plugin-provided hook timeouts.
- Set `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` only when explicitly allowing more SessionEnd time; do not rely on it for session retention.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`.
Hermes-specific setup lives in [`../hermes/README.md`](../hermes/README.md).
