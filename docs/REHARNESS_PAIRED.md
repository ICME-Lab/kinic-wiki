# Matched-history revision experiments

`kinic-vfs-cli learn paired` is a local-canister research command for arbitrary
caller-supplied project suites. It complements the sequential `learn stream`:
all scored decisions start from fixed predecision evidence, so one arm's failures
cannot become another arm's learning input. Plugins continue to use the CLI.

## Intervention and controls

Supply the existing evaluation suite format and a JSON map from task ID to:

```json
{
  "task-id": {
    "selected": [
      {
        "id": "prior-task-id",
        "query": "the previous task",
        "original": {"observations": "public original evidence"},
        "reflection": "the frozen reflection"
      }
    ],
    "latest": {"observations": "public evidence observed before the scored task"},
    "new_reflection": "one shared reflection of the latest observation"
  }
}
```

The caller freezes selection IDs/order, original sources and the new reflection.
The CLI independently revises each selected reflection using the same paper-style
source-grounded prompt as `learn stream`. It does not feed evaluation prompts,
verifiers or scored outcomes to revision generation. The caller must still ensure
historical evidence predates the scored task; timestamps/semantic provenance are
not independently attested. Inputs are redacted before use and archived exactly
as used. Annotation or final-evaluation answers must never be included in histories.

| Standard report mode | Paired meaning |
|---|---|
| none | No supplied memory |
| raw | Same selected original sources and latest observation |
| current | Frozen reflections plus the fixed new reflection |
| revision | Revised reflections plus the identical fixed new reflection |

The causal comparison of interest is **current versus revision**. It measures the
direct effect of replacing old reflections, excluding effects on how a later
forward reflection is written or how future retrieval histories evolve. Revisions are
independent of each other and generated once per task, then reused across decision
trials. This estimates decision variation conditional on those generated revisions;
it does not estimate independent revision-generation variance. Every decision gets
a new Git archive and execution home. Mode order rotates by task and trial pair,
and reverses for odd trials. Even trial counts exactly reverse relative arm order
within each task; odd counts leave an imbalance, explicitly visible in sample order.

All arms have the same byte ceiling. Overflow rejects the experiment without
truncation; actual context lengths may differ. This is a common ceiling, **not**
token-matched input. The revised arm can therefore change content and length.
Token usage and elapsed time must be reported separately. No exact-rule-store
fifth arm is implemented yet.

## Running

Prepare the optional synthetic fixture:

```sh
python3 evaluation/reharness/paired_fixture.py prepare --output /absolute/new-fixture
kinic-vfs-cli <local connection arguments> learn paired \
  --suite /absolute/new-fixture/suite.json \
  --histories /absolute/new-fixture/histories.json \
  --runner-file /absolute/runner.json \
  --isolation-config /absolute/isolation.json \
  --project-id 00000000000000000000000000000001 \
  --experiment-id unique-paired-run \
  --output /absolute/new-run --trials 2 --max-context-bytes 65536 --json
```

The endpoint must be loopback, the model explicit, and output/experiment ID new.
Before inference, the CLI reserves canonical canister state. It stores exact input,
context and report payloads in content-addressed chunks. Completed/uncertain IDs
cannot be rerun automatically; inspect evidence and use a separately labeled new
experiment for an intentional retry. Partial work remains reserved on error.
No knowledge publication, candidate promotion or ordinary agent session changes
occur. Revision failure diagnostics use the existing bounded `failure.json` format.

Real paired execution currently requires **macOS**, Python 3 on PATH, and an isolation configuration.
The wrapper sources are embedded from the CLI crate’s packaged assets; repository
entrypoints delegate to those same sources.
Codex example (paths must exist):

```json
{
  "engine": "codex",
  "launcher": ["/absolute/runtime/codex"],
  "auth_source": "/absolute/private/auth.json",
  "invocations_root": "/absolute/owned-invocations",
  "trusted_read_roots": ["/absolute/runtime", "/absolute/python-runtime"],
  "tool_bin_dirs": ["/absolute/python-runtime/bin"]
}
```

Launcher must match the pinned runner executable. Auth must be owner-only. The
wrapper copies only auth into a fresh private home; no prior sessions or normal
profiles are copied. It denies reads/writes outside the current workspace, fresh
invocation and trusted/system runtime roots. Broad ancestor roots and workspaces
inside implicitly readable system roots are rejected. Network and file metadata
remain allowed: this is a local file-content boundary, not an adversarial network
sandbox. Trust roots must contain runtimes, not task answers. Codex inner sandbox
is disabled only inside this mandatory outer boundary to avoid nesting seatbelt.

For DSH, use `engine: "dsh"`, the raw runtime launcher and the credential/module
fields documented in [DSH isolation](../evaluation/reharness/DSH_ISOLATION.md).
The same shipped DSH wrapper establishes fresh credentials/profile/session storage.
The first launcher executable must match the runner; extra launcher arguments may
identify its CLI entrypoint. DSH paired quality has not been measured in this pass.
Unsupported platforms fail closed; adding another containment backend remains work.

`--unisolated-test-only` is an explicit alternative for offline scripted plumbing
fixtures. It cannot be combined with isolation config. Such reports carry
`quality_eligible: false`, and CLI comparison rejects them. New reports use schema
2 so older binaries reject instead of silently dropping this restriction. New
readers retain schema-1 compatibility; the flag is a pipeline restriction, not
cryptographic proof that an arbitrary supplied report or model is genuine.
`quality_eligible: true` merely permits comparison; it does not authorize promotion.

## Fixture and grounding audit

The fixture has billing rounding and cache TTL families, each with partial change,
return-to-old-release and six irrelevant memories. Both families keep other fields
unchanged. All necessary evidence exists before scoring. Seven memories are supplied
in the distractor case deliberately: this tests interference at a fixed selection,
not top-5 retrieval accuracy. The external oracle is outside the task Git archive
and reports test outcomes without teaching rules to subsequent decisions.
These hand-authored histories contain intentionally overbroad scoping and a false
pass count. They are stress fixtures, not naturally collected production histories
or the paper's complete benchmark. Both families are validation only; no disjoint
final-set release decision is possible from this fixture alone.

`grounding.py` scores independent annotations of reflection claims. Supply a map
of memory IDs to `reflection` and `original`, and annotation rows with `memory_id`,
exact `quote`, `verdict` (`supported`, `contradicted`, `unverifiable`),
`evidence_pointer` (JSON pointer into original), and `rationale`. It validates
anchors, rejects duplicates and reports counts/unannotated memories. It does not
pretend to verify a human verdict or annotation exhaustiveness; no annotation is
not a passing score. Audit originals and revised reflections separately, ideally
blinded and with independent adjudication. Do not use an agent's own success claim
as evidence of factual correctness.

## Verification scope

Regression tests cover fixed shared reflection/IDs, exact originals, duplicate
selection and over-budget rejection, two-trial mode order, no replay after reserved
execution, canonical context restoration, test-only comparison rejection, partial
changes/old environments and annotation anchors. Actual macOS boundary tests deny
parent histories, other contexts, sibling answers and prior invocation auth while
allowing the current task file. Scripted integration validates plumbing only;
real-model results and their limitations are recorded separately.

Completed pilot: [results and limitations](REHARNESS_PAIRED_RESULTS.md).

## Selective revision research policy

`learn paired --revision-policy selective` adds one isolated selection invocation
per task history before revision. Its response is a single JSON object containing a `selection`
array; nested JSON strings are rejected. Default `all` preserves the paper-style baseline.
The selector receives only the selected original evidence/reflections and latest
evidence, not the scored task or verifier. It returns every memory ID once with
`keep`, `revise`, or `uncertain`, a short reason, and exact JSON-pointer evidence
anchors. Unknown/duplicate/missing IDs, absent citations and malformed responses
abort the experiment. `uncertain` triggers revision. Kept reflection bytes, memory
order and the shared new reflection stay unchanged. Anchors validate provenance,
not the truth of the model's interpretation.

The canister reservation binds the policy. `selection_calls` records detector
usage/time/output and `selections` records validated decisions before any revision;
`revision_calls` records only executed revisions. Parsed but invalid selection choices remain
in canonical state with a pending reservation. Malformed outer/inner JSON is
omitted; available execution usage/time and rejection status are retained, with
a sanitized local failure diagnostic. A launch failure has no execution usage to
record. Uncertain experiments never replay.
Selection plus revision cost is the policy overhead. Report `revision` means the
policy chosen for that experiment; retain `paired.json` with the standalone report.
Comparing different policy runs is observational across runs, not a randomized
fifth arm. Promotion is not enabled by this research policy.

`evaluation/reharness/selection_score.py --labels LABELS --state paired.json`
computes false negatives (missed required revisions), false positives (unnecessary
revisions), precision and recall against complete independent boolean labels.
Labels must be frozen before inference and never supplied to the agent. The
committed `results/selective-labels-v1.json` covers the existing six synthetic
histories: six seeded contradictory/overgeneralized targets and twelve supported
unrelated distractors. These labels are not an exhaustive natural-data truth audit.

Completed selective-policy results, interruption accounting and adoption limits:
[selective pilot](REHARNESS_SELECTIVE_RESULTS.md).
