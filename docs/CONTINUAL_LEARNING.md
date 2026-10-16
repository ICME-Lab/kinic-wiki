# Continual learning through the existing CLI

Kinic retains knowledge and evidence in the canister. `kinic-vfs-cli` runs retrieval,
external agents, validation and guarded publication locally. No learning Worker is
required. This feature does not deploy or enable itself on production canisters.
Upgrade the canister before using the new revision and publication APIs; older
canisters return a missing-method error rather than silently losing provenance.

## Runtime configuration

For the TOML setup, short commands, working-directory rules and non-executing
`agent doctor`, see [Agent configuration and diagnostics](AGENT_CONFIGURATION.md).
The explicit JSON examples below remain supported.

All remote commands reuse the existing database link, canister and identity flags.
Learning writes require a database writer. Historical reads require database reader
membership; marketplace purchase-only access does not expose historical content.
Use `--json` for automation. The learning commands currently return JSON in both
human and machine mode. Local `eval` and `dsh setup` work without a database or
identity connection.

A runner file selects the external executable and model. Examples:

```json
{"engine":"codex","executable":"codex","timeout_seconds":600,"max_output_bytes":8388608,"environment":{}}
```

```json
{"engine":"dsh","executable":"/absolute/path/to/dsh","model":"deepseek-official/deepseek-v4-flash","timeout_seconds":600,"max_output_bytes":8388608,"environment":{}}
```

An executable may be a normal launcher script that forwards argv. For the local
DSH source installation, `scripts/launch-local-dsh.node.sh` launches its supported
CLI/profile entrypoint. Avoid a wrapper that rewrites arguments or refreshes
credentials as a side effect. DSH always launches `--profile sdk`, initializes its
provider/model, enqueues one prompt, then waits for that message's receipt,
completed root turn and root idle. Startup idle, unrelated sessions and enqueue
acknowledgments are not success. Codex uses `exec --json` and requires a completed
turn. Both capture bounded evidence, time and available token counts. Missing costs
stay unknown. Timeouts and malformed/truncated streams produce incomplete runs.

`reasoning_effort` is optional. `read_only` defaults to false; Codex explicitly
uses workspace-write for execution and read-only for revision/reranking/grounding.
DSH selects the equivalent shipped SDK permission policy through its environment.
Custom profile policies remain the operator's responsibility. Raw extra arguments
cannot override the selected model, sandbox or profile policy. Inference commands
force read-only and reject DSH patch overlays that could replace that policy.

For the legacy explicit JSON workflow, create `.kinic-learning.json` in the project for recall:

```json
{"namespace":"/Knowledge","budget_tokens":4000,"fts":true,"graph":true,"semantic":false,"max_index_nodes":1000,"environment":[]}
```

The namespace can instead be `/Skills` or `/Memory`. Recall includes OS,
architecture, working directory and bounded dependency manifest text as retrieval
signals. Add explicit environment labels when automatic signals are insufficient.
`environment` metadata string values and `applies_to`/`exceptions` are matched
against these task/environment signals. This is a lexical condition filter, not a
proof of arbitrary natural-language preconditions; final applicability remains an
agent judgment. Non-string environment metadata is not an executable constraint.

Semantic retrieval requires explicit embedding configuration:

```json
{"namespace":"/Knowledge","budget_tokens":4000,"semantic":true,"embedding":{"endpoint":"https://provider.example/embeddings","model":"chosen-model","api_key_env":"KINIC_EMBEDDING_API_KEY"}}
```

The endpoint accepts `{model,input}` and returns `data[0].embedding`. Credentials
are read from the named environment variable, never stored in config. Text is sent
to that configured provider. A `reranker` RunnerConfig optionally enables model
reranking; leave it absent to inspect rank-fusion performance alone. The index is
partitioned by replica/canister/database/principal/model/embedding endpoint and
namespace. Evaluation overlays have separate indexes. Every recall authorizes
against the current canister, syncs a complete bounded snapshot, removes stale
paths and re-reads selected revisions. It fails on an exceeded index budget or an
unconfigured enabled stage. It does not serve private cache contents after a
revoked read. FTS, graph, semantic and reranking can be ablated independently.

## Run, record and retry

```sh
kinic-vfs-cli agent run --task 'Fix the reported regression' --runner-file ./runner.json --recall-config ./.kinic-learning.json --verification-file ./checks.json --json
kinic-vfs-cli agent recall --task 'Investigate the regression' --recall-config ./.kinic-learning.json --json
kinic-vfs-cli agent record --event-file ./event.json --json
kinic-vfs-cli agent flush --json
```

`checks.json` is an array of executable argv arrays, for example
`[["cargo","test","-p","vfs-store"]]`. The task runner executes in the selected
working directory; isolated evaluation uses separate archived task directories.
A completed model response is not verified task success. Outcome requires complete
execution, nonempty passing checks and their explicit requirement verdict. A
self-reported outcome without checks never qualifies.

Event JSON has `{id,run_id,kind,payload}`. Adoption can be recorded separately using
`kind: "adoption"`; recalled content alone is never adoption. The context receipt
stores search candidates, stable node identity/revision, source hash, supplied-body
hash, authority, full metadata, exact rendered JSON frames and truncation state.
The rendered frames, including metadata, escaping and delimiters, obey the
approximate four-Unicode-characters-per-token budget and are supplied verbatim by
both direct runs and normal hooks.

Events first enter a private SQLite outbox under `~/.kinic/learning` (override with
`--state-dir` or `KINIC_LEARNING_HOME`), partitioned by endpoint/database/principal.
Identical IDs deduplicate; changed content under an existing ID fails. Remote
`/Sources/learning-runs/<run-hash>/<event-hash>.json` evidence is immutable through
this path. Lost write acknowledgments are reconciled by exact content reads.
Acknowledged IDs remain reserved. Failed sync stays pending and is reported.

## Revise, evaluate and publish

```sh
kinic-vfs-cli learn propose --run-id '<recorded-run-id>' --runner-file ./runner.json --json
kinic-vfs-cli learn evaluate --candidate-path '/Sources/learning-candidates/<hash>.json' --suite ./validation-suite.json --runner-file ./runner.json --recall-config ./.kinic-learning.json --output ./evaluation-output/new-run --trials 3 --json
kinic-vfs-cli learn promote --candidate-path '/Sources/learning-candidates/<hash>.json' --evaluation-path '/Sources/learning-evaluations/<hash>.json' --json
kinic-vfs-cli learn rollback --publication-path '/Sources/learning-publications/<hash>.json' --json
```

Candidate generation resolves the exact historical consumed lessons and linked
source revisions, including after edits, moves or deletion, alongside downstream
results. Current target/source guards remain separate from historical evidence. It distinguishes corrections grounded in original evidence
from new observations. Operations include keeping, conditioning, correcting,
splitting, merging, deprecating and adding lessons. Candidate targets are staged
under `/Sources`, not written into live knowledge before validation.

Only nodes explicitly marked with top-level metadata `"authority":"agent"` may be
automatically changed. Unclassified/human nodes, protected or approved nodes,
instructions and approved decisions are rejected. General VFS writer permissions
are unchanged: this restriction belongs to the dedicated learning publisher, not
to every manual edit. Include lesson `applies_to`, `exceptions`, `environment`,
`state`, `evidence` revision refs and dependencies in metadata. Skill `SKILL.md`
nodes can participate when explicitly agent-owned; existing curated skills remain
protected by default. The Skill Registry is retained.

`learn evaluate` accepts validation-only tasks, applies the candidate through the
same recall pipeline and budget as serving, including canonical Markdown links
and all dependency invalidations, and runs all four comparison modes. Retrieval
conditions use the task's pinned dependency manifests and declared environment.
An independent read-only model checks grounding. Machine checks, scope compliance,
paired trials and family-cluster uncertainty govern performance eligibility. A
model's approval alone never authorizes publication. Eligible grounded changes
publish automatically; pass `--no-auto-promote` to retain only the evaluation.
Insufficient evidence leaves the candidate unpublished.

Evaluation records are HMAC-attested using a private local key scoped to the
endpoint/database/principal. The CLI recomputes comparison validity and verifies
the exact candidate snapshot, source versions and attestation before publishing.
Keep the local state directory to promote from another session. Another machine
must securely retain that key or rerun validation; copying a report alone does not
qualify. Signing does not establish generalization beyond the measured tasks.

The canister validates all evidence IDs/revisions/etags/hashes, target etags and
namespace revision guards in one transaction. Scope guards include additions,
deletions and moves that could change ranking, while unrelated evidence writes
under `/Sources` do not invalidate a `/Knowledge` evaluation. Accepted operation IDs reserve their exact request bytes. Missing parent folders are created inside the guarded publication transaction. Before
sending a mutation, the CLI durably records an attested publication intent and all
actual target/dependency preimages. Retries replay that exact request after an
ambiguous success. Each evaluation has a separate signed publication intent, so
a rejected scope guard can be followed by a fresh evaluation and publication
attempt. All attempts retain the same candidate operation ID: once one request
commits, a different request for that candidate is rejected. Dependencies marked
for revalidation become invalidated.
Rollback restores actual prior targets and dependencies; new lessons become
deprecated. It refuses intervening edits and has its own attested retry intent.

## Evaluation and normal integrations

See [evaluation fixtures](../evaluation/continual-learning/README.md) for pinned
archives, raw/current/revision contexts, holdout rules and statistical thresholds.
Use `eval run`, `eval compare` and `eval report` without a canister connection.
Dedicated fixtures include six synthetic categories and a real historical Candid
bug. Synthetic fixtures test the mechanism; they are not measured production gains.

`codex setup` installs normal recall/observational hooks alongside the existing
session recorder. Restart and review hook trust in Codex. Setup reports capability
and trust activation as unverified; use `agent run` if hooks are unavailable.
Without `.kinic-learning.json`, learning hooks skip with an explicit diagnostic.
Tool hooks retain metadata/hashes, not raw tool arguments or outputs; success and
adoption remain unknown. Failed hook events have a separate private retry queue.

`dsh setup --output ./new-plugin-directory --recall-config ./.kinic-learning.json`
prepares a self-contained ESM plugin and explicit profile overlay. Install it into
the chosen DSH profile and load the overlay as described in
[the DSH plugin guide](../plugins/dsh/README.md). Setup does not modify a running
server or existing profile. Native recall is committed through DSH's durable
message path. Observational event overflow/failure is diagnosed, not presented as
complete evidence.

## Verification

- Rust: `cargo test --workspace`.
- Production bindings: `pnpm --dir packages/vfs-candid test` and
  `node scripts/check-mainnet-candid-compat.mjs`.
- Hooks: `python3 -m unittest discover -s plugins/runtime/tests`.
- DSH plugin: `node --test plugins/dsh/tests/*.test.mjs` with its DSH peer packages installed.
- PocketIC: `pnpm --dir pocketic-tests test:learning-revisions` (a genuine pre-learning Wasm
  at `KINIC_LEARNING_BASELINE_WASM` additionally enables the old-to-new migration case).
- Explicit live transport smoke: set `KINIC_LIVE_CODEX_EXECUTABLE` and
  `KINIC_LIVE_DSH_EXECUTABLE`, then
  `cargo test -p kinic-vfs-cli --test learning_live -- --ignored --nocapture`.

Live transport smoke verifies actual provider access, event handling and completion.
It does not demonstrate learning-related performance improvement. Production
activation should follow held-out task-quality evaluation and regression review.

Implementation evidence and release limits: the existing Wiki workflow `/Knowledge/kinic-wiki/workflows/a1cf9738-5e80-40bd-88b0-6ce259d50be5/completion.md`.

For arbitrary-project setup and CLI-only plugins, see [portable learning](PORTABLE_LEARNING.md).
