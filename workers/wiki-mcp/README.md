# Kinic Wiki MCP

Remote MCP Worker for anonymous read-only Kinic Wiki recall.

Canonical documentation: `../../docs/mcp.md`.

## Endpoints

- Production: `https://wiki-mcp.kinic.xyz/mcp`
- Staging: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Local: `http://127.0.0.1:8787/mcp`

## Tools

- `find_databases`: discover public databases from public metadata.
- `search`: search one public database with canister FTS.
- `fetch`: read one search result node by opaque id.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
```
