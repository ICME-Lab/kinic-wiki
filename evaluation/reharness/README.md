# ReHarness synthetic sequential pilot

This is a small synthetic pilot for diagnosing continual-memory behavior and
runtime costs. It is **not** CLBench, a reproduction of the paper's dataset, or
evidence of the paper's reported gains. Mock runner tests establish plumbing
only. The CLI report's `fidelity` field records implementation deviations.

Eight independent coding episodes share an initially undocumented deployment
contract. Tasks 1–4 use a legacy billing profile; tasks 5–8 switch explicitly to
a current profile with a new key namespace and a different decimal tie-breaking
rule. The billing kind varies within each profile. Every episode starts from the
same unsolved Git commit. The verifier emits authoritative profile conventions
on failure so later episodes can benefit from retained feedback. Exact rules are
intentionally absent from each task's checkout; this partial specification is a
controlled operational-memory probe, not a realistic general coding benchmark.

The fixture repository has one unsolved commit and only `README.md` and
`adapter.py`. No reference implementation, verifier, answer commit, or earlier
agent changes appear in its archive. The external verifier resides beside the
repository. This is a packaging boundary, **not an OS sandbox**: a runner with
unrestricted filesystem access could still inspect the external verifier. For
credible model measurements, enforce filesystem isolation that exposes only the
agent checkout and approved tools; audit agent traces for evaluator access.
Without that isolation, label results as cooperative-runner pilot results.

## Prepare and test

Run from the repository root. These commands use new explicit directories and
never create worktrees under `/private/tmp`.

```sh
python3 -m unittest discover -s evaluation/reharness -p test_pilot.py -v
python3 evaluation/reharness/prepare.py --output evaluation/reharness/runs/fixture-01
```

Preparation refuses to overwrite existing paths. It prints an absolute suite
path. Generated manifests contain absolute local paths, so regenerate them when
moving machines. Git object IDs may differ across preparations because commit
timestamps vary; one prepared manifest pins the identical source for all runs.

Embedding-server tests require the dedicated environment described in [EMBEDDING.md](EMBEDDING.md).

## Compare policies

Start the local canister and provide a runner file using the CLI's existing
runner format. Keep provider secrets in environment variables or protected
configuration; never place secret values in connection arguments. The helper
passes connection arguments directly to the CLI without shell interpretation.
Use the same runner/model, suite, retrieval mode, top-k and budget for every
policy. Supply the actual local connection flags supported by your CLI.

The helper is dry-run by default and does not invoke the CLI:

```sh
python3 evaluation/reharness/run_comparison.py \
  --cli target/debug/kinic-vfs-cli \
  --suite evaluation/reharness/runs/fixture-01/suite.json \
  --runner-file /absolute/path/to/runner.json \
  --project-id 00112233445566778899aabbccddeeff \
  --trials 3 --top-k 5 \
  --policies none raw append-only reharness \
  --retrieval lexical \
  --output evaluation/reharness/runs/plan-01
```

To execute, use a **new output directory** and append `--execute`. Each
policy/trial gets a unique stream ID and a separate output directory; the CLI
runs all eight tasks sequentially with remote memory persisting within that
stream. Policy execution order rotates between trials, while task order remains
fixed. Add connection flags as repeated `--connection-arg=VALUE` arguments;
for a flag and separate value supply two arguments. This helper does not start
background workers or invoke a live provider during preparation or dry runs.

For embedding retrieval, replace `--retrieval lexical` with
`--retrieval embedding --embedding-config /absolute/path/to/embedding.json`.
Lexical retrieval is an explicit approximation. Do not pool results across these
retrieval settings. Keep the embedding provider/model fixed across comparisons.

## Interpret results

`comparison.json` retains the trial/policy trajectory, stream IDs, fidelity
labels, task successes, CLI wall time, decision/revision/write phase durations,
model-call counts, and token totals when reported. Missing token accounting is
`null`, never zero. CLI failures and incomplete/malformed reports remain visible
and are excluded from success aggregates; report those failed trials separately.
Raw provider/CLI stdout and stderr are not copied into this comparison artifact.
The CLI's own output directory remains responsible for its own redaction.

Inspect success by task position: first exposure (1), legacy reuse (2–4), shift
(5), and current reuse (6–8). A single mean hides adaptation failures. Compare
memory-policy overhead using decision/revision/write time and total wall time;
phase timings are measurements of implementation phases, not pure model or
network time. Token totals are usable only when the provider reports them.
Repeat independent streams for variability and compare paired task outcomes.
Eight correlated episodes from one synthetic family cannot establish broad
quality gains, statistical significance, or paper-equivalent performance.

## Matched-history follow-up

Use [`learn paired`](../../docs/REHARNESS_PAIRED.md) to isolate backward revision
from new-reflection benefit. It fixes predecision history and the shared new
reflection, reverses arm order within trial pairs, requires file-read isolation
for real runs, and stores exact artifacts in the local canister. Synthetic
fixtures and independent claim-annotation scoring are included.
