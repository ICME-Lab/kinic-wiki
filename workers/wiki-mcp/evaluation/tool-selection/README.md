# Wiki tool selection evaluation

This harness exercises the real Wiki MCP registration, input validation, mutation
wrappers and response formatting against an in-memory Wiki. It measures Codex
task completion, not OAuth/canister integration, ChatGPT accuracy or automatic
skill discovery. See [results](reports/RESULTS.md) for the comparison and limits.

## Offline checks

Run from the repository root. These commands do not call a model:

```sh
pnpm --dir workers/wiki-mcp test:tool-selection
pnpm test:mcp-latency
pnpm --dir workers/wiki-mcp eval:tool-selection:report
node workers/wiki-mcp/evaluation/tool-selection/select.mjs \
  workers/wiki-mcp/evaluation/tool-selection/reports/holdout-final-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/dev-approved-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/selection-history.json
```

`report.mjs` regrades retained synthetic evidence. Detailed `*-audited.json`
reports are generated and ignored; `summary-history.json` and
`selection-history.json` retain the compact final results. Omit `--history` when
invoking `report.mjs` directly to reproduce the original final-state grading.

## Evaluation design

`cases.mjs` fixes 32 cases, split into 16 development and 16 holdout cases.
`corpus-lock.json` records their hash. Each condition runs twice, with and without
an explicitly supplied skill and reference document. Labels and expected state
are visible only to the grader. Correct alternative tool sequences are accepted.

| Variant | Contract |
|---|---|
| A | Original 16 tools at the commit in the corpus lock |
| B | 16 tools with improved descriptions, instructions and skill |
| C | B with one-to-ten-path `read_paths` and no public `read_path` |

Variants exist only in evaluation bundles. `build.mjs` uses the baseline Git
commit and snapshots under `variants/`; it replaces only the VFS data boundary.
Keep the baseline commit available when building from a shallow checkout.

`grade.mjs` checks final data, evidence, requested answer facts, item errors,
etags and atomicity. `history-audit.mjs` also checks mutation targets and replays
operation effects, including content, kind and metadata. Missing or inconsistent
histories cannot pass. This audit supports the fixed corpus; it is not a general
natural-language authorization engine. Host-denied attempts have no reliable
chronological position and are checked against initial state without being
replayed as commits.

`select.mjs` requires complete case/repetition coverage, at least 95% holdout
completion in each skill condition, and no observed unsafe operations in final
development or holdout. C must also be no worse than B in completion, input errors
and mean calls. Ties favor C. Extra-call heuristics are reported separately.

## Model runs

`run.mjs` uses the existing Codex account, the recorded model/reasoning setting,
`--ignore-user-config --ephemeral --approve-for-me`, and only the synthetic stdio
MCP. Shell, web and host skill discovery are disabled. Each session has an empty
workspace and independent fixture. Limits are two concurrent sessions, 180 seconds
and 12 executed MCP calls per session, with 512 sessions per campaign.

This campaign has used **510/512 sessions**. A new full comparison requires a new
budget and separate output records. Do not overwrite `holdout-lock.json` or the
retained measurements. Approval denials stop new cases and count as failures;
interrupted starts also consume the budget. After a forced shutdown, check for
remaining evaluation processes before removing `.tmp-test/runner.lock`.

To build the retained final variants without starting sessions:

```sh
node workers/wiki-mcp/evaluation/tool-selection/build.mjs r2
```

The runner accepts `--phase dev|holdout`, `--round r0|r1|r2`, `--label`, `--case`,
`--variants`, `--modes`, `--repeats`, and `--read-only-cases`. Holdout runs require
matching frozen source hashes. Never tune candidates or labels from holdout results.

## Files

- Versioned: cases, locks, variant snapshots, settings, original measurements,
  synthetic `reports/evidence/*.jsonl`, final summary and decision.
- Generated: detailed audits and diagnostic logs. The scoped `.gitignore` retains
  only explicitly listed reports.
- Temporary: bundles, fixtures, locks and raw CLI transcripts under `.tmp-test/`.
  Keep credentials out of versioned reports; put custom in-repository OAuth caches
  under `.tmp-test/`.
