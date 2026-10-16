# Agent status implementation plan

> Use kinic-superpowers:executing-plans inline; human requested implementation of the described minimum status on 2026-10-16.

Goal: explain locally observed progress without executing, syncing, repairing or creating state.
Architecture: early CLI dispatch and a dedicated read-only reader of existing outbox, scoped inbox and jobs. JSON is the canonical report; human text shows the same evidence. No new state machine or index.
Tech stack: existing Rust/clap/serde/rusqlite.
Spec: 2026-10-15-agent-configuration-diagnostics-proposal.md section7; selected wiki spec v4h:ce45cd297ed354b85f489c8467520ef01fac918b3e31df039aa0d72459a7db1e. Human accepted the chat description with では実装してみて.
Base: f734cecb; integrate reviewed parent correction14e47597 before status.

## Constraints
- Default status performs only local reads, no identity helper/process/network, directory creation, schema migration, chmod, queue replay or learning.
- Fields have provenance and scope; unavailable data stays unknown, not zero/success/never-run.
- Filter by destination/principal/project; do not aggregate stages of the same event.
- Never output task/context/transcript bodies, runner environments or raw stored error strings.
- Probe, refresh and new indices deferred; publication/rollback absent local evidence stay unknown.

## Review focus
Wrong project/principal binding; active WAL databases; partially corrupt or locked sources; missing state/config/auth; bare receipts mistaken for delivery; old queues/config partitions; unbounded local payloads.

## Task1: Integrate parent corrections
- [x] Compose overlapping shared-config changes with explicit config/snapshot/job binding corrections; preserve tests from both sides.
- [x] Run CLI library/integration suites and commit integration before adding status.

## Task2: Read-only status and CLI
Files: create src/agent_status.rs and tests/agent_status.rs; modify lib.rs, main.rs and learning/cli.rs. Shared read-only path helpers may be extracted from workflow_hooks/outbox/jobs without changing runtime behavior.
Interface: agent_status::run(args: &StatusArgs, connection: &ConnectionArgs) -> anyhow::Result<()>; StatusArgs holds cwd, recall_config, StateArgs. Build report without client.
- [x] Add binary tests: command accepted, missing state leaves HOME/state absent, explicit --cwd selects target configuration before routing, output has schema1 and per-source unknown states.
- [x] Observe RED; implement early dispatch and bounded report collection.
- [x] Real SQLite fixtures: current/other project and identity, acknowledged/pending records, job candidate/evaluation/failure, receipt versus delivery, corrupt/locked/missing DB, active WAL and unchanged filesystem. Fixture executables/network listener catch unintended operations.
- [x] Observe RED for each behavior; implement read-only queries with short timeout, bounded input and sanitized partial failures. No creation-capable open helpers.
- [x] Run focused tests then workspace; review diff independently and fix findings.

## Task3: Documentation and delivery
- [x] Document JSON/text, current scope, partial results, queue distinctions and unavailable evidence.
- [x] Run workspace/fmt/diff checks, record results/review, commit feature, persist selected wiki workflow evidence. Keep branch/worktree; no push/main integration/activation.
