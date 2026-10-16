# Continual learning implementation validation — 2026-10-15

Implementation branch: `feat/continual-learning`; base commit
`a76234cfccd2d29264d923b71bcfaa030879586a`.
The approved conversation plan is recorded in Kinic workflow
`a1cf9738-5e80-40bd-88b0-6ce259d50be5`.

## Delivered paths

- Additive Rust/Candid APIs, SQLite migration 004, durable identities and revision
  history, atomic evidence/target/scope guards, protected knowledge enforcement.
- CLI run/recall/record/flush, private outbox and derived search cache, conditional
  FTS/semantic/graph recall, exact context receipts and historical evidence.
- Codex JSONL and DSH SDK adapters, normal Codex hooks and a native Cordis plugin.
- Candidate generation, isolated four-mode evaluation, attested automatic
  publication, dependency invalidation and recoverable rollback.
- Synthetic and pinned historical tasks, external machine oracles, family splits
  and clustered uncertainty estimates. See [usage](CONTINUAL_LEARNING.md).

## Verification evidence

- `cargo test --workspace --quiet`: 841 passed, 0 failed, 3 intentionally ignored
  before the final publication retry regression. The final focused run
  `cargo test -p kinic-vfs-cli --lib learning::workflow::workflow_tests --quiet`
  passed all 7 tests, including the added stale-scope recovery regression. The ignored checks require live agents or an explicit external environment.
- `python3 -m unittest discover -s plugins/runtime/tests`: 49 passed.
- `node --test plugins/dsh/tests/*.test.mjs`: 4 passed with actual Cordis/Session.
- Candid tooling: 5 passed; generated binding check and additive compatibility
  against the pinned mainnet interface passed.
- Genuine release Wasm with PocketIC: 4 passed, no skips. Covers old-to-new
  migration, stable identities/history across upgrades, protected/atomic/idempotent
  publication, scope conflicts and reader authorization. Reproduce with
  `POCKET_IC_BIN=<runtime> pnpm --dir pocketic-tests test:learning-revisions`.
- Actual Codex and DSH transport tests passed. A same-task coding comparison
  passed all 8 external-oracle cases (four modes, two engines, one trial).
  An earlier ambiguous fixture caused all 8 to fail despite completed agent turns;
  its input type was clarified and rerun. Machine failure was never converted to
  success based on agent claims.

## Review disposition

Independent full-change review and a scoped follow-up identified six issues;
all were corrected and covered by regression checks: evaluate the complete
mutation set including dependencies, guard all consumed retrieval state, use the
same canonical graph for overlays and serving, resolve historical source versions
separately from current guards, use execution/pinned environments for recall, and
apply private cache permissions independently of outbox initialization.

Follow-up identified a recovery issue after stale-scope rejection. Publication
attempts must be evaluation-specific while retaining a candidate-wide canister
operation ID, allowing a fresh uncommitted attempt and rejecting replacement
of an already committed payload. The final focused suite passed all 7 tests;
the controller inspected the patch and independently reran that suite.
`cargo fmt --all -- --check`, staged and working-tree whitespace checks passed.

## Operational limits and release decision

No production canister was upgraded, no active DSH profile was changed, and no
production learning was enabled. New APIs require an operator-managed canister
upgrade. Normal hook trust/restart support must be checked in the target Codex
installation; `agent run` is the supported fallback.

The live coding comparison is a transport/oracle smoke, not evidence of learning
quality improvement. Broad held-out, repeated family-level evaluation remains
required before production activation. Final evaluation failures must not become
candidate-generation input. Family overlap across separate manifests and repeated
final-set use require operator discipline.

Semantic search requires explicitly configured embedding service/model. The
condition filter is lexical; it cannot prove arbitrary natural-language conditions.
Agent-native sandboxes and separate archived directories do not constitute an
additional OS container. Local HMAC attestation keys are identity/connection scoped;
retain the key securely or rerun validation when moving evaluation to another host.
