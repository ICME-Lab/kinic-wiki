# Kinic Wiki Remote MCP

`workers/wiki-mcp` provides two read-only remote MCP boundaries:

- production is public and anonymous;
- staging requires OAuth and an Internet Identity MCP grant, and can read databases granted to that principal.

## Boundary

- Production reads public databases only and queries the canister anonymously.
- Staging exposes the same eight tools through an Internet Identity delegated principal. It does not add write tools.
- Private database authorization remains in the Kinic canister; the Worker does not accept a database owner principal as input.
- Billing, marketplace purchase, and archive operations are not exposed.
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

On staging, unauthenticated `GET /mcp` and `POST /mcp` return `401` with RFC 9728 protected-resource metadata in `WWW-Authenticate`. Production keeps the anonymous contract.

## Staging authentication

Register this exact connector URL in Internet Identity Settings:

```text
https://wiki-mcp-staging.kinic.xyz/mcp
```

The implementation follows the Internet Identity MCP server guide pinned to commit [`5c0a5a64df3c87f1b98c489ef1c8d897bf002149`](https://github.com/dfinity/internet-identity/blob/5c0a5a64df3c87f1b98c489ef1c8d897bf002149/docs/mcp-server-guide.md).

Discovery and OAuth endpoints:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /.well-known/ii-auth-callbacks`
- `GET|POST /mcp/connect`

OAuth uses authorization code with mandatory S256 PKCE. The only scopes are `mcp:read` and `offline_access`; the audience is fixed to `https://wiki-mcp-staging.kinic.xyz/mcp`. Access tokens last at most one hour, refresh tokens rotate on every use, and the local session cannot exceed eight hours or the II grant expiration.

The II registration grant is accepted only when `mcp_register_v2` reports `queries`. Each authenticated MCP request then calls `mcp_get_accounts`, `mcp_prepare_delegation`, and `mcp_get_delegation` for the exact target origin `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`. The resulting per-app delegation is read-only, lasts at most five minutes, and is never cached across requests.

II revocation takes effect the next time staging tries to mint a per-app delegation. The local OAuth session is invalidated and the client receives `invalid_token`; reconnect through the client to restore access. Changing `MCP_KEY_ENCRYPTION_KEY` intentionally invalidates all existing sessions.

The II callback returns stable, non-sensitive errors:

- `400 invalid_connection`: the callback, initiator binding, delegation, or local encrypted session is invalid or expired;
- `401 registration_rejected`: II rejected `mcp_register_v2`;
- `403 read_only_required`: II returned a permission other than `queries`;
- `503 temporarily_unavailable`: the II Actor or registration call failed.

Staging logs only a random trace id, the connection stage, the stable error code, and the HTTP status. It does not log OAuth state, session ids, authorization codes, delegation chains, tokens, keys, raw principals, II error bodies, or private database text.

## Tools

- `find_databases`
  - Input: `{ "query": "agent memory", "limit": 10 }`
  - Reads `list_databases()` as the request principal (anonymous in production, II delegated in staging)
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

Authenticated staging smoke:

```bash
pnpm --dir workers/wiki-mcp smoke:staging -- --open

pnpm --dir workers/wiki-mcp smoke:staging -- \
  --open \
  --database-id db_private_example \
  --path /Knowledge/index.md
```

The staging client uses a random OAuth state, S256 PKCE, and an ephemeral `127.0.0.1` callback. It verifies the exact eight-tool contract and runs `find_databases`; when a database id is supplied, it also runs `context`, and when a path is supplied, `read_path`. Output contains only tool counts, visibility/success flags, and response byte lengths.

## Configuration

Production uses `wrangler.jsonc`; staging uses `wrangler.staging.jsonc` and a separate Worker plus Durable Object namespace.

- `KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai`
- `KINIC_WIKI_IC_HOST=https://icp0.io`
- `KINIC_WIKI_PUBLIC_ORIGIN=https://wiki.kinic.xyz`

Cloudflare custom domains:

- `wiki-mcp.kinic.xyz` belongs only to `kinic-wiki-mcp`.
- `wiki-mcp-staging.kinic.xyz` belongs only to `kinic-wiki-mcp-staging`.

Before deploying staging, create a 32-byte random value and store its base64/base64url form as a secret:

```bash
pnpm --dir workers/wiki-mcp exec wrangler secret put MCP_KEY_ENCRYPTION_KEY --config wrangler.staging.jsonc
```

Do not put this value in Wrangler vars or logs. Production has no auth-state binding and does not share staging storage.

## ChatGPT Developer Mode

Use a separate wiki app or staging app. Do not replace the existing memory app endpoint.

1. In II Settings, add `https://wiki-mcp-staging.kinic.xyz/mcp` as the trusted connector.
2. Configure the same MCP URL in ChatGPT/Codex and complete OAuth plus the II read-only consent.
3. Refresh tools.
4. Confirm tools list contains exactly `find_databases`, `search`, `fetch_many`, `read_path`, `read_paths`, `list`, `memory_manifest`, and `context`.
5. Run review test cases:
   - `find_databases` can select `KINIC-WIKI`.
   - `context` returns task-scoped nodes and evidence for a known public DB.
   - `search` for `clipper usage` returns an evidence node with `preview_mode: "content-start"`.
   - `list` with `prefix: "/"` discovers top-level prefixes.
   - `fetch_many` returns node text for one or more search result ids.
   - `read_path` returns node text for a known path.
   - `read_paths` returns multiple known path bodies and item-level missing-path errors.
   - a known owner private database is visible and readable;
   - the same database stays unavailable anonymously and to another principal;
   - unknown or stale ids return a common unavailable error.
6. Disable or remove the connector in II Settings and verify the next MCP request returns `invalid_token`.

Production promotion, write tools, and non-default II account selection are outside this release.

For the public production review submission, choose **With MCP**, attach `skills/kinic-wiki-mcp/`, and do not package an `.app.json` reference to the existing Developer Mode app. Run the production submission smoke three times:

```bash
pnpm --dir workers/wiki-mcp review:smoke -- --mcp-url https://wiki-mcp.kinic.xyz/mcp --repeats 3
```

Then run every positive and negative prompt from `workers/wiki-mcp/chatgpt-app-submission.json` twice in a new ChatGPT web conversation with the submitted plugin and skill attached.

## Review Checklist

- Production requires no credentials; staging requires OAuth plus an II read-only grant.
- No write tools.
- Production has no private database access.
- The submitted **With MCP** plugin includes `skills/kinic-wiki-mcp/`, and `agents/openai.yaml` points to `https://wiki-mcp.kinic.xyz/mcp`.
- Production responses contain only public database metadata, public node URLs, and public node text.
- Staging responses are restricted by the delegated caller in the Kinic canister.
- Logs do not include raw principals, delegations, tokens, private keys, or private database bodies.
- Responses do not include user ids, internal request/session ids, or secrets.
- `https://mcp.kinic.xyz/mcp` remains unchanged.
- `https://wiki.kinic.xyz` browser routes remain unchanged.
