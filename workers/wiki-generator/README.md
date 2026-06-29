# Wiki Generator Worker

Cloudflare Worker for turning evidence sources into review-ready wiki pages.

## LLM

Generation uses DeepSeek Chat Completions with `deepseek-v4-flash`.
Set `DEEPSEEK_API_KEY` as a Cloudflare secret. `KINIC_WIKI_WORKER_TOKEN` protects `POST /run` and `POST /source-capture`; it is not an LLM API key.

## Source Capture

The worker processes explicit `/Sources/source-capture-requests` `kinic.source_capture_request` nodes.
Those request nodes are VFS `file` nodes and act as request audit logs: they record `requested_by`, `requested_at`, `claimed_at`, `status`, `source_path`, `target_path`, `finished_at`, and `error`.
The fetched raw web evidence written under `/Sources/...` remains a VFS `source` node. Source paths only need to stay under the configured source root with safe path segments; `/Sources/<provider>/<id>.md` is not required.
Raw web sources keep URL provenance only. Request/source correspondence is tracked from the request node's `source_path`, not by writing `request_path` back into the evidence source.
Trusted servers trigger a single request with bearer-authenticated `POST /source-capture`:

```json
{ "canisterId": "xis3j-paaaa-aaaai-axumq-cai", "databaseId": "db_...", "requestPath": "/Sources/source-capture-requests/<request-id>.md", "sessionNonce": "<authorized-session-nonce>" }
```

For each queued request it:

1. fetches one `http` or `https` URL with a bounded response size,
2. stores immutable evidence under `/Sources/...`,
3. queues the evidence source for wiki page generation,
4. writes the generated page under `/Knowledge/conversations`,
5. updates the request status to `completed` or `failed`.

If a generated source path already exists, the worker writes the next available ASCII suffix such as `stem-2.md` and records that actual path in the request node. Evidence nodes are not overwritten by a repeated URL capture.
Failed requests are terminal. To run capture again, submit a new request for the same URL; immutable source path allocation keeps the new capture separate from the failed request.

The worker identity in `KINIC_WIKI_WORKER_IDENTITY_PEM` must have writer access to the target database.
Use the exact PEM output from `icp identity export <identity-name>`.
New databases include the default LLM writer service principal as a `writer` member. That automatic grant is part of the source capture permission model: if an owner revokes the service principal, source capture session authorization and checks fail until writer access is restored.
Session checks are not permanent capability grants. The canister rejects them after cycles suspension or low balance, and the worker re-checks immediately before external URL fetch and DeepSeek generation.
Manual `/run` and source queue jobs without a browser session call `check_database_write_cycles` before DeepSeek; the worker identity must be writer or owner.

The `source_capture` rename is a breaking operational boundary. Drain old `url_ingest` queue messages before deploying this worker, and deploy updated WikiBrowser / extension clients together with the worker. Old routes, old queue message kinds, and old extension builds are not accepted by this path.

## Cloudflare Setup

```bash
pnpm exec wrangler queues create kinic-wiki-generation
pnpm exec wrangler d1 create kinic-wiki-generator
pnpm exec wrangler d1 migrations apply kinic-wiki-generator --remote
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler secret put KINIC_WIKI_WORKER_TOKEN
pnpm exec wrangler secret put KINIC_WIKI_WORKER_IDENTITY_PEM
```

After `d1 create`, copy the returned database id into `wrangler.jsonc`.

## Browser Source Capture Integration

Use this order when enabling WikiBrowser source capture:

1. Deploy this Worker with `KINIC_WIKI_WORKER_TOKEN` and `KINIC_WIKI_WORKER_IDENTITY_PEM` set.
2. Confirm the target canister exposes `authorize_source_capture_trigger_session`, `check_source_capture_trigger_session`, `check_source_run_session`, and `check_database_write_cycles`.
3. Grant the Worker identity writer access to target databases, or keep the default LLM writer service principal grant.
4. Set WikiBrowser `KINIC_WIKI_GENERATOR_URL` to this Worker URL.
5. Set the same `KINIC_WIKI_WORKER_TOKEN` as a WikiBrowser runtime secret.
6. Run a smoke from WikiBrowser's `/<database-id>/Knowledge?tab=ingest` route and confirm `/Sources/source-capture-requests/...` plus `/Sources/...` output.

PDF, authenticated pages, and multi-URL batching are out of scope for this worker path.
