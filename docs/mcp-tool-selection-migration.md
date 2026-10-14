# Known-path read migration (local, not deployed)

The selected implementation exposes 15 Private tools (7 reads + 8 mutations) and
7 read-only tools. The published plugin still exposes the previous 16-tool
contract. This local change has not been deployed, uploaded, or rescanned, and
its skill has not been bundled into the published plugin.

## Client change

`read_path` is removed from common registration. There is no hidden MCP alias.
Replace:

```json
{"name":"read_path","arguments":{"database_id":"db_example","path":"/Knowledge/page.md"}}
```

with:

```json
{"name":"read_paths","arguments":{"database_id":"db_example","paths":["/Knowledge/page.md"]}}
```

`paths` accepts 1–10 entries. Even for one path the successful call has
`structuredContent.results` and `structuredContent.metadata`. Check the top-level
`isError`, then each item's `is_error`. Read the body from `results[0].text` and
etag from `results[0].metadata.etag`. Do not interpret a successful tool call as
proof that the item exists or is readable. Missing pages, denied reads, and
oversized item metadata are item errors. Authentication or request validation can
still fail the whole call. Duplicates retain input order; successful items survive
other item failures.

Existing multi-page output fields, the 10-item limit, Unicode/body budgets,
256,000-byte final result limit, etag rules and mutation transactions are unchanged.
The repository smoke and review clients now issue actual `read_paths` calls and
unwrap one result locally, failing closed on malformed responses and path mismatches.
The internal `readPath`/`read_node` code remains for internal checks and tests; it
is not an MCP tool. Canister API, Candid and storage formats do not change.

## Tool selection and skill

Use `context` for ordinary questions; `search` plus `list` for exhaustive work;
`fetch_many` for exact IDs or public page URLs (up to 10 across databases);
`read_paths` for known paths; and `memory_manifest` for capabilities/limits.
Known references need no preliminary search. Search limit is 1–20 and list limit
is 1–99. Single edits reject ambiguous matches unless `replace_all` is true;
ordered multi-edits replace every match at each step. Mixed atomic changes stay
in one `mutate_nodes_batch` call.

Server descriptions, the local skill/reference, README, submission cases,
descriptor snapshots, and diagnostic scripts are aligned. The skill reference
includes a single-item example and item-error handling.

## Future publication (separate task)

This is a breaking MCP contract change. Notify external clients and migrate their
calls/result handling before switching their endpoint to this Worker version.
Publish the matching Worker, submission definitions and packaged skill together
as an explicitly authorized release; refresh tool discovery and verify private
and read-only inventories, reconnect/scan as required, and test single/partial
reads after publication. A canister upgrade is unnecessary for this change.
Local evaluation results do not establish ChatGPT plugin accuracy.

See [comparison results](../workers/wiki-mcp/evaluation/tool-selection/reports/RESULTS.md)
for the fixed corpus, adoption decision and local verification.

The latency benchmark now measures `read_paths_single`, `read_paths` and
`read_paths_sequential_same_count`, including when discovery finds only one page.
Its comparison keys use these names. Consumers of benchmark JSON should update
old `read_path` scenario/ratio keys; older endpoints that require two paths report
failed single-read measurements. Run `pnpm test:mcp-latency` for local verification.
