# Wiki MCP tool selection and skill alignment

## Scope and frozen comparison

The initial scope was local implementation and evaluation. The user subsequently
authorized a branch, commit, pull request and review. Deployment, production Wiki
mutation, plugin upload and rescan remain outside this follow-up scope. The existing
search/OAuth/UI work remains in the original checkout; this work starts at
`9a0b6aa7cc1a95f0c4a081586c8c3a465998f158` in a managed worktree.

- A: published 16-tool interface and original skill.
- B: 16 tools with clearer intent routing and replacement semantics.
- C: B with `read_path` removed and `read_paths` accepting 1–10 paths; output
  remains the existing results array plus metadata.
- Skills are evaluated both absent and explicitly provided. This does not test
  automatic skill selection. The published plugin currently has no bundled skill.

The 32 synthetic cases and their dev/holdout split were locked before descriptor
changes. Candidate snapshots and source/descriptor hashes make each comparison
reproducible. Models cannot see the expected data or prior attempts. Holdout working directories use neutral UUIDs; early development directory names included scenario identifiers.
Real MCP discovery, validation and formatting run against an isolated VFS fixture.
The fixture preserves ordered/all-or-nothing mutation, ambiguity errors, etags,
and the sequential all-matches behavior of multi-edit; it is not a canister or
OAuth integration test.

## Selection criteria

Final holdout task completion must be at least 95% separately with/without the
skill. There must be no observed unsolicited writes, broadened changes, etag
bypasses or broken requested transactions. Valid alternative tool sequences pass.
C is adopted only when completion is no lower than B in both conditions and its
input-error count and mean MCP calls do not increase. Ties favor C. Otherwise B
is retained if it passes the acceptance gate; if neither passes, report the gap
and do not remove an existing tool merely to meet a count target.

Metrics include actual state, body evidence, required answer facts, errors,
extraneous calls, time and token usage. Infrastructure failures remain visible.
Maximum: 512 sessions, two concurrent sessions, 180 seconds and 12 MCP calls per
session, two development refinement rounds. No tuning on holdout results.

## Initial implementation and validation

Read routing now distinguishes known paths, known result IDs/URLs, ordinary
questions, inventory and exhaustive investigation. Mutation descriptions explicitly
state that edit rejects multiple matches by default, whereas multi-edit replaces
all matches at each step. Skills require unique surrounding text for a limited
replacement and preserve mixed transaction boundaries.

The development harness has independent checks for corpus integrity, ambiguous
edits, rollback, concurrent writes, all-matches multi-edit, evaluator acceptance of
alternative correct tools, unsafe changes, split transactions and actual A/B/C
MCP schemas. Unit assertions were corrected to supply complete synthetic node
metadata. Outcome graders also verify full requested text and partial failure
reporting; final grading is frozen before holdout.

Initial B checks: MCP 105 Node + 192 Vitest + 38 Worker tests passed; TypeScript and
Candid subset checks passed; 29 Rust store tests passed; Private and public cf
dry-run builds passed; skill frontmatter validation passed using a local venv.
Descriptor hashes were regenerated for the intentional description changes.

## Completed comparison and adoption

C-r2 is adopted: 15 Private / 7 read-only tools. All 192 final development and
192 held-out sessions passed. Each variant completed 32/32 with and without the
skill. C's holdout mean calls were 1.84375 / 1.87500, versus B's 1.84375 / 1.90625;
input errors were zero for B and C. No unsafe operation was observed. Thus C meets
the fixed 95%/zero-unsafe/no-worse adoption criteria. A also completed every task;
the observed gain is fewer input errors/calls, not higher task completion.

The two development refinements clarified existing search/list limits and routing
for known URLs. No holdout tuning occurred. Frozen labels, candidate sources and
grader remain intact. A supported `--approve-for-me` environment, authorized by
the user, resolved the earlier synthetic mutation approval block. Overall 510 of
512 allowed sessions started: 491 successful, 17 approval denials, 2 interrupted.
Failures and interrupted starts remain in the evidence; they do not count as success.

Single-path clients now call `read_paths` with one path and inspect item errors
before using text/etags. Public `read_path` registration is removed with no hidden
alias; the internal implementation is retained. Tool metadata, examples, skill,
submission cases, smoke clients and descriptor snapshots use the same contract.
The final product's wire descriptor hash matches evaluated C. Canister API,
Candid, storage schema, etag rules and atomic mutation behavior are unchanged.

Final local checks: 345 MCP tests, 14 evaluation harness tests, TypeScript, Candid
subset consistency, skill/submission checks, and sequential Private/public cf
dry-run builds passed. The previously completed 29 Rust store tests remain valid;
no Rust changes were made. No deployment, plugin upload or rescan was performed.
The local scope is complete; publication remains separate and the live plugin
still has its 16-tool contract and no bundled skill.

See [results and limits](../workers/wiki-mcp/evaluation/tool-selection/reports/RESULTS.md)
and [client migration](../docs/mcp-tool-selection-migration.md). Durable synthetic
trace files allow offline regrading; original CLI logs are ignored. This measures
Codex with an explicitly supplied skill, not ChatGPT plugin precision or automatic
skill discovery.

## Review follow-up

The post-review operation-history audit closes the final-state-only safety gap.
It preserves all frozen inputs and original reports and regrades all 510 saved
sessions into separate history-audited artifacts. Final dev/holdout remains
384/384, zero unsafe operations; C remains selected. The latency benchmark's
single/sequential reads now use one-element `read_paths`, inspect structured
item errors and run even when discovery returns one page. Verification passed:
24 evaluation tests and 4 benchmark tests (including local HTTP CLI scenarios).
See [review fixes](../workers/wiki-mcp/evaluation/tool-selection/reports/REVIEW-FIXES.md).
