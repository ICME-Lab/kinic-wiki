# Local ReHarness streaming experiments

`kinic-vfs-cli learn stream` implements an experimental, strictly online memory
rollout for any caller-supplied project/task suite. The canister stores the
canonical stream; the CLI controls retrieval and learning; Codex or DSH executes
decisions, revisions and reflection writes. Existing production candidate
validation/promotion and plugin-to-CLI routing remain separate.

## Protocol

For each ordered task, retrieve up to five memories by cosine similarity between
original task queries; execute one isolated task; obtain external verifier
feedback; independently revise each retrieved reflection using its immutable
original trajectory as the source and the latest trajectory as feedback; write
one new reflection using the revised reflections as demonstrations. Unretrieved
memories retain their contents. The stream does not replay tasks or select
updates using a separate validation set.

The implementation follows ReHarness (arXiv:2610.12668v1), §3.3, equations (1)–(3), and Figure
5. Prompts preserve the source/feedback distinction and strict JSON reflection
output. Source grounding is an instruction to the model, not a proof that every
sentence is supported. Raw internal reasoning is excluded from learning inputs;
public tool observations, final answers and verifier feedback are retained.
Memory calls run read-only and instruct the model not to use tools. Before
accepting their JSON output, the CLI rejects incomplete execution and observed
tool activity (including unknown Codex item kinds). This is an acceptance check
after execution, not prevention of tool use or proof of factual grounding.

| Element | Implementation / fidelity limit |
|---|---|
| Query-to-query retrieval | Original Qwen3-Embedding-8B, cosine top-5; model revision declared in configuration and independently checked for the recorded experiment |
| Backward revision | One independent call per retrieved reflection, using immutable original source |
| Forward reflection | One call conditioned on the revised retrieved examples |
| Backbone | One pinned runner/model/configuration for all three roles within a stream |
| Decision interface | Native coding-agent tools; differs from the paper's structured-action prompt |
| Prompts and evidence | Adapted Figure 5 instructions; original sources are redacted public projections, not every visible event or full code diff |
| Grounding validation | Source constraint in prompts; the paper's factual-claim audit has not been reproduced |
| Baselines and metrics | Top-K Raw and local no-revision ablation; no claim to reproduce RBank or normalized-gain scores |
| Embedding runtime | Local MPS fp16, fp32 normalization; paper runtime numerical equivalence unverified |
| Benchmark | Synthetic billing-profile shift pilot; not the paper's benchmark or a reproduction of its scores |
| Lexical option | Explicit ablation/deviation, never reported as semantic retrieval |

## Run

Start and deploy a local Wiki canister with the repository's `icp` configuration.
Provide explicit local replica, canister, database and identity flags. The stream
rejects non-loopback replicas. Prepare a task suite using
[evaluation/reharness/README.md](../evaluation/reharness/README.md) and start the
original embedding model using [EMBEDDING.md](../evaluation/reharness/EMBEDDING.md).

```sh
kinic-vfs-cli --replica-host http://localhost:8011/ \
  --canister-id YOUR_LOCAL_CANISTER --database-id YOUR_EXPERIMENT_DB \
  learn stream --suite /absolute/path/suite.json \
  --runner-file /absolute/path/runner.json \
  --project-id 00112233445566778899aabbccddeeff \
  --stream-id first-reharness-run --policy reharness \
  --retrieval embedding --embedding-config /absolute/path/embedding.json \
  --top-k 5 --output /absolute/path/new-output --json
```

Policies are `none`, `raw`, `append-only`, and `reharness`. All except `none`
retrieve prior memories. `raw` supplies original trajectories; `append-only`
writes reflections without revising old ones. Use independent stream IDs and
output directories for every trial/policy. Runner credentials must stay in
protected, dedicated agent homes. Do not reuse an active DSH session, ordinary
plugin-rich profile, or the user's development checkout for evaluation.

Task manifests pin a source commit, task prompt, allowed changed paths and
external checks. The existing evaluation runner exports a clean source archive
for each task. External verifier and runner executable files are content-bound;
configuration changes require a fresh stream. Embedding revision is caller-declared metadata: the CLI does not yet attest the remote endpoint weights or detect a same-URL server replacement. Keep that process fixed and independently verify its artifacts throughout a trial. This is a cooperative native-agent
pilot: archive isolation does not by itself prevent an agent from reading an
external oracle elsewhere on the host. Audit traces and use an OS containment
boundary before claiming benchmark-grade isolation.

## Persistence and failures

Canonical state resides under
`/Memory/projects/<project-id>/reharness/<stream-id>/state.json`. Each phase uses
an etag compare-and-swap checkpoint. A unique execution reservation precedes
every decision and memory model call. Lost acknowledgements can reconcile by
exact content; conflicting writers cannot both claim the same call. A recovered
uncertain model invocation fails closed instead of silently replaying it or
underreporting costs. Start a new independent stream after such an interruption.

Completed runs can be read again without model calls. Invalid JSON reflections,
incomplete execution, truncated external verification and changed bindings halt
the rollout. Nothing invents feedback for missing evidence. Embedding vectors are
stored once as immutable, hash-addressed sidecar nodes
under the stream. Checkpoints retain references; resume checks the namespace,
hash, dimensions and exact f64 bit representation before retrieval. Legacy inline
vectors remain readable. Original trajectories and exact supplied contexts also use immutable payload
sidecars, split at UTF-8 boundaries into 64 KiB chunks. Both chunk and whole-payload
hashes and lengths are checked before use. JSON source hydration retains floating
point values across reserialization. Per-payload restoration is bounded to 16 MiB
and 512 references; aggregate restoration is bounded to 64 MiB before allocation
and I/O. No evidence is truncated to meet a limit. State schema 2 prevents older
readers from interpreting stripped placeholders; current readers accept legacy
schema 1 and migrate it when writing.
Checkpoints remain bounded to 900 KB and suites to 100 tasks; oversized metadata
or payloads fail explicitly. Sidecars reduce repeated persistence, not inference
context length or total model memory requirements.

`report.json` records task outcomes, exact supplied context, selected memory IDs,
phase durations, agent invocations (legacy `model_calls`) and available token counts.
An invocation can include multiple provider requests and retries. Missing usage remains
null. Incomplete trials must be reported separately from success aggregates.
One task family and one trial cannot establish general improvement, statistical
significance, or optimal design. Compare multiple task families and trials before
changing production defaults.

## Observed storage bottleneck

The first local experiment exhausted its initial database accounting credits after
107 updates. In a three-step append-only checkpoint, embeddings accounted for
350,959 of 382,994 bytes (91.6%). The full JSON was written, revisioned and
reindexed at each phase even though old vectors were unchanged.

Immutable embedding sidecars remove this repeated payload while retaining the
same retrieval values, call order and state CAS. A 4096-dimensional regression
fixture shrank the state checkpoint from 158,340 to 640 bytes (99.6%); that is a
serialization measurement, not an end-to-end latency or model-quality gain.
Sidecars still incur one creation write and hydration reads, and their own bytes
remain stored. Full original trajectories and supplied context still grow with
the stream.

A later contained DSH raw trial hit the state bound after six tasks: completed
supplied contexts contributed 600,179 UTF-8 bytes, and original sources another
168,523 bytes. The next checkpoint exceeded the
limit. Exact source/context sidecars address both contributors. A multi-megabyte
Unicode regression shrank serialized state from 2,661,048 to 4,404 bytes and
retained exact restored sources and contexts; original evidence remains stored
in sidecars. See [local results and limitations](REHARNESS_LOCAL_RESULTS.md).

Memory inference failures now save a bounded, sanitized `failure.json` beside
inference artifacts. Terminal DSH failures receive the same bounded graceful
shutdown as successful turns, allowing buffered logs to drain. See the
[investigation and limitations](REHARNESS_INVESTIGATION.md).
