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

## v1 Limits

- The Agent Memory API v1 is read-only.
- Writes must use CLI commands, VFS mutation APIs, or the shared tool dispatcher.
- `recent_changes` is not part of v1. Use `recent_nodes` through the VFS API when recent live nodes are needed.
- `memory_summary` is not part of v1. Use `query_context` with a summary-style task when a maintained overview is needed.
