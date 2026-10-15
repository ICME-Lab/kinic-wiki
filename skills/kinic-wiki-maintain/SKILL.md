---
name: kinic-wiki-maintain
description: Run bounded LLM-led Kinic Wiki maintenance through inspection, evidence-backed edits, and reinspection. Use for repeated improvement or scheduled maintenance; use kinic-wiki-lint alone for a read-only health report.
---

# Kinic Wiki Maintain

Use [maintain.md](maintain.md) for the execution contract and stopping rules.
Use `kinic-wiki-lint` for inspection and `kinic-wiki-edit` for accepted repairs.
These skills must be installed together from the same repository revision.

The LLM selects and writes improvements; this skill does not add automatic catalog updates to the server.
An explicit `mode: repair` authorizes non-destructive maintenance inside the supplied Knowledge prefix. Otherwise inspect only.
Never infer permission to delete articles, rewrite sources, change access, publish, or deploy.

Validate the final run report with:

```sh
python3 scripts/validate-report.py /absolute/path/to/report.json
```

Resolve the script relative to this skill directory. Validation checks reporting consistency, not the truth of the inspection: retain read/command evidence for coverage and verification claims.
