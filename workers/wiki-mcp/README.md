# Kinic Wiki MCP

Remote MCP Workers for Kinic Wiki recall: anonymous read-only production and Internet Identity authenticated read-only staging.

Canonical documentation: `../../docs/mcp.md`.

## Endpoints

- Production: `https://wiki-mcp.kinic.xyz/mcp`
- Staging: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Local: `http://127.0.0.1:8787/mcp`

## Tools

- `find_databases`: discover databases visible to the request principal (public databases in production).
- `search`: search one database visible to the request principal with canister FTS and selectable preview mode.
- `fetch_many`: read 1 to 10 search result nodes by exact opaque ids or public URLs returned by `search`.
- `read_path`: read one known VFS path without a search result id.
- `read_paths`: read up to 10 known VFS paths with one restricted SQL query.
- `list`: list node inventory under a prefix without content.
- `memory_manifest`: discover Store API roots, capabilities, and limits.
- `context`: read task-scoped context through `query_context`.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm smoke:staging -- --open
```

Pass `--database-id <id>` and `--path <known-path>` to the staging smoke command to verify private database visibility plus `context` and `read_path`. The command reports only success flags and response sizes, not tokens or private node text.
