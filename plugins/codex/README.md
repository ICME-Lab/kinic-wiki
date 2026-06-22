# Kinic Codex Plugin

Codex adapter for recording Skill Registry run evidence and processing skill evolution jobs.
Install through the CLI:

```bash
kinic-vfs-cli codex setup
```

Skills:

- `kinic-record-skill-run`: records run evidence after a skill materially affects a task.
- `kinic-evolve-skill-job`: processes queued improvement jobs with Codex.

Session capture:

- The `Stop` hook saves Codex turn transcripts to local pending storage first, then writes raw sources with `kinic-vfs-cli` on a best-effort basis.
- Restart Codex after setup, then review and trust the hook with `/hooks`.
- Codex does not support `async: true` command hooks yet, so the hook uses a short synchronous timeout.
- If plugin-bundled hooks do not load in your Codex version, copy `hooks/hooks.json` into `~/.codex/hooks.json` and replace the command with the absolute installed script path.

Shared runtime code lives under `plugins/runtime/kinic_agent_runtime`.
Hermes-specific setup lives in [`../hermes/README.md`](../hermes/README.md).
