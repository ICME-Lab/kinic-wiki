# Kinic Wiki continual learning implementation

Approved specification: the user's implementation request in this chat (2026-10-15).

Goal: maximize development task success and quality through the existing kinic-vfs-cli, Codex and DeepSeek Harness. Canister is authoritative; CLI orchestrates learning; external agents execute code. No new hosted Worker. Preserve all four stores and the Skill Registry.

## Tasks
1. Add durable node identities, revision history, atomic version-checked learning publication, typed contracts and migrations. Tests cover move/delete/recreate, migration baseline, conflicts and protected knowledge.
2. Add shared learning records, durable idempotent outbox and agent recall/record/flush CLI. Record exact supplied content separately from adoption and outcome.
3. Add Codex JSONL and DSH SDK runners with bounded lifecycle, isolated evaluation and baseline comparison.
4. Add conditional lessons, derived local SQLite retrieval, FTS/semantic/graph fusion and source-checked context assembly.
5. Add candidate generation, source validation, comparative evaluation, gated publication, invalidation and rollback.
6. Add normal Codex/DSH integration, fixtures, docs and full regression verification.

## Binding constraints
- Existing DB/identity resolution, additive APIs, JSON CLI output.
- Codex exec --json; DSH launches only through dsh --profile sdk. Never attach evaluation to an existing live session.
- Source/run evidence is retained; no invented historical revisions or successful outcomes.
- No automatic modification of human instructions or approved decisions.
- Compare none/raw/current/revision with matched runtime settings and isolated workspaces; separate train/validation/final task families.
- No production deployment or setup of the user's active agent profiles in this implementation.

## Verification
Rust unit/integration suites; migration and authorization tests; Python outbox/hooks; DSH plugin event handling; evaluator isolation and statistics; actual-agent checks where installed/authenticated. Disclose any unavailable live checks without claiming measured improvement.
