# Store/Recall MCP

`kinic-vfs-cli mcp serve` starts a local stdio MCP server for read-only Store/Recall tools.
It is a protocol adapter over the existing Kinic Wiki Store API and Rust client.
See [`STORE_RECALL_MCP.md`](STORE_RECALL_MCP.md) for the interface contract.

## Start

Use the selected database as the MCP server scope:

```bash
kinic-vfs-cli mcp serve --database-id <database-id>
```

During development:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- mcp serve --database-id <database-id>
```

Root-level database selection also works:

```bash
kinic-vfs-cli --database-id <database-id> mcp serve
```

The server uses the same connection and identity resolution as other read-only DB commands.
Public databases can use anonymous reads when granted to `2vxsx-fae`.
Private databases require the selected `icp-cli` identity to be a database member.

## Client Config

MCP client configuration shape:

```json
{
  "mcpServers": {
    "kinic": {
      "command": "kinic-vfs-cli",
      "args": ["mcp", "serve", "--database-id", "<database-id>"]
    }
  }
}
```

The MCP process writes JSON-RPC messages to stdout.
Diagnostics must go to stderr.

## Tools

v0 exposes only read-only Store/Recall tools:

- `kinic.memory_manifest`
- `kinic.query_context`
- `kinic.source_evidence`
- `kinic.skill_find`

Each tool call must pass the same `database_id` used to start the server.
Calls with a different `database_id` are rejected as tool errors.

## Limits

v0 does not expose writes, Context Pack tools, billing, marketplace, grants, archive, or restore operations.
Remote Streamable HTTP, resources, prompts, and patch approval workflows are future work.
