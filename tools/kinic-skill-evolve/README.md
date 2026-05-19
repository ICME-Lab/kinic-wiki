# kinic-skill-evolve

Thin Python runner for Kinic skill evolution.

```bash
OPENROUTER_API_KEY=... python tools/kinic-skill-evolve/kinic_skill_evolve.py evolve legal-review \
  --provider openrouter \
  --model anthropic/claude-sonnet-4.5
```

The runner writes:

```text
/Wiki/skills/<id>/proposals/<proposal-id>/candidate/SKILL.md
/Wiki/skills/<id>/proposals/<proposal-id>/metrics.json
```

Apply through:

```bash
kinic-vfs-cli skill apply-proposal <id> <proposal-id>
```
