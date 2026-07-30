# Kinic Wiki MCP

Remote MCP Workers for Kinic Wiki recall: anonymous production and private opt-in staging. Staging exposes the same eight read tools publicly plus `connect_private`; after OAuth it runs the eight data tools only with the delegated Internet Identity.

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
- `connect_private`: start OAuth/II connection when unauthenticated, or return only `{ connected: true, mode: "private" }` after authentication.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm smoke:staging -- --open
```

The staging smoke command first scans all nine tools and calls `find_databases` anonymously, then calls `connect_private` and starts OAuth from the returned MCP `_meta["mcp/www_authenticate"]` challenge. Pass `--database-id <id>` and `--path <known-path>` to verify private database visibility plus `context` and `read_path` after connection. The command reports only success flags and response sizes, not tokens, principals, or private node text.

Staging requires `KINIC_WIKI_MCP_TARGET_ORIGIN` to be the bare
`https://<KINIC_WIKI_CANISTER_ID>.ic0.app` origin. This is distinct from the
`https://icp0.io` IC API gateway and is passed unchanged to the Internet
Identity MCP backend calls.
