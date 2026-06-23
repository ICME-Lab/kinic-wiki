# Kinic Claude Code Plugin

Claude Code adapter for recording Skill Registry run evidence and processing skill evolution jobs.
Install through the CLI:

```bash
kinic-vfs-cli claude setup
```

Skills:

- `kinic-record-skill-run`: records run evidence after a skill materially affects a task.
- `kinic-evolve-skill-job`: processes queued improvement jobs with Claude Code.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`.
Hermes-specific setup lives in [`../hermes/README.md`](../hermes/README.md).


## SessionEnd transcript capture

The installed plugin also includes `scripts/session-end.sh` for Claude Code
`SessionEnd` hooks. The script reads the hook JSON payload from stdin and writes a
compact, redacted pending raw source record under `~/.kinic/pending-sessions` (or
`$KINIC_HOME/pending-sessions`).

```bash
cat session-end-payload.json | ~/.claude/plugins/kinic-skill-recorder/scripts/session-end.sh
```

Capture caps can be tuned with `KINIC_SESSION_MAX_TEXT_CHARS`,
`KINIC_SESSION_MAX_TOOL_RESULT_CHARS`, and `KINIC_SESSION_MAX_CONTENT_CHARS`.
