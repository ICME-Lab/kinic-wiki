# Continual learning evaluation

`eval run` compares `none`, `raw`, `current`, and `revision` using the same task,
runner configuration and trial number. Supply an immutable suite manifest and
explicit per-task/per-mode contexts (`snapshot_id`, `content`). `none` must have
empty content. Every run uses a new output directory. The evaluator persists
`manifest.json`, `contexts.json`, `report.json` and each `sample.json`; retain these
as evidence, including failures. Costs and missing token counts remain null.
Credentials explicitly supplied through runner environment are redacted from
reports, event strings, check output, manifests and contexts. Task environment
variables must not contain credentials.

Each sample exports exactly `start_commit` through `git archive`, then initializes
one local baseline commit. It receives neither source history nor remotes, host
uncommitted changes, oracle files, or later solution commits. Every task, mode and
trial gets a separate source directory and HOME/TMPDIR. The runner and verifier
inherit only explicitly configured environment values plus PATH. Set CODEX_HOME
or a DSH-specific configuration location explicitly when a live authenticated run
needs it; do not change the user's active profiles. No fixture invokes paid agents
by itself. Set CARGO_HOME explicitly to an existing dependency cache and RUSTUP_HOME
to an installed toolchain when Cargo is supplied by rustup for the offline
historical verifier. Its Cargo target directory and harness remain outside
the agent workspace.

A suite's `verification` is a list of executable/argument arrays, never shell
command strings. `{workspace}` is expanded by the evaluator. Call
`SuiteManifest::resolve_paths(manifest_directory)` before running: it resolves
relative `repo` paths and `{suite_dir}` for external verification programs. Checks
run only after the agent exits, with bounded output and time. Source changes are
hashed before verification independently of mutable Git metadata, including
ignored/untracked files, deletes, permissions and symlinks. Any changed path
outside `allowed_paths` fails the sample. Success requires a complete agent
execution, every verification check passing and scope compliance.

This provides reproducible workspace and environment separation. It does not
create an OS security boundary for an unrestricted external runner: use the
runner's sandbox or an external container when evaluating untrusted agents.
Verification scripts are trusted executable suite inputs. Do not grant an agent
host filesystem access to held-out oracles or a solution checkout. Keep output
and verification artifacts outside the agent's writable source directory.

`compare_reports(previous, candidate)` pairs previous `current` with candidate
`revision` on validation tasks only. `compare_modes` also supports descriptive
four-mode and final comparisons. Runtime configuration, source trees, normalized
environments, executable/oracle file fingerprints, task/trial pairs and suite fingerprints must match. Results use a
deterministic 10,000-replicate family-cluster bootstrap with equal family weights,
95% percentile interval and seed `0x4b494e49435f4556`. At least three independent
families and six pairs, a strictly positive lower bound and no family regression
are necessary for promotion eligibility. These are conservative decision rules,
not a claim that three families provide strong generalization evidence. Record
additional families for consequential decisions. An empty or small dataset is
never eligible. A family cannot cross train/validation/final splits. Final results
are always ineligible and must remain a one-time held-out report; never feed their
failures or oracle contents into candidate generation. The promotion layer must
also enforce source evidence, the exact candidate snapshot and approval policy.

## Historical golden task

`golden-suite.json` reproduces the real Kinic node-mutation Candid decoding bug.
The immutable buggy source is `b378316dd8ae9cdd8d475e858062cf5a5b57deff`, the parent
of historical fix `194bd03bc8791a1072b73b1681888f298690c4ed`. Provenance comes from
`git show 194bd03b`, not an invented historical run. The task checks all five enum
variants, structured errors, nested Result responses and unchanged snake_case
JSON serialization. The verifier is external to the exported historical source;
the fixture includes no solution patch. It is assigned to `final`, so this single
task cannot establish improvement or authorize publication. The historical fix
commit is provenance for reviewers and is never included in an agent prompt.
The public Rust dependency cache must contain the verifier dependencies because
verification uses Cargo offline mode. Missing caches fail explicitly.

## Synthetic categories

`synthetic_cases.json` covers stale advice, an environment mismatch, conflicting
sources, generalization beyond a memorized example, irrelevant retrieved evidence,
and absent success evidence. These are authored test cases and illustrative
knowledge contexts, not historical observations or measured learning outcomes.
Prepare a source-only suite in a new project-local directory:

```text
python3 evaluation/continual-learning/prepare_synthetic.py ./evaluation/synthetic-run-input
```

The generated `suite.json` pins its tiny repository's source commit and references
an external behavioral oracle. `contexts.json` supplies four explicit snapshots.
Two categories are train, three are validation and missing evidence is final;
family IDs are disjoint across splits. The generated repository contains only
`policy.py` and README, without the cases, contexts or verifier. Use at least two
trials to exercise the comparison mechanics; synthetic results only validate the
pipeline and do not demonstrate production task improvement.

Local Rust tests use disposable fake executable agents and ordinary subprocesses;
they check archival isolation, all four modes, environment clearing, scope rejection,
unknown cost, deterministic intervals, matched trials, insufficient evidence,
regressions and the final-split promotion barrier. No paid agent calls are made.

## Real canister verification

`pnpm --dir pocketic-tests test:learning-revisions` builds both the current canister
and the immutable pre-learning `a76234cfccd2d29264d923b71bcfaa030879586a` Wasm from
an isolated Git archive. It runs PocketIC checks for identity across edit/move/delete/
recreation, historical snapshots and pagination, caller authorization, guarded
atomic publication and rollback, protected human content, replay after restart,
same-module upgrades and an actual old-schema to new-schema migration. The old
schema contributes exactly one honest snapshot of the content present at upgrade;
pre-upgrade edits do not become fabricated history. The baseline build is offline
and uses a separate target directory to preserve the current compiled packages. Set POCKET_IC_BIN to an installed
compatible PocketIC binary if the harness default is unavailable. No network
canister or production deployment is involved.
