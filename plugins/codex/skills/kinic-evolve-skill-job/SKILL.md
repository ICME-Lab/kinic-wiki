---
name: kinic-evolve-skill-job
description: Process a queued Kinic skill evolution job using Codex as the LLM. Use when the user wants Codex to run the skill improvement loop, evolve a skill from recorded evidence, or process queued Kinic evolution jobs without Hermes.
---

# Kinic Evolve Skill Job

Use this skill when Codex should turn recorded Kinic run evidence into a skill improvement proposal.

1. Run `${PLUGIN_ROOT}/scripts/evolve-job.sh prepare [job-id]`.
2. Read the returned JSON. If it reports no queued job, stop and report that no job exists.
3. Use the returned `messages` as the evolution prompt. Follow them exactly.
4. Produce the complete candidate `SKILL.md` only. Preserve frontmatter, identity, scope, and permissions. Do not expand permissions.
5. Write the candidate to a temporary Markdown file.
6. Run `${PLUGIN_ROOT}/scripts/evolve-job.sh finish <job-id> <candidate-file>`.
7. Summarize the proposal, apply result, and `job_status` from the JSON output.

Do not use MCP for this workflow. Codex is the LLM; the script only claims jobs, reads evidence, writes proposals, runs gates, applies accepted candidates, and completes jobs through the shared Python runner with `generator=codex-plugin` and `llm_route=codex-skill`.
