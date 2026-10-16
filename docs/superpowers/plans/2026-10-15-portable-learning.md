# Portable Kinic Wiki learning implementation

Goal: generic common infrastructure for arbitrary projects; plugins invoke CLI only.
Approved conversation plan: user “計画を実施”, 2026-10-15. Base d37d148f.
Wiki workflow: a1cf9738-5e80-40bd-88b0-6ce259d50be5.
Approval summary snapshots: spec dc64357670866d4e6357bffa5678cfb11e9164925a657ededc02f356baa798e6; plan da0791e9932f39842eeb1d585634c46c3c66f9ca92afe488991caee34cd2c9fa.

- [x] Stable versioned project setup, identity/connection binding, worktree discovery and legacy migration.
- [x] Multi-scope globally budgeted recall, project-bound records and candidate boundaries.
- [x] CLI durable jobs connecting evidence/proposal/evaluation/publication, retry and disable.
- [x] Codex/DSH thin CLI-only adapters, installed payload independent from source checkout.
- [x] Final regression, review fixes and documentation; 867 Rust/49 Python/5 DSH passed.
- [x] Preserve implementation in the feature branch; no push/merge/activation.

Ruling: preserve a separately appended configuration/diagnostics execution in the
shared Wiki workflow. Its append does not change this implementation's approved
portable-foundation scope; do not overwrite that execution's documents/progress.
Ruling: shared scopes are read inputs; shared publication remains unavailable
without a separate multi-project validation policy. Private automatic publication
retains all existing grounding/performance/version/protection gates.
