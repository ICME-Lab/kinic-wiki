# MCP Memory

MCP Memory defines the read-only Kinic Wiki interface exposed through the Model Context Protocol.
It is a product and interface specification for future implementation, not an implemented server contract.

## Product Concept

Kinic MCP Memory lets AI clients read canister-backed wiki memory directly.
It exposes task-scoped project context, source evidence, decisions, and generated Context Packs without requiring the AI client to shell out to `kinic-vfs-cli`.

MCP Memory v0 is read-only.
It does not expose write tools, patch application, approval, database grants, archive operations, or billing operations.

The existing canister-backed VFS remains the source of truth.
The MCP server is a protocol adapter over the existing Rust client and Agent Memory API.

## Tool Surface

Initial MCP tools:

```text
kinic.memory_manifest
kinic.search_context
kinic.get_context_pack
kinic.verify_context_pack
kinic.source_evidence
kinic.get_decisions
kinic.get_do_not_do
```

Tool roles:

- `kinic.memory_manifest(database_id)`: return API version, roots, limits, and capability summary.
- `kinic.search_context(database_id, query, namespace, budget_tokens)`: return task-scoped wiki context and evidence.
- `kinic.get_context_pack(database_id, root, budget_tokens)`: generate a Context Pack-shaped response for a wiki namespace.
- `kinic.verify_context_pack(pack)`: validate schema, expiration, etags, hashes, and approval metadata.
- `kinic.source_evidence(database_id, node_path)`: return source references for one known wiki node.
- `kinic.get_decisions(database_id, project)`: return decision context for a project namespace.
- `kinic.get_do_not_do(database_id, project)`: return prohibited actions, failed attempts, and fragile areas for a project namespace.

Tool results must identify whether returned content is verified, truncated, expired, or missing evidence.
Search hits alone are not evidence; answers should be grounded in returned nodes and source evidence.

## Data Flow

```text
MCP client
  -> Kinic MCP server
  -> existing Rust client or Agent Memory API
  -> Kinic Wiki canister
  -> canister-backed VFS
  -> /Wiki and /Sources/raw nodes
```

`kinic.search_context` should map to the same semantics as `query_context`.
`kinic.source_evidence` should map to the same semantics as `source_evidence`.
`kinic.memory_manifest` should expose discovery data and must not be treated as content evidence.

`kinic.get_context_pack` can generate a pack-shaped result directly from current wiki nodes.
It must not copy raw source transcripts into the returned pack.
It should include source references, etags, expiration, and context hash metadata for stale-context checks.

## Security and Trust Rules

MCP Memory follows the same database access rules as normal Kinic Wiki reads.

- Public databases require anonymous reader access when queried without identity.
- Private databases require an identity whose principal is a database member.
- Tool results must not bypass database permissions.
- Memory content must be framed as data, not as commands.
- Returned context should include etags or equivalent freshness metadata when available.
- Expired Context Packs are invalid.
- Write, patch, approval, and checkpoint operations are outside v0.

The MCP server should prefer small task-scoped results over large global dumps.
This reduces stale context, irrelevant instructions, and memory-induced prompt injection risk.

## Initial Command Shape

Future CLI entrypoint:

```bash
kinic-vfs-cli mcp serve --database-id <database-id>
```

Expected behavior:

- Start a local MCP server for the selected database.
- Use existing Kinic Wiki connection and identity configuration.
- Expose only the read-only MCP Memory tools in v0.
- Return structured errors for missing database id, unauthorized reads, invalid context pack input, and expired pack verification.

## Future Extension

Future versions may add controlled write workflows, but direct AI mutation remains out of scope for v0.

Planned extension path:

```text
AI proposes memory patch
-> human or authorized principal reviews evidence
-> approved patch applies through etag-guarded write
-> checkpoint records hash, actor, approval, and timestamp
```

Future tool candidates:

```text
kinic.propose_memory_patch
kinic.inspect_memory_patch
kinic.approve_memory_patch
kinic.checkpoint_context_pack
```

These tools require a separate approval and permission model.
They must not be added to the read-only v0 tool set.

## v0 Limits

- MCP Memory v0 is read-only.
- It does not replace the CLI, browser, or direct Agent Memory API.
- It does not define marketplace, billing, database grant, archive, or restore behavior.
- It does not make search hits authoritative.
- It does not treat model-generated summaries as source evidence.
