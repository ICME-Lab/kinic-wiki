# Review findings before Wiki batch-read release

Reviewed: 2026-10-13
Scope: the SQL literal-validation patch, existing database SQL restrictions, Wiki MCP batch reads, and the approved Kinic Wiki connection.
Method: source review plus temporary tests against local SQLite, VfsService Reader access, and mocked Worker SQL results. No production exploit probe or remote mutation was run. The new approved app successfully completed a read-only `find_databases` call and exposes the expected eight read and two batch-write tools; Private batch content was not inspected.

Status: Both findings are fixed and locally verified on `fix/wiki-batch-read-sql-validation`. The production canister and Worker still need staging validation and release.

## P1: database SQL can read forbidden internal tables

`validate_database_sql_from_clause` checks the first text token named `from` and the next token, rather than SQLite's actual source table. A SELECT expression can contain double-quoted identifiers named `from`, `fs_nodes`, and `where` before the real FROM clause. The restricted validator accepts the decoy and then SQLite executes the real source table. Separately, SQLite's `expr IN table_name` syntax reads a named table without another SELECT or FROM token. The text-token validator accepts that too.

Local reproductions:

- A direct Reader query of `schema_migrations` was rejected as intended. With a quoted `from`/`fs_nodes` decoy inside `json_object`, the same Reader obtained one row from `schema_migrations`. This used a temporary VfsService database and a Reader grant, not a privileged caller.
- `FsStore::query_sql_json` successfully read `fs_change_log` through the decoy and executed `id IN publication_mutation_commits` with an internal table named in the `IN` position.

Relevant code: `crates/vfs_store/src/fs_store/sql_json.rs`, especially `validate_database_sql_from_clause`; `crates/vfs_runtime/src/lib.rs::query_database_sql_json`. The initial table-token search existed before the literal-validation patch. The new scanner does not close it. This is an allowlist and data-boundary failure within a database. It does not demonstrate access to another database or a write primitive.

Fix direction: use SQLite's prepare-time authorizer to reject reads from any table except `fs_nodes` and `fs_links`, including implicit reads, if the native and Wasm SQLite adapters can support the same policy. Otherwise, restrict the accepted SQL to a small explicit SELECT grammar that identifies the actual FROM source and every table reference; avoid another text-token heuristic. Add Reader-level negative regressions for quoted decoys, `IN table_name`, nested sources, and the existing direct-table cases. Confirm no Candid or schema migration is needed before release.

Resolution: the lexical scan now distinguishes actual unquoted SQL keywords from quoted identifiers, requires exactly one structural FROM, and rejects implicit `IN table_name` reads. Store and ordinary Reader regression tests reject the decoy and implicit table cases, while approved `fs_nodes`/`fs_links` queries remain valid. SQLite's `hex` scalar function was allowed to support the bounded Worker query; row, response, and execution budgets still apply. This is a targeted restriction of the existing SQL surface, not a general SQL parser. The same test set must pass on staging before release.

## P2: batch reads can silently return incomplete content

The Worker SQL uses `substr(content, 1, limit)` and `length(content) > limit` for truncation. SQLite text functions stop at an embedded NUL. A local node containing `prefix\0suffix` remained intact when read directly, but the batch SQL returned only `prefix` and `truncated: false`. Stored content can therefore differ from what the agent sees, without an error.

The Worker then calls `clipText`, which limits JavaScript UTF-16 code units. For 30,000 emoji, the batch SQL result can report `content_truncated: false` because the SQLite code-point count is under 40,000. `clipText` cuts the returned text to 40,000 code units, including half a surrogate pair, while `fetchedNode` keeps `truncated: false` because it trusts the explicit SQL flag. A focused Worker test reproduced both the shortening and the false flag.

Relevant code: `workers/wiki-mcp/src/index.ts::readPathsSql`, `fetchedNode`, and `clipText`.

Fix direction: define the batch limit in bytes or Unicode scalar values consistently, avoid relying on SQLite `length()` or `substr()` for content containing NUL, and compute the final truncation flag after Worker clipping. Keep the response budget and exact single/batch content semantics in tests, including NUL, emoji, and escaped control characters. If SQL cannot safely slice arbitrary text, fetch bounded raw content with a mechanism that explicitly reports byte length, or return a clear truncation/error status.

Resolution: the Worker SQL slices the UTF-8 BLOB and returns a bounded hexadecimal prefix with byte-accurate truncation. The Worker decodes it strictly, drops an incomplete UTF-8 tail when needed, and combines the SQL flag with any final Worker clipping. It also avoids cutting a surrogate pair in single reads. Real SQLite and Worker tests cover NUL, emoji, malformed hex, path grouping, and item errors. Worker and canister deployments are both required because the patch changes the SQL validator and the Worker query/decoder.

## Release gate and coverage

The production canister still has the original `--` batch-read failure; the fix branch has not been deployed. The release Wasm has been rebuilt after both fixes. Stage the canister and Worker together, run the read-only smoke and Reader negative regressions on staging, then follow the authorized production release path. The earlier Wasm SHA-256 (`e98a4af0...`) is obsolete and must not be deployed.

The audit was scoped to this SQL endpoint and the batch-read response path. It did not review every VFS canister method, OAuth behavior, or all plugin permissions. Existing unrelated OAuth working-tree changes were not modified.
