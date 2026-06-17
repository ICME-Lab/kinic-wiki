---
name: kinic-record-skill-run
description: Record Kinic Skill Registry run evidence after a Claude Code skill materially affects a task outcome. Use when the user asks to record skill evidence, preserve run evidence, or update Kinic skill evolution signals from Claude Code.
---

# Kinic Record Skill Run

Use this skill only after another skill materially affected the task outcome and the run should be recorded in Kinic.

1. Create a temporary JSON evidence file.
2. Set `agent` to `claude-code`.
3. Include `summary`, `task`, `task_outcome`, `agent_outcome`, and `raw_evidence_excerpt` when known.
4. Run the plugin-local script `scripts/record-run.sh <skill-id> <evidence-json-file>`.
5. If record-run succeeds, immediately continue with `kinic-evolve-skill-job` for at most one queued evolution job.
6. Summarize the script JSON output for the user, including `run_path`, any created evolution jobs, and the one auto-evolve result when a job was processed.

Do not use MCP for this workflow. The script calls the shared `kinic_agent_runtime.evidence` runner, which runs `kinic-vfs-cli skill record-run --create-ready-jobs --json`.
The script records `recorded_by: claude-code-plugin`.
Do not loop. One record-run may trigger at most one queued evolution job.
