# Selective revision pilot — 2026-10-16

Selective revision corrected the six seeded claims and achieved 12/12 task
successes, with fewer revision invocations than the previous all-revision pilot.
It did **not** improve task success over frozen reflections or raw evidence, both
also 12/12. This is an efficiency candidate, not evidence for enabling automatic
revision in production or for an optimal policy.

## Implementation and comparison

The portable CLI now accepts `learn paired --revision-policy selective`; the
default remains `all`. One isolated selector per history inspects original
sources, current reflections and latest evidence, classifying every selected
memory as keep/revise/uncertain with source anchors. Uncertainty triggers revision.
Kept bytes, selected IDs/order and the shared new reflection remain fixed. The
selector receives no scored task, verifier or labels. See
[the protocol](REHARNESS_PAIRED.md).

Real Codex used `gpt-6.1-sol`, high reasoning, 180-second execution limits,
macOS read containment and fresh invocation homes. Six tasks in two synthetic
validation families, two decision trials and four arms produced 48 completed
executions; no execution interruption occurred. Three cases per family cover
partial changes, returning to an old release, and six unrelated distractors.

Histories and all 18 none/raw/frozen control contexts exactly match the
[previous all-revision pilot](REHARNESS_PAIRED_RESULTS.md). Revisions differ.
Comparison to that pilot is across runs, with different binaries/times, not a
randomized fifth arm. Selection and revisions were generated once per history
and reused across decision trials.

| Measure | Previous all revision | Selective revision |
|---|---:|---:|
| Candidate task successes | 12/12 | 12/12 |
| Selector invocations | 0 | 6 |
| Revision invocations | 18 | 6 |
| Total preparation invocations | 18 | 12 |
| Preparation agent seconds | 215.494 | 168.133 |
| Preparation input tokens | 262,317 | 176,677 |
| Preparation output tokens | 5,750 | 4,492 |
| Candidate context bytes, one copy per task | 12,325 | 6,849 |
| Candidate decision agent seconds | 422.062 | 374.509 |

Preparation time was about 22% lower in this completed run; context bytes were
about 44% lower. Agent seconds exclude controller and canister persistence time.
Invocation counts are not provider API-request counts. Token usage includes
cached input; monetary cost is unavailable. Across-run timing differences do not
establish a general speed improvement.

Current-run successes: none 0/12, raw 12/12, frozen 12/12, selective 12/12. Each
memory arm scored 6/6 in each family. The frozen-versus-selective family-cluster
comparison has delta 0 and `eligible=false`: only two independent families and
no positive improvement. Its degenerate sample bootstrap interval [0,0] does
not establish population equivalence or non-inferiority. No final-set evaluation
or production promotion occurred. Frozen reflections avoid all preparation
inference and also passed, so this experiment does not justify always revising.

## Selection and factual correction

The [predeclared labels](../evaluation/reharness/results/selective-labels-v1.json)
were committed before inference and withheld from every agent. The six seeded
target occurrences require correction; twelve unrelated, supported distractors
do not. Selection produced TP=6, FN=0, FP=0, TN=12, uncertain=0. This evaluates
those labels only. The six positive occurrences share two original sources;
they are not six independent domains or a natural-data truth benchmark.

A manual, nonblind source audit confirms that all six revised target claims
correctly say all five original checks failed. Their release-1 requirements
remain scoped to release 1. The audit targets seeded count errors, not every
claim or every distractor. All twelve kept distractor reflections are byte-for-
byte identical to their frozen versions.

## Interrupted pilot and review fixes

The first selective attempt stopped on its fourth selector: a JSON string
encoding an array lacked the final closing bracket. It had four selector and
three revision invocations, zero scored decisions, 84.672 agent seconds,
103,033 input tokens and 2,395 output tokens. It remains an incomplete experiment
and was not replayed or included in task-success rates. This extra development
cost is separate from the completed-run preparation comparison above.

The corrected run requires a direct JSON array instead of nested JSON text and
uses a new experiment ID. There is no silent repair or automatic retry.

Fresh review found two issues: prose redaction could corrupt serialized JSON,
and invalid outer responses lost canonical usage. Structured field redaction and
an execution envelope saved before validation address them. Arbitrary malformed
text is omitted; available usage, completion and rejection status persist.
Launch failure has no execution usage to recover. A regression also reproduced
execution failure mislabeled as output validation; phase classification is now
correct. Pending reservations continue to prevent replay.

The accounting and phase regressions were observed failing before fixes. The
structured authorization-anchor case is covered by parser and controller tests;
the original regex corruption was reproduced in review. Final Rust workspace:
906 passed, 0 failed, 3 ignored. Python: 28 passed. Formatting and whitespace
checks pass. Strict Clippy still fails on 18 existing branch findings; it is not
a clean lint gate. No deferred findings from this scoped review remain.

## Evidence and decisions

The measured binary is from `0985d656`, SHA256
`54beffe49114b33ec748ba9338b391d10ffa1bb552fcae8515b6ba1bf0401b5c`.
`4ca9cb4a` subsequently corrects failure-phase diagnostics, with no successful-run
policy change. The all-revision baseline retains its original binary/schema;
we did not relabel it as a new run.

Local-canister readback verified all 22 payload chunks, their lengths/hashes,
assembled hashes and parsed equality with local histories (8,321 bytes), contexts
(18,459 bytes) and report (1,249,120 bytes). State including selection decisions
and usage also exactly matches the local final state.

- [Sanitized metrics, decisions, comparison and canonical proof](../evaluation/reharness/results/selective-pilot-2026-10-16.json)
- [Anchored target-claim audit](../evaluation/reharness/results/selective-grounding-2026-10-16.json)

Rulings: retain the four-arm evaluator and compare policies across runs, at the
cost of weaker causal attribution; replace nested JSON with a direct array after
observed failure, with interrupted-run cost retained; treat seeded-label results
as limited evidence and keep automatic adoption disabled. Review did not judge
model quality while the pilot was running, natural-data label truth, or unrelated
historical branch behavior. Completed measurements support only the claims above;
whole-workspace regression tests do not replace a new review of unrelated code.

Next discriminative tasks should make incorrect operational instructions affect
code correctness, use disjoint projects/families and separate held-out cases.
This pilot's shared latest evidence lets frozen reflections pass despite seeded
reporting errors. Both quality gains and selection misses need evaluation under
that harder condition before selecting a default policy. DSH was not retried
after the prior balance-exhaustion result. Worktree and private evidence are
retained; no push, merge, production activation or ordinary DSH-session changes.
