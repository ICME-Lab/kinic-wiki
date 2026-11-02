# Matched-history pilot results — 2026-10-16

Implemented [the portable paired protocol](REHARNESS_PAIRED.md) and completed a
real Codex pilot: six tasks, two decision trials, four modes, 48 decisions and
18 prior-memory revision invocations. No execution was interrupted. The model was
`gpt-6.1-sol`, high reasoning, with a 180-second per-invocation timeout. DSH was
not retried after its previously confirmed balance exhaustion.

## Outcome

| Context | External task success | Decision agent invocations | Decision seconds |
|---|---:|---:|---:|
| None | 0/12 | 12 | 364.1 |
| Original evidence | 12/12 | 12 | 365.5 |
| Frozen reflections + shared new reflection | 12/12 | 12 | 388.5 |
| Revised reflections + identical new reflection | 12/12 | 12 | 422.1 |

Both billing and cache families yielded 6/6 for each memory mode and 0/6 without
memory. Within each family, partial rule changes, return to the old release and
irrelevant-memory interference each passed both trials for all memory modes.
The external checks, allowed-change scope and completed execution determine task
success; the agent's final claim does not.

Backward revision added **no observed task-success gain** over frozen reflections.
All memory baselines saturated these fixtures. This is a measured tie on these
controlled tasks, not evidence of equivalence on general development work or a
proof that revision is useless. The comparison gate correctly reports
`eligible: false`: only two task families are present, and the observed delta is
zero. Its degenerate zero-width bootstrap interval describes this saturated
sample; it does not establish certainty about unseen families.

## Factual correctness changed despite tied task success

Each target's frozen reflection deliberately included the false claim that one
of five checks passed; its original fixture explicitly contains five false
results. All six generated target revisions corrected that count. They also
restricted guidance to the source release instead of applying it to every future
release, based on inspection of the generated text.

The [anchored factual-claim audit](../evaluation/reharness/results/paired-grounding-2026-10-16.json)
records the exact count claim, original evidence and annotation: frozen has six
contradicted count claims; revised has six supported count claims. This is a
non-blinded audit of **one seeded claim per target**, sharing two underlying
synthetic sources. Twelve distractor reflections were not annotated. It is not an
exhaustive grounding audit or six independent sources, and does not demonstrate
repair of the earlier naturally occurring DSH error.

Thus factual correctness and downstream task success need separate metrics. These
results support retaining the ability to revise demonstrably false lessons, while
providing no success-rate evidence for mandatory revision on every retrieval.
Prioritizing revisions when evidence contradicts a claim or its applicability is
a promising next design to compare, not a proven optimal policy.

## Additional work and representation size

The 18 revision invocations consumed 215.494 aggregate agent-execution seconds,
262,317 reported input tokens and 5,750 reported output tokens. Decision trials
reuse those generated revisions; generation was not repeated for each trial.
Common historical/new reflections were supplied fixtures, so their generation
cost is absent from every arm.

Summed once per each of the six tasks, supplied contexts contained:

| Context | UTF-8 bytes |
|---|---:|
| Original evidence | 4,572 |
| Frozen reflections | 3,618 |
| Revised reflections | 12,325 |

Revised contexts were about 3.4 times the frozen size. The common byte ceiling was
65,536; no arm was truncated. This compares the intervention as produced, not
length-matched text. Invocation counts are **not provider API request counts**.
Token counters include provider-reported usage and caching semantics; no dollar
cost or controlled latency advantage is claimed. Full counters are retained in
[the sanitized machine-readable result](../evaluation/reharness/results/paired-pilot-2026-10-16.json).

## Controls and limits

- Selected IDs and order matched exactly between frozen/revised arms. The new
  reflection was byte-identical. Context hashes remained fixed across trials.
- Original histories and generated contexts were fixed before any scored decision;
  no scored feedback was used to generate another arm's memory.
- Every decision used a fresh source archive and invocation home. A mandatory
  outer macOS boundary denied reads of other contexts, histories and sessions.
  Local adversarial file-read fixtures verified denial. Network and metadata
  remain allowed; this is not an adversarial network-isolation proof.
- Odd trials reverse arm order; rotation spreads positions across tasks. Assignment
  is deterministic, and agents were not blinded to arm names in workspace paths.
- Revision generation occurs once per task. Repeated decisions are conditional on
  those revisions; they do not sample revision-generation uncertainty.
- These are synthetic predecision histories and two validation families. Seven
  selected memories in the distractor case test interference, not retrieval recall.
  No held-out final family, exact-rule-store fifth arm, full paper benchmark or
  actual-project repair advantage has been established.
- The measured executable was preserved before report-schema-2 and packaging
  follow-ups; its SHA256 is in the result JSON. The recorded schema-1 quality
  report remains labeled as measured, rather than being rewritten as a new run.
  Final source emits schema 2 and rejects test-only reports in comparisons.

## Persistence, implementation and verification

Canonical local canister state completed successfully. Readback reconstructed and
hash/length-checked all 23 referenced chunks: histories 8,321 bytes, contexts
24,017 bytes and report 1,355,718 bytes. Parsed payloads exactly matched local
artifacts. The output retains all failed stateless decisions; no result was retried
to improve the aggregate.

Implementation commits: `62b44dc9` adds matched-history execution and control
checks; `47e241c8` packages isolation scripts inside the CLI crate. Review found and
fixed parent/sibling read contamination, test-only restrictions lost from standalone
reports, implicit system-readable directory exposure, and old-reader acceptance of
restricted reports. Focused re-review had no remaining actionable finding.

Verification for this change:

- Rust workspace: 897 passed, zero failed, three ignored.
- Python: 26 passed in the existing embedding environment. The default Python
  lacks torch; that environment's full-suite invocation failed import and was
  rerun successfully with the environment owning that dependency.
- After asset relocation: paired integration and Python suite passed; package file
  listing confirmed both embedded isolation scripts. Formatting/diff checks passed.
- Real local-canister scripted run: 48 decisions completed. A separate schema-2
  smoke run completed eight decisions and its standalone report was rejected for
  quality comparison. Neither is a real-model quality result.
- Strict Clippy was attempted and reported 18 existing findings in the retained
  research branch, outside the added paired implementation. A clean Clippy gate
  is not claimed.

Private artifacts remain under `.superpowers/research/reharness-2610.12668v1/`:
`paired-v1-fixture`, `paired-codex-v1`, `paired-codex-invocations`,
`paired-plumbing-v1`, and `paired-report-v2-smoke`. Credentials and raw transcripts
are not published. Other concurrent worktree edits were left untouched and are
not covered by the verification totals above.
