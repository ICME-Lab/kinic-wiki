# Agent configuration and diagnostics

Configure a project once, then use the ordinary commands:

```sh
kinic-vfs-cli agent setup --engine codex
kinic-vfs-cli agent doctor --engine codex
kinic-vfs-cli agent run --engine codex --task 'Fix the regression and run the tests'
kinic-vfs-cli agent recall --task 'Find the earlier authentication decisions'
```

A database link and the existing icp-cli identity are still required for learning
reads/writes. Setup does not create a database, authenticate to a model, enable
learning jobs, or publish knowledge. The existing evaluation and promotion rules
remain in force.

## Project and user settings

Connection settings retain their existing names and precedence. Add learning and
engine tables to `.kinic/config.toml`:

```toml
# Existing connection values belong at the top level.
# replica_host = "https://icp0.io"
# canister_id = "..."
# database_id = "..."

[learning]
namespace = "/Knowledge"
budget_tokens = 4000
fts = true
graph = true
semantic = false
max_index_nodes = 1000
# A relative state_dir is relative to this TOML file, hence .kinic/state here.
# state_dir = "state"

[agents.codex]
model = "your-selected-model"
timeout_seconds = 600
max_output_bytes = 8388608

[agents.dsh]
model = "your-provider/your-model"
timeout_seconds = 600
```

Models are examples to replace, not defaults or recommendations. Omit `model` and
`reasoning_effort` to retain the engine's existing default behavior. No semantic
provider or reranker is enabled automatically. If semantic search is enabled,
configure the existing embedding endpoint/model and `api_key_env` fields under
`[learning.embedding]`; the named environment variable holds the credential.

Machine-specific executables normally go in the existing user file
`~/.config/kinic-vfs-cli/config.toml`. If that file does not exist but
`~/.kinic-vfs-cli.toml` does, the existing fallback file is used. Example:

```toml
[agents.dsh]
executable = "/absolute/path/to/your/dsh-launcher"
```

A bare executable name uses PATH. A path in TOML is relative to the file defining
that value. Runner fields retain their existing names: `model`,
`reasoning_effort`, `timeout_seconds`, `max_output_bytes`, `extra_args`,
`read_only`, and `env_clear`. Literal runner `environment` values are not accepted
in TOML; use the existing inherited credential environment. Legacy runner JSON
continues to support its previous explicit environment map.

Learning/engine fields resolve individually in this order: explicit command
arguments, explicitly provided JSON fields, project TOML, user TOML, existing
runtime defaults. Arrays replace rather than concatenate. Unspecified JSON fields
do not mask TOML fields. With no TOML learning/engine settings, existing JSON
inputs retain their defaults and path interpretation. Existing connection
argument/environment/file precedence is unchanged.

`--runner-file` and `--recall-config` remain available. Legacy recall JSON may also be supplied as
`--recall-config -` to `agent recall` or `agent run`. The CLI reads it once
before identity setup and reuses it in memory; no temporary configuration file
or automatic job policy is created. Versioned portable-project configuration
requires an on-disk file. Runner and recall configuration cannot both use stdin.
 A conflicting `--engine`
and JSON engine is an error. `agent run` requires either engine or runner-file;
there is no new implicit engine selection. An explicit legacy runner with no
recall configuration and no TOML learning table retains its previous empty-context
behavior for an unversioned legacy project. A versioned portable project always retains its scoped recall. Recall/hooks also support the legacy `.kinic-learning.json` fallback.

## Working directory

Use `--cwd` on agent commands to choose another project before configuration,
connection and identity resolution:

```sh
kinic-vfs-cli agent doctor --cwd /path/to/project --json
kinic-vfs-cli agent run --cwd /path/to/project --engine codex --task 'Run the tests'
```

Project discovery walks upwards to the first `.kinic/config.toml` or Git root,
matching existing connection discovery. Explicit CLI file paths retain the
invocation directory as their base. Relative paths inside legacy JSON retain
legacy interpretation; TOML paths use their defining file's directory. Hooks use
their event/session cwd; a conflicting explicit hook cwd is rejected.

`--state-dir` takes precedence over `KINIC_LEARNING_HOME`, then TOML's
`learning.state_dir`, then `~/.kinic/learning`. Setup without any existing recall
configuration creates a starter project budget of 4096 tokens; it does not
rewrite the budget of existing TOML or legacy JSON configurations.

## Setup and changes

```sh
kinic-vfs-cli agent setup --engine dsh --executable /absolute/path/to/launcher --dry-run --json
kinic-vfs-cli agent setup --engine dsh --executable /absolute/path/to/launcher
# If replacements were reported, review them and then apply explicitly:
kinic-vfs-cli agent setup --engine dsh --executable /absolute/path/to/launcher --apply
```

Setup lists PATH candidates without running them or inspecting model responses.
When DSH has no configured/explicit executable, a unique PATH candidate is
required; otherwise choose `--executable`. An explicit bare name can be prepared
before installation; doctor will report its absence until it is available.

New files can be created on the first invocation. If any existing file would
change, setup reports `changes_pending` and writes nothing until `--apply` is
provided. `--dry-run` never writes. Reports include changed file paths, before/after
hashes, and executable-setting changes. Unknown TOML tables, comments, unrelated
marketplace entries and unmanaged plugin files are preserved. An unchanged setup
returns `unchanged`.

Executable settings default to the user file. Use `--project` to explicitly save a
machine path in project configuration. If an existing project executable would
mask a user change, setup requests `--project` instead of claiming the new user
value took effect.

`codex setup` and `dsh setup` use this same implementation. Existing DSH
`--output` and `--recall-config` flags are retained. The legacy DSH alias preserves
a configured launcher; with none configured, it can prepare artifacts with the
bare `dsh` name before installation. Pass `--executable` to pin a launcher; doctor
reports whether it is available. The default DSH package/overlay location is
`.kinic/plugins/dsh`. `--output` selects a different directory.

Codex setup prepares the self-contained plugin and marketplace entry. Installation,
plugin enablement, hook trust, restart and observed operation are separate facts.
Check the Codex plugin UI and `/hooks`, then restart when needed. Placement is
reported as prepared, not proof that hooks ran.

DSH setup prepares a package and `kinic-learning.patch.yml`. Install that package
in the chosen profile and load the overlay using DSH's supported commands. Setup
does not edit active profiles or connect to running sessions. Both adapters call
the CLI to resolve TOML and perform learning; they do not implement a second TOML
resolver. Durable hook intake and retry now belong to the CLI, as in the portable-learning
foundation. The Codex adapter has no independent learning queue or TOML parser.
Intake is partitioned by the destination, engine, project/cwd and a fingerprint of
all contributing JSON/TOML files. Portable project records pin the configured
principal, which is checked against the actual caller before replay; legacy input
without a known principal stays pending for explicit reconciliation. Existing
Python-queue files from older installations are not deleted or silently imported.

The portable foundation's versioned `.kinic-learning.json` remains the authority
for project identity, private/shared scopes, enablement and validation policy.
Its runtime values are a compatibility fallback beneath new TOML settings;
explicit JSON overrides remain highest priority. TOML may tune budget, retrieval
conditions and normal engine defaults, but may not change a portable project's
identity or scopes. Conflicting scope settings fail with an explanation. The automatic learner continues to pass its explicitly pinned project runner and
validation configuration to evaluation; those explicit snapshots outrank normal
engine defaults. Update that policy with the existing learn setup flow rather than
silently changing an evaluation's model or criteria through a runtime default.
Automatic learning still requires the existing explicit `learn setup`/enable flow; `agent
setup` does not activate it. See [portable learning](PORTABLE_LEARNING.md).

## Doctor contract

```sh
kinic-vfs-cli agent doctor
kinic-vfs-cli agent doctor --engine dsh --json
kinic-vfs-cli agent doctor --strict
```

With no engine flag, doctor checks configured engines plus common settings. It
loads configuration, checks executable attributes and default payload placement,
inspects stored identity/delegation where accessible without external commands,
and makes bounded read-only database/revision API calls when a target is known.
Each remote read (status, node/scope revision, node read and a one-item snapshot) has a five-second bound; a failed prerequisite skips dependent
API checks. An inaccessible keyring identity remains unknown; any anonymous
fallback is labeled and does not establish that identity's access. For portable
projects, doctor separately compares the resolved destination and stored caller
with the project binding. A successful remote read cannot hide a binding mismatch;
an unavailable stored caller leaves the identity comparison unknown.

Doctor never starts an executable (including wrappers or `--version`), creates a
model/embedding request, writes to the Wiki, opens/creates queues, refreshes
credentials, creates directories/databases, retries records or repairs state.
Existing file presence does not prove model connectivity, hook activation or
write permission. Custom DSH payload locations require separate inspection.

Checks have `ok`, `warning`, `error`, `unknown` or `skipped`, a stable code,
evidence and a suggested next action. JSON includes `schema_version: 1`, UTC
`checked_at`, target, configuration sources and independent check results. Raw
configuration parse excerpts, credential values and remote error bodies are not
printed. Missing identity/configuration does not suppress available local checks.

Exit codes are 0 for no confirmed errors, 1 for diagnosed errors, and 2 for failure
to run/produce diagnostics. Warning/unknown normally allow 0; `--strict` makes them
1. An optional skipped check alone is not a failure. A timeout remains unknown;
it is not reported as permission denial or a missing API.

This release implements configuration/setup/ordinary doctor (proposal stage A).
`doctor --probe`, remote status refresh and a new learning-state
index are deferred. Stage B local `agent status` is described below. Existing receipts and evaluation/publication artifacts remain
the evidence; no new claim of learning quality is inferred from setup or diagnosis.

## Local learning status

```sh
kinic-vfs-cli agent status
kinic-vfs-cli agent status --cwd /path/to/project --json
kinic-vfs-cli agent status --recall-config /path/to/external-project.json --state-dir /path/to/state --json
```

`agent status` displays existing local evidence and performs no network requests,
engine/credential-helper execution, queue replay, learning, schema migration or
state creation. It uses the same cwd and state-directory precedence as other
agent commands. Explicit file paths retain the invocation directory as their
base; stdin configuration is not supported.

The report includes:

- Project/DB, configuration sources and engines. A principal from portable project
  configuration is labeled as configured, not proof of active authentication.
  A readable stored identity is checked against that binding. A destination or
  caller mismatch suppresses bound queue reads.
- Pending/acknowledged outbox records for identified runs of the selected project,
  destination and principal. Last record means local insertion order. Events
  without enough project evidence are withheld; incomplete attribution or
  truncated input makes exact counts unknown. Conflicting owners for a reused
  run ID, or a recorded repository whose workspace can no longer be resolved,
  are also withheld as unattributed evidence.
- The latest locally recorded context receipt and run. Receipt assembly does not
  prove delivery to an engine, adoption, task success or better learning quality.
- Existing learning-job states, candidate/evaluation references and sanitized
  reason codes. A recorded job state does not establish current process health.
- Pending CLI hook inputs, separately for both supported engines' current cwd/configuration
  partition. These are a different stage from outbox records, so counts are not
  added. Old configuration partitions and legacy Python adapter queues are
  excluded explicitly, rather than silently counted as empty.

JSON has `schema_version: 1`, UTC `checked_at`, `mode: local_read_only`, target,
configuration, records, context, learning, intake, publication and rollback.
Each available source carries its path and scope. Values without evidence remain
`unknown`/`null`; partially readable data is `partial`. Configuration or source
errors produce partial reports without raw parser, transcript or error bodies.
A successfully produced report exits 0, including unknown/partial sections;
use doctor for connection diagnosis and its diagnostic exit-code contract.

The existing events and jobs do not persist reliable event/send timestamps.
Status therefore shows event time as unknown. A storage-file modification time
is labeled as such and is never substituted for an event or send time. Final
send failures, remote publication/rollback details and actual context delivery
remain unknown when there is no local evidence. Even a job recorded as published
is not remote verification of its publication artifact.

SQLite reads use a dedicated read-only path with a short lock timeout, without
opening the creation-capable outbox or job APIs. Live WAL/shared-memory files and
rollback journals are reported as unavailable to avoid modifying sidecars or
pretending an incomplete checkpoint is current. Retry status after the writer
closes; status does not checkpoint, unlock or repair anything. Missing, locked,
corrupt and unsupported stores leave other sections available. Each source is
read independently; the report is not an atomic system-wide snapshot. Reads are
bounded to 4096 records/jobs/inputs, 1 MiB per body and 16 MiB of returned bodies per database or inbox source;
truncation is explicit and never becomes an exact pending count. SQLite may scan other rows while selecting the current scope. Local startup
configuration and stored identity files must be regular files of at most 8 MiB;
oversized or nonregular files leave the relevant evidence unavailable.

This implements proposal stage B. `doctor --probe`, `status --refresh` and new
observation indices remain conditional additions, based on operational gaps.
