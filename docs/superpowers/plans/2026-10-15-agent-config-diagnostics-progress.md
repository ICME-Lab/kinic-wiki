# Stage A implementation evidence

Plan: docs/superpowers/plans/2026-10-15-agent-config-diagnostics.md
Spec: docs/superpowers/plans/2026-10-15-agent-configuration-diagnostics-proposal.md (stage A).
Base: d37d148faddeac352b0c8adb06b623ecc35dce59. Branch: feat/agent-config-diagnostics.
Approval: user requested implementation after the reviewed proposal, 2026-10-15, session 01a13e50-e1d4-75d0-b07c-7d514be5e9c3.

## Decisions
- Implement inline in a dedicated Codex-managed checkout; the parent's portable-foundation work is in a separate checkout.
- Scope is configuration/setup/ordinary doctor. No new status, probe, jobs or canister changes.
- Keep the parent's Wiki progress history and scope. The additional approved scope and execution plan were appended to the same workflow, with acknowledged revisions.
- TOML edits preserve unknown tables/comments using toml_edit. Machine paths default to user settings; existing project values cannot be silently masked.
- Rust owns config resolution. Python/JS do not parse or merge TOML. Codex retry binding conservatively includes setting files and identity-selection metadata.
- Setup's new starter budget is 4096 only when no recall configuration exists. Existing budgets/models/retrieval policies are not rewritten.
- Existing-file setup replacements are explicit --apply. Payload files are planned individually, retaining unmanaged files rather than replacing whole directories.
- Doctor loads file-backed identities without subprocesses. Inaccessible credential stores remain unknown; anonymous read results are labeled separately.
- One logical implementation commit after final review: integration and aliases share compilation interfaces, so task checkpoints are verification milestones, not partial unbuildable commits.

## Milestones and evidence
1. Baseline: cargo test -p kinic-vfs-cli-core --lib --quiet: 62 passed.
2. RED: two regression tests reproduced link/unlink dropping learning tables/comments and deleting learning-only configuration. GREEN: core64 passed.
3. Resolver: missing-module RED; layering, JSON override, legacy defaults/paths and secret-error tests GREEN: 3 passed. An initial macOS /var versus /private/var expectation was corrected to compare the canonical project root, matching existing cwd discovery.
4. CLI: short command parsing RED then GREEN; --cwd is applied before connection/identity and explicit CLI file paths retain their invocation base. Hook request cwd is normalized before dispatch.
5. Python: TOML-only recall and identity-selection partition tests failed before changes; all runtime52 passed afterwards. DSH normal adapter5 passed with real SDK dispatch and fixture subprocesses.
6. Setup/doctor: missing-command/alias RED, then binary integration6 passed. Fixtures verified dry-run, unchanged/conflict/apply, other-project cwd, no configured-wrapper execution, no local storage creation and no parse-secret output.
7. Permission classifier RED on the repository's real database role-denial messages, then GREEN after recognizing those typed replica rejections. Unknown remote errors remain unknown and their bodies are withheld.
8. Rust whole-workspace run: 851 passed, 0 failed, 3 intentional ignored. Latest focused run after bounded read-API additions: app212 + resolver3 + binary6 all passed. cargo fmt --all -- --check passed.
9. Fresh whole-change review dispatched against staged patch SHA256 2c4dc657946b78eed22d3f88bb854c974b27635306c2d2442433928b0211107e; findings pending.

## Limitations
No real model inference, installed app activation, production canister writes or user profile edits were performed for this change. New doctor checks inspect default payload locations; custom DSH output needs separate inspection. Existing broad held-out learning-quality release requirements remain in force. Local dependency symlink for DSH tests is not a deliverable and will be removed after validation.

## Review and validation checkpoint
Fresh reviewer identified six substantive issues: actual-caller retry binding, relative cwd double resolution, implicit legacy JSON overriding TOML in Codex, engine-only legacy recall, invalid table shapes, and doctor's infrastructure-failure exit code. Each was reproduced and fixed. Scoped verification accepted all six and found a DSH structured-error acknowledgment mismatch; that was fixed and verified with real SDK fixture tests, including retry and sanitized warning behavior.
Final checkpoint: workspace857 passed/0 failed/3 ignored; full CLI270 passed/0 failed/1 intentional live-transport ignore; Python57 passed; DSH7 passed; fmt/diff checks passed.
Parent portable-foundation commit7129f8df became available during implementation. This checkpoint is committed before integrating that completed parent to preserve both implementations and validate their composition. No model/profile/production activation performed.

## Integration with completed portable foundation
Parent7129f8df was merged after checkpoint9ffb857f. Conflicts were composed rather than discarding behavior: parent project identity, scoped reads, durable CLI hook intake, redaction and finite jobs remain; common runtime TOML and safe setup/doctor remain. Python learning queue code from the checkpoint is superseded by the parent's thinner CLI-only transport. Old queue files are preserved, not automatically imported. Actual caller checks and unknown-principal retention now use the CLI's pinned-project inbox protocol.
Read-only Git metadata discovery replaces external git processes so doctor never executes helpers, while preserving primary-checkout identity sharing. The common resolver understands both versioned project JSON and unversioned legacy recall. TOML can change runtime parameters but cannot change project identity/scopes/enablement. Automatic evaluation keeps explicitly pinned runner/policy snapshots, which retain their explicit-input priority.
Integration regressions cover TOML override of a portable budget/model while preserving project scopes, runtime configuration changes partitioning durable intake, two-project real SQLite hooks, relative cwd, and non-executing Git discovery. Focused merged Rust237+resolver6+binary9+portableCLI2 pass; Python50 and DSH8 pass. Full merged verification and scoped integration review pending.


## Final integration review and verification
Fresh scoped review found two integration regressions: the legacy DSH setup alias replaced an existing launcher, and doctor omitted portable destination/principal binding checks. Both regressions were reproduced, fixed, and verified. Doctor now reports connection mismatch, caller mismatch and unavailable caller separately. The reviewer also noted that the older adapter routing guard followed intake/replay; requests carrying that guard now wait for actual caller verification before either operation. A missing-identity binary regression confirms that such a request creates no intake directory. Scoped rereview found no remaining substantive issue.

Final source verification (2026-10-15):
- `cargo test --workspace --quiet`: 888 passed, 0 failed, 3 intentional ignored (42 suites; exit 0).
- One additional binary regression was added while the workspace run was executing. Final `cargo test -p kinic-vfs-cli --test agent_entrypoints --quiet`: all 12 passed, including that regression. No production code changed after the full run began.
- `PYTHONPATH=plugins/runtime python3 -m unittest discover -s plugins/runtime/tests -v`: 50 passed.
- `node --test plugins/dsh/tests/*.test.mjs`: 8 passed with the real SDK and disposable fixture subprocesses. Temporary dependency symlink removed after verification.
- `cargo fmt --all -- --check`, unstaged/staged `git diff --check`: passed.

The completed parent7129f8df is included in this branch; checkpoint9ffb857f remains recoverable. Source and documentation are retained in the managed worktree. Stage A is delivered; status/probe/index work remains deferred by the reviewed proposal. No production deployment, actual model inference, active app/profile changes, main-branch integration or push was performed by this change.
