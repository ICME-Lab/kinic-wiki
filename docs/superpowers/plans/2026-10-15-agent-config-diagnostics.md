# Agent configuration and diagnostics implementation plan

> Execute inline using kinic-superpowers:executing-plans. Human requested implementation of the reviewed proposal on 2026-10-15.

Goal: deliver proposal stage A; retain legacy inputs and learning semantics.
Architecture: shared Rust configuration resolution, CLI-owned learning, thin plugin adapters, local setup and read-only diagnostics before normal identity startup.
Tech stack: Rust, clap, serde, TOML editing, existing Python/JS plugin runtimes.
Spec: docs/superpowers/plans/2026-10-15-agent-configuration-diagnostics-proposal.md (stage A).
Base: d37d148faddeac352b0c8adb06b623ecc35dce59. Completed portable foundation 7129f8df3f4760de225e213a5538682dd4977e58 integrated before final verification.

## Global constraints
No status/probe implementation, model calls from doctor/setup, active DSH profile modification, canister changes or evaluation-policy changes. Preserve parent portable-foundation work in its separate checkout.

## Review focus
- Explicit JSON defaults versus absent values and partial TOML overrides.
- cwd chosen before connection and identity resolution, including hooks.
- Codex retry binding and unknown connection settings.
- Secret values in parse/remote errors and JSON output.
- Existing configuration and plugin payload preserved unless applying a displayed change.

### Task 1: Shared configuration and safe edits
Files: core connection.rs; app agent_config.rs; Cargo manifests.
Produces: ConfigResolver loading project/user settings with provenance and existing JSON inputs; safe connection key edits.
- [x] Add and run failing link/unlink preservation and configuration layering/path/legacy tests.
- [x] Implement preserving edits and resolver; run core and configuration tests.

### Task 2: CLI and plugin configuration integration
Files: learning/cli.rs, learning/workflow.rs, main.rs, Python learning_hook.py, DSH adapter and tests.
Consumes: resolver. Produces: optional runner/recall JSON, engine selection, early cwd resolution, TOML-only hook flow with partitioned retries.
- [x] Add and run failing CLI/integration and plugin tests for TOML-only operation and cwd isolation.
- [x] Integrate without changing existing JSON behavior; run related Rust/Python/DSH suites.

### Task 3: Setup and doctor
Files: agent_setup.rs, agent_doctor.rs, codex.rs, cli dispatch and tests.
Consumes: resolver and bundled payloads. Produces: additive setup with dry-run/apply and structured non-executing doctor.
- [x] Add and run failing setup/idempotence and doctor no-side-effect/error-code/redaction tests.
- [x] Implement and run binary integration tests; use bounded read-only remote probes only.

### Task 4: Documentation and whole-change validation
Files: docs/CONTINUAL_LEARNING.md and validation report.
- [x] Explain TOML schema, examples, path/precedence rules, setup activation and diagnosis.
- [x] Run Rust workspace and Python/DSH tests plus fmt; record exact outcomes and limitations.
- [x] Obtain fresh whole-change review, fix substantive findings and rerun affected tests.
- [x] Commit scoped changes and persist evidence. No push/merge/release.
