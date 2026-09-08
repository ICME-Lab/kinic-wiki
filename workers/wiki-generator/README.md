# Wiki Generator Workers

This package deploys two Cloudflare Workers: `kinic-wiki-generator` turns evidence sources into review-ready wiki pages, while the private `kinic-nns-proposal-review` Worker publishes pre-vote NNS proposal reviews.

## LLM

Both Workers use DeepSeek Chat Completions with `deepseek-v4-flash` and receive `DEEPSEEK_API_KEY` as separate Cloudflare secret bindings. `KINIC_WIKI_WORKER_TOKEN` protects `POST /run`, `POST /source-capture`, `POST /nns-audit/run`, and `GET /nns-audit/status`; it is not an LLM API key.
`GET /healthz` is unauthenticated and returns `{ "ok": true }` without accessing D1, R2, Queues, VFS, or DeepSeek. The CI Worker-runtime test uses this route to verify that the production entrypoint starts inside workerd.

The Queue consumers run ordinary Workers only; Dynamic Workers are not required. The general Queue contains source, source-capture, and link-preview messages. The dedicated NNS Queue contains only `nns_proposal_review` messages. Each consumer batch contains at most four messages; source and NNS generation run concurrently within their separate Workers, while source capture and link-preview work stay sequential in the general Worker.

Each Worker starts with five Queue consumer invocations and batches of at most four messages. Their concurrency, backlog, and failure rates are monitored independently; DeepSeek rate limits remain shared when both Workers use the same provider account.

DeepSeek requests explicitly disable thinking mode for structured wiki extraction, use a 180-second timeout, manual redirect handling, and a 256 KiB response limit. Source text, prompts, generated content, session nonces, and secrets are excluded from Queue failure diagnostics and structured logs. Provider failure logs include only the HTTP status, model, input character count, serialized request byte count, and retryability.

## Generation retries and checkpoints

`source_jobs` uses a five-minute execution lease keyed by the Cloudflare Queue message ID. The lease is acquired with an atomic D1 compare-and-set, so duplicate deliveries do not make concurrent paid LLM calls for the same source etag. A duplicate with an active lease is copied back to the primary Queue with a delay derived from the lease expiry; the original delivery is acknowledged only after that delayed send succeeds.

After DeepSeek succeeds, generated Markdown is checkpointed in D1 with status `generated` before reading the target from VFS. The observed target ETag is then appended to that checkpoint before commit. A VFS or completion-state failure retries from the saved Markdown without calling DeepSeek again. Resume skips a target that already matches the checkpoint, writes over the unchanged observed ETag, and stops with `source_checkpoint_conflict` if the target changed after the snapshot. If target observation was interrupted, resume only writes when the target is still absent or accepts an exact content match; a different existing target requires manual resolution. Exhausting commit retries leaves the checkpoint in `generated`; after inspecting the sanitized failure Queue entry, an authorized manual `/run` requeue resumes the commit without another DeepSeek call. Permanent authorization, source, configuration, and generated-schema failures become terminal `failed` jobs. Transient provider, D1, and VFS failures retry with bounded backoff. A DeepSeek 503 without `Retry-After` uses equal jitter with attempt windows of 30–60, 60–120, 120–240, and 150–300 seconds before the fifth and final application attempt.

Cloudflare automatic dead-letter forwarding is intentionally disabled because original Queue messages can carry session nonces. On the fifth failed application attempt, the Worker publishes a sanitized diagnostic to `kinic-wiki-generation-failures` and acknowledges the original message only after that send succeeds.

## NNS Proposal Reviews

The private `kinic-nns-proposal-review` Worker owns the NNS Cron, Queue, D1 state, DeepSeek calls, and VFS publication. It has no public route or workers.dev URL. The public `wiki-generator.kinic.xyz/nns-audit/*` endpoints authenticate requests and forward them through the `NNS_PROPOSAL_REVIEW_SERVICE` binding.

When `KINIC_NNS_AUDIT_DATABASE_ID` is configured on the dedicated Worker, its 15-minute Cron trigger discovers new NNS proposals through the official IC Dashboard API v3. The first successful poll stores the current latest proposal ID as both the activation boundary and discovery watermark. It does not enqueue existing proposals, including proposals that are still open at activation time.

Later polls paginate `/proposals` by `limit` and `offset`, extract actual proposal IDs in the Worker, and scan a 100-ID overlap to tolerate short API publication delays. Action query parameters are not used. Discovery rows and the advanced watermark are committed atomically in D1 before Queue publication. A Queue send failure therefore leaves a `discovered` row for the next poll.

Each proposal is fetched once from `/proposals/<id>`. Before persistence or prompting, the public record is limited to proposal ID, title, summary, topic, URL, normalized action, payload, proposal/deadline timestamps, reject cost, and `status_at_capture`. Nested data recursively removes proposer identity, ballot, Known Neuron, tally, voting-power, reward, decision, settlement, and execution-result fields. The resulting record is an off-chain Dashboard API snapshot; it is not a direct governance-canister proof and is never refreshed after the first capture.

The Worker writes these paths in the configured database:

- `/Sources/nns/proposals/<id>/proposal.md`: sanitized official API snapshot.
- `/Sources/nns/proposals/<id>/reference.md`: optional bounded capture of the proposal's own HTTP(S) `url`.
- `/Knowledge/nns/proposals/<id>/review.md`: English AI review or deterministic `NOT_APPLICABLE` page.
- `/Knowledge/nns/index.md`: generated index of completed review records.
- `/Knowledge/nns/review-policy.md`: default policy seeded only when absent and never overwritten by the Worker.

Proposal, reference, and review nodes are create-only. A retry accepts an exact node match, but sends a differing existing node to the sanitized failure Queue for manual resolution. The generated index is the only worker-overwritten page and uses ETag retries. The first sanitized proposal snapshot and bounded reference result are checkpointed in D1 before DeepSeek. AI output is checkpointed before any of the three create-only artifacts are committed, so provider retries reuse the same captured evidence and partial VFS failures resume without another DeepSeek request.

Artifact completion and index synchronization are tracked separately. A completed job whose index update failed remains pending and is re-enqueued by a later 15-minute poll until `/Knowledge/nns/index.md` is updated successfully.

Open proposals receive `ADOPT`, `REJECT`, or `NEEDS_CLARIFICATION`. Motion, ManageNetworkEconomics, and CreateServiceNervousSystem actions receive focused checks; all other actions receive the generic review. A proposal first observed with a non-`OPEN` status is still recorded, but DeepSeek is not called and the review is `NOT_APPLICABLE` with `review_status: skipped_not_open`.

This feature retains `status_at_capture` only to decide whether a pre-vote review is applicable. It does not collect proposer or Known Neuron identities, ballots, voting power, tallies, final outcome payloads, or execution results. It does not vote, backfill old proposals, update reviews after closure, cover SNS proposals, or provide cryptographic immutability. Treat the public database as an administrator-controlled review record.

Operational endpoints retain their public paths and require the general Worker bearer token:

```text
POST /nns-audit/run
POST /nns-audit/run  { "retryFailed": true }
GET  /nns-audit/status
```

The empty/manual run performs the same discovery pass as Cron. `retryFailed: true` first makes terminal failed jobs eligible for a deliberate retry; generated checkpoints are retained and reused.

## Source Capture

The worker processes explicit `/Sources/source-capture-requests` `kinic.source_capture_request` nodes.
Those request nodes are VFS `file` nodes and act as request audit logs: they record `requested_by`, `requested_at`, `claimed_at`, `status`, `source_path`, `target_path`, `finished_at`, and `error`.
The fetched raw web evidence written under `/Sources/...` remains a VFS `source` node. Source paths only need to stay under the configured source root with safe path segments; `/Sources/<provider>/<id>.md` is not required.
Raw web sources keep URL provenance only. Request/source correspondence is tracked from the request node's `source_path`, not by writing `request_path` back into the evidence source.
Trusted servers trigger a single request with bearer-authenticated `POST /source-capture`:

```json
{ "canisterId": "6emaw-iyaaa-aaaay-aacka-cai", "databaseId": "db_...", "requestPath": "/Sources/source-capture-requests/<request-id>.md", "sessionNonce": "<authorized-session-nonce>" }
```

For each queued request it:

1. fetches one `http` or `https` URL with a bounded response size,
2. stores immutable evidence under `/Sources/...`,
3. queues the evidence source for wiki page generation,
4. writes the generated page under `/Knowledge/conversations`,
5. updates the request status to `completed` or `failed`.

If a generated source path already exists, the worker writes the next available ASCII suffix such as `stem-2.md` and records that actual path in the request node. Evidence nodes are not overwritten by a repeated URL capture.
Failed requests are terminal. To run capture again, submit a new request for the same URL; immutable source path allocation keeps the new capture separate from the failed request.
Automatic source-capture recovery and scheduled recovery scans are not part of this Worker. Operational recovery uses the sanitized failure Queue and an explicit manual requeue.

The worker identity in `KINIC_WIKI_WORKER_IDENTITY_PEM` must have writer access to the target database.
Use the exact PEM output from `icp identity export <identity-name>`.
New databases include the default LLM writer service principal as a `writer` member. That automatic grant is part of the source capture permission model: if an owner revokes the service principal, source capture session authorization and checks fail until writer access is restored.
Session checks are not permanent capability grants. The canister rejects them after cycles suspension or low balance, and the worker re-checks immediately before external URL fetch and DeepSeek generation.
Manual `/run` and source queue jobs without a browser session call `check_database_write_cycles` before DeepSeek; the worker identity must be writer or owner.

The `source_capture` rename is a breaking operational boundary. Drain old `url_ingest` queue messages before deploying this worker, and deploy updated WikiBrowser / extension clients together with the worker. Old routes, old queue message kinds, and old extension builds are not accepted by this path.

## Cloudflare Setup

Create and configure the general Worker resources:

```bash
pnpm exec wrangler queues create kinic-wiki-generation
pnpm exec wrangler queues create kinic-wiki-generation-failures
pnpm exec wrangler d1 create kinic-wiki-generator
pnpm exec wrangler d1 migrations apply kinic-wiki-generator --remote
pnpm exec wrangler secret put DEEPSEEK_API_KEY
pnpm exec wrangler secret put KINIC_WIKI_WORKER_TOKEN
pnpm exec wrangler secret put KINIC_WIKI_WORKER_IDENTITY_PEM
```

After `d1 create`, copy the returned database id into `wrangler.jsonc`.

Migration `0003_source_job_target_snapshot.sql` must be applied before deploying the Worker that reads the target snapshot columns. Pause the source Queue consumer while applying the migration and deploying the Worker. Existing `generated` checkpoints have no target snapshot, so they resume conservatively: an absent target or exact content match is accepted, while a different existing target stops for manual resolution.

Create the isolated NNS resources before deploying either side of the Service Binding:

```bash
pnpm exec wrangler queues create kinic-nns-proposal-review
pnpm exec wrangler queues create kinic-nns-proposal-review-failures
pnpm exec wrangler d1 create kinic-nns-proposal-review
pnpm exec wrangler d1 migrations apply kinic-nns-proposal-review --remote --config wrangler.nns.jsonc
pnpm exec wrangler secret put DEEPSEEK_API_KEY --config wrangler.nns.jsonc
pnpm exec wrangler secret put KINIC_NNS_WORKER_IDENTITY_PEM --config wrangler.nns.jsonc
```

Copy the dedicated D1 id into `wrangler.nns.jsonc` after creation. Set `KINIC_NNS_WORKER_IDENTITY_PEM` to the same PEM currently used by `KINIC_WIKI_WORKER_IDENTITY_PEM`; the bindings remain independently managed even though the principal is reused.

Apply `nns-migrations/0001_nns_proposal_reviews.sql`, then deploy `kinic-nns-proposal-review` with `KINIC_NNS_AUDIT_DATABASE_ID` still absent. Deploy the general Worker with its Service Binding next and confirm the authenticated public status endpoint returns `{ "enabled": false }`. Only then enable the audit:

```bash
pnpm exec wrangler secret put KINIC_NNS_AUDIT_DATABASE_ID --config wrangler.nns.jsonc
```

The target wiki database must already be active, retain the reused Worker principal as `writer`, and grant the anonymous principal `reader` access. The first authenticated `POST /nns-audit/run` initializes the discovery cursor without backfilling; verify D1, Queue, VFS artifacts, and logs before relying on Cron.

`KINIC_NNS_API_BASE_URL` defaults to `https://ic-api.internetcomputer.org/api/v3` and must use HTTPS. If `KINIC_NNS_AUDIT_DATABASE_ID` is absent, scheduled NNS processing is a no-op and existing Worker functions remain available.

Both Queues start with `max_batch_size = 4`, `max_batch_timeout = 1`, `max_concurrency = 5`, and `max_retries = 5`. During an NNS incident, pause only `kinic-nns-proposal-review`; normal wiki generation remains available. To reduce pressure, lower the affected Queue's `max_concurrency` from 5 to 2 and then 1 without changing batch size at the same time.

Monitor backlog age, retry rate, failure Queue depth, DeepSeek 429/5xx rate, LLM and end-to-end p95 latency, and D1/VFS failures separately for both Workers. Keep the initial settings unchanged for the first 100 production jobs or 24 hours.

## Browser Source Capture Integration

Use this order when enabling WikiBrowser source capture:

1. Deploy this Worker with `KINIC_WIKI_WORKER_TOKEN` and `KINIC_WIKI_WORKER_IDENTITY_PEM` set.
2. Confirm the target canister exposes `authorize_source_capture_trigger_session`, `check_source_capture_trigger_session`, `check_source_run_session`, and `check_database_write_cycles`.
3. Grant the Worker identity writer access to target databases, or keep the default LLM writer service principal grant.
4. Set WikiBrowser `KINIC_WIKI_GENERATOR_URL` to this Worker URL.
5. Set the same `KINIC_WIKI_WORKER_TOKEN` as a WikiBrowser runtime secret.
6. Run a smoke from WikiBrowser's `/db/<database-id>/Knowledge?tab=source-capture` route and confirm `/Sources/source-capture-requests/...` plus `/Sources/...` output.

PDF, authenticated pages, and multi-URL batching are out of scope for this worker path.
