# Wiki tool selection results

## Decision

Selected **C-r2: 15 Private / 7 read-only tools**, with `read_paths` accepting
1–10 paths. The final development and holdout comparisons each passed 192/192
sessions with no observed unsafe operations. C meets the fixed acceptance criteria
and is no worse than B in either skill condition for completion, input errors or
mean calls. `selection-history.json` records the decision.

## Final holdout (16 cases × 2 repetitions per condition)

| Variant | Supplied skill | Completed | Mean MCP calls | Input errors | Extra calls* | Mean seconds |
|---|---|---:|---:|---:|---:|---:|
| A: original 16 | no | 32/32 | 2.00000 | 7 | 6 | 20.964 |
| A: original 16 | yes | 32/32 | 2.03125 | 3 | 5 | 21.251 |
| B: improved 16 | no | 32/32 | 1.84375 | 0 | 2 | 21.524 |
| B: improved 16 | yes | 32/32 | 1.90625 | 0 | 3 | 20.855 |
| C: improved 15 | no | 32/32 | 1.84375 | 0 | 1 | 20.776 |
| C: improved 15 | yes | 32/32 | 1.87500 | 0 | 2 | 20.637 |

All 192 holdout sessions completed with no infrastructure failures. All variants
had zero observed unsafe operations across the final development and holdout
runs. C ties B's mean calls without the skill and uses one fewer call across the
32 skill sessions. Ties favor C under the accepted rule.

A also completed every task: this experiment demonstrates fewer recoverable
input mistakes and fewer calls, **not an increase in task completion accuracy**.
Across both skill conditions, C used 119 calls versus A's 129 (7.8% fewer), and
input errors fell from 10 to 0. These are small synthetic samples, not proof that
15 tools generally outperform 16.

*Extra calls are totals above fixed per-case useful-call heuristics, reported
separately from acceptance. Correct alternative sequences are accepted.

Reported Codex token totals (32 sessions each):

| Variant | Skill | Input tokens | Output tokens |
|---|---|---:|---:|
| A | no | 2,924,850 | 8,207 |
| A | yes | 2,601,702 | 8,683 |
| B | no | 3,040,365 | 8,527 |
| B | yes | 2,607,876 | 8,389 |
| C | no | 2,945,627 | 7,963 |
| C | yes | 2,560,391 | 8,315 |

These are CLI-reported turn usage, not billed-token or automatic-reviewer usage
measurements. Elapsed time includes orchestration/review/network variation.

## Method and limitations

- Baseline: `9a0b6aa7cc1a95f0c4a081586c8c3a465998f158`.
- Codex CLI `0.162.0-alpha.17.2`, model `gpt-6-astra`, reasoning `medium`,
  Node 24.19.0. `environment.json` records the dependency lock and settings.
- 32 fixed cases: 16 development and 16 holdout; two repetitions per variant and
  skill condition. Two development refinements clarified limits and known-URL
  routing before holdout. Labels and acceptance thresholds were not changed.
- 510 total attempts: 491 successful, 17 approval denials, 2 interrupted starts.
  Failed/interrupted attempts are not successes. All 384 final comparison
  sessions completed; earlier attempts remain in the evidence.
- Each session uses an independent synthetic Wiki and only its MCP. Shell, web,
  host skill discovery and production credentials are unavailable. The fixture
  models etags, replacement semantics, rollback and concurrent edits; search and
  inventory are simplified.
- Skills are explicitly supplied. These results do not measure automatic skill
  discovery, ChatGPT plugin accuracy or real-corpus retrieval quality.

The frozen grader evaluates outcomes and accepts correct alternative tool
sequences. A supplemental operation-history audit checks targets and intermediate
operation effects, including writes that are later reverted. It was added after
holdout and is not part of the original frozen rubric. All 510 records reconcile
under this audit, with no additional unsafe operations found. This strengthens
checks on the recorded corpus; it does not establish general safety.

Use `summary-history.json` and `selection-history.json` for current results.
Detailed audits can be regenerated from the original measurements and synthetic
`evidence/*.jsonl` without model calls; see [evaluation commands](../README.md).
`dev-approved-runtime.json` identifies the grader imported by the development
process: its original per-row hash could reflect later on-disk edits. Regenerated
audits identify their actual grader; holdout captured the runtime hash once.
Unknown timing or token use is excluded from averages, not treated as zero.

## Verification for tool selection

- Wiki MCP: 345 tests (109 Node, 198 Vitest, 38 workerd), TypeScript and Candid
  subset consistency passed at adoption.
- Evaluation harness and operation-history audit: 24 tests passed.
- Latency benchmark: 4 tests passed, including CLI calls to a local HTTP fixture.
- Related Rust store tests: 29 passed.
- Skill/submission/descriptor checks and Private/read-only Worker `cf` dry-run
  builds passed.

Coverage includes single and batch reads, item errors, duplicate paths, Unicode,
size bounds, single/all-match replacements, sequential edits, etag conflicts,
atomic rollback and malformed-response handling. These results describe the tool
selection change; other features have their own verification records.
