# Skill Registry

This document is the canonical Skill Registry reference.

Skill Registry stores Agent Skills-compatible packages as ordinary VFS nodes.
The database copy is the runtime source of truth.
GitHub and other package sources are provenance or import sources, not the live registry.

The v1 product loop is:

```text
draft skill -> upsert -> find -> inspect -> record run -> promote, deprecate, or rollback
```

## Data Model

The public registry model is intentionally small:

```text
/Skills/<id>/SKILL.md
/Skills/<id>/manifest.md
/Skills/<id>/versions/<snapshot-id>/SKILL.md
/Skills/<id>/versions/<snapshot-id>/manifest.md
/Sources/skill-runs/<id>/<run-id>.md
/Sources/skill-runs/<id>/<run-id>.correction.<timestamp>.md
```

`SKILL.md` is the current Agent Skills entry file.
`manifest.md` is the management record.
`versions/` contains pre-change snapshots.
`/Sources/skill-runs/` contains usage evidence and corrections.

Existing databases may still contain older candidate or job nodes.
New CLI and UI surfaces do not read them, and no automatic migration deletes them.

## Manifest

`manifest.md` is Markdown with YAML frontmatter:

```yaml
---
kind: kinic.skill
schema_version: 1
id: legal-review
version: 0.1.0
entry: SKILL.md
title: Legal Review
summary: Contract review workflow
tags:
  - legal
status: reviewed
permissions:
  file_read: true
  network: false
  shell: false
provenance:
  source: github.com/legal-review
  source_ref: abc123
---
# Skill Manifest
```

Required fields:

- `kind`: `kinic.skill`
- `schema_version`: `1`
- `id`: single path-safe skill id
- `version`: package display version in `MAJOR.MINOR.PATCH` numeric form
- `entry`: `SKILL.md`

`manifest.version` is not a release history id.
It is a package display number.
The registry validates only the numeric `MAJOR.MINOR.PATCH` shape.
It does not auto-bump, reject lower versions, or reject reused values.

On `skill upsert`, missing or empty manifest display fields may be filled from `SKILL.md` frontmatter.
Existing manifest values win.
`SKILL.md` `name` is upstream runtime or display metadata and may differ from the DB skill id.

## Snapshots

`skill upsert` snapshots the current registry version before overwriting an existing `SKILL.md`.
The snapshot contains the current `SKILL.md` and current `manifest.md` when present.
Initial upsert of a new skill does not create a snapshot.

`skill upsert --prune` also snapshots before deleting stale package files.
`versions/` is never pruned by package upsert.

`skill rollback <id> <snapshot-id>` snapshots the current version first, then restores the selected snapshot into current `SKILL.md` and `manifest.md`.

## CLI

`kinic-vfs-cli skill ...` is the supported CLI surface.
Use `database link` once, then run skill commands without repeating `--database-id`.

Common commands:

- `skill upsert`: write or update a package from a local directory.
- `skill import github`: import package files from GitHub.
- `skill find`: search packages by task context.
- `skill inspect`: read manifest, entry file, package files, and recent run evidence.
- `skill record-run`: append usage evidence under `/Sources/skill-runs/...`.
- `skill record-correction`: append an explicit correction for an existing run.
- `skill set-status`: set `draft`, `reviewed`, `promoted`, or `deprecated`.
- `skill export`: export runtime package files for an external agent skill directory.
- `skill rollback`: restore a snapshot and snapshot the replaced current version.
- `skill history`: list `versions`, `runs`, and `corrections`.
- `skill install`: write a downstream lockfile only.

`skill history --json` returns rollback-ready snapshot IDs:

```json
{
  "id": "legal-review",
  "versions": [{ "id": "20260625091500-a1b2c3d4", "path": "/Skills/legal-review/versions/20260625091500-a1b2c3d4" }],
  "runs": [{ "path": "/Sources/skill-runs/legal-review/run-1.md" }],
  "corrections": [{ "path": "/Sources/skill-runs/legal-review/run-1.correction.1782360000000.md" }]
}
```

## Run Evidence

Run evidence is the operational record of whether a skill helped.
It is stored under `/Sources/skill-runs/<id>/...` and includes content hashes for the skill and manifest.
`skill find` and `skill inspect` include `run_summary` with total runs, success/partial/fail counts, last use, and last outcome.

Evidence JSON may set `recorded_by`, such as `hermes-plugin`, `codex-plugin`, or `claude-code-plugin`.
Direct CLI evidence defaults to `cli`.
Invalid or old evidence is ignored by `run_summary` but remains readable as source history.

Hermes, Codex, and Claude Code integrations only record run evidence and export/setup current skills.
They do not create improvement jobs or apply candidates.

## Browser

The browser Skill Registry view lists current packages, manifests, run evidence, snapshots, status controls, package import/upsert, and database permissions.

Registry access follows the selected database role.
Skill-specific metadata, evidence, snapshots, and status actions live under `/skills/<database-id>`.

## Agent Runtime

Agents can use Skill Registry through the shared tool dispatcher:

```text
skill_find -> skill_inspect -> skill_read SKILL.md -> skill_read helper files -> skill_record_run
```

Discovery and read tools are read-only.
`skill_record_run` is a write tool and is not included in the read-only tool set.
Agents should ignore `deprecated` skills by default and prefer `promoted` or `reviewed` candidates.

Use the CLI for package operations such as `skill upsert`, import, rollback, install lockfiles, and database linking.

## Validation

Run the focused checks after changing registry behavior:

```bash
cargo test -p kinic-vfs-cli
pnpm --dir wikibrowser test
pnpm --dir skill-registry-web test
```
