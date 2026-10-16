# Kinic Wiki learning in arbitrary projects

The feature belongs to Kinic Wiki's common infrastructure. The project being
worked on supplies tasks and evidence; it does not need to contain Kinic Wiki
source code. Codex and DSH plugins invoke `kinic-vfs-cli` only. All connection,
retrieval, evidence, durable job and publication policy lives in the CLI. The
canister retains the authoritative knowledge, evidence and immutable revisions.

## Setup

Install a released CLI on PATH (or select `KINIC_VFS_CLI`), prepare your usual
Kinic identity and database access, then run from the target project:

```sh
kinic-vfs-cli --database-id <db> learn setup --project-root . --runner-file /absolute/path/runner.json --shared-scope /Knowledge/shared --json
kinic-vfs-cli learn status --project-root . --json
```

`--validation-suite /absolute/path/validation.json` registers the project's
validation-only evaluation suite. Without one, learning retains proposals and
never publishes them. The runner file uses the existing RunnerConfig format in
[continual learning](CONTINUAL_LEARNING.md). Credentials stay in the normal
identity store or inherited environment; do not put secret environment values in
the runner or reranker configuration. Setup rejects these values. Set runner
`"inherited_environment":["OPENAI_API_KEY"]` (or `DEEPSEEK_API_KEY` for dsh) to
reference credentials available in the launching process. Isolated evaluation
passes these only to the runner, redacts their values from artifacts, and keeps
the verifier environment isolated. Missing referenced values fail explicitly.

Setup creates version 2 `.kinic-learning.json` containing a stable opaque
`project_id`, pinned replica/canister/database/principal, runner configuration,
validation suite, recall settings and selected shared scopes. Explicit CLI and
connection environment settings are still checked against the pinned project;
conflicting settings fail. Project connection values take precedence over global
defaults. No authentication material is copied into this file.

Repeated setup preserves existing settings, identity and disabled state. A legacy
recall file is explicitly migrated, with its original bytes preserved as
`.kinic-learning.json.legacy`; the former namespace becomes a selected read scope.
Legacy files still work for recall/record without setup, but do not start jobs.
Within a version 2 project, a legacy file or stdin runtime override retains the
project's scope, identity, and connection checks. Such transient overrides do not
start automatic learning jobs; durable jobs require the version 2 config path.
Use the version 2 file to change runner, suite or read scopes. Executable/suite
paths are absolute: update host paths explicitly after moving machines. Retain
normal identity state and evaluator keys separately. Linked Git worktrees find
the primary project's config; a separate explicit config creates a separate
binding. Copying a config intentionally preserves its project identity.

## Knowledge boundaries

Each project owns `/Knowledge/projects/<id>`, `/Memory/projects/<id>` and
`/Skills/projects/<id>`. Recall ranks these scopes together with the explicitly
selected shared scopes, using one overall budget. Another project's private
knowledge is not selected implicitly. Database ACLs still govern access; prefixes
are learning boundaries, not a replacement for database permissions.

Runs, context receipts and candidates carry project identity. Same session/turn
IDs in two projects produce different run bindings. Outboxes, caches and queues
are partitioned, and candidate/dependency writes must stay inside that project's
private scopes. Shared knowledge can inform a project-specific lesson; shared
writes remain staged candidates with an explicit multi-project-validation
requirement. This release supplies shared reads and private publication; it does
not register a cross-project publication policy or automatically promote shared
candidates. Existing four stores and Skill Registry remain intact.

## Normal use and recovery

Install the official [Codex](../plugins/codex/README.md) or
[DSH](../plugins/dsh/README.md) plugin. CLI paths must resolve independently of the
Kinic source checkout; there is no development `target/debug` fallback. Setup
prepares integration but does not claim hook activation: review Codex trust and
restart requirements, or activate the chosen DSH profile explicitly. Existing
active profiles are not modified by this feature's implementation. If normal
hooks are unsupported, use `agent run` with the project configuration.

A prompt recalls knowledge through the CLI and retains the exact context receipt.
Tool and terminal events become evidence; terminal events enqueue learning work.
A finite independent CLI process drains the queue. No permanent worker is
installed, and hooks do not wait for model evaluation. Pending work is retried on
the next prompt or explicitly:

```sh
kinic-vfs-cli learn drain --project-root . --json
kinic-vfs-cli learn disable --project-root . --json
kinic-vfs-cli learn enable --project-root . --json
```

When a plugin uses an external version 2 file, its effective canonical config
path also selects the connection and follows the background job. Manual recovery
can use `learn drain --project-root /path/to/project --recall-config /path/to/external.json`.
Evaluation rejects a recall configuration bound to another project. Runtime runner
artifacts are isolated by connection, principal and project, with content-addressed
configuration filenames.

The queue is durable and serialized per identity/database/project. Each drain
attempts a failed job at most once; new arrivals receive a handoff/recheck.
Configuration and validation-manifest changes invalidate pending evaluation.
Network failures before hook dispatch retain redacted input in a private CLI
inbox; subsequent hooks retry observations. Effective configuration, engine and original run identity are reserved before
network/identity setup. Completed-turn transcript evidence is captured and
redacted at intake; replay never substitutes a later turn's mutable log. Old
inbox entries without a snapshot retain the observation with missing transcript
evidence instead. Prompt events do not capture a previous turn's results. Missed recalls are recorded as missed, never replayed as
if context had actually been delivered. Legacy inputs without a pinned principal
remain locally pending after ambiguous failures and require manual reconciliation. Processed evidence uses
the idempotent outbox. Deleted or truncated logs remain explicitly incomplete.
Hook observations never establish verified task success or adoption.

A job progresses through proposal, comparative isolated evaluation and guarded
publication. Grounding plus significant improvement and no regression are required;
missing or insufficient validation stays unpublished. Native tests/oracles, not
assistant self-reports, determine task outcomes. Existing human/protected decision
checks, source/scope guards and rollback apply. Read `learn status` for job state
and error details. Disable prevents enqueue and publication, retaining evidence
and pending work. An ambiguous publication retains the exact signed attempt;
changing its configuration requires manual reconciliation rather than replaying a
different request blindly.

## Validation and release

The automated portable acceptance tests use two independent temporary projects,
real SQLite-backed API calls, both plugin event routes and a deterministic external
JSONL model peer. They verify setup, scoped recall, outbox, proposals, retained
candidates, restart and disable. Separate tests check global search budgeting,
shared-source invalidation, CLI help/early unconfigured skip, installed plugin
transport and serialization/recovery boundaries. Fake model transport is not
proof of provider access or learning quality.

No production deployment or enabled profile is implied. Before release, run
held-out repeated task-family comparisons and actual-agent integration in the
target installation. The first implementation's live provider smoke is recorded
in the existing Wiki workflow `/Knowledge/kinic-wiki/workflows/a1cf9738-5e80-40bd-88b0-6ce259d50be5/completion.md`; it does not measure this
extension's generalization or prove a quality gain.
