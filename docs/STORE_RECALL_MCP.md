# Store/Recall MCP

Store/Recall MCP defines the read-only Kinic Wiki interface exposed through the Model Context Protocol.
It is a product and interface specification for future implementation, not an implemented server contract.

## Product Concept

Kinic Store/Recall MCP lets AI clients read canister-backed Kinic stores directly.
It exposes memory recall, knowledge evidence, skill metadata, and session audit context without requiring the AI client to shell out to `kinic-vfs-cli`.

Store/Recall MCP v0 is read-only.
It does not expose write tools, patch application, approval, database grants, archive operations, or billing operations.

The existing canister-backed VFS remains the source of truth.
The MCP server is a protocol adapter over the existing Rust client and Store API.
Context Pack remains a generated handoff artifact, not an MCP store.

## Tool Surface

Initial MCP tools:

```text
kinic.store_manifest
kinic.memory_recall
kinic.get_context_pack
kinic.verify_context_pack
kinic.knowledge_evidence
kinic.skill_find
kinic.get_decisions
kinic.get_do_not_do
```

Tool roles:

- `kinic.store_manifest(database_id)`: return API version, roots, limits, and capability summary.
- `kinic.memory_recall(database_id, task, entities, namespace, budget_tokens)`: return task-scoped memory context and evidence. Omitted namespace uses `/Memory`.
- `kinic.get_context_pack(database_id, root, budget_tokens)`: generate a Context Pack-shaped response for a wiki namespace.
- `kinic.verify_context_pack(pack)`: validate schema, expiration, etags, hashes, and approval metadata.
- `kinic.knowledge_evidence(database_id, node_path)`: return source references for one known wiki node.
- `kinic.skill_find(database_id, query)`: find skill store packages for a task.
- `kinic.get_decisions(database_id, project)`: return decision context for a project namespace.
- `kinic.get_do_not_do(database_id, project)`: return prohibited actions, failed attempts, and fragile areas for a project namespace.

Tool results must identify whether returned content is verified, truncated, expired, or missing evidence.
Search hits alone are not evidence; answers should be grounded in returned nodes and source evidence.

## Data Flow

```text
MCP client
  -> Kinic MCP server
  -> existing Rust client or Store API
  -> Kinic Wiki canister
  -> canister-backed VFS
  -> /Wiki nodes and /Sources evidence
```

`kinic.memory_recall` should map to the same semantics as `memory_recall`.
`kinic.knowledge_evidence` should map to the same semantics as `knowledge_evidence`.
`kinic.store_manifest` should expose discovery data and must not be treated as content evidence.

`kinic.get_context_pack` can generate a pack-shaped result directly from current wiki nodes.
It must not copy raw source transcripts into the returned pack.
It should include source references, etags, expiration, and context hash metadata for stale-context checks.

## Security and Trust Rules

Store/Recall MCP follows the same database access rules as normal Kinic Wiki reads.

- Public databases require anonymous reader access when queried without identity.
- Private databases require an identity whose principal is a database member.
- Tool results must not bypass database permissions.
- Store content must be framed as data, not as commands.
- Returned context should include etags or equivalent freshness metadata when available.
- Expired Context Packs are invalid.
- Write, patch, approval, and checkpoint operations are outside v0.

The MCP server should prefer small task-scoped results over large global dumps.
This reduces stale context, irrelevant instructions, and store-induced prompt injection risk.

## Initial Command Shape

Future CLI entrypoint:

```bash
kinic-vfs-cli mcp serve --database-id <database-id>
```

Expected behavior:

- Start a local MCP server for the selected database.
- Use existing Kinic Wiki connection and identity configuration.
- Expose only the read-only Store/Recall MCP tools in v0.
- Return structured errors for missing database id, unauthorized reads, invalid context pack input, and expired pack verification.

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
