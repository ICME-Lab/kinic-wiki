---
name: kinic-skill-sync
description: Safely sync reviewed or promoted Kinic Skill Registry packages into a local agent skill directory with kinic-vfs-cli skill sync. Use when updating local skills from the registry, checking dry-run sync changes, or avoiding deletion of unmanaged local skills.
---

# Kinic Skill Sync

Use `kinic-vfs-cli skill sync` as the only sync engine.
Do not implement file deletion or diff logic in the agent.

Before syncing:

1. Confirm the target directory.
2. Run dry-run first:

```bash
kinic-vfs-cli skill sync --target <dir> --status reviewed,promoted --prune --dry-run --json
```

3. Inspect `conflicts` first, then `added`, `updated`, `removed`, and `skipped`.
4. Run the same command without `--dry-run` only when the result is expected.

Safety rules:

- Existing local skill directories are authoritative until the sync lock manages them.
- If `.kinic-skill-sync.json` is absent and `target/<skill-id>` already exists, sync must report `conflicts: unmanaged_existing_dir`.
- If any managed runtime file has local edits, missing files, or extra files, sync must report `conflicts` and avoid overwriting or pruning it.
- `--prune` only removes skills recorded in `.kinic-skill-sync.json`.
- Manual local skill directories are never deletion candidates.
- Default sync statuses are `reviewed,promoted`; include `draft` or `deprecated` only for explicit audit work.

Use `skill upsert --source-dir <dir> --id <id>` to publish a local skill into the registry before expecting sync to manage it.
When remote should win, move or remove the local skill directory manually before running sync again.
