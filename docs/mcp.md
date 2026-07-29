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
- `fetch_many`
  - Input: `{ "ids": ["<id-or-public-url-from-search>"] }`
  - Fetches 1 to 10 search results by the exact opaque `id` or public `url` returned by `search`, and returns item-level errors for invalid or stale references
  - Do not pass ChatGPT citation tokens such as `turn0file0`; if an opaque id is hidden, construct `https://wiki.kinic.xyz/db/{database_id}{path}` from the result metadata
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
- `memory_manifest`
  - Input: `{ "database_id": "db_..." }`
  - Calls canister `memory_manifest`
  - Use to discover Store API roots, capabilities, roles, and limits
- `context`
  - Input: `{ "database_id": "db_...", "task": "...", "entities": [], "namespace": "/", "budget_tokens": 2000, "include_evidence": true, "depth": 1 }`
  - Calls canister `query_context`
  - Use first for normal question answering and task-scoped context collection
  - Omitting `namespace` searches from `/`; pass `/Knowledge` explicitly to restrict recall to that store

All tools keep read-only annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false`

## Agent Read Workflows

For normal question answering, call `context` first and answer from returned nodes and evidence. Treat `search_hits` as routing data, not final evidence.

For broad, list, or classification tasks:

1. Build a candidate set with multiple `search` calls. Use query variants such as the raw user phrase, key nouns, synonyms, title terms, and topic terms.
2. Use `preview_mode: "content-start"` when search result previews are used for candidate classification.
3. Use `list` with `prefix: "/"` to discover top-level prefixes, then narrow later searches to `/Knowledge`, `/Sources`, or a discovered wiki prefix such as `/Wiki` when useful.
4. Separate title/path matches from topic or ability-term matches before synthesis. Do not mix another work's ability evidence into a title-matched work.
5. Use `fetch_many` for one or more exact search result ids or public URLs. Use `read_paths` for 2 or more known paths from `list`, `context`, or `search` metadata. Use `read_path` for a single known-path evidence check. Use returned `context.evidence` for source-reference trust checks.
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

- `KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai`
- `KINIC_WIKI_IC_HOST=https://icp0.io`
- `KINIC_WIKI_PUBLIC_ORIGIN=https://wiki.kinic.xyz`

Cloudflare custom domains:

- `wiki-mcp.kinic.xyz`
- `wiki-mcp-staging.kinic.xyz`

## ChatGPT Developer Mode

Use a separate wiki app or staging app. Do not replace the existing memory app endpoint.

1. Configure MCP URL as `https://wiki-mcp-staging.kinic.xyz/mcp`.
2. Attach `skills/kinic-wiki-mcp/` to the plugin. For the public review submission, choose **With MCP** and submit the MCP with this skill; do not package an `.app.json` reference to the existing Developer Mode app.
3. Refresh tools.
4. Confirm tools list contains exactly `find_databases`, `search`, `fetch_many`, `read_path`, `read_paths`, `list`, `memory_manifest`, and `context`.
5. Run review test cases:
   - `find_databases` selects `hono-docs`.
   - `context` defaults to `/` and returns Hono testing guidance for `app.request` and `testClient`.
   - `search` for `testing app.request testClient` under `/Wiki` returns testClient guidance with `preview_mode: "content-start"`.
   - `list` with `prefix: "/"` and `limit: 99` discovers top-level prefixes.
   - `fetch_many` returns text for the strongest search results.
   - `read_path` returns `/Knowledge/sources/honojs__hono/index.md`.
   - `read_paths` returns two Hono testClient pages.
   - private, unknown, or stale ids return errors.
6. Run the automated submission smoke three times against both configured endpoints. This also validates the attached skill instructions, tool reference, and OpenAI MCP dependency:

```bash
pnpm --dir workers/wiki-mcp review:smoke -- --repeats 3
```

7. Run every positive and negative prompt from `workers/wiki-mcp/chatgpt-app-submission.json` twice in a new ChatGPT web conversation with the submitted plugin and skill attached.
8. Deploy only after local checks pass, then repeat steps 6 and 7 before resubmission. The current Cloudflare configuration routes staging and production hostnames to the same Worker, so staging checks endpoint parity rather than an isolated pre-production deployment.

## Review Checklist

- No credentials required.
- No write tools.
- No private database access.
- The submitted **With MCP** plugin includes `skills/kinic-wiki-mcp/`, and `agents/openai.yaml` points to `https://wiki-mcp.kinic.xyz/mcp`.
- Responses contain only public database metadata, public node URLs, and public node text.
- Responses do not include user ids, internal request/session ids, or secrets.
- `https://mcp.kinic.xyz/mcp` remains unchanged.
- `https://wiki.kinic.xyz` browser routes remain unchanged.
