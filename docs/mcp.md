# Kinic Wiki Remote MCP

This document describes the repository implementation: 16 registered Private tools (15 model-visible tools plus one app-only connection profile) and 7 anonymous public tools. Use `tools/list` to inspect the contract exposed by a deployed endpoint.

`workers/wiki-mcp` provides three isolated deployments:

- public production is anonymous and read-only;
- Private production authenticates with OAuth before tool discovery, uses an Internet Identity delegated Actor for every data call, and permits batch writes only with II `Actions & questions`;
- Private staging has the same security contract as Private production but targets the staging canister and separate OAuth state.

## Boundary

- Public production reads public databases only and queries the canister anonymously.
- Private production and Private staging expose the seven model-visible read tools plus eight mutation tools (`write_nodes`, `mutate_nodes_batch`, `append_nodes`, `edit_nodes`, `multi_edit_nodes`, `create_folders`, `move_nodes`, `delete_nodes`). `initialize`, `tools/list`, and `tools/call` all require OAuth.
- After connection, all data tools use only the delegated principal. Anonymous public database results are never merged into private results.
- A supplied but invalid, expired, revoked, or wrong-resource Bearer token returns `401`; it never falls back to anonymous.
- Private database authorization remains in the Kinic canister; the Worker does not accept a database owner principal as input.
- Mutations are limited to VFS content CRUD. Database administration, members, billing, marketplace purchase, publication, and archive operations are not exposed.
- Public production has `MCP_WRITE_POLICY=disabled`; both Private deployments have `MCP_WRITE_POLICY=private`. Missing or unknown policy values fail closed with `503`.
- Existing memory app endpoint `https://mcp.kinic.xyz/mcp` is a separate service and must not be changed for Kinic Wiki.
- `https://wiki.kinic.xyz` remains the wiki browser and public node URL origin.

## Endpoint

- Public search MCP: `https://wiki-mcp.kinic.xyz/mcp`
- Private production MCP: `https://wiki-private-mcp.kinic.xyz/mcp`
- Private staging MCP: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Public search health: `https://wiki-mcp.kinic.xyz/health`
- Private production health: `https://wiki-private-mcp.kinic.xyz/health`
- Private staging health: `https://wiki-mcp-staging.kinic.xyz/health`
- Root info: `GET /`

Route behavior:

- `POST /mcp`: the only MCP transport endpoint.
- `GET /mcp`: unsupported by the stateless transport; returns `405` with `Allow: POST`.
- `GET /health`: health JSON.
- `GET /`: human-readable info JSON with endpoint and tool names.
- `POST /`: not an MCP alias.

On both Private endpoints, every unauthenticated MCP POST returns HTTP `401` with an `mcp:read` RFC 9728 OAuth challenge before any canister call. Read descriptors advertise OAuth-only `mcp:read`; mutation tools advertise OAuth-only `mcp:read mcp:write`, and a read-only token receives that step-up challenge only when it calls a mutation tool. The MCP POST body is limited to 256 KiB across the complete request or JSON-RPC batch. Requests over that limit return `413` before token authentication. OAuth endpoint request bodies keep their separate 16 KiB limit.

## Connection profile

Private MCP registers `get_profile` with `_meta["openai/profile"]: true` and
`_meta.ui.visibility: ["app"]`. Its strict input is `{}` and its output is
`{"id":"<authenticated principal>"}`, returned identically in `structuredContent`
and JSON text content. It requires `mcp:read`, works without write permission,
and reuses the validated request identity without querying the Wiki canister.
Missing or anonymous identities fail closed. No profile is registered on public MCP.

The PID stays stable across OAuth refresh, reconnection, scope changes, and
per-app key rotation for the same II identity and canonical derivation origin.
No names or email addresses are synthesized. The profile supports connection
recognition; it does not change OAuth expiry or guarantee automatic duplicate
connection removal. Verify host profile discovery and model invisibility after
scanning tools. If either fails or connection is disrupted, roll back the Private
Worker rather than exposing a sixteenth tool to the model. Compare existing
connections' verified PIDs before removing a duplicate; retain connections whose
identity differs or cannot be verified.

See [OpenAI profile contract](https://developers.openai.com/plugins/build/auth#support-multiple-accounts)
and [tool visibility](https://developers.openai.com/plugins/reference).

## Private authentication

Register the endpoint being used as an exact connector URL in Internet Identity Settings. Private production uses:

```text
https://wiki-private-mcp.kinic.xyz/mcp
```

Private staging uses:

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

OAuth uses authorization code with mandatory S256 PKCE and DCR. The scopes are `mcp:read`, `mcp:write`, and `offline_access`; each audience is fixed to its exact Private MCP URL. Authorization codes expire after at most ten minutes, access tokens last at most one hour, refresh tokens rotate on every use, and the local session cannot exceed eight hours or the II grant expiration. Reuse of an authorization code or rotated refresh token revokes the active local session. A session also requires a fresh connection after 64 refresh rotations.

The authorization page offers Internet Identity. A review-only username/password path is available when `MCP_REVIEW_LOGIN_ENABLED=true`; checked-in native cf configurations disable it after review completion. `MCP_REVIEW_ACCESS_VERSION` was changed to invalidate earlier reviewer sessions when deployed. Review credentials authorize a dedicated Ed25519 service identity whose private key and expected principal are stored as Cloudflare Secrets; all MCP tools still call the real canister. For that identity, the Worker enforces the environment-specific `MCP_REVIEW_DATABASE_ID` and `MCP_REVIEW_WRITE_PREFIX` before every write, including both sides of a move, while the service principal remains limited to `writer` on `openai-review-fixture`. Reviewer sessions use the same PKCE, code, token, scope, expiration, and refresh-replay controls as II sessions. `MCP_REVIEW_ACCESS_VERSION` is checked before authorization-code exchange, refresh rotation, and access-token use, providing explicit credential-session revocation; earlier version values must not be reused.

The authorization, II callback, and connect-error pages share one inline stylesheet allowed only by its CSP hash (`PAGE_STYLE_HASH` in `workers/wiki-mcp/src/auth/pages.ts`). They render in English only; `ui_locales` and `Accept-Language` are ignored, which keeps the reviewer section aligned with the submitted review instructions. The page summarizes the requested access (read, or read and edit when `mcp:write` is requested); II consent still decides the final permission. Browser form posts to `/oauth/connect/*` return HTML error cards for expired sessions (400), reviewer rate limits (429, `Retry-After: 60`), and unavailable sign-in (503); OAuth API endpoints keep their JSON errors.

DCR applies a best-effort limit of ten registration attempts per connecting IP per minute in each Cloudflare location. Cloudflare's rate limiter is eventually consistent, so concurrent requests can temporarily exceed that limit. A rejected request returns `429` with `Retry-After: 60`; a rate-limiter failure returns `503`. Registered clients expire after 180 days without use and extend that deadline when an unexpired client ID is referenced by an OAuth request.

The II registration grant accepts both `queries` (`Questions only`) and `all` (`Actions & questions`). Browser, CLI, and iOS login flows continue to request the public derivation origin `https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io`; the II frontend rewrites that gateway alias to the legacy canonical seed origin. Private production targets `https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app`, while Private staging targets `https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app`. Direct MCP backend calls pass the environment's configured bare `ic0.app` origin unchanged. A Questions-only grant removes `mcp:write` from the local OAuth session and remains read-only. An Actions & questions grant preserves `mcp:write` and enables content mutations. `initialize`, `tools/list`, and notification-only batches validate OAuth without minting a canister identity. The first `tools/call` mints a per-app delegation, encrypts its app key and chain in the session Durable Object, and reuses it until 30 seconds before its at-most-five-minute expiration. Concurrent cache misses share one mint.

Already-minted delegations remain usable for their remaining lifetime, so II revocation can take up to five minutes to reach a cached session. The next mint after expiry observes revocation, invalidates the local OAuth session, and returns `invalid_token`; reconnect through the client to restore access. Refresh-token rotation preserves a valid delegation cache. Changing `MCP_KEY_ENCRYPTION_KEY` intentionally invalidates all existing sessions.

The II callback returns stable, non-sensitive errors:

- `400 invalid_connection`: the callback, initiator binding, delegation, or local encrypted session is invalid or expired;
- `401 registration_rejected`: II rejected `mcp_register_v2`;
- `503 temporarily_unavailable`: the II Actor or registration call failed.

Private Workers log only a random trace id, the connection, per-app delegation, or authenticated canister-call stage, the stable error code, and the HTTP status when applicable. They do not log OAuth state, session ids, authorization codes, delegation chains, tokens, keys, raw principals, II or canister error bodies, or private database text.

## Tools

- `find_databases`
  - Input: `{ "query": "agent memory", "limit": 10 }`
  - Reads `list_databases()` as the request principal (anonymous on public search, II delegated on Private endpoints)
  - Ranks only the metadata returned for that principal using name, tags, summary, and description
- `search`
  - Input: `{ "database_id": "db_...", "query": "...", "prefix": "/", "limit": 10, "preview_mode": "light" }`
  - Calls canister `search_nodes`
  - `preview_mode` accepts `light`, `content-start`, or `none`; use `content-start` for broad/list/classification candidate review
  - Returns fetchable opaque ids
- `fetch_many`
  - Input: `{ "ids": ["<id-or-public-url-from-search>"] }`
  - Fetches 1 to 10 exact opaque search IDs or public Wiki URLs, including user-provided URLs and results from multiple databases, and returns item-level errors for invalid or stale references
  - Do not pass ChatGPT citation tokens such as `turn0file0`; if an opaque id is hidden, construct `https://wiki.kinic.xyz/db/{database_id}{path}` from the result metadata
- `read_paths`
  - Input: `{ "database_id": "db_...", "paths": ["/Knowledge/a.md", "/Knowledge/b.md"] }`
  - Reads 1 to 10 known paths with one `read_nodes` call
  - For one page, pass a one-element `paths` array. The response still contains `structuredContent.results` and `structuredContent.metadata`. Check top-level `isError` and each item's `is_error` before using `results[0].text` or `results[0].metadata.etag`.
  - Use for known paths from `list`, `context`, or `search` metadata
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
- `write_nodes`
  - Preferred for creation and full replacement, including a single node
  - Atomically creates or replaces 1 to 100 nodes in one database, in order
  - Every item requires `path`, `kind`, `content`, and `metadata_json`; only `expected_etag` is optional
- `append_nodes`: Append content; optionally change metadata or kind. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `edit_nodes`: Replace exact text with etag protection; multiple matches fail unless `replace_all: true`. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `multi_edit_nodes`: Apply ordered exact-text edits within each node, replacing every match at each step. Include unique surrounding text for a limited replacement. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `create_folders`: Create folders; existing folders are unchanged. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `move_nodes`: Move or rename nodes with etag protection. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `delete_nodes`: Delete explicitly selected nodes with etag protection. Accepts `database_id` and 1–100 `operations` without `type`; uses the corresponding mixed-batch fields below. Each call is ordered and atomic.
- `mutate_nodes_batch`
  - Use when different operation kinds must commit together; prefer dedicated tools for same-kind operations and never split a mixed atomic batch
  - Atomically applies 1 to 100 ordered `write`, `append`, `edit`, `multi_edit`, `mkdir`, `move`, or `delete` operations in one database
  - A `write` operation has the same required fields as `write_nodes`
  - A `move` with `overwrite: true` must include `expected_target_etag` when the destination exists. If the destination does not exist, omit it. Supplying it with `overwrite: false` is invalid.
  - The first failure rolls back the entire transaction and returns a zero-based `failed_index`

Read tools keep read-only annotations. All mutation tools use `readOnlyHint: false` and `openWorldHint: true`. `create_folders` is non-destructive and idempotent; the other mutation tools use `destructiveHint: true`. The open-world hint is required because an authenticated writer can change a public database or the content of an already-published node.

## Agent Write Workflow

1. Read each existing target and its etag with `read_paths`. Known paths need no preliminary search or context call.
2. Write only when the user explicitly requests a change. Automatic skill invocation does not authorize writes.
3. Use `write_nodes` for create/full replacement only, even for one node. Use the dedicated tool for same-kind changes, even for one item. Use `mutate_nodes_batch` when different operation kinds must execute atomically; never split such a batch into multiple calls.
4. Keep each 1–100 item batch in one database and preserve returned etags.
5. On `etag_conflict`, treat `path` as the failed operation input and `conflict_path` as the actual stale node. Compare supplied `current_content` and `current_etag` with the intended change, noting `current_content_truncated` and `current_content_size`; the inline content is capped at 40,000 characters. Regenerate the batch and retry at most twice only if intent remains unambiguous. Otherwise return the current/desired difference instead of overwriting.

The node mutation Candid methods return `NodeMutationError { code; message; failed_index; conflict_path }`, where `code` is one of `EtagConflict`, `NotFound`, `Forbidden`, `WriteUnavailable`, or `InvalidOperation`. This intentionally replaces `Err : text` for all node mutations. Canister and bundled clients, including the Wiki Clipper and Rust CLI, must be released together when their target canister is upgraded; old mutation decoders are incompatible. Known external Candid clients must be notified separately because repository checks cannot discover them. The same release runs the versioned index `001→002→003` and filesystem `001→002` migrations used by native publication recovery; do not skip schema preflight.

## Agent Read Workflows

For normal question answering without a specified page, call `context` first and answer from returned nodes and evidence. Treat `search_hits` as routing data, not final evidence.

Known paths go directly to `read_paths` (1–10). Known search IDs or public Wiki URLs go directly to `fetch_many` (1–10, including multiple databases). `search` accepts 1–20 results (default 10); `list` accepts 1–99 (default 99). Use `memory_manifest` for capabilities and limits.

For broad, list, or classification tasks:

1. Build a candidate set with multiple `search` calls. Use query variants such as the raw user phrase, key nouns, synonyms, title terms, and topic terms.
2. Use `preview_mode: "content-start"` when search result previews are used for candidate classification.
3. Use `list` with `prefix: "/"` to discover top-level prefixes, then narrow later searches to `/Knowledge`, `/Sources`, or a discovered wiki prefix such as `/Wiki` when useful.
4. Separate title/path matches from topic or ability-term matches before synthesis. Do not mix another work's ability evidence into a title-matched work.
5. Use `fetch_many` for one or more exact search result ids or public URLs. Use `read_paths` for 1–10 known paths from the user, `list`, `context`, or `search` metadata. Use returned `context.evidence` for source-reference trust checks.
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

Authenticated Private production smoke uses the same client with an isolated cache:

```bash
MCP_STAGING_AUTH_CACHE="${XDG_STATE_HOME:-$HOME/.local/state}/kinic-wiki/mcp-private-smoke-oauth.json" \
  pnpm --dir workers/wiki-mcp smoke:staging -- \
  --server-url https://wiki-private-mcp.kinic.xyz/mcp \
  --open
```

The private smoke client uses a random OAuth state, S256 PKCE, and an ephemeral `127.0.0.1` callback. It stores the registered client and rotating OAuth tokens with file mode `0600`, requests `offline_access`, and reuses or refreshes that session on later runs. Browser consent is therefore required on the first run, when adding write scope, after expiry or revocation, or after `--reset-auth`; set `MCP_STAGING_AUTH_CACHE` to isolate the cache for each endpoint. Do not run this diagnostic concurrently against the same cache because refresh tokens rotate. It verifies the exact 16-registered / 15-model-visible tool contract and authenticated profile, runs authenticated private reads, and optionally exercises single-item `write_nodes`, etag conflict rereads, atomic rollback, multi-item `write_nodes`, heterogeneous batch mutation, and batch cleanup at `--write-smoke-path`. The path must be new; cleanup uses returned etags. Output contains only tool counts, success flags, and response byte lengths.

## Configuration

`cloudflare.config.ts` selects public search by default, Private production with `--mode private`, and Private staging with `--mode staging`. Each Private deployment has its own Worker, Durable Object namespace, rate-limit namespace, and encryption key.

- public search and Private production: `KINIC_WIKI_CANISTER_ID=6emaw-iyaaa-aaaay-aacka-cai`
- Private staging: `KINIC_WIKI_CANISTER_ID=3ryrw-kyaaa-aaaaf-qgxpq-cai`
- `KINIC_WIKI_IC_HOST=https://icp0.io`
- public search and Private production: `KINIC_WIKI_PUBLIC_ORIGIN=https://wiki.kinic.xyz`
- Private staging: `KINIC_WIKI_PUBLIC_ORIGIN=https://kinic-wiki-browser-staging.hude.workers.dev`
- Private production: `KINIC_WIKI_MCP_TARGET_ORIGIN=https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app`
- Private staging: `KINIC_WIKI_MCP_TARGET_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app`
- public search: `MCP_ACCESS_POLICY=public`, `MCP_WRITE_POLICY=disabled`
- Private production and staging: `MCP_ACCESS_POLICY=private_required`, `MCP_WRITE_POLICY=private`

`MCP_ACCESS_POLICY` accepts only `public` or `private_required`. `MCP_WRITE_POLICY` accepts only `disabled` or `private`. A missing or unknown value returns `503` instead of guessing another mode.

Both Private deployments require the `MCP_AUTH_STATE` Durable Object plus separate registration and reviewer-login rate-limit bindings. The V5 migration replaces `McpAuthStateV4` without importing its clients or sessions, so existing Private MCP connections must authenticate again. Public search remains anonymous and has none of these bindings.

`KINIC_WIKI_IC_HOST` is the IC API gateway. `KINIC_WIKI_MCP_TARGET_ORIGIN` is the exact origin used by the II backend to derive the existing Kinic principal; it must be a bare HTTPS `ic0.app` origin for `KINIC_WIKI_CANISTER_ID`. The Worker does not rewrite, discover, or fall back between origins at runtime. The canister's `/.well-known/ii-alternative-origins` remains responsible only for allowing the controlled `wiki.kinic.xyz` frontend to request the public derivation origin.

Cloudflare custom domains:

- `wiki-mcp.kinic.xyz` belongs only to `kinic-wiki-mcp`.
- `wiki-private-mcp.kinic.xyz` belongs only to `kinic-wiki-mcp-private`.
- `wiki-mcp-staging.kinic.xyz` belongs only to `kinic-wiki-mcp-staging`.

Before deploying either Private Worker, create a separate 32-byte random value and store its base64/base64url form as a secret:

```bash
CLOUDFLARE_SECRETS_FILE=/absolute/path/outside-repo/private-mcp-secrets.json pnpm --dir workers/wiki-mcp deploy:private
CLOUDFLARE_SECRETS_FILE=/absolute/path/outside-repo/staging-mcp-secrets.json pnpm --dir workers/wiki-mcp deploy:staging
```

Do not put these values in Wrangler vars or logs. Public search has no auth-state binding. Private production and staging never share OAuth state or encryption keys.

## ChatGPT Developer Mode

Use a separate Private wiki app. Do not replace the public search app or the existing memory app endpoint.

1. In II Settings, add `https://wiki-private-mcp.kinic.xyz/mcp` as the trusted connector. Use the staging URL only for staging validation.
2. Configure the same MCP URL in ChatGPT/Codex and confirm the initial connection starts OAuth from the HTTP `401` challenge.
3. Refresh tools and confirm the registered list has 16 tools, with seven reads plus eight mutations available to the model and an app-only `get_profile`, with no `connect_private` or single-mutation tools.
4. Complete II consent with either `Questions only` or `Actions & questions`, then run authenticated `find_databases`, `context`, and `read_paths`.
5. Run review test cases:
   - `find_databases` can select `KINIC-WIKI`.
   - `context` returns task-scoped nodes and evidence for a known public DB.
   - `search` for `clipper usage` returns an evidence node with `preview_mode: "content-start"`.
   - `list` with `prefix: "/"` discovers top-level prefixes.
   - `fetch_many` returns node text for one or more search result ids.
   - `read_paths` returns one or multiple known path bodies and item-level missing-path errors.
   - a known owner private database is visible and readable;
   - the same database stays unavailable anonymously and to another principal;
   - unknown or stale ids return a common unavailable error.
   - Questions-only sessions cannot call a mutation;
   - Actions & questions sessions use `write_nodes` for single/multiple create or replace, use the six dedicated mutation tools for same-kind operations, and `mutate_nodes_batch` for mixed atomic operations;
   - a stale etag returns the failed operation index plus current content and etag, and does not partially commit the batch.
6. Disable or remove the connector in II Settings and verify the next MCP request returns `invalid_token`.

Private production has its own OAuth settings, storage, connector registration, and skill URL. Staging OAuth clients, sessions, and tokens are never migrated or shared. Public search remains anonymous with seven read tools and is not the app represented by the current submission file.

`skills/kinic-wiki-mcp/` points only to Private production. Do not attach or republish it in the public search plugin.

Before submitting the Private app, create the dedicated reviewer fixture described in `docs/openai-private-review.md`, then run the authenticated production review smoke three times:

```bash
pnpm --dir workers/wiki-mcp review:smoke -- \
  --mcp-url https://wiki-private-mcp.kinic.xyz/mcp \
  --repeats 3 \
  --open
```

Then run every positive and negative prompt from `workers/wiki-mcp/chatgpt-app-submission.json` in new ChatGPT web and mobile conversations with only the Private app attached.

## Review Checklist

- Public search remains public and anonymous; both Private endpoints require OAuth at connection.
- Public search exposes no write tools; Private write tools require both `mcp:write` and II `Actions & questions`.
- Public search has no private database access and remains at `https://wiki-mcp.kinic.xyz/mcp` without configuration changes.
- The private skill points to `https://wiki-private-mcp.kinic.xyz/mcp` and is not republished into the public search plugin.
- Public search responses contain only public database metadata, public node URLs, and public node text.
- Private responses are restricted by the delegated caller in the Kinic canister.
- Logs do not include raw principals, delegations, tokens, private keys, or private database bodies.
- Responses do not include user ids, internal request/session ids, or secrets.
- `https://mcp.kinic.xyz/mcp` remains unchanged.
- `https://wiki.kinic.xyz` browser routes remain unchanged.

### Tool selection and replacement scope

Use `context` for normal questions, `list`/`search` and fetched bodies for broad investigations, and path reads directly for known pages. `fetch_many` accepts exact search IDs or public page URLs, including references across databases.

`edit_nodes` rejects multiple matches by default; `replace_all: true` opts into replacing every occurrence. `multi_edit_nodes` applies edits in order and replaces all matches at each step. Include unique surrounding text to restrict a replacement. Dedicated tools handle same-kind work; `mutate_nodes_batch` preserves a requested mixed transaction.
