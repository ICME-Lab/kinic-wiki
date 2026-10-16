# Portable learning validation — 2026-10-15

Base: `d37d148faddeac352b0c8adb06b623ecc35dce59`.
Branch: `feat/continual-learning`.
Approved scope: arbitrary-project Kinic Wiki common infrastructure; plugins invoke
CLI only. This is not a system for improving the Kinic Wiki repository itself.

## Evidence

- `cargo test --workspace --quiet`: 867 passed, 0 failed, 3 intentionally
  ignored external-environment checks, on the final implementation tree.
- `cargo fmt --all -- --check` and working/staged whitespace checks passed.
- Python shared runtime: 49 passed; real Cordis DSH plugin: 5 passed.
- CLI binary tests cover command availability and unconfigured hooks skipping
  before identity/network access, under an isolated HOME and PATH.
- Real SQLite-backed acceptance uses two unrelated fixture projects and both
  Codex/DSH event routes. Covers setup, own/shared recall, identical session IDs,
  recording, outbox, durable jobs, proposal generation, candidate retention,
  restart and disable. Only the external inference process is deterministic.
- An explicitly signed publication fixture isolates project publication/rollback
  from inference/statistics. It verifies actual guarded writes, next recall,
  rejection of another project's rollback and recall after rollback. It does not
  claim that the model-generated candidate passed real comparative evaluation.
- Separate source/retrieval tests cover global budgets, shared scope invalidation,
  cache partitioning and legacy fingerprint preservation. DSH setup accepts the
  version 2 config and prepares an independent plugin payload.

## Review and recovery fixes

Fresh review identified and resolved common redaction coverage, queued-arrival
handoff, and validation-manifest rechecking. Scoped review then identified and
resolved explicit-config/engine inbox partitioning and offline prompt run binding.
Additional regression exposed and fixed cross-project rollback. Important fixes
have reproducing tests, including failed-before/passed-after inbox interface,
redaction, legacy backup, DSH setup and rollback checks.

The CLI reserves input run identity before network/identity initialization, retains
redacted input on failure and replays observations with the original config and
engine. Failed recalls stay explicitly absent. Replay without a pinned legacy
principal is retained locally for manual reconciliation. Raw comparative history
is restricted to the current project's tagged events. Transcript evidence is a
bounded current-turn tail, with missing boundaries/truncation explicitly reported.

## Rulings and limits

- Shared knowledge is selected explicitly and may inform project-specific
  improvements. Shared-target proposals can be retained, but shared publication
  requires a separately registered multi-project policy; this release does not
  register that policy or automatically promote common candidates.
- Moving to another host requires updating absolute runner/suite paths. Repeated
  setup preserves existing project identity/settings rather than silently changing
  them; Git worktrees on the same host share the primary config.
- A configuration change during an ambiguous publication preserves the exact
  attempt for manual reconciliation instead of risking a different committed
  payload. Unknown/incomplete evidence does not become verified task success.
- A separate configuration/diagnostics chat appended its own scope to the shared
  Wiki workflow during execution. Its documents and progress were preserved; it
  does not change this branch's approved scope or authorize importing its work.

No production deployment, active-profile activation, push or merge is part of this
change. Native agent sandboxes plus archived evaluation directories are not an OS
container. Provider transport and statistical eligibility tests from the original
foundation remain; these deterministic fixtures do not establish a measured
quality gain. Actual installed-host integration and held-out repeated task-family
quality measurement remain release validation.


## Requested review fixes — 2026-10-15

Base `7129f8df`. Reproducing tests failed before the four fixes and passed after:
immutable redacted transcript intake/replay; explicit configuration before
connection resolution and throughout background drain; candidate/evaluation project
identity checks; runtime artifact isolation by connection/principal/project.
An external-config acceptance test drives a normal hook through proposal retention
without any discovered project config. A real binary test uses anonymous mode to
stop before authentication/network construction, proving intake used the external
file's connection. Background command tests assert the config argument survives.

Scoped independent review confirmed all four corrections without additional
load-bearing findings. No production activation, model invocation, profile changes,
push or merge was performed. Final `cargo test --workspace --quiet`: 873 passed,
0 failed, 3 intentionally ignored external-environment checks. The CLI package
passed 288 tests with 1 live-provider check ignored. Formatting and whitespace
checks passed. The final commit is recorded in the Wiki review/completion append;
preceding phase counts above remain historical evidence.
