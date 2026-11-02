# Local ReHarness experiment results — 2026-10-16

Machine-readable [sanitized results](../evaluation/reharness/results/local-pilot-2026-10-16.json)
retain all completed and interrupted trials.
The subsequent [failure and revision-effect investigation](REHARNESS_INVESTIGATION.md)
corrects diagnostic interpretation and explains the pilot’s limited discrimination.
The legacy `model_calls` field counts agent invocations, not provider API requests.

## Scope and reproducibility

This is a local implementation and diagnostic pilot, not a reproduction of the
paper's benchmark scores or proof of an optimal design. The generic CLI accepts
caller-supplied project/task manifests; this repository is the implementation
host, not the only project that can use it. Plugins continue to invoke the CLI.

The experiment uses a real local Wiki canister and the original
Qwen/Qwen3-Embedding-8B weights at revision
`1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` (all four upstream weight-shard
checksums verified). Query-to-query cosine top-5 retrieval is fixed. The local
runtime uses MPS fp16 weights and fp32 normalization. The running endpoint
predates the newer server provenance response; checksums and runtime provenance
were recorded separately. The CLI does not cryptographically attest endpoints.

Paper PDF/HTML and a pinned CL-Bench codebase/database subset (46 files,
765,905 bytes, upstream commit `5f8c50eb1e84b2eda2ef4faff757dfc812a0ea26`)
are stored locally. Full paper benchmark environments were not downloaded or run.
The protocol follows independent backward revisions from immutable original
sources followed by forward reflection writing. Figure 5 prompts are adapted,
public evidence is redacted and projected, and the paper's factual-claim grounding
audit has not been reproduced. See [fidelity details](REHARNESS_EXPERIMENTS.md).

The eight synthetic billing-adapter tasks deliberately omit conventions, provide
external failure feedback, and switch profiles at task five. This isolates
cross-task feedback retention but strongly favors memory over a stateless agent.
There is one task family and one trial per mode; tasks are dependent observations.
No statistical significance, general coding gain, or task-family confidence
interval is claimed. Raw is Top-K Raw; append-only is a local no-revision ablation,
not a claimed RBank reproduction. A current-production gated-policy comparator
has not been run in this strict-online pilot.

Models and budgets are fixed within each engine: Codex `gpt-6.1-sol`, high
reasoning, 180-second invocation timeout; DSH
`deepseek-official/deepseek-v4-flash`, 360-second invocation timeout. All three
roles share that engine's runner. Across-engine budgets and models differ.
Policies ran concurrently, so observed wall time is not a controlled standalone
latency benchmark. Usage is provider-reported; cost is unavailable.

Codex trials use preserved baseline `8f8f47ec` (binary SHA256
`d2de6001697eed67ea53872901fc9ded9f3591a911d55de046dc9a86f01a0490`).
Contained DSH trials use stream code `3ec365e8` and wrapper `21d4a874`.
Both predate `255bce09`: on the first raw task the supplied context was `[]`,
whereas the other policies had empty context. This adds a wrapper to the raw
cold start and is a comparison limitation. The regression is fixed and tested
in current source; these trials have not been relabeled as post-fix runs.

## Codex completed pilot

| Policy | External success | Agent invocations | Observed wall seconds | Decision seconds | Revision seconds | Write seconds |
|---|---:|---:|---:|---:|---:|---:|
| none | 0/8 | 8 | 811.0 | 625.9 | 0.0 | 0.0 |
| raw | 6/8 | 8 | 539.8 | 341.9 | 0.0 | 0.0 |
| append-only | 6/8 | 16 | 669.8 | 361.3 | 0.0 | 106.2 |
| reharness | 6/8 | 41 | 1199.3 | 332.9 | 516.3 | 129.0 |

All three memory policies failed tasks 1 and 5 and passed the remaining six.
The stateless policy failed all eight. Feedback retention helps this deliberately
partially specified task, but recurrent revision added no observed success over
raw retrieval or append-only reflections. Its 25 revision invocations consumed 516.3
seconds in aggregate; the matched outcome does not justify selecting it as the
production default. Concurrent wall times do not establish a latency speedup.

The final supplied context was 25,311 UTF-8 bytes for raw, 6,866 for append-only,
and 14,104 for ReHarness. Reflections compressed these trajectories, but revision
also expanded the reflections compared with append-only in this trial. This is
a measured tradeoff, not evidence that a shorter representation is always better.

## DSH completed and interrupted trials

| Completed policy | External success | Agent invocations | Observed wall seconds | Decision seconds | Revision seconds | Write seconds |
|---|---:|---:|---:|---:|---:|---:|
| none | 0/8 | 8 | 1597.2 | 1532.2 | 0.0 | 0.0 |
| append-only | 6/8 | 16 | 679.6 | 463.7 | 0.0 | 126.2 |

The remaining trials are not complete and have no aggregate success-rate claim:

| Trial | Fully checkpointed steps | Successes within those steps | Stop |
|---|---:|---:|---|
| raw-03, old persistence | 6 | 4 | State size limit |
| ReHarness-03 | 6 | 3 | Incomplete memory-agent execution |
| raw-04, repaired persistence | 4 | 3 | Provider QUOTA / HTTP 402 / Insufficient Balance on task 5 |

ReHarness task 7 also completed its decision successfully and all five backward
revisions, but stopped during forward reflection writing. Its inference
reservation remains persisted; it is not a fully completed seventh stream step.
No uncertain inference was replayed to obtain a better result.

Raw-04 is a fresh trial using preserved binary 6061f4d2, SHA256
99c1de40e36ac7bf9deae1197f6940a57bc98ef92cd8bc44e39bd64deeea019c.
It includes the payload and cold-start fixes, so it is not a same-code paired
baseline. It stopped for an independently observed provider balance error, not
the previous state-size error. No provider top-up or further inference retry was
made. A complete DSH Raw/ReHarness quality comparison remains unverified.

The source/context integration tests establish that the old capacity failure is
fixed for the tested payload; they do not turn either interrupted model trial
into a completed quality result.

## DSH diagnostic observations

The contained raw stream halted after six completed decisions with
`state_size_limit`; four of those six passed. It is an incomplete trial, not a
4/8 or 4/6 completed-policy success rate. Its original public trajectories and
repeated supplied context outgrew the bounded checkpoint despite embedding
sidecars. The failure is retained rather than truncating evidence or silently
restarting the stream.

In ReHarness task 3, the agent implemented `event["kind"]` even though both the
task and supplied reflections said kind was supplied by the task. Its own smoke
checks invented that input field and passed; the external verifier reported
`KeyError: kind` for all five cases. The final agent answer incorrectly claimed
a literal `credit`. The subsequent reflection diagnosed the mistake; task 4
used literal `payout` and passed all five external cases. This shows a real
failure/feedback/next-task recovery sequence, without proving that revision
rather than new reflection alone caused recovery.

A generated reflection also overstated that the exception-only failure payload
proved the remaining fields were correct. The payload does not establish that;
code inspection is separate evidence. Prompt-only source grounding is therefore
insufficient to claim factual correctness. Some contained git commands also
failed to load libxcrun, an infrastructure confound. Own invocation session
reads are permitted; they do not constitute cross-task feedback.

## Measured engineering corrections

The first rollout exhausted the dedicated local database's initial accounting
credits after 107 updates. A local-only test credit grant restored access without
changing production balances or using a real payment ledger. Interrupted streams
are excluded from completed-trial aggregates.

Embeddings occupied 350,959 of 382,994 checkpoint bytes (91.6%). Immutable
content-addressed sidecars now retain exact f64 bits, while state contains
hash/dimension references. A 4096-dimensional regression fixture shrank repeated
checkpoint serialization from 158,340 to 640 bytes (99.6%). This does not mean
99.6% less total storage or faster inference: sidecars still require creation and
hydration, and trajectories still grow. A real-canister, real-Qwen, scripted-agent
integration completed three tasks and nine scripted calls; its state was 3,099
bytes with three verified sidecars. Re-reading the completed stream made zero
additional agent calls. That check validates plumbing, not model quality.

An earlier DSH trial could list outside its task workspace and shared experimental
session directories. It was stopped and excluded; no foreign answer read was
established. The new outer macOS sandbox restricts file-content reads and writes,
uses fresh per-invocation homes, and denies parent/oracle/sibling reads. Actual
contained model traces show parent-directory reads denied. Network and metadata
remain allowed; this is not a hostile-machine/network security guarantee.
Codex uses its native cooperative sandbox and audited task archives, not the
same DSH OS boundary. Neither ordinary DSH sessions nor user profiles were edited.
The final bounded audit covers 66 decision samples and 812 public tool calls.
It found 40 denial results and 40 libxcrun failures; of 20 parent probes, 18
had explicit denials, one listed its own allowed invocation parent, and one
suppressed stderr and is inconclusive. No confirmed foreign evaluator or other
task answer read was identified within this audit. This is not an exhaustive
proof of isolation.

Source/context payload chunks subsequently removed the measured amplification.
The 2,661,048-byte regression serializes to 4,404 bytes with exact restored
Unicode/JSON evidence. A real-canister, real-Qwen, scripted raw rollout then
completed 3/3 tasks and three scripted calls: 3,601,451 referenced bytes total,
largest exact supplied context 1,200,485 bytes, and a 7,620-byte schema-2 state.
All 16 unique chunk nodes and assembled payloads passed hash/length checks;
originals and selected-order contexts matched exactly. Completed replay returned
the same report and made zero new calls (56.29-second rollout, 3.51-second replay).
This addresses the old raw stream's capacity failure in an integration test,
not a new real-DSH quality result. The failed original trial remains failed.

Review also found a JSON floating-point roundtrip that changed immutable source
values and a compatibility risk from old readers ignoring reference fields.
The CLI now enables roundtrip-safe float parsing, emits state schema 2 and accepts
legacy schema 1; old readers reject the new state instead of consuming empty
placeholders. Restoration bounds (16 MiB per payload, 64 MiB aggregate) remain
explicit and fail without truncation.

A final protocol check (84b0ba5b) rejects observed tool activity before adopting
memory-agent output, even when that output is valid JSON. Incomplete execution
still rejects first. It allows benign Codex text/reasoning/error items and rejects
tool/unknown item types; DSH tool and subagent events also reject. This is a
post-execution acceptance boundary, not tool-execution prevention or factual
grounding. The recorded quality trials predate this guard.

## Verification

After the diagnostic and DSH shutdown fixes (`a4d52296`, `a92f47d4`), a fresh
`cargo test --workspace --quiet` passed 896 tests, failed zero and ignored three.
Formatting and whitespace checks passed. Independent review found no actionable
issue. This is offline engineering validation, not a new model-quality trial.

Full Rust workspace after source/context sidecars and numeric/schema fixes: 890
passed, zero failed, three ignored. All 16 payload-era targeted stream tests passed, including
the cold-start and numeric-source RED-to-GREEN regressions. Python: 21 passed (comparison
fixtures, embedding server, and actual macOS DSH containment tests).
The final inference guard adds two stream regressions (18 targeted tests total);
its complete CLI package run passed 307 tests, with zero failures and one ignored.
The workspace total above predates only that guard.
Formatting, whitespace checks and CLI build passed. Independent scoped reviews
covered invocation reservations, executable/verifier binding, report metadata,
sidecar hydration/CAS, containment and the cold-start fix.

Private raw artifacts remain under
`.superpowers/research/reharness-2610.12668v1/` in the managed execution worktree.
They include checksummed sources, runner provenance, exact supplied contexts,
external checks, per-task reports, excluded-trial records and comparison JSON.
Credentials and raw transcripts are not published as Wiki knowledge.

## Design implications, not yet proven improvements

Keep the four policy switches and immutable evidence. The current results support
feedback retention on this fixture, but do not support making per-read revision
mandatory. Preserve the paper-style path as the reference implementation, and
compare alternative schedules against it before changing defaults.

The highest-value next quality test is a disjoint collection of real project
task families with stale instructions, conflicting evidence and condition changes.
It must distinguish new-reflection benefit from backward-revision benefit, audit
factual claims against original evidence, and keep final evaluation feedback out
of candidate generation. The current single-family pilot cannot select a winner.

Potential latency experiments are parallel execution of independent revisions
and evidence-triggered revision scheduling. The former can preserve the paper's
independence if every revision receives the same pre-phase snapshot; the latter
changes the protocol and must be labeled as an ablation. Neither is implemented
or claimed to improve quality here. Native execution's external verification must
remain separate from model self-assessment, as the payload-kind failure shows.

Capacity fixes retain the protocol and exact historical text; they are adopted
because a real rollout hit a concrete infrastructure limit. They do not establish
that larger memory or longer prompts improve task performance. No production
learning policy was enabled by these local experiments.
