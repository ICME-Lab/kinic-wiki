# Wiki Generator Worker

Cloudflare Worker for turning raw sources into review-ready wiki pages.

## LLM

Generation uses DeepSeek Chat Completions with `deepseek-v4-flash`.
Set `DEEPSEEK_API_KEY` as a Cloudflare secret. `KINIC_WIKI_WORKER_TOKEN` protects `POST /run` and `POST /url-ingest`; it is not an LLM API key.

## URL Ingest

The worker processes explicit `/Sources/ingest-requests` `kinic.url_ingest_request` nodes.
Those request nodes are VFS `file` nodes and act as request audit logs: they record `requested_by`, `requested_at`, `claimed_at`, `status`, `source_path`, `target_path`, `finished_at`, and `error`.
The fetched raw web evidence written to `/Sources/raw/<provider>/<id>.md` remains a VFS `source` node. Legacy one-segment raw source paths are not accepted by the worker; migrate them explicitly before regeneration or purge operations.
Raw web sources keep URL provenance only. Request/source correspondence is tracked from the request node's `source_path`, not by writing `request_path` back into the raw source.
Trusted servers trigger a single request with bearer-authenticated `POST /url-ingest`:

```json
{ "canisterId": "xis3j-paaaa-aaaai-axumq-cai", "databaseId": "db_...", "requestPath": "/Sources/ingest-requests/<request-id>.md", "sessionNonce": "<authorized-session-nonce>" }
```

For each queued request it:

1. fetches one `http` or `https` URL with a bounded response size,
2. stores normalized evidence under `/Sources/raw/<provider>/<id>.md`,
3. queues the raw source for wiki page generation,
4. writes the generated page under `/Wiki/conversations`,
5. updates the request status to `completed` or `failed`.

The worker identity in `KINIC_WIKI_WORKER_IDENTITY_PEM` must have writer access to the target database.
Use the exact PEM output from `icp identity export <identity-name>`.
New databases include the default LLM writer service principal as a `writer` member. That automatic grant is part of the URL ingest permission model: if an owner revokes the service principal, URL ingest session authorization and checks fail until writer access is restored.
Session checks are not permanent capability grants. The canister rejects them after credits suspension or low balance, and the worker re-checks immediately before external URL fetch and DeepSeek generation.
Manual `/run` and source queue jobs without a browser session call `check_database_write_credits` before DeepSeek; the worker identity must be writer or owner.

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

## Browser URL Ingest Integration

Use this order when enabling WikiBrowser URL ingest:

1. Deploy this Worker with `KINIC_WIKI_WORKER_TOKEN` and `KINIC_WIKI_WORKER_IDENTITY_PEM` set.
2. Confirm the target canister exposes `authorize_url_ingest_trigger_session`, `check_url_ingest_trigger_session`, `check_source_run_session`, and `check_database_write_credits`.
3. Grant the Worker identity writer access to target databases, or keep the default LLM writer service principal grant.
4. Set WikiBrowser `KINIC_WIKI_GENERATOR_URL` to this Worker URL.
5. Set the same `KINIC_WIKI_WORKER_TOKEN` as a WikiBrowser runtime secret.
6. Run a smoke from WikiBrowser's `/<database-id>/Wiki?tab=ingest` route and confirm `/Sources/ingest-requests/...` plus `/Sources/raw/...` output.

PDF, authenticated pages, and multi-URL batching are out of scope for this worker path.
