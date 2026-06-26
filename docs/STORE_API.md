# Store API

The Canister Store API is a read-only query surface for agents that talk directly to a Kinic Wiki canister.
It exposes the four Kinic stores without requiring `kinic-vfs-cli` or the shared tool dispatcher.

Use this API when the caller already has an IC canister client and wants memory recall, knowledge evidence, skill metadata, or session audit context as structured data.
Use [`AGENT_TOOL_CALLING.md`](AGENT_TOOL_CALLING.md) when the caller needs OpenAI-compatible or Anthropic-compatible tool schemas.

## Four Stores

- `memory`: short facts, preferences, and active context. `query_context` assembles task-scoped context from canonical role pages, search hits, links, and optional evidence.
- `knowledge`: long-term notes under `/Knowledge/...` plus raw evidence under `/Sources/<provider>/...`. Wiki links form the knowledge mesh; `source_evidence` resolves store references for a known node.
- `skill`: reusable `SKILL.md` packages under `/Skills/...`. The Skill Registry CLI owns package upsert, snapshots, discovery, run evidence, rollback, and status workflows.
- `session`: agent session state under `/Sessions/...` plus session transcript evidence under `/Sources/sessions/...`. Resumable summaries are outside v1.

Context Pack is an export artifact generated from store content. It is not a store.
Its `Reference` concepts identify Kinic targets with `kinic.store` and `kinic.store_path`, so `/Sources/<provider>/...`, `/Sources/sessions/...`, `/Sources/skill-runs/...`, and `/Sessions/...` can be represented without copying referenced bodies into the bundle.
Curator is a future maintenance workflow for skill and knowledge; it is not part of Store API v1.

## Trust Model

Kinic store trust follows this lifecycle:

```text
/Sources/<provider>/... -> human review -> role page -> query_context
```

- `/Sources/<provider>/...` is canonical raw evidence.
- `/Knowledge/...` is organized knowledge, but not automatically canonical.
- Working notes can help review, but they are not a separate canonical lifecycle state.
- Role pages are the memory recall layer when their claims are backed by source evidence or human review.
- Agents should prefer role-page claims plus `source_evidence` over working-note text or search previews.

Role-page responsibilities:

- `facts.md`: stable facts, current values, selected options, and stable relationships.
- `events.md`: completed dated events.
- `plans.md`: future or pending items, next actions, temporary constraints, and active operational policies.
- `preferences.md`: preferences, decision criteria, and durable choices.
- `open_questions.md`: unresolved items, conflicts, and evidence gaps.
- `provenance.md`: raw source ids, source paths, import metadata, and review trace.
- `summary.md`, `overview.md`, and `topics/*.md`: synthesis and orientation, not final evidence for exact claims.

Do not place future, pending, unresolved, chronology-only, or recap content in `facts.md`.
Do not answer from working notes as if they were canonical memory.

## Prerequisites

- `canister_id`: the Kinic Wiki canister to query.
- `database_id`: the target database inside that canister.
- Public databases require reader access for the anonymous principal `2vxsx-fae` when queried without identity.
- Private databases require an identity client whose principal is a database member.

## Methods

- `memory_manifest(MemoryManifestRequest)`: discover the API version, enabled stores, roots, capability summary, canonical roles, limits, and recommended entrypoint.
- `query_context(QueryContextRequest)`: read task-scoped knowledge context. This is the primary entrypoint for normal agent questions.
- `query_database_sql_json(database_id, sql, limit)`: run a database-scoped read-only SQL query and receive JSON object text rows.
- `source_evidence(SourceEvidenceRequest)`: read `/Sources` evidence references for one known knowledge node path.

These methods are canister query methods. They do not mutate wiki content.

## Manifest Contract

`memory_manifest({ database_id })` currently returns:

- `api_version`: `kinic-stores-v1`
- `enabled_stores`: `memory`, `knowledge`, `skill`, and `session`
- `roots`: memory role pages, knowledge notes and evidence, skill packages and run evidence, session state and session evidence
- `entry_roots`: primary roots for the enabled stores
- `write_policy`: `stores_read_only`
- `recommended_entrypoint`: `query_context`
- `max_depth`: `2`
- `max_query_limit`: `100`
- `budget_unit`: `approx_chars_from_tokens`

Treat `capabilities` and `canonical_roles` as discovery data.
Do not use `memory_manifest({ database_id })` as content evidence for an answer.
The `canonical_roles` list mirrors the current wiki schema. Agents should use it to find role pages before relying on broad search results.

## Memory Recall

`query_context` accepts:

- `database_id`: target database id.
- `task`: user task or question.
- `entities`: optional names, topics, or paths that should bias recall.
- `namespace`: optional scope root. If omitted, `query_context` uses `/Memory`.
- `budget_tokens`: approximate context budget. `0` uses the canister default.
- `include_evidence`: include knowledge evidence for returned knowledge nodes when true.
- `depth`: local graph depth. Valid values are `0`, `1`, and `2`.

Minimal request shape:

```json
{
  "database_id": "<database-id>",
  "task": "summarize current project decisions",
  "entities": [],
  "namespace": "/Memory",
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
Treat `search_hits` as recall and routing data.
Treat `nodes` from canonical role pages as the primary memory payload.
Treat working-note nodes as unreviewed unless the same claim is present in a role page.
If `truncated` is true, narrow the `namespace`, reduce `entities`, or issue a follow-up query for a more specific task.
`query_context` reserves budget for node context and evidence before adding search hit previews, so small budgets still return answerable node content when at least one candidate fits the namespace.

## Knowledge Evidence

Use `source_evidence` when the caller already knows the exact knowledge node path and needs source refs for trust checking or citations.
The request takes `database_id` and `node_path`.
The response returns the knowledge `node_path` and refs with source path, linking path, raw href, and link text.
Refs also include source freshness metadata when the source node can be read: `source_etag`, `source_updated_at`, and `source_content_hash`.
Use freshness metadata to detect whether a citation was checked against the same source revision.
Freshness metadata does not make a working note canonical.

`source_evidence` returns an error when the knowledge node does not exist.

## Database SQL JSON Query

Use `query_database_sql_json` when a caller needs direct structured inspection of the target wiki DB.
The method uses the same read access as `read_node`: database members, marketplace-entitled readers, and anonymous callers for public-readable DBs can query the DB they can already read.
The browser Query panel `sql:` action and CLI `query-sql` command both call this same database-scoped API.

The method only runs against the specified wiki DB. Reader, public reader, and marketplace-entitled callers can only issue the restricted JSON `SELECT` below against `fs_nodes` or `fs_links`.
It cannot read the canister index DB, controller metrics tables, session tables, marketplace orders, billing tables, migration tables, change-log tables, path-state tables, or other internal tables.

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
  "rows": ["{\"path\":\"/Knowledge/example.md\",\"updated_at\":1700000000000}"],
  "row_count": 1,
  "limit": 20
}
```

## Public Wiki Metrics

`wiki_metrics` and `wiki_metrics_series(days)` are unauthenticated public aggregate telemetry APIs.
They expose user and database counts, paid user totals, charged KINIC totals in e8s, and `last_activity_at_ms`.
`wiki_metrics_series(days)` clamps `days` to `1..7`; `0` returns one point and values above `7` return seven points.
Controller-only operational SQL remains separate in `query_index_sql_json`; database readers cannot call that index DB API.

## v1 Limits

- The Store API v1 is read-only.
- Writes must use CLI commands, VFS mutation APIs, or the shared tool dispatcher.
- `memory_summary` is not part of v1. Use `query_context` with a summary-style task when a maintained overview is needed.
- Skill curator, knowledge curator, ambient surfacing, synonyms, and session resume summaries are outside v1.
