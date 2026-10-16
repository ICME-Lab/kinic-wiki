# Agent status execution evidence

Plan: 2026-10-16-agent-status.md; selected workflow a1cf9738-5e80-40bd-88b0-6ce259d50be5.
Human accepted minimum status with では実装してみて on 2026-10-16; scope is section7/B of the existing configuration/diagnostics proposal, not probe/refresh/index.

## Integration
Base f734cecb; completed parent correction14e47597 composed as e0d9387c. Shared TOML/optional JSON precedence and existing routing guards retained alongside explicit config propagation, transcript snapshots and pinned job/evaluation bindings. Library243 tests passed. Imported portable binary test depended on the old fingerprint implementation; changed to inspect accepted intake/config/principal. Portable binary3 passed.

## Status RED/GREEN evidence
- Missing command: two binary tests failed on unrecognized status; early dispatch/empty-state/cwd tests then passed.
- Read-only real SQLite evidence tests failed before readers existed. Added scoped project/principal attribution, receipt versus delivery distinction, job state/references, sanitized errors, missing/corrupt/locked/WAL handling. Six passed after implementation. The first lock fixture accidentally closed a DB descriptor after BEGIN EXCLUSIVE, releasing POSIX locks; fixed fixture to snapshot before acquiring its lock.
- Explicit external project engine selection and unattributed events failed, then passed. Unknown attribution cannot become a false exact zero. Invalid configuration stays sanitized/partial.
- Real CLI hook intake tests cover current partitions and configuration changes, distinct record/input counts and unchanged filesystem. Human display test failed on opaque JSON lines, then passed after concise labeled output. Stdin test reproduced a blocked input read; status now rejects stdin without waiting.
- Real stored identity mismatch and malformed/oversized database rows retain safe partial results and unchanged files.

## Review fixes
Fresh independent review of immutable patch2547064b found three Important issues. Each was reproduced by binary regression and fixed:
1. Nonportable runs use their actual cwd: status now resolves their workspace root and excludes independent nested projects.
2. Bounded database reads did not bound startup config/identity reads: shared regular-file 8MiB reader now covers config parsing/hashing, connection TOML, portable JSON, Git markers and diagnostic identity files. Oversized TOML and FIFO tests failed before and passed after. Ordinary-sized inputs preserve behavior.
3. A bad engine intake source erased other results: per-engine errors now retain readable entries and mark aggregate partial. A file replacing one engine directory reproduced the issue.
Additional local ruling: supported engines must be inspected even without a runner table, because thin hooks can legitimately submit input before runner configuration. Real Codex+DSH intake regression verifies both; no combined total.
Fixed patch f028b1644981eb27e4d0987f802092cea4b3139cd09fc96f83080f103e24b492 passed scoped rereview with no new actionable findings. A final reader-only adjustment forces reverse rowid traversal and connection-local in-memory temporaries, preventing read-only queries from spilling temporary files to disk. All19 status tests passed afterwards; narrow review approved the adjustment with no new blocking finding. The rowid traversal can scan other scopes; limits bound returned bodies, not total database pages read.

## Rulings and scope
- No new state machine, indices, failure/timestamp records or remote caches. Missing timestamps stay null; file mtime is storage metadata only.
- Active SQLite WAL/shm/journal sources remain unknown to avoid mutating sidecars or reading incomplete checkpoints. Closed/checkpointed WAL uses immutable URI; rollback mode uses read-only locking with100ms timeout.
- Existing records/jobs provide local evidence, not global publication proof, live process health, model connectivity or quality improvement. Context assembly does not prove delivery/adoption.
- Reads are capped4096 rows/inputs,1MiB/body,16MiB of returned bodies/source; exact counts withheld when truncated, malformed or unattributed. Current cwd/config inbox partitions only; old partitions and deprecated Python queues explicitly excluded.
- No production deployment, model calls, active profiles, main integration or push. Existing managed worktree retained. DSH temporary dependency symlink removed after verification.

## Verification
Initial full workspace before review fixes:908 passed/0 failed/3 intentional ignored.
After review fixes: status binary19 passed/0 failed; workspace914 passed/0 failed/3 intentional ignored. The final SQL temporary-storage adjustment passed binary19; delivery workspace verification passed:914 passed/0 failed/3 intentional ignored (43 suites, exit0), after the final adjustment.
Python runtime50 passed; DSH real-SDK adapter8 passed. Formatting and whitespace checks passed before final staging.


## Delivery verification
`cargo test --workspace --quiet`:914 passed/0 failed/3 intentional ignored (43 suites; exit0), including status binary19.
`PYTHONPATH=plugins/runtime python3 -m unittest discover -s plugins/runtime/tests -v`:50 passed.
`node --test plugins/dsh/tests/*.test.mjs`:8 passed using the real SDK and fixture subprocesses; temporary dependency symlink removed.
`cargo fmt --all -- --check` and staged/unstaged whitespace checks passed. Fresh whole-change review, fix rereview and final SQL adjustment review have no unresolved blocking findings. Stage B implementation complete; branch/worktree retained for owner integration. Main and installed CLI unchanged. Conditional probe/refresh/index work remains deferred.


## Requested review corrections — 2026-10-16
Human requested review, then explicitly 対応して for all3 findings at base e8b3b39c. No scope expansion or new design decision required.
1. Same custom run ID in two projects selected the other project's receipt/count. Real SQLite binary regression failed, then passed after requiring a unique consistent run owner; conflicting owners and inherited unowned observations are quarantined.
2. Deleted/unresolvable legacy repository had been treated as known ownership, yielding observed0. Binary regression failed, then passed with unresolved ownership propagated to unattributed/partial evidence and unknown exact counts.
3. Legacy --recall-config - failed canonicalization before identity; after that it would reread stdin during project/options resolution. Binary regression failed at ENOENT before fixes. Run/Recall now capture one bounded JSON value before connection setup, reuse it through the resolver and runtime helper, and avoid creating a temporary config/policy. Prepared-value precedence/repeated-resolution and real StoreClient recall tests pass. Portable v2 stdin and simultaneous runner/recall stdin remain explicit errors; status's non-reading stdin rejection is preserved.
Focused CLI library/integration suites passed, including status21, config8, entrypoints14 and lib244; no actual external-agent run. Full workspace verification passed: cargo test --workspace --quiet, 920 passed / 0 failed / 3 intentional ignored, exit0. Fresh scoped static review found no actionable findings and approved the correction scope. No external-agent inference was run; unchanged plugin suites were not rerun in this follow-up. Immutable code patch399cd34b36dd389e12ba55b345d75fcd42b13e7a683828314f0919143dc95b5c sent to reviewer.


## PR packaging — 2026-10-16
GitHub push protection rejected the original history because commit7129f8df contains a synthetic Slack-token fixture in a redaction test. No protection bypass was used. Original feat/agent-config-diagnostics and its commits are preserved. PR branch feat/agent-learning-cli starts at origin/main and collects the same final tree via squash; its only code difference is constructing that synthetic token with concat! in the test source. Production code is unchanged. The focused redaction suite and format/whitespace checks verify this fixture-only adjustment; full workspace920/0/3 refers to the preceding identical production tree.
