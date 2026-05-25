# Kinic Codex Plugin

Codex adapter for recording Skill Registry run evidence and processing skill evolution jobs.
Install through the CLI:

```bash
kinic-vfs-cli codex setup
```

Skills:

- `kinic-record-skill-run`: records run evidence after a skill materially affects a task.
- `kinic-evolve-skill-job`: processes queued improvement jobs with Codex.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`.
Hermes-specific setup lives in [`../hermes/README.md`](../hermes/README.md).
