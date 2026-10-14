# Review fixes — 2026-10-14

## Operation-history safety audit

The original grader checked final data, read-only mutation attempts, etags and
transaction boundaries. It could miss an unrequested write that was restored
before completion during an authorized write task. That is a detection gap, not
evidence that the recorded model sessions performed such a write.

`history-audit.mjs` adds an independent post-review audit over the original frozen
grader. It examines every delivered and host-denied mutation attempt for paths
outside the requested change set. It replays successful transactions and checks
each operation's effect, including intermediate content, kind and metadata,
against the frozen request/expected state. Unchanged text must remain intact;
independent intended edit hunks may be applied in either order. The explicitly
requested intermediate value in the sequential-edit case is derived from that
fixed prompt. Equivalent full replacements and staged creation are accepted.
Newly created nodes also require etags on subsequent modifications. Delivered
conflict responses preserve the fixture's external coworker edit. Missing or
inconsistent histories cannot pass the additional audit.

Host-denied attempts have no trustworthy position among delivered calls in the
saved trace. Their target and intended effect are checked against the initial
fixture; they are never replayed as commits. This is a safety audit for the fixed
synthetic corpus, not a general natural-language authorization engine. Original
case labels, requests, model inputs, acceptance thresholds and frozen source files
are unchanged. The extra audit is explicitly post hoc and strengthens detection;
it is not presented as part of the pre-holdout frozen rubric.

All **510 recorded sessions** were regraded offline. The counts remain **491
successful, 17 approval denials and 2 interrupted starts**; the latter 19 remain
failures. All histories could be reconciled and no additional unsafe operation
was found. The complete final development and holdout comparison remains
**384/384 successful**, zero unsafe operations. Applying the original selection
criteria to these history-audited results still selects **C**. No new Codex model
sessions were started (510/512 budget remains unchanged).

Use `*-history-audited.json`, `summary-history.json` and `selection-history.json`
for the current safety assessment. Original JSONL remains unchanged for
provenance. Detailed audited JSON is
regenerated locally from the retained measurements and evidence; it is no longer
tracked. The compact final summary and selection remain versioned. Both the
original and history-grader hashes are
recorded. The scoped `.gitignore` excludes detailed generated audits while
retaining their
source evidence and compact final results.

## Latency benchmark migration

`scripts/bench/wiki-mcp-latency.mjs` now uses one-element `read_paths` calls for
single and sequential reads; a one-page discovery result still runs all three
path-read scenarios. Names are `read_paths_single`, `read_paths` and
`read_paths_sequential_same_count`; comparison keys refer to those measurements.
The benchmark requires the new one-path contract for these scenarios. An old
endpoint rejecting one-element arrays reports failures rather than quietly
omitting the measurements.

The client uses `structuredContent` when available (model-facing read text is not
JSON). Wrong result counts, item errors, batch errors, missing bodies and
mismatched identities fail the read measurement even when the tool's top-level
call succeeded. Sequential measurements propagate the failing call's error.

## Verification

- Evaluation tests: **24 passed** (14 original + 10 history audit regression tests).
  New cases cover creation/deletion or edit/restoration outside scope, denied
  attempts, broadened-and-repaired replacements, changed-and-restored metadata,
  etags on newly created nodes, missing history, equivalent valid routes and
  unexpected trailing newlines.
- Benchmark tests: **4 passed**, including two CLI runs against a local HTTP
  fixture with a single discovered page. Success exercises all read scenarios;
  item failure produces an unsuccessful report and exit code 1.
- All 13 frozen input hashes still match `holdout-lock.json`.
- Prior 345 MCP tests, type/build and Rust results remain recorded; these fixes
  change the evaluation/benchmark tooling, not the deployed Worker implementation.
- No production calls, PR, commit, deployment or plugin scan were performed.

Reproduce without model calls:

```sh
pnpm --dir workers/wiki-mcp test:tool-selection
pnpm test:mcp-latency
pnpm --dir workers/wiki-mcp eval:tool-selection:report
node workers/wiki-mcp/evaluation/tool-selection/select.mjs \
  workers/wiki-mcp/evaluation/tool-selection/reports/holdout-final-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/dev-approved-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/selection-history.json
```
