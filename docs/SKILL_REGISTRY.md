# Skill Registry

This document is the canonical Skill Registry reference.

Skill Registry stores Agent Skills-compatible `SKILL.md` packages as ordinary wiki nodes.
It is a DB-backed skill knowledge base, not a GitHub or Vercel marketplace replacement.
GitHub is provenance/source context; the DB copy is the runtime source of truth.

Use it when a team wants skills to be searchable by task situation, review status, provenance, eval notes, and run evidence.
The product loop is:

```text
draft skill -> upsert -> find from task context -> inspect -> record run -> promote or deprecate
```

Hermes and Codex integration use the same DB copy as the canonical source. Shared Python runtime
lives in `plugins/runtime/kinic_agent_runtime`; Hermes, Codex, and Claude Code keep separate adapters on top of it.
Kinic exports the current runtime files into external skill directories, records run evidence back
into `/Sources`, and applies evolved candidates only when the proposal `base_etag` still matches
current `SKILL.md`.

Access control is database-level.
Registry nodes follow the same `Owner`, `Writer`, and `Reader` roles as every other node in the database.
Use separate databases when different skill sets need different membership.

## Why Not Just A Skill Store

Vercel-style skill stores are useful as distribution shelves:

- publish or discover reusable skills
- install a skill into an agent environment
- treat GitHub or a package source as the main artifact history

Kinic Skill KB is for growing skills after teams start using them:

- search skills by task context, not only by package name
- keep `manifest.md`, `SKILL.md`, provenance, evals, and run evidence in one queryable DB
- record whether a skill actually helped a task under `/Sources/skill-runs/...`
- move skills through `draft`, `reviewed`, `promoted`, and `deprecated`
- share access with database roles instead of path-level ACL or marketplace visibility

GitHub is still the source and review history.
The DB copy is the operational record: what the team can find, trust, inspect, and improve from usage.

## Layout

Skills live under `/Wiki/skills`:

```text
/Wiki/skills/<name>/manifest.md
/Wiki/skills/<name>/SKILL.md
/Wiki/skills/<name>/ingest.md
/Wiki/skills/<name>/provenance.md   # optional
/Wiki/skills/<name>/evals.md        # optional
```

`manifest.md` is the registry record.
`SKILL.md` is the Agent Skills entry file.
Package-local Markdown files referenced from `SKILL.md`, such as `ingest.md`, are stored with the package.
`provenance.md` and `evals.md` are optional long-form records.
Run evidence is stored as source nodes:

```text
/Sources/skill-runs/<name>/<timestamp>.md
/Sources/skill-runs/<name>/<run-id>.correction.<timestamp>.md
```

Evolution candidates and applied versions are ordinary wiki nodes:

```text
/Wiki/skills/<name>/versions/<timestamp-or-hash>/SKILL.md
/Wiki/skills/<name>/versions/<timestamp-or-hash>/manifest.md
/Wiki/skills/<name>/proposals/<proposal-id>/proposal.md
/Wiki/skills/<name>/proposals/<proposal-id>/candidate/SKILL.md
/Wiki/skills/<name>/proposals/<proposal-id>/diff.md
/Wiki/skills/<name>/proposals/<proposal-id>/metrics.json
/Wiki/skill-evolution-jobs/<job-id>.md
```

## Manifest

`manifest.md` is Markdown with YAML frontmatter.
The Browser inspector parses a small read-only v1 display subset.

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
use_cases:
  - Review contract redlines
status: reviewed
replaces: []
related:
  - /Wiki/legal/contracts.md
knowledge:
  - /Wiki/legal/contracts.md
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

- `kind`: must be `kinic.skill`
- `schema_version`: must be `1`
- `id`: must use a single path-safe skill name
- `version`: skill package version
- `entry`: must be `SKILL.md` in v1
- `title`: display title, usually copied from `SKILL.md` frontmatter `metadata.title`

Optional fields:

- `summary`: one-line description used by `skill find`
- `tags`: search and grouping tags
- `use_cases`: task situations where the skill is useful
- `status`: `draft`, `reviewed`, `promoted`, or `deprecated`
- `replaces`: replaced skill ids
- `related`: related wiki or source paths
- `knowledge`: wiki paths the skill depends on
- `permissions`: declared expected access needs
- `provenance`: source, source revision, and upstream package metadata such as license

`manifest.md` is the Skill KB index and lifecycle record.
`SKILL.md` frontmatter is upstream package metadata input.
On `skill upsert`, empty manifest fields are filled from `SKILL.md`: `metadata.title` to `title`, `description` to `summary`, `metadata.category` to `tags`, and `license` to `provenance.license`.
Existing manifest values win.
`SKILL.md` `name` is an upstream runtime or display name and may differ from the DB skill id.

## CLI Usage

`kinic-vfs-cli skill ...` is the supported CLI surface for Skill Registry.
There is no separate `skill-cli` binary in v1.
`kinic-vfs-cli` owns the shared connection, database selection, and identity plumbing; skill commands operate on normal VFS nodes under `/Wiki/skills`.

Use `database link` once, then run `skill` commands without repeating `--database-id`.
They are thin wrappers over normal VFS nodes and do not add canister schema or path-level ACL.
For the manual first-run flow, see [`QUICKSTART_SKILL_KB.md`](QUICKSTART_SKILL_KB.md).

```bash
DB_ID="$(cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database create "Team skills")"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database link "$DB_ID"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill upsert --source-dir ./skills/legal-review --id legal-review
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill find "review contract redlines"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill inspect legal-review --json
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill record-run legal-review --task "review vendor contract" --outcome success --notes-file ./notes.md
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill set-status legal-review --status promoted
```

Command responsibilities:

- `hermes setup`: install the Kinic Hermes plugin, update local Hermes config, export reviewed/promoted skills, and print local status. Invalid Hermes config shapes fail instead of being repaired.
- `hermes pull`: refresh the local Hermes skill projection from the linked database.
- `hermes status`: inspect local plugin/projection/pending state and job counts when a database is linked.
- `hermes flush-pending`: replay locally saved Hermes run evidence.
- `hermes shadows`: list local shadow/correction files for troubleshooting.
- `codex setup`: install the self-contained Kinic Codex skill-only plugin and update the personal Codex marketplace.
- `skill upsert`: store or update a package from a local directory.
- `skill find`: search packages by task context.
- `skill inspect`: read manifest, entry file, package files, and recent run evidence.
- `skill record-run`: append usage evidence under `/Sources/skill-runs/...`.
- `skill record-correction`: append an explicit correction for an existing run.
- `skill export`: export runtime package files for an external agent skill directory.
- `skill apply-proposal`: apply an evolution candidate only if `base_etag` matches current.
- `skill rollback`: restore a previous version and snapshot the replaced current skill.
- `skill history`: list versions, proposals, jobs, runs, and corrections for a skill.
- `skill export-github`: export package files to GitHub through `gh`.
- `skill evolve-jobs create-ready/list`: debug queued job creation and status.
- `skill evolve-jobs claim/complete`: internal runner coordination for queued/running/done/conflict/failed jobs.
- `skill set-status`: move a package through `draft`, `reviewed`, `promoted`, or `deprecated`.
- `skill import github`: import package files from a GitHub source.
- `skill propose-improvement`: write evidence-backed proposal records.
- `skill approve-proposal`: mark a proposal reviewed; it does not apply the diff.
- `skill install`: write a downstream lockfile only; it does not place files into an agent runtime.

Share access with database member commands:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database grant team-skills <principal> reader
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database grant team-skills <principal> writer
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- identity show
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- database grant-current-identity team-skills writer
```

Status values are intentionally simple:

- `draft`: imported or experimental skill.
- `reviewed`: checked by the owning team.
- `promoted`: recommended for common use.
- `deprecated`: hidden from default `skill find`; include with `--include-deprecated`.

Run evidence under `/Sources/skill-runs/...` is the product differentiator.
It records what happened when a skill was used, including skill and manifest hashes, so teams can promote useful skills and retire weak ones.
`skill find` and `skill inspect` include `run_summary` with total runs, success/partial/fail counts, last use, and last outcome.
Old or invalid run evidence is ignored by `run_summary` but still appears in `recent_runs`.
Evidence JSON can set `recorded_by` to the caller recorder name, such as `hermes-plugin`, `codex-plugin`, or `claude-code-plugin`; direct CLI evidence defaults to `cli`.
Path timestamps are millis IDs; frontmatter `*_at` timestamps are RFC3339.

Hermes automatic capture stores sanitized evidence in `/Sources/skill-runs/<skill-id>/...`.
By default it records tool names, redacted/truncated tool args and result excerpts, redacted/truncated final response text, usage deltas, and capture metadata (`redacted`, `truncated`, and `max_chars`).
Set `KINIC_HERMES_CAPTURE_RAW=0` to record only usage-derived metadata without raw tool or response text.
If recording fails, pending evidence is written to `$KINIC_HOME/pending-runs`; delete those files before replay if they should not be retained.

Hermes keeps the Hermes-specific hook route:

```bash
kinic-vfs-cli hermes setup
kinic-vfs-cli hermes pull
```

`hermes setup` installs a self-contained plugin under `$HERMES_HOME/plugins/kinic`, enables `kinic` in `$HERMES_HOME/config.yaml`, and keeps skill projection under `$KINIC_HOME/hermes-current/skills`.
This Hermes projection path is Hermes-specific.
The plugin directory is managed and is deleted before each setup rewrite; do not keep manual files or symlinks inside it.
Valid Hermes config files are backed up before rewrite. If the config root, `plugins`, or `plugins.enabled` has an unexpected shape, setup fails and leaves the file unchanged.
`hermes pull` prunes stale managed skill directories and deleted exported files while leaving unmanaged files directly under the projection root alone.
Then run this inside Hermes:

```text
/kinic_evolve_job
```

The Hermes plugin records run evidence through `skill record-run --create-ready-jobs` and processes one queued job through `ctx.llm` when `/kinic_evolve_job` is invoked.
It passes `generator: hermes-plugin` and `llm_route: hermes-ctx-llm` into proposal metrics.
`kinic-skill-evolve finish-job` is a shim over the shared runtime used by the plugin to write proposals, evaluate gates, apply accepted candidates, and complete the job.

Codex uses a separate skill-only plugin. It does not run Hermes and does not use MCP.
The Codex plugin source is versioned in `plugins/codex`; binary installs use the CLI-managed home copy.
Install or refresh the personal plugin with:

```bash
npm install -g kinic-vfs-cli
kinic-vfs-cli codex setup
```

The command installs a self-contained plugin under `~/.codex/plugins/kinic-skill-recorder` and updates `~/.agents/plugins/marketplace.json` while preserving unrelated entries.
The plugin directory is managed and is deleted before each setup rewrite; do not keep manual files or symlinks inside it.
If an existing plugin directory lacks Kinic's managed marker, setup backs it up before replacing it.
Codex setup fails instead of repairing marketplace JSON whose root is not an object or whose `plugins` field is not an array; valid marketplace files are backed up before rewrite.
The Codex marketplace entry uses `./.codex/plugins/kinic-skill-recorder`, resolved from the personal marketplace root (`$HOME`), not from `~/.agents/plugins`.
For repo development only, `scripts/install-codex-skill-recorder.sh` runs `codex setup` from the local build or source tree.
After a Codex skill materially affects a task, use `kinic-record-skill-run`; it writes an evidence JSON file and calls:

```bash
~/.codex/plugins/kinic-skill-recorder/scripts/record-run.sh <skill-id> ./run-evidence.json
```

To process the queued improvement with Codex instead of Hermes, use `kinic-evolve-skill-job`.
It calls the same Python runner used by Hermes:

```bash
~/.codex/plugins/kinic-skill-recorder/scripts/evolve-job.sh prepare [job-id]
~/.codex/plugins/kinic-skill-recorder/scripts/evolve-job.sh finish <job-id> ./candidate-SKILL.md
```

Codex reads the prepared messages, generates the candidate `SKILL.md`, and the runner writes the proposal, evaluates gates, applies accepted candidates, and completes the job.
It passes `generator: codex-plugin` and `llm_route: codex-skill` into proposal metrics.
Codex writes accepted skill projection to `$KINIC_SKILL_PROJECTION_DIR`, defaulting to `$HOME/.kinic/skill-projection/skills`; it does not read `KINIC_HERMES_PROJECTION_DIR`.

Claude Code uses a separate skill-only plugin with the same run/evolve surface:

```bash
kinic-vfs-cli claude setup
```

The command installs a local Claude Code marketplace under `~/.claude/plugins/kinic`, copies a self-contained plugin into that marketplace, and enables `kinic-skill-recorder@kinic` in `~/.claude/settings.json`.
The plugin directory is managed and is deleted before each setup rewrite; do not keep manual files or symlinks inside it.
It passes `generator: claude-code-plugin` and `llm_route: claude-code-skill` into proposal metrics.
Claude Code writes accepted skill projection to `$KINIC_SKILL_PROJECTION_DIR`, defaulting to `$HOME/.kinic/skill-projection/skills`; it does not read `KINIC_HERMES_PROJECTION_DIR`.

Set `KINIC_VFS_CLI_ALLOW_NON_II=1` only for explicit non-II operator workflows.

Skill Registry Web lives outside the public Browser:

```bash
pnpm --dir skill-registry-web install
pnpm --dir skill-registry-web dev
```

Open `/skills/<database-id>` in that app to inspect evolution jobs, proposal candidates, run evidence, and database permissions. Browser `/skills/<database-id>` remains the general Skill Registry UI.

Automated recorders can pass a JSON evidence file instead of prompting the user for run schema:

```bash
kinic-vfs-cli skill record-run legal-review --evidence-json ./run-evidence.json --create-ready-jobs
```

The JSON should include `task_outcome` and `agent_outcome` when known. Accepted values are
`success`, `partial`, `fail`, and `unknown`. Missing outcomes are allowed for early automatic capture.
`run_summary` reads v1 `outcome` and v2 `agent_outcome`; `unknown` updates run totals and last outcome without incrementing success/partial/fail.

Evolution jobs are normal Skill Registry records. These commands are for debugging and runner coordination, not the normal user route:

```bash
kinic-vfs-cli skill evolve-jobs create-ready
kinic-vfs-cli skill evolve-jobs list --status queued --json
kinic-vfs-cli skill evolve-jobs claim <job-id> --json
kinic-vfs-cli skill evolve-jobs complete <job-id> --status done --summary "proposal applied"
```

`create-ready` counts only run evidence newer than the latest job for a skill. Correction files are excluded before the new-run threshold is checked, and queued jobs keep the newest source run paths up to `min_new_runs`.
Claim ownership is checked with the caller principal and claim expiry. Workers that share the same principal are treated as the same owner; no separate lease token is used.

`apply-proposal` refuses candidates unless `metrics.json` contains passing
`candidate_score_gate`, `heading_consistency_gate`, and `permission_gate` values. The
heading gate is a coarse declared-heading consistency check, not semantic verification. It
also refuses stale proposals whose `base_etag` no longer matches current
`SKILL.md`.
In v1, `apply-proposal --projection-dir` syncs only the applied `SKILL.md`.
Manifest and sidecar updates are outside proposal apply scope; use `skill upsert`
or `skill export` when the package file set changes.

The dashboard reads proposal records from:

```text
/Wiki/skills/<name>/proposals/<proposal-id>/proposal.md
/Wiki/skills/<name>/proposals/<proposal-id>/candidate/SKILL.md
/Wiki/skills/<name>/proposals/<proposal-id>/diff.md
/Wiki/skills/<name>/proposals/<proposal-id>/metrics.json
```

`skill upsert` stores the package, not just the entry file.
It writes `SKILL.md`, `manifest.md`, optional `provenance.md` and `evals.md`, and direct package-local `.md` links from `SKILL.md`.
If `manifest.md` is missing, it is generated from `--id` plus `SKILL.md` frontmatter.
For example, a package-local Markdown link with label `ingest` and target `ingest.md` is stored as `/Wiki/skills/<name>/ingest.md`.
URLs, absolute paths, missing files, and files outside the package directory are ignored.
By default, upsert does not delete existing DB files.
Use `--prune` when the source package is the desired exact file set and stale package files should be removed.

Import uses existing package storage after fetching upstream files:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill import github owner/repo:skills/legal-review --id legal-review --ref main --prune
```

GitHub import records `source`, `source_url`, and `revision` in manifest provenance.
Vercel and SkillHub are next-phase supply sources; this PR only exposes import commands that can complete successfully.

Manual improvement proposals are evidence-backed notes, not automatic rewrites:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill propose-improvement legal-review \
  --runs /Sources/skill-runs/legal-review/123.md \
  --summary "Tighten missing-approval checks" \
  --diff-file ./proposal.diff
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill approve-proposal legal-review /Wiki/skills/legal-review/proposals/123
```

`propose-improvement` writes a v1 proposal directory containing `proposal.md`, `diff.md`, `candidate/SKILL.md`, `metrics.json`, and `status.md`.
`approve-proposal` updates `status.md` to `reviewed`. It does not apply the diff to `SKILL.md`; use `apply-proposal` for gated candidate application.
Approval only accepts proposal roots under the target skill's `proposals/` directory with matching proposal frontmatter and status metadata.

## Example

The golden sample lives under [`../examples/skill-kb`](../examples/skill-kb):

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill upsert \
  --source-dir examples/skill-kb/skills/legal-review \
  --id legal-review \
  --prune
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill find "contract review"
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill record-run legal-review \
  --task "review vendor MSA redlines before counsel handoff" \
  --outcome success \
  --notes-file examples/skill-kb/runs/legal-review-success.md
```

## Browser

The product target is a team-operated Skill Registry, not only a CLI workflow.
The browser provides the team operation surface:

- `/skills/<database-id>` lists skill packages in one catalog.
- Search filters by id, title, summary, tags, use cases, knowledge links, and provenance fields.
- Status filters separate active skills from deprecated ones.
- Summary cards show total, promoted, reviewed, draft, and deprecated counts.
- Each skill card links back into the wiki package for detailed `manifest.md`, `SKILL.md`, provenance, evals, and proposal records.
- Logged-in writers can update status, record run evidence, and approve proposed improvements from the catalog page.
- Run evidence is written under `/Sources/skill-runs/<skill-id>/...` with browser provenance and content hashes.
- Logged-in writers can upsert pasted packages and import public GitHub packages from the browser.
- Browser package prune is disabled until the browser VFS exposes delete operations.
- Proposal diffs can be previewed and applied only when they target package-local Markdown files and the current node etag still matches.
- Browser operations record audit events under `/Sources/skill-events/<skill-id>/...`.

The wiki browser treats registry paths as ordinary wiki nodes.
Skill-specific metadata, evidence, proposals, and status actions live only in `/skills/<database-id>`.
Registry access follows the selected database role.

## Agent Runtime

Agents can use Skill KB without shelling out to the CLI through the shared tool dispatcher:

```text
skill_find -> skill_inspect -> skill_read SKILL.md -> skill_read helper files -> skill_record_run
```

Discovery and read tools are read-only.
`skill_record_run` is a write tool and is not included in the read-only tool set.
All tools require `database_id` and use existing VFS reads, searches, and writes.
Agents should ignore `deprecated` skills by default, prefer `promoted` or `reviewed` candidates, and treat the read `SKILL.md` as task-local instruction.
See [`AGENT_TOOL_CALLING.md`](AGENT_TOOL_CALLING.md) for shared Rust library wiring and current tool names.
Use the CLI for package operations such as `skill upsert`, import, proposal approval, and database linking.
`skill install` is lockfile-only in v1. It records the selected package identity, etags, hashes, and paths for a downstream agent environment; it does not copy files into a local skills directory.

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- skill install legal-review --lockfile ./legal-review.lock.json
```

## v1 Limits

- No path-level ACL.
- CLI release artifacts have SHA-256 checksums but no signed release verification.
- No marketplace-wide hash pinning beyond per-run `skill_hash` and `manifest_hash`.
- No dependency resolution.
- No install-time execution permission enforcement.
- No dedicated Store UI.
- No automatic GitHub update monitoring.
- No automatic skill rewriting from evidence.
- No GitHub org/team policy sync.
- `skill install` only writes a lockfile; it does not place files into an agent runtime.
- No implicit protected knowledge from skill manifests; use separate databases for different access boundaries.

## Validation

Run the standard checks after changing registry behavior:

```bash
cargo test --workspace
pnpm --dir wikibrowser test
pnpm --dir wikibrowser typecheck
pnpm --dir skill-registry-web test
pnpm --dir skill-registry-web typecheck
pnpm --dir skill-registry-web build
cargo check -p kinic-vfs-cli --bin kinic-vfs-cli
```
