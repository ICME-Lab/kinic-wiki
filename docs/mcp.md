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
  - Ranks public database metadata using name, tags, summary, and description
- `search`
  - Input: `{ "database_id": "db_...", "query": "...", "prefix": "/", "limit": 10, "preview_mode": "light" }`
  - Calls canister `search_nodes`
  - `preview_mode` accepts `light`, `content-start`, or `none`; use `content-start` for broad/list/classification candidate review
  - Returns fetchable opaque ids
- `fetch`
  - Input: `{ "id": "<id-from-search>" }`
  - Decodes the opaque id and calls canister `read_node`
- `fetch_many`
  - Input: `{ "ids": ["<id-from-search>"] }`
  - Fetches up to 10 search result ids and returns item-level errors for invalid or stale ids
- `read_path`
  - Input: `{ "database_id": "db_...", "path": "/Knowledge/index.md" }`
  - Calls canister `read_node` for a known path without requiring a search result id
- `read_paths`
  - Input: `{ "database_id": "db_...", "paths": ["/Knowledge/a.md", "/Knowledge/b.md"] }`
  - Reads 2 to 10 known paths with one restricted `query_database_sql_json` call
  - Use for multiple paths from `list`, `context`, or `search` metadata
- `list`
  - Input: `{ "database_id": "db_...", "prefix": "/", "recursive": false, "limit": 99 }`
  - Calls canister `list_nodes`
  - Use for inventory and prefix discovery; it does not return node content
- `context`
  - Input: `{ "database_id": "db_...", "task": "...", "entities": [], "namespace": "/Knowledge", "budget_tokens": 2000, "include_evidence": true, "depth": 1 }`
  - Calls canister `query_context`
  - Use first for normal question answering and task-scoped context collection

All tools keep read-only annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

## Agent Read Workflows

For normal question answering, call `context` first and answer from returned nodes and evidence. Treat `search_hits` as routing data, not final evidence.

For broad, list, or classification tasks:

1. Build a candidate set with multiple `search` calls. Use query variants such as the raw user phrase, key nouns, synonyms, title terms, and topic terms.
2. Use `preview_mode: "content-start"` when search result previews are used for candidate classification.
3. If `/Knowledge` is thin, use `list` with `prefix: "/"` to discover top-level prefixes, then search `/Sources` and any discovered wiki prefix such as `/Wiki`.
4. Separate title/path matches from topic or ability-term matches before synthesis. Do not mix another work's ability evidence into a title-matched work.
5. Use `fetch_many` for several search result ids. Use `read_paths` for 2 or more known paths from `list`, `context`, or `search` metadata. Use `read_path` for a single final evidence check.
6. Report coverage limits: search queries, prefixes checked, fetched count, excluded candidates, and any `truncated: true` results.

Recipe list example:

- Search `レシピ`, `作り方`, `料理`, and `recipe` with `prefix: "/"`.
- Search `/Sources` when curated `/Knowledge` nodes are sparse.
- Dedupe by path, title, source URL, and overlapping preview text.
- Fetch representative and ambiguous candidates, not every low-confidence hit.

Title plus ability example:

- Search the title term separately from `能力`, `スキル`, `魔法`, and discovered ability terms.
- Group evidence by work/source before answering.
- Mark cross-work generalization as inference.

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
3. Confirm tools list contains exactly `find_databases`, `search`, `fetch`, `fetch_many`, `read_path`, `read_paths`, `list`, and `context`.
4. Run review test cases:
   - `find_databases` can select `KINIC-WIKI`.
   - `context` returns task-scoped nodes and evidence for a known public DB.
   - `search` for `clipper usage` returns an evidence node with `preview_mode: "content-start"`.
   - `list` with `prefix: "/"` discovers top-level prefixes.
   - `fetch` and `fetch_many` return node text for search result ids.
   - `read_path` returns node text for a known path.
   - `read_paths` returns multiple known path bodies and item-level missing-path errors.
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
