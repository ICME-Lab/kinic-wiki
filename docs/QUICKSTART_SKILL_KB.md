# Skill Knowledge Base Quickstart

This walkthrough creates a DB-linked skill catalog and runs the sample Skill KB loop.
For layout, manifest fields, status values, access rules, and Browser support, see
[`SKILL_REGISTRY.md`](SKILL_REGISTRY.md).

## Prerequisites

- A deployed VFS canister.
- A principal with permission to create or write the target database.
- Local replica users should start and deploy the canister before running these commands.

Set the target canister:

```bash
export CANISTER_ID=<canister-id>
```

Use `--local` in each database setup command when targeting a local replica.

## 5 Minute Flow

Create and link a database.
`database create` is only needed the first time.
If the database already exists and you have access, start from `database link <database-id>`.

```bash
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id "$CANISTER_ID" database create "Team skills")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- --canister-id "$CANISTER_ID" database link "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database current
```

Upload the sample skill:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill upsert \
  --source-dir examples/skill-kb/skills/legal-review \
  --id legal-review \
  --prune
```

`skill upsert` uploads the package.
`--prune` removes stale package files already in the DB but no longer present in the source package.

Find and inspect it:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill find "contract review"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill inspect legal-review
```

Record evidence from a real or demo run:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill record-run legal-review \
  --task "review vendor MSA redlines before counsel handoff" \
  --outcome success \
  --notes-file examples/skill-kb/runs/legal-review-success.md
```

Promote the skill after review:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill set-status legal-review --status promoted
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill inspect legal-review
```

Automated evidence can also be recorded without manual schema prompts:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill record-run legal-review \
  --evidence-json ./run-evidence.json
```

Set up Hermes once, then run evolution from inside Hermes:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- hermes setup
```

```text
/kinic_evolve_job
```

## Troubleshooting

- Missing database link: run `database current`; if `database_id` is empty, run `database link <database-id>`.
- Permission denied: ask a database owner to grant `reader` for find/inspect or `writer` for upsert/record-run/set-status.
- Invalid manifest: check the required fields in [`SKILL_REGISTRY.md`](SKILL_REGISTRY.md).
- Missing skill in search: rerun `skill find <query> --include-deprecated` if auditing old skills.
- Stale Hermes projection after browser apply: run `kinic-vfs-cli hermes pull`.
- Hermes projection check: run `kinic-vfs-cli hermes status`.
- Pending Hermes evidence: run `kinic-vfs-cli hermes flush-pending`.
- Shadow correction files: run `kinic-vfs-cli hermes shadows`.
- Evolution job debugging: run `kinic-vfs-cli skill evolve-jobs create-ready` and `kinic-vfs-cli skill evolve-jobs list --status queued --json`.

## Demo Script

The scripted version uses the same sample:

```bash
CANISTER_ID=<canister-id> scripts/demo_skill_kb.sh
```

The script can be rerun with the same `DATABASE_ID`.
If the database already exists, it links the workspace and continues.

For local replica:

```bash
CANISTER_ID=<canister-id> LOCAL=1 scripts/demo_skill_kb.sh
```
