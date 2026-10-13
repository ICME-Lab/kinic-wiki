# Fix SQL validation for Wiki batch reads

Status: IN PROGRESS — local fixes verified; staging and production release pending
Priority: P1
Recorded: 2026-10-13
Baseline: main at 3a2b774f

Release review: [003-wiki-batch-read-review-findings.md](./003-wiki-batch-read-review-findings.md) documents the Reader-level internal-table allowlist bypass and silent batch-content truncation, both fixed locally with regression tests. Stage the canister and Worker together before any production upgrade.

## Implementation record

Implemented on `fix/wiki-batch-read-sql-validation`:

- A shared quote-aware scanner excludes single-quoted literal data, honors doubled
  quote escaping, and checks decoded double-quoted, backtick, and bracketed
  identifiers against the existing restrictions. Malformed quotes are rejected.
- Restricted database SQL still rejects actual comments and extra statements.
  Index SQL retains its existing comment support; its comments are scanned without
  interpreting their contents as executable tokens.
- Store regressions use the actual Worker batch SELECT template and execute it
  against SQLite. They cover exact content/etag round trips for 12 unusual paths,
  prohibited syntax, quoted identifiers, and randomized literal text.
- Worker regressions verify escaping, duplicate references, and mixed missing
  results through both batch tools. Worker production code now uses a byte-bounded
  hex response to preserve NUL content and Unicode truncation. Candid is unchanged.
- Reader-level SQL tests reject quoted FROM decoys, direct internal tables, and
  implicit `IN table_name` reads. The restricted validator still enforces SQL
  budgets and allows only the approved database tables as structural sources.
- `workers/wiki-mcp/scripts/batch-read-smoke.mjs` compares both batch tools with
  single-read controls and checks item errors and truncation. It supports public
  reads or the existing read-only OAuth client with an isolated cache.

Verification on 2026-10-13:

- Before the fix, the new real-store tests failed on the original `--` path and
  literal semicolon, confirming the production failure.
- The full store suite passed after both review fixes (175 tests); the final
  seven focused store regressions also passed, including property testing.
- Two Reader-level SQL regressions and 18 existing database/index SQL tests
  passed on the final scanner, including access and execution-budget checks.
- Wiki MCP checks passed: Candid subset, 79 Node tests, 117 Vitest tests, 35 Worker
  tests, and TypeScript typecheck. Auth-related working-tree changes from another
  activity were preserved and are outside this patch.
- The dedicated live-smoke validator tests passed (6 tests, included in the 79
  Node tests). Updated validator imports were rechecked with those 6 tests.
- `cargo check -p vfs-canister --target wasm32-unknown-unknown --locked` passed;
  `bash scripts/build-vfs-canister.sh` subsequently built the final release Wasm.
- Scoped Rust formatting and `git diff --check` passed.
- A read-only public baseline run still failed specifically at `read_paths batch
  failed`, as expected before a canister upgrade. No remote data was changed.

Release artifact: `target/wasm32-unknown-unknown/release/vfs_canister.wasm`.
SHA-256 after both review fixes: `9ce918f87508ed17704c5678f12bd9471dc9dc276549471eb2d7ebe60b0b764e`.
Staging requires its own build with the repository's staging-origin configuration
and a coordinated Worker deployment. No deployment, commit, or push was performed.
Remaining work is staging canister/Worker upgrade and read smoke, authorized
production release, then approved-app verification.

## Problem and evidence

Live reads through the existing KinicWiki connection reproduced a canister-side
validation error when `read_paths` or same-database multi-item `fetch_many` includes
a path containing `--`. Single `read_path` and single-item `fetch_many` succeed.
Batch reads of `/Knowledge` and `/Sources/honojs__hono/provenance.md` succeed.

Read-only probes also reproduced errors for path components `update`, `join`,
`select`, and `semi;colon`. A normal nonexistent path returns only an item-level
not-found error, while each problematic path causes the valid companion item to
fail too. No probe nodes were created.

`workers/wiki-mcp/src/index.ts` creates a SELECT with quoted path literals.
`crates/vfs_store/src/fs_store/sql_json.rs` scans the entire SQL string for
semicolons and comment markers, then tokenizes identifiers without respecting
quoted strings. Valid path text is therefore interpreted as SQL syntax.

The connected plugin exposes an older descriptor set. The current public server
advertises eight read tools; the submitted Private app advertises those reads
plus two batch mutation tools. Connection refresh is a separate issue and does
not repair this canister-side bug. Private live reproduction is still pending.

## Intended outcome

Valid paths can be read in a batch, including paths with SQL keywords, comment
markers, semicolons, Unicode, or apostrophes. Actual SQL comments, extra statements,
forbidden operations, and queries outside the existing restricted contract remain
rejected. Access control, result limits, execution budgets, JSON output validation,
and the Candid interface remain unchanged.

## Implementation sequence

1. Add failing Rust regression tests through the real store execution path using
   the SQL shape generated by the Worker. Create fixture nodes locally, combine
   each unusual path with an ordinary valid path, and assert exact returned paths
   and content. Include `--`, `/*`, `*/`, `;`, `update`, `join`, `select`, `limit`,
   `from`, an apostrophe escaped as `''`, and Japanese text.
2. Introduce a quote-aware SQL lexical scan shared by the SELECT validation and
   restricted database validation. Track single-quoted literals and SQLite's
   doubled quote escaping; recognize syntax tokens and statement/comment markers
   only outside literals. Reject unterminated literals and unsupported or malformed
   quoting deliberately. Review double-quoted, backtick, and bracketed identifier
   behavior explicitly; do not let quoted identifiers bypass table or keyword
   restrictions. Inspect every caller of the exported `validate_sql_json_select`,
   including index SQL queries, before changing its behavior.
3. Feed the existing keyword, FROM, ORDER BY, and LIMIT checks from the same
   lexical representation. Preserve all existing structural restrictions and
   budgets. Do not simply remove the comment or keyword checks, and do not solve
   this by renaming wiki nodes. Keep Worker apostrophe escaping intact.
4. Extend the Worker tests to cover unusual paths, mixed valid/missing items,
   same-database batch grouping, duplicate references, and model-facing errors.
   Add an integration test that exercises Worker-generated SQL against the real
   Rust validator/store or a local canister. Mocked SQL results alone do not close
   the coverage gap. Keep existing tests for batch failure isolation.
5. Add a reusable read-only live regression smoke for existing public nodes with
   `--`, a mixed ordinary/unusual path batch, and the single-read control. Verify
   item results and `metadata.batch_error`, not merely HTTP status or top-level
   `isError`. Run the same reads with an authenticated Private connection when
   available; do not print tokens or private node text.

## Verification

- Store tests: execute SELECT queries against real SQLite and validate exact
  content for the unusual-path fixtures.
- Negative tests: actual line/block comments, actual extra statements, forbidden
  operations, disallowed tables, subqueries/joins/unions, invalid LIMIT/ORDER BY,
  malformed quotes, and escaped-quote attempts must still fail under the existing
  policy. Test markers both inside and outside literals.
- Run existing index/store/runtime SQL tests because the SELECT validator is
  shared. Use existing test filters for focused checks, then the affected suites.
- Run `pnpm --dir workers/wiki-mcp test` and `typecheck` if Worker/test changes are
  included. Check the Candid subset for drift and confirm no API change.
- Inspect the final diff and test coverage before any release.

## Release sequence

The root fix is in the canister's store crate, so a plugin reinstall or Worker-only
deployment is insufficient. First build and upgrade the staging canister through
the repository's existing release workflow. Run public-equivalent and authenticated
Private read smoke tests against staging, including ordinary reads and prohibited
SQL probes. Check upgrade compatibility and the recorded schema versions without
introducing migrations for this lexical fix.

Prepare the reviewed patch, verification results, and upgrade procedure before
requesting production-release approval. Upgrade the production canister only when
authorized. Deploy the Worker only if its code changed; use the official `cf` CLI
and the repository deployment wrappers for any Cloudflare deployment.

After release, rerun the original failing public batches and authenticated Private
reads. Verify a fresh conversation with the newly connected approved Kinic Wiki
app, including search followed by multi-item retrieval. Keep the previous artifact
and follow the existing compatible rollback procedure if validation or normal
reads regress; never assume a canister downgrade is safe without schema review.

## Acceptance and scope

- The original two routing nodes can be read together by both batch tools.
- Adding a path with keywords/comment-like characters does not break its ordinary
  companion item.
- Actual prohibited SQL remains rejected and existing authorization/budget tests
  pass.
- Read-only live smoke checks report zero unexpected item errors.
- Approved-app connection state is confirmed separately; installation or OAuth is
  never inferred from an installation suggestion.

No automatic batch-to-single fallback is planned initially: fix the shared
validator and preserve the batch efficiency. Any later fallback needs explicit
error classification so it cannot hide authorization failures or multiply calls
after resource-budget errors. Japanese context recall is a separate investigation.
