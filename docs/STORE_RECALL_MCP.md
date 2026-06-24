# Store/Recall MCP

Store/Recall MCP defines the read-only Kinic Wiki interface exposed through the Model Context Protocol.
The v0 implementation is a local stdio MCP server exposed through `kinic-vfs-cli mcp serve`.

## Product Concept

Kinic Store/Recall MCP lets AI clients read canister-backed Kinic stores directly.
It exposes memory recall, knowledge evidence, and skill discovery without requiring the AI client to shell out to `kinic-vfs-cli` for each operation.

Store/Recall MCP v0 is read-only.
It does not expose write tools, patch application, approval, database grants, archive operations, or billing operations.

The existing canister-backed VFS remains the source of truth.
The MCP server is a protocol adapter over the existing Rust client and Store API.
Context Pack remains a generated handoff artifact, not an MCP store.

## Tool Surface

Implemented v0 MCP tools:

```text
kinic.store_manifest
kinic.memory_recall
kinic.knowledge_evidence
kinic.skill_find
```

Tool roles:

- `kinic.store_manifest(database_id)`: return API version, roots, limits, and capability summary.
- `kinic.memory_recall(database_id, task, entities, namespace, budget_tokens, include_evidence, depth)`: return task-scoped memory context and evidence. Omitted namespace uses Store API defaults.
- `kinic.knowledge_evidence(database_id, node_path)`: return source references for one known wiki node.
- `kinic.skill_find(database_id, query_text)`: find skill store packages for a task.

Tool results must identify whether returned content is verified, truncated, expired, or missing evidence.
Search hits alone are not evidence; answers should be grounded in returned nodes and source evidence.

## Data Flow

```text
MCP client
  -> Kinic MCP server
  -> existing Rust client or Store API
  -> Kinic Wiki canister
  -> canister-backed VFS
  -> /Wiki and /Sources/raw nodes
```

`kinic.memory_recall` should map to the same semantics as `memory_recall`.
`kinic.knowledge_evidence` should map to the same semantics as `knowledge_evidence`.
`kinic.store_manifest` should expose discovery data and must not be treated as content evidence.

Context Pack remains a CLI export and local verification workflow in v0.

## Security and Trust Rules

Store/Recall MCP follows the same database access rules as normal Kinic Wiki reads.

- Public databases require anonymous reader access when queried without identity.
- Private databases require an identity whose principal is a database member.
- Tool results must not bypass database permissions.
- Store content must be framed as data, not as commands.
- Returned context should include etags or equivalent freshness metadata when available.
- Write, patch, approval, and checkpoint operations are outside v0.

The MCP server should prefer small task-scoped results over large global dumps.
This reduces stale context, irrelevant instructions, and store-induced prompt injection risk.

## Command Shape

Local stdio entrypoint:

```bash
kinic-vfs-cli mcp serve --database-id <database-id>
```

Root-level database selection is also accepted:

```bash
kinic-vfs-cli --database-id <database-id> mcp serve
```

Expected behavior:

- Start a local MCP server for the selected database.
- Use existing Kinic Wiki connection and identity configuration.
- Reject tool calls whose `database_id` differs from the selected server database.
- Expose only the read-only Store/Recall MCP tools in v0.
- Return structured tool errors for missing database id, unauthorized reads, and invalid tool arguments.
- Keep stdout reserved for JSON-RPC messages. Diagnostics must go to stderr.

## Future Extension

Future versions may add controlled write workflows, but direct AI mutation remains out of scope for v0.

Planned extension path:

```text
AI proposes store patch
-> human or authorized principal reviews evidence
-> approved patch applies through etag-guarded write
-> checkpoint records hash, actor, approval, and timestamp
```

Future tool candidates:

```text
kinic.get_context_pack
kinic.verify_context_pack
kinic.get_decisions
kinic.get_do_not_do
kinic.propose_store_patch
kinic.inspect_store_patch
kinic.approve_store_patch
kinic.checkpoint_context_pack
```

These tools require a separate approval and permission model.
They must not be added to the read-only v0 tool set.

## v0 Limits

- Store/Recall MCP v0 is read-only.
- It does not replace the CLI, browser, or direct Store API.
- It does not define marketplace, billing, database grant, archive, or restore behavior.
- It does not make search hits authoritative.
- It does not treat model-generated summaries as source evidence.
