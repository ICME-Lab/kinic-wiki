# Kinic Wiki Remote MCP

`workers/wiki-mcp` provides two deployment stages:

- production is public, anonymous, and read-only;
- staging is private opt-in: unauthenticated requests stay read-only, while authenticated requests use an Internet Identity delegated Actor and may write content when II grants `Actions & questions`.

## Boundary

- Production reads public databases only and queries the canister anonymously.
- Staging exposes the existing eight read tools, `connect_private`, seven single-mutation tools, and two batch-mutation tools. Reads work anonymously; connection and mutations require OAuth.
- After connection, all eight data tools use only the delegated principal. Anonymous public database results are not merged into private results.
- A supplied but invalid, expired, revoked, or wrong-resource Bearer token returns `401`; it never falls back to anonymous.
- Private database authorization remains in the Kinic canister; the Worker does not accept a database owner principal as input.
- Mutations are limited to VFS content CRUD. Database administration, members, billing, marketplace purchase, publication, and archive operations are not exposed.
- Production has `MCP_WRITE_POLICY=disabled`; staging has `MCP_WRITE_POLICY=private`. Missing or unknown policy values fail closed with `503`.
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

On staging, unauthenticated initialization, tool discovery, and calls to the eight read tools stay public. Read descriptors advertise `noauth` plus `mcp:read`; `connect_private` and mutation tools advertise OAuth-only `mcp:read mcp:write`. An unauthenticated single protected tool call returns an MCP tool error with `_meta["mcp/www_authenticate"]`; a JSON-RPC batch containing a protected tool makes the whole HTTP request authentication-required. The MCP POST body is limited to 256 KiB across the complete request or batch. Requests over that limit return `413` before token authentication. OAuth endpoint request bodies keep their separate 16 KiB limit.

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

OAuth uses authorization code with mandatory S256 PKCE and DCR. The scopes are `mcp:read`, `mcp:write`, and `offline_access`; the staging audience is fixed to `https://wiki-mcp-staging.kinic.xyz/mcp`. Authorization codes expire after at most ten minutes, access tokens last at most one hour, refresh tokens rotate on every use, and the local session cannot exceed eight hours or the II grant expiration. Reuse of an authorization code or rotated refresh token revokes the active local session. A session also requires a fresh connection after 64 refresh rotations.

DCR applies a best-effort limit of ten registration attempts per connecting IP per minute in each Cloudflare location. Cloudflare's rate limiter is eventually consistent, so concurrent requests can temporarily exceed that limit. A rejected request returns `429` with `Retry-After: 60`; a rate-limiter failure returns `503`. Registered clients expire after 180 days without use and extend that deadline when an unexpired client ID is referenced by an OAuth request.

The II registration grant accepts both `queries` (`Questions only`) and `all` (`Actions & questions`). Browser, CLI, and iOS login flows continue to request the public derivation origin `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`; the II frontend rewrites that gateway alias to the legacy canonical seed origin. The direct MCP backend calls pass `https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app` unchanged so they derive the same existing Kinic principal. A Questions-only grant removes `mcp:write` from the local OAuth session and remains read-only. An Actions & questions grant preserves `mcp:write` and enables content mutations. Delegations last at most five minutes and are never cached across requests.

II revocation takes effect the next time staging tries to mint a per-app delegation. The local OAuth session is invalidated and the client receives `invalid_token`; reconnect through the client to restore access. Changing `MCP_KEY_ENCRYPTION_KEY` intentionally invalidates all existing sessions.

The II callback returns stable, non-sensitive errors:

- `400 invalid_connection`: the callback, initiator binding, delegation, or local encrypted session is invalid or expired;
- `401 registration_rejected`: II rejected `mcp_register_v2`;
- `503 temporarily_unavailable`: the II Actor or registration call failed.

Staging logs only a random trace id, the connection, per-app delegation, or authenticated canister-call stage, the stable error code, and the HTTP status when applicable. It does not log OAuth state, session ids, authorization codes, delegation chains, tokens, keys, raw principals, II or canister error bodies, or private database text.

## Tools

- `find_databases`
  - Input: `{ "query": "agent memory", "limit": 10 }`
  - Reads `list_databases()` as the request principal (anonymous before connection, II delegated after connection)
  - Ranks only the metadata returned for that principal using name, tags, summary, and description
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
- `connect_private`
  - Input: `{}`
  - Without a Bearer token, returns an MCP tool error carrying `_meta["mcp/www_authenticate"]` so clients can start per-tool OAuth
  - After authentication, returns only `{ "connected": true, "mode": "private", "access": "read_only" | "read_write" }`
  - Does not return a principal, delegation, token, database list, or database content
- `write_node`, `append_node`, `edit_node`, `multi_edit_node`, `mkdir_node`, `move_node`, `delete_node`
  - Perform one content mutation; updates, moves, and deletes require the current etag
  - No Kinic-specific confirmation step is inserted before execution
- `write_nodes`
  - Atomically creates or replaces 1 to 100 nodes in one database
- `mutate_nodes_batch`
  - Atomically applies 1 to 100 ordered `write`, `append`, `edit`, `multi_edit`, `mkdir`, `move`, or `delete` operations in one database
  - The first failure rolls back the entire transaction and returns `failed_index`

Read tools keep read-only annotations. Mutation tools use `readOnlyHint: false`; delete and heterogeneous batch also use `destructiveHint: true`. Every tool keeps `openWorldHint: false`.

## Agent Write Workflow

1. Read task-scoped private context with `context`, `read_path`, or `read_paths`.
2. Generate the intended change and call a single mutation or an atomic batch directly. Kinic does not add a per-call confirmation prompt.
3. Persist the returned etag for later changes. A later conversation reads the same updated VFS nodes normally.
4. On `etag_conflict`, re-read the supplied `current_content` and `current_etag`, compare them with the intended edit, regenerate the change, and retry at most twice. If intent cannot be preserved safely, return the current/desired difference instead of overwriting.

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
  --path /Knowledge/index.md \
  --write-smoke-path /Knowledge/mcp-staging-smoke.md
```

The staging client uses a random OAuth state, S256 PKCE, and an ephemeral `127.0.0.1` callback. It verifies the exact 18-tool contract, runs public and private read checks, and optionally runs a write/batch/delete round trip at `--write-smoke-path`. The path must be new; cleanup uses the returned etag. Output contains only tool counts, success flags, and response byte lengths. This diagnostic client keeps OAuth credentials in memory only, so each process requires consent again. Normal clients retain and rotate their refresh token for the configured session lifetime and do not require consent for every tool call.

## Configuration

Production uses `wrangler.jsonc`; staging uses `wrangler.staging.jsonc` and a separate Worker plus Durable Object namespace.

- `KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai`
- `KINIC_WIKI_IC_HOST=https://icp0.io`
- `KINIC_WIKI_PUBLIC_ORIGIN=https://wiki.kinic.xyz`
- staging only: `KINIC_WIKI_MCP_TARGET_ORIGIN=https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app`
- production until promotion: `MCP_ACCESS_POLICY=public`
- staging: `MCP_ACCESS_POLICY=private_opt_in`
- production: `MCP_WRITE_POLICY=disabled`
- staging: `MCP_WRITE_POLICY=private`

`MCP_ACCESS_POLICY` accepts only `public`, `private_required`, or `private_opt_in`. `MCP_WRITE_POLICY` accepts only `disabled` or `private`. A missing or unknown value returns `503` instead of guessing another mode.

Staging requires both the `MCP_AUTH_STATE` Durable Object and `MCP_REGISTRATION_RATE_LIMIT` bindings. The V3 auth-state migration deletes V2 authorization state so permission and write scope cannot be inferred for old sessions. After deployment, every previously connected client must register and connect again. Production remains public and has neither binding.

`KINIC_WIKI_IC_HOST` is the IC API gateway. `KINIC_WIKI_MCP_TARGET_ORIGIN` is the exact origin used by the II backend to derive the existing Kinic principal; it must be a bare HTTPS `ic0.app` origin for `KINIC_WIKI_CANISTER_ID`. The Worker does not rewrite, discover, or fall back between origins at runtime. The canister's `/.well-known/ii-alternative-origins` remains responsible only for allowing the controlled `wiki.kinic.xyz` frontend to request the public derivation origin.

Cloudflare custom domains:

- `wiki-mcp.kinic.xyz` belongs only to `kinic-wiki-mcp`.
- `wiki-mcp-staging.kinic.xyz` belongs only to `kinic-wiki-mcp-staging`.

Before deploying staging, create a 32-byte random value and store its base64/base64url form as a secret:

```bash
pnpm --dir workers/wiki-mcp exec wrangler secret put MCP_KEY_ENCRYPTION_KEY --config wrangler.staging.jsonc
```

Do not put this value in Wrangler vars or logs. Before the staging per-tool OAuth gate passes, production has no auth-state binding and does not share staging storage.

## ChatGPT Developer Mode

Use a separate wiki app or staging app. Do not replace the existing memory app endpoint.

1. In II Settings, add `https://wiki-mcp-staging.kinic.xyz/mcp` as the trusted connector.
2. Configure the same MCP URL in ChatGPT/Codex without pre-connecting OAuth.
3. Refresh tools and confirm the exact 18-tool list contains eight reads, `connect_private`, seven single mutations, and two batch mutations.
4. Run public `find_databases`, `context`, and `read_path`.
5. Call `connect_private` and confirm ChatGPT starts OAuth from that call's MCP `_meta["mcp/www_authenticate"]` challenge. Complete II consent with either `Questions only` or `Actions & questions`.
6. Confirm the automatic retry returns `access: "read_only"` for Questions only and `access: "read_write"` for Actions & questions.
7. Run review test cases:
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
   - Questions-only sessions cannot call a mutation;
   - Actions & questions sessions can run write, edit, heterogeneous atomic batch, move, and etag-guarded delete;
   - a stale etag returns the failed operation index plus current content and etag, and does not partially commit the batch.
8. Disable or remove the connector in II Settings and verify the next MCP request returns `invalid_token`.

Production promotion is blocked until step 5 succeeds in ChatGPT. After it succeeds, production receives its own Durable Object namespace and `MCP_KEY_ENCRYPTION_KEY`, `MCP_PUBLIC_ORIGIN=https://wiki-mcp.kinic.xyz`, `MCP_ACCESS_POLICY=private_opt_in`, callback `https://wiki-mcp.kinic.xyz/mcp/connect`, and a separate II connector registration. Staging OAuth clients, sessions, and tokens are never migrated or shared. If ChatGPT does not start OAuth from the tool-level MCP challenge, production remains unchanged while an alternate connection UX is evaluated.

For the public production review submission, choose **With MCP**, attach `skills/kinic-wiki-mcp/`, and do not package an `.app.json` reference to the existing Developer Mode app. Run the production submission smoke three times:

```bash
pnpm --dir workers/wiki-mcp review:smoke -- --mcp-url https://wiki-mcp.kinic.xyz/mcp --repeats 3
```

Then run every positive and negative prompt from `workers/wiki-mcp/chatgpt-app-submission.json` twice in a new ChatGPT web conversation with the submitted plugin and skill attached.

## Review Checklist

- Production remains public until the per-tool OAuth gate passes; staging is private opt-in.
- Production exposes no write tools; staging write tools require both `mcp:write` and II `Actions & questions`.
- Production has no private database access.
- The submitted **With MCP** plugin includes `skills/kinic-wiki-mcp/`, and `agents/openai.yaml` points to `https://wiki-mcp.kinic.xyz/mcp`.
- Production responses contain only public database metadata, public node URLs, and public node text.
- Staging responses are restricted by the delegated caller in the Kinic canister.
- Logs do not include raw principals, delegations, tokens, private keys, or private database bodies.
- Responses do not include user ids, internal request/session ids, or secrets.
- `https://mcp.kinic.xyz/mcp` remains unchanged.
- `https://wiki.kinic.xyz` browser routes remain unchanged.
