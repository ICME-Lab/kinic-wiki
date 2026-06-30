# Kinic Wiki Remote MCP

`workers/wiki-mcp` is a public, anonymous, read-only remote MCP server for Kinic Wiki databases.

## Boundary

- v1 reads public databases only.
- It does not expose writes, OAuth, private database reads, billing, marketplace purchase, or archive operations.
- It queries the configured Kinic Wiki canister anonymously.
- Existing memory app endpoint `https://mcp.kinic.xyz/mcp` is a separate service and must not be changed for Kinic Wiki.
- `https://wiki.kinic.xyz` remains the wiki browser and public node URL origin.

## Endpoint

- Production MCP: `https://wiki-mcp.kinic.xyz/mcp`
- Staging MCP: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Production health: `https://wiki-mcp.kinic.xyz/health`
- Staging health: `https://wiki-mcp-staging.kinic.xyz/health`
- Root info: `GET /`

Route behavior:

- `POST /mcp`: canonical MCP endpoint.
- `GET /mcp`: Streamable HTTP transport endpoint.
- `GET /health`: health JSON.
- `GET /`: human-readable info JSON with endpoint and tool names.
- `POST /`: not an MCP alias.

## Tools

- `find_databases`
  - Input: `{ "query": "agent memory", "limit": 10 }`
  - Reads anonymous `list_databases()`
  - Ranks public database metadata using title, tags, summary, and description
- `search`
  - Input: `{ "database_id": "db_...", "query": "...", "prefix": "/", "limit": 10 }`
  - Calls canister `search_nodes` with `preview_mode: Light`
  - Returns fetchable opaque ids
- `fetch`
  - Input: `{ "id": "<id-from-search>" }`
  - Decodes the opaque id and calls canister `read_node`

All tools keep read-only annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

## Local

```bash
pnpm --dir workers/wiki-mcp install
pnpm --dir workers/wiki-mcp test
pnpm --dir workers/wiki-mcp typecheck
pnpm --dir workers/wiki-mcp dev
```

Local MCP URL:

```text
http://127.0.0.1:8787/mcp
```

Local smoke:

```bash
curl -sS http://127.0.0.1:8787/health
curl -sS http://127.0.0.1:8787/
curl -sS http://127.0.0.1:8787/mcp \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Configuration

`wrangler.jsonc` defaults:

- `KINIC_WIKI_CANISTER_ID=xis3j-paaaa-aaaai-axumq-cai`
- `KINIC_WIKI_IC_HOST=https://icp0.io`
- `KINIC_WIKI_PUBLIC_ORIGIN=https://wiki.kinic.xyz`

Cloudflare custom domains:

- `wiki-mcp.kinic.xyz`
- `wiki-mcp-staging.kinic.xyz`

## ChatGPT Developer Mode

Use a separate wiki app or staging app. Do not replace the existing memory app endpoint.

1. Configure MCP URL as `https://wiki-mcp-staging.kinic.xyz/mcp`.
2. Refresh tools.
3. Confirm tools list contains exactly `find_databases`, `search`, and `fetch`.
4. Run review test cases:
   - `find_databases` can select `KINIC-WIKI`.
   - `search` for `clipper usage` returns an evidence node.
   - `fetch` returns node text for a search result id.
   - private, unknown, or stale ids return errors.
5. Promote the same configuration to `https://wiki-mcp.kinic.xyz/mcp` after staging passes.

## Review Checklist

- No credentials required.
- No write tools.
- No private database access.
- Responses contain only public database metadata, public node URLs, and public node text.
- Responses do not include user ids, internal request/session ids, or secrets.
- `https://mcp.kinic.xyz/mcp` remains unchanged.
- `https://wiki.kinic.xyz` browser routes remain unchanged.
