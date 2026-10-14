# Wiki tool selection evaluation

This harness evaluates task completion through the real Wiki MCP server, tool
schemas, mutation wrappers, and result formatting. Only its VFS data boundary is
replaced by an in-memory synthetic wiki. It is not an OAuth/canister integration
benchmark and does not measure ChatGPT's tool discovery or automatic skill loading.

`cases.mjs` contains 32 synthetic cases, 16 development and 16 held-out; the corpus
hash was frozen before product descriptor changes in `corpus-lock.json`. Expected
state, evidence and answer facts are visible only to the grader. The model receives
the request, actual MCP discovery/instructions, and (in the skill condition) the
skill plus reference. Different correct tool sequences are accepted. The grader
checks final content/kind/metadata, read evidence, requested atomicity, unexpected
changes and read-only mutation attempts. Useful-call ceilings are reporting
heuristics, not pass/fail conditions.

A is the published commit recorded in the corpus lock. B is the descriptor/skill
improvement. C removes only the public `read_path` registration and changes
`read_paths` to accept 1–10 paths; output formatting is the product implementation.
The comparison variants exist only in the evaluation build, never as a production runtime switch. C-r2 was selected and migrated into the product.

Run from the repository root:

```sh
node workers/wiki-mcp/evaluation/tool-selection/build.mjs
pnpm --dir workers/wiki-mcp test:tool-selection
node workers/wiki-mcp/evaluation/tool-selection/run.mjs --phase dev --label dev-r0
# Only after development is complete; do not tune on these results:
node workers/wiki-mcp/evaluation/tool-selection/build.mjs r2
node workers/wiki-mcp/evaluation/tool-selection/freeze.mjs r2
node workers/wiki-mcp/evaluation/tool-selection/run.mjs --phase holdout --round r2 --label holdout-final
node workers/wiki-mcp/evaluation/tool-selection/report.mjs --history --write
node workers/wiki-mcp/evaluation/tool-selection/select.mjs \
  workers/wiki-mcp/evaluation/tool-selection/reports/holdout-final-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/dev-approved-history-audited.json \
  workers/wiki-mcp/evaluation/tool-selection/reports/selection-history.json
```

Codex uses the existing account with `--ignore-user-config --ephemeral`, the
recorded model/reasoning setting and only the synthetic stdio MCP server. Shell,
web and host skill discovery are disabled. Each session has an empty working
directory, independent fixture and transcript. At most two sessions run at once;
the limit is 180 seconds and 12 MCP calls per session. No production Wiki writes,
provider API keys, external MCP accounts, deployments or plugin changes are used.

The `reports` directory stores settings and per-session measurements (synthetic
answers only). `.tmp-test` is ignored and stores bundles, raw observations and
Codex transcripts. Both successful and failed sessions are counted; infrastructure
failures are identified separately. Expected behavior is not changed to pass a
candidate. Passing this corpus does not prove general safety or ChatGPT accuracy.

## Completed campaign and replay

See [reports/RESULTS.md](reports/RESULTS.md) for the final C adoption and metrics.
The examples above describe the completed campaign. `holdout-lock.json` already
exists and must not be overwritten. This campaign used 510/512 sessions; the
runner deliberately refuses another full comparison within that budget. Offline
harness tests and evidence regrading require no model sessions. A new full model
campaign needs a separately authorized budget and fresh output directories;
preserve the existing measurements, evidence and freeze as the original
comparison record.
The initial run encountered Codex's MCP approval gate. After explicit user
approval, the runner uses the supported `--approve-for-me` automatic review mode
in each empty fixture workspace. Product tool annotations are unchanged, and
shell/web/host skill discovery remain disabled. Approval denials still stop new
cases; they are never counted as successful model behavior.

`--read-only-cases` permits focused checks without mutation cases. Interrupted
starts count toward the budget, and a coordinator lock prevents concurrent
runners exceeding two sessions. If a process is forcibly killed, verify no
evaluation children remain before removing a stale `.tmp-test/runner.lock`.

Refinement source/skill snapshots live under `variants/r0`, `r1`, `r2`. Build a
specific round with `node workers/wiki-mcp/evaluation/tool-selection/build.mjs r2`
and select it with `--round r2`. After infrastructure is resolved and development
is complete, freeze with `node workers/wiki-mcp/evaluation/tool-selection/freeze.mjs r2`.
The holdout command must also pass `--round r2`; it refuses to run without the
matching `holdout-lock.json`, or when frozen sources change. Keep the original
acceptance criteria. No more than two refinement rounds are allowed.

The synthetic `reports/evidence/*.jsonl` files retain observations for regrading
without ignored CLI transcripts. `*-audited.json` is the current grading of those
traces; the initial JSONL measurements are retained for provenance. Timing and
usage for interrupted sessions are unavailable, not zero-cost successes.

Adoption is computed by `select.mjs` from audited holdout and development JSON. It
requires every frozen case/repetition in each condition, at least 95% holdout
completion, zero observed unsafe operations in the final candidate's dev/holdout
runs, and C no worse than B in each skill condition for completion, validation
errors and mean MCP calls. Incomplete infrastructure runs cannot become a C win.
Recorded usage is Codex's reported turn usage; any separate automatic reviewer
usage is not exposed by these transcripts.

## Versioned evidence and local output

The scoped `.gitignore` ignores new report files by default and explicitly retains
this completed synthetic campaign: original measurements, settings and regrading
evidence, including approval failures and interrupted starts, plus the compact
final summary and adoption decision. Detailed `*-audited.json` files and the
original `summary.json`/`selection.json` are generated output and are not tracked.
Regenerate them with the reporting and selection commands above; omitting
`--history` reproduces the original audit. Local generated copies may be retained.
Keep the fixed cases,
variant sources, locks and final report versioned. An additional campaign should
add only reviewed synthetic evidence to this allowlist when it is ready to retain.

Raw Codex transcripts, temporary fixtures, process locks, bundles and diagnostic
logs belong in `.tmp-test/` (ignored repository-wide). Do not put credentials in
versioned reports. OAuth caches default to the user's state directory; when using
a custom in-repository cache path, place it under `.tmp-test/`. Environment files
are ignored while `.example` and `.template` files remain eligible for versioning.

The post-review `history-audit.mjs` supplements the unchanged frozen grader.
`eval:tool-selection:report` includes this audit by default; raw `run.mjs` results
alone are not the current safety assessment. Omit `--history` only to reproduce
the original grading. The original measurements stay intact; detailed audit
output is generated locally,
and the current results use the `-history-audited.json` suffix. See
[review fixes](reports/REVIEW-FIXES.md) for the detection gap, audit limitations,
regrading results and commands. No extra model sessions are needed for regrading.
