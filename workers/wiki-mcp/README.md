# Kinic Wiki MCP

Remote MCP Worker for anonymous read-only Kinic Wiki recall.

Canonical documentation: `../../docs/mcp.md`.

## Endpoints

- Production: `https://wiki-mcp.kinic.xyz/mcp`
- Staging: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Local: `http://127.0.0.1:8787/mcp`

## Tools

- `find_databases`: discover public databases from public metadata.
- `search`: search one public database with canister FTS and selectable preview mode.
- `fetch`: read one search result node by opaque id.
- `fetch_many`: read up to 10 search result nodes by opaque ids.
- `read_path`: read one known VFS path without a search result id.
- `read_paths`: read up to 10 known VFS paths with one restricted SQL query.
- `list`: list node inventory under a prefix without content.
- `memory_manifest`: discover Store API roots, capabilities, and limits.
- `context`: read task-scoped context through `query_context`.
- `source_evidence`: read source references for one known knowledge node path.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```
