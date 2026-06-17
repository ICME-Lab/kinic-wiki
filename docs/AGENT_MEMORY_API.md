# Agent Memory API

The Canister Agent Memory API is a read-only query surface for agents that talk directly to a Kinic Wiki canister.
It returns wiki context, local graph context, and source evidence without requiring `kinic-vfs-cli` or the shared tool dispatcher.

Use this API when the caller already has an IC canister client and wants long-term wiki memory as structured context.
Use [`AGENT_TOOL_CALLING.md`](AGENT_TOOL_CALLING.md) when the caller needs OpenAI-compatible or Anthropic-compatible tool schemas.

## Prerequisites

- `canister_id`: the Kinic Wiki canister to query.
- `database_id`: the target database inside that canister.
- Public databases require reader access for the anonymous principal `2vxsx-fae` when queried without identity.
- Private databases require an identity client whose principal is a database member.

## Methods

- `memory_manifest()`: discover the API version, roots, capability summary, canonical roles, limits, and recommended entrypoint.
- `query_context(QueryContextRequest)`: read task-scoped wiki context. This is the primary entrypoint for normal agent questions.
- `query_database_sql_json(database_id, sql, limit)`: run a database-scoped read-only SQL query and receive JSON object text rows.
- `source_evidence(SourceEvidenceRequest)`: read `/Sources` references for one known wiki node path.

These methods are canister query methods. They do not mutate wiki content.

## Manifest Contract

`memory_manifest()` currently returns:

- `api_version`: `agent-memory-v1`
- `roots`: `/Wiki` for wiki nodes and `/Sources` for raw source nodes
- `write_policy`: `agent_memory_read_only`
- `recommended_entrypoint`: `query_context`
- `max_depth`: `2`
- `max_query_limit`: `100`
- `budget_unit`: `approx_chars_from_tokens`

Treat `capabilities` and `canonical_roles` as discovery data.
Do not use `memory_manifest()` as content evidence for an answer.

## Query Context

`query_context` accepts:

- `database_id`: target database id.
- `task`: user task or question.
- `entities`: optional names, topics, or paths that should bias recall.
- `namespace`: optional scope root. If omitted, the canister uses `/Wiki`.
- `budget_tokens`: approximate context budget. `0` uses the canister default.
- `include_evidence`: include source evidence for returned wiki nodes when true.
- `depth`: local graph depth. Valid values are `0`, `1`, and `2`.

Minimal request shape:

```json
{
  "database_id": "<database-id>",
  "task": "summarize current project decisions",
  "entities": [],
  "namespace": "/Wiki",
  "budget_tokens": 1000,
  "include_evidence": true,
  "depth": 1
}
```

The response includes:

- `search_hits`: recall hits for the task and entities.
- `nodes`: node contexts selected for the answer, including incoming and outgoing links.
- `graph_links`: local graph edges when `depth > 0`.
- `evidence`: source references when `include_evidence` is true.
- `truncated`: true when the response was cut to fit the approximate budget.

Agents should answer from returned nodes and evidence, not from search hits alone.
If `truncated` is true, narrow the `namespace`, reduce `entities`, or issue a follow-up query for a more specific task.

## Source Evidence

Use `source_evidence` when the caller already knows the exact wiki node path and needs source refs for trust checking or citations.
The request takes `database_id` and `node_path`.
The response returns the wiki `node_path` and refs with source path, linking path, raw href, and link text.

`source_evidence` returns an error when the wiki node does not exist.

## Database SQL JSON Query

Use `query_database_sql_json` when a caller needs direct structured inspection of the target wiki DB.
The method uses the same read access as `read_node`: database members, marketplace-entitled readers, and anonymous callers for public-readable DBs can query the DB they can already read.
The browser Query panel `sql:` action and CLI `query-sql` command both call this same database-scoped API.

The method only runs against the specified wiki DB. It cannot read the canister index DB, controller metrics tables, session tables, marketplace orders, or billing tables.

SQL constraints:

- The SQL must be one restricted `SELECT` statement, at most 4096 bytes.
- The query must read from exactly one allowed table: `fs_nodes` or `fs_links`.
- `LIMIT` is required in the SQL and must be between 1 and 100.
- Optional `ORDER BY` is limited to one allowed column plus optional `ASC` or `DESC`, followed directly by `LIMIT`.
- `OFFSET` is rejected.
- `;`, comments, joins, compound selects, subqueries, grouping/window clauses, mutating/admin tokens, and large generated/aggregate values are rejected.
- The query must return exactly one selected column, and each value must be non-null valid JSON object TEXT.
- The request `limit` is also clamped to the canister query limit.
- Each JSON row is capped at 64 KiB, and the total JSON rows response is capped at 256 KiB.

Example:

```sql
SELECT json_object('path', path, 'updated_at', updated_at)
FROM fs_nodes
ORDER BY updated_at DESC
LIMIT 20
```

The response shape is:

```json
{
  "rows": ["{\"path\":\"/Wiki/example.md\",\"updated_at\":1700000000000}"],
  "row_count": 1,
  "limit": 20
}
```

## Public Wiki Metrics

`wiki_metrics` and `wiki_metrics_series(days)` are unauthenticated public aggregate telemetry APIs.
They expose user and database counts, paid user totals, charged KINIC totals in e8s, and `last_activity_at_ms`.
`wiki_metrics_series(days)` clamps `days` to `1..7`; `0` returns one point and values above `7` return seven points.
Controller-only operational SQL remains separate in `query_index_sql_json`.

## v1 Limits

- The Agent Memory API v1 is read-only.
- Writes must use CLI commands, VFS mutation APIs, or the shared tool dispatcher.
- `memory_summary` is not part of v1. Use `query_context` with a summary-style task when a maintained overview is needed.
