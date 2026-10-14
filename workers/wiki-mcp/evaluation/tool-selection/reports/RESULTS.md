# Tool selection evaluation — C adopted locally

> Post-review update: [operation-history audit and benchmark fixes](REVIEW-FIXES.md)
> are complete. All 510 records were regraded; final comparison remains 384/384,
> with no additional unsafe operation and C still selected. Use the
> `*-history-audited.json`, `summary-history.json`, and `selection-history.json`
> artifacts for the current safety assessment. Detailed audit JSON is generated
> locally from retained measurements/evidence; the compact final summary and
> selection remain versioned. See the evaluation README for replay commands.

## Decision

Adopt **C-r2: 15 Private / 7 read-only tools**. The final comparison meets the
predeclared acceptance criteria: 100% completion with and without the supplied
skill, zero observed unsafe operations, and no increase versus B in input errors
or mean calls in either condition. `selection-history.json` records this decision from
the audited development/holdout rows. No criteria or labels were changed after
seeing holdout results.

The product now registers `read_paths` for 1–10 paths and removes `read_path`.
Single results retain the array-plus-metadata envelope. Repository clients,
smokes, submission cases, snapshots, skill and docs are migrated. No hidden MCP
alias exists. The evaluated C wire descriptor hash matches the migrated product
in a regression test. Internal single-node code remains where needed.

See [migration](../../../../../docs/mcp-tool-selection-migration.md). The changes
are prepared for a separately requested pull request and review. No deployment,
production write, plugin upload or rescan was performed. Unrelated
search/OAuth/UI changes remain in the original checkout. The published plugin
still has 16 tools and no bundled skill.

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

## Development and bounded refinements

The final fixed r2 development comparison completed 192/192 with zero unsafe
operations or infrastructure failures:

| Variant | Skill | Completed | Mean calls | Input errors |
|---|---|---:|---:|---:|
| A | no | 32/32 | 1.96875 | 6 |
| A | yes | 32/32 | 2.09375 | 3 |
| B | no | 32/32 | 1.81250 | 0 |
| B | yes | 32/32 | 1.87500 | 0 |
| C | no | 32/32 | 1.84375 | 0 |
| C | yes | 32/32 | 1.87500 | 0 |

Two focused refinements preceded the full comparison:

1. **r1: state existing limits.** Initial agents requested 100–200 results although
   search permits 20 and list 99. Descriptions, parameter documentation and skill
   now state those limits. Eight paired B/C investigation runs improved from
   8.375 to 5.5 mean calls, with validation errors reduced from 19 to 0. No limit
   or retrieval behavior changed.
2. **r2: clarify known URLs.** Skill wording had suggested `fetch_many` mainly
   after search, causing unnecessary separate reads. Explicit user-provided and
   cross-database URL routing reduced mean calls on eight paired B/C URL cases
   from 1.375 to 1.0. Eight known-path checks also passed with one call each.

Focused samples were chosen after development observations; they are not an
independent final test. No third tuning round occurred. Holdout began only after
the full development comparison and the immutable `holdout-lock.json` freeze.
Frozen sources and grader hashes remain unchanged.

## Execution, failures and provenance

- Published baseline: `9a0b6aa7cc1a95f0c4a081586c8c3a465998f158`.
- CLI `0.162.0-alpha.17.2`, model `gpt-6-astra`, reasoning `medium`, Node 24.19.0.
  `environment.json` records the dependency lock and execution settings.
- 32 fixed scenarios (16 development, 16 holdout), frozen before implementation.
  Prompts, labels and expected data were never changed to pass a candidate.
- **510 started sessions out of 512 maximum: 491 passed, 17 approval denials,
  2 interrupted starts.** Breakdown: original pilot 2; initial development 91;
  focused r1/r2 16 each; approved write pilot 1; final dev 192; holdout 192.
  Neither infrastructure failures nor interrupted sessions count as success.
- The initial mutation runs stopped at `MCP tool call requires approval, but
  approval policy is never`. After explicit user approval, a supported
  `--approve-for-me` synthetic write pilot succeeded; all final comparisons used
  that mode. No tool annotations or approval controls were weakened.
- At most two concurrent sessions, 180 seconds/session and 12 executed MCP calls.
  Each uses a separate fixture/session; the final runner also uses an empty
  UUID-named working directory. Earlier development directory names included case
  identifiers, but no expected data. Holdout model inputs omit case identifiers.
- Only the synthetic MCP is configured. Shell, web and host skill discovery are
  disabled; no production Wiki credentials/accounts or expected labels are given
  to the model. Actual product discovery, validation and response generation are
  exercised with the VFS boundary replaced by an in-memory fixture.

The fixture models etags, ambiguity, ordered replacements, transaction rollback
and concurrent edits. Its inventory and search are simplified; it does not prove
canister/OAuth integration or real-corpus retrieval accuracy. Skill-on explicitly
supplies the skill and reference, so automatic discovery is not evaluated. The
post-selection reference adds a client migration example; the tested selection
rules remain unchanged. Codex results are not ChatGPT plugin accuracy guarantees.

The original grading can be regenerated as `*-audited.json` and `summary.json`.
Original JSONL measurements are preserved.
`evidence/*.jsonl` retains synthetic requests, responses, state and undelivered
attempts for regrading without ignored raw CLI logs. The grader checks whole final
data, read evidence, requested text/answer facts, partial errors, atomicity, etags
and unsafe attempts; valid alternative tool sequences pass. Early measurement
fixes counted protocol validation errors, allowed equivalent evidence paths and
handled coworker changes separately. They did not alter case labels. The final
grader was frozen before holdout.

`dev-approved-runtime.json` records the grader imported when the development
process started; its early per-row file hash could reflect later on-disk grading
repairs. Audited records explicitly identify the final grader. Holdout records
capture the runtime hash once. Unknown duration/token use for interrupted starts
is excluded from averages, not represented as zero-cost success.

## Local regression verification

- Wiki MCP: 109 Node + 198 Vitest + 38 workerd tests passed (345 total).
- TypeScript and Candid subset consistency passed.
- Related Rust store tests: 29 passed; no Rust/API/storage changes in this patch.
- Evaluation harness: 14 tests passed (frozen corpus, rollback, conflict, unsafe
  operations, alternative outcomes, selection criteria and actual A/B/C schemas).
- Single `read_paths` success, missing/denied/transport errors, Unicode body
  identity, duplicate restoration, 0/10/11 boundaries, oversized metadata and
  final UTF-8 bounds covered. Removed `read_path` is not callable.
- Existing single/all-match edits, sequential multi-edit, etag conflicts and
  atomic rollback checks pass. Smoke cleanup refuses mismatched/malformed reads.
- Skill syntax/frontmatter, reference tool inventory, YAML and submission
  consistency passed; intentional descriptor snapshots updated.
- Private and public Worker `cf` dry-run builds passed sequentially. Earlier
  parallel builds collided in cf's shared generated output; sequential rebuilding
  resolved it without source/config changes. No deployment occurred.

The implementation and local validation scope are complete. External client
migration and publication remain a separately authorized release.
