# Wiki Generator Workers

This package deploys three Cloudflare Workers: `kinic-wiki-generator` turns evidence sources into review-ready wiki pages, `kinic-nns-proposal-review` evaluates NNS proposals, and the private Queue-only `kinic-nns-voter` Worker owns the NNS hotkey and vote submission.

## LLM

The general Worker uses DeepSeek Chat Completions with `deepseek-v4-flash`. The NNS review Worker uses Jev `jev-latest` for constrained decisions and DeepSeek only for the human-readable explanation. It receives `TYPESAFE_API_KEY` and `DEEPSEEK_API_KEY` as separate secret bindings. The voter has neither provider key. `KINIC_WIKI_WORKER_TOKEN` protects `POST /run`, `POST /source-capture`, `POST /nns-audit/run`, and `GET /nns-audit/status`; it is not an LLM API key.
`GET /healthz` is unauthenticated and returns `{ "ok": true }` without accessing D1, R2, Queues, VFS, or DeepSeek. The CI Worker-runtime test uses this route to verify that the production entrypoint starts inside workerd.

The Queue consumers run ordinary Workers only; Dynamic Workers are not required. The general Queue contains source, source-capture, and link-preview messages. The dedicated NNS review Queue contains `nns_proposal_review` messages, including retries of a pending DeepSeek explanation. The vote Queue accepts only internal `nns_vote_intent` messages and runs one message at a time.

The general and review Workers start with five Queue consumer invocations and batches of at most four messages. The voter uses batch size one and concurrency one. Their backlog and failure rates are monitored independently; DeepSeek rate limits remain shared by the general and review Workers when they use the same provider account.

DeepSeek requests explicitly disable thinking mode for structured wiki extraction, use a 180-second timeout, manual redirect handling, and a 256 KiB response limit. Source text, prompts, generated content, session nonces, and secrets are excluded from Queue failure diagnostics and structured logs. Provider failure logs include only the HTTP status, model, input character count, serialized request byte count, and retryability.

## Generation retries and checkpoints

`source_jobs` uses a five-minute execution lease keyed by the Cloudflare Queue message ID. The lease is acquired with an atomic D1 compare-and-set, so duplicate deliveries do not make concurrent paid LLM calls for the same source etag. A duplicate with an active lease is copied back to the primary Queue with a delay derived from the lease expiry; the original delivery is acknowledged only after that delayed send succeeds.

After DeepSeek succeeds, generated Markdown is checkpointed in D1 with status `generated` before reading the target from VFS. The observed target ETag is then appended to that checkpoint before commit. A VFS or completion-state failure retries from the saved Markdown without calling DeepSeek again. Resume skips a target that already matches the checkpoint, writes over the unchanged observed ETag, and stops with `source_checkpoint_conflict` if the target changed after the snapshot. If target observation was interrupted, resume only writes when the target is still absent or accepts an exact content match; a different existing target requires manual resolution. Exhausting commit retries leaves the checkpoint in `generated`; after inspecting the sanitized failure Queue entry, an authorized manual `/run` requeue resumes the commit without another DeepSeek call. Permanent authorization, source, configuration, and generated-schema failures become terminal `failed` jobs. Transient provider, D1, and VFS failures retry with bounded backoff. A DeepSeek 503 without `Retry-After` uses equal jitter with attempt windows of 30–60, 60–120, 120–240, and 150–300 seconds before the fifth and final application attempt.

Cloudflare automatic dead-letter forwarding is intentionally disabled because original Queue messages can carry session nonces. On the fifth failed application attempt, the Worker publishes a sanitized diagnostic to `kinic-wiki-generation-failures` and acknowledges the original message only after that send succeeds.

## NNS Proposal Reviews

The private `kinic-nns-proposal-review` Worker owns the daily NNS Cron, review Queue, Jev and DeepSeek calls, and Wiki publication. It has no public route or workers.dev URL. The public `wiki-generator.kinic.xyz/nns-audit/*` endpoints authenticate requests and forward them through the `NNS_PROPOSAL_REVIEW_SERVICE` binding. The separate voter Worker has no route at all and is reached only through `kinic-nns-votes`. Neither NNS Worker has a D1 binding: discovery, leases, checkpoints, decisions, and vote state are Wiki nodes protected by ETags.

When `KINIC_NNS_AUDIT_DATABASE_ID` is configured on the dedicated Worker, its once-daily Cron trigger (`0 0 * * *`, 00:00 UTC) discovers new NNS proposals through the official IC Dashboard API v3. The first successful poll stores the current latest proposal ID as both the activation boundary and discovery watermark in `/Knowledge/nns/system/discovery-state.md`. It does not enqueue existing proposals, including proposals that are still open at activation time.

Later polls paginate `/proposals` by `limit` and `offset`, extract actual proposal IDs in the Worker, and scan a 100-ID overlap to tolerate API publication delays. Action query parameters are not used. Each proposal gets a compact node under `/Knowledge/nns/system/workflows` before Queue publication, so a Queue send failure leaves a visible `discovered` workflow for the next poll.

Each proposal is fetched once from `/proposals/<id>`. The Worker extracts up to six HTTP(S) references from the proposal URL, summary, and payload, prioritizes `forum.dfinity.org`, captures every reachable source, and writes the raw pages plus `evidence.md` before calling Jev. It also queries NNS Governance `rrkah-fqaaa-aaaaa-aaaaq-cai` with `get_pending_proposals({ return_self_describing_action = true })`. ID, topic, action, summary, and available payload are compared. A missing proposal, closed state, expired deadline, mismatch, truncated required source, unknown action, invalid policy, or missing required evidence forces `HOLD`.

Jev receives four separate state sections: policy, Governance proposal, Dashboard snapshot, and reference evidence. It answers one `ADOPT / REJECT / HOLD` Choice plus five Noul questions. Code validates all probabilities and applies fixed minimum gates; Jev cannot sign or submit a vote. DeepSeek receives the fixed decision ID and can only explain it. If DeepSeek fails, `decision.md` is still published and the explanation checkpoint is retried independently.

The Worker writes these paths in the configured database:

- `/Sources/nns/proposals/<id>/proposal.md`: sanitized official API snapshot.
- `/Sources/nns/proposals/<id>/governance.md`: authoritative Governance snapshot used by the decision.
- `/Sources/nns/proposals/<id>/forum.md`, `forum-2.md`, ...: bounded Forum discussion captures.
- `/Sources/nns/proposals/<id>/reference.md`, `reference-2.md`, ...: other bounded linked evidence.
- `/Knowledge/nns/proposals/<id>/evidence.md`: deterministic evidence manifest fixed before Jev evaluation.
- `/Knowledge/nns/system/workflows/<id>.md`: compact ETag-protected discovery, lease, hashes, and retry checkpoint.
- `/Knowledge/nns/proposals/<id>/decision.md`: policy/evidence hashes, deterministic checks, Jev probabilities, and final code decision.
- `/Knowledge/nns/proposals/<id>/decisions/<decision-id>.md`: immutable decision history used for policy-triggered reevaluation.
- `/Knowledge/nns/proposals/<id>/review.md`: English AI review or deterministic `NOT_APPLICABLE` page.
- `/Knowledge/nns/proposals/<id>/vote.md`: voter intent, submission, and reconciliation status.
- `/Knowledge/nns/system/votes/<id>.md`: compact ETag-protected voter state; the public `vote.md` is its projection.
- `/Knowledge/nns/index.md`: generated index of completed review records.
- `/Knowledge/nns/autovote-policy.md`: canonical versioned voting policy, seeded in disabled shadow mode and never overwritten by the Worker.

Proposal, Governance, evidence-source, evidence-manifest, and decision-history nodes are create-only. A retry accepts an exact node match. Current `decision.md` and `review.md` use ETags when a policy change creates a new decision. The system workflow and vote nodes are the Wiki-backed mutable state machines. They contain compact metadata and hashes rather than captured evidence or generated Markdown.

Artifact completion and index synchronization are tracked separately. A completed workflow whose index update failed remains pending and is re-enqueued by a later daily poll until `/Knowledge/nns/index.md` is updated successfully.

All proposal actions enter the evaluation path. Registered actions declare their family, required evidence, deterministic checks, Jev question set, and whether v1 may auto-vote. The initial registry permits automatic voting only for `Motion`; executable economics, SNS, canister, subnet, and node-management actions remain publication-only until their type-specific deterministic verifiers and shadow samples are complete. An unknown or unsupported action is evaluated for publication but cannot become a vote intent. A proposal first observed with a non-`OPEN` status is still recorded, but it cannot be voted.

The voter rereads the Wiki policy and rejects a stale policy hash. It then rechecks OPEN status, deadline, target-neuron ballot eligibility, hotkey authorization, and existing/following ballots; simulates the exact `RegisterVote` request before submitting it; and confirms the result from the proposal ballot and recent neuron ballots. A delivery found in `submitting`, `accepted`, or `unknown` is reconciled and is never automatically resubmitted. The single `vote.md` path per proposal and its ETag prevent conflicting duplicate intents for the configured single neuron.

The policy starts with `enabled: false` and `mode: shadow`. Thresholds cannot be configured below `0.90`; the Choice gate and evidence-backed REJECT gate remain at least `0.95`. `auto_vote_choices: [ADOPT]` or `[REJECT]` can qualify directions independently after shadow review. `KINIC_NNS_AUTOVOTE_ENABLED` is a second kill switch and also defaults to false.

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
pnpm exec wrangler queues create kinic-nns-votes
pnpm exec wrangler queues create kinic-nns-vote-failures
pnpm exec wrangler secret put DEEPSEEK_API_KEY --config wrangler.nns.jsonc
pnpm exec wrangler secret put TYPESAFE_API_KEY --config wrangler.nns.jsonc
pnpm exec wrangler secret put KINIC_NNS_WORKER_IDENTITY_PEM --config wrangler.nns.jsonc
pnpm exec wrangler secret put KINIC_NNS_VOTER_IDENTITY_PEM --config wrangler.nns-voter.jsonc
pnpm exec wrangler secret put KINIC_NNS_VOTER_WIKI_IDENTITY_PEM --config wrangler.nns-voter.jsonc
```

`KINIC_NNS_VOTER_IDENTITY_PEM` must be a dedicated neuron hotkey and must not be the Wiki writer PEM. `KINIC_NNS_VOTER_WIKI_IDENTITY_PEM` is a separate Wiki writer secret used to claim and update `vote.md`.

Drain or pause the existing review and vote Queues before replacing the old D1-backed Workers. Deploy both private Workers with `KINIC_NNS_AUDIT_DATABASE_ID` still absent and `KINIC_NNS_AUTOVOTE_ENABLED=false`, then deploy the general Worker with its Service Binding. Confirm the authenticated public status endpoint returns `{ "enabled": false }`. Old D1 rows are not imported; existing public proposal artifacts remain untouched. Only then enable the Wiki database ID on both private Workers and set the same decimal neuron ID on review and voter:

```bash
pnpm exec wrangler secret put KINIC_NNS_AUDIT_DATABASE_ID --config wrangler.nns.jsonc
pnpm exec wrangler secret put KINIC_NNS_AUDIT_DATABASE_ID --config wrangler.nns-voter.jsonc
pnpm exec wrangler secret put KINIC_NNS_VOTER_NEURON_ID --config wrangler.nns.jsonc
pnpm exec wrangler secret put KINIC_NNS_VOTER_NEURON_ID --config wrangler.nns-voter.jsonc
```

The target wiki database must already be active and grant both Wiki-writing identities `writer` access. The first authenticated `POST /nns-audit/run` initializes the discovery cursor without backfilling. Keep the Wiki policy disabled and in shadow mode for the first 20 decisions. For each action family and vote direction, require at least three correct automatic-vote candidates and zero wrong-vote candidates. Enable only the passing directions (`auto_vote_choices`) and actions, change the policy to live, and finally set `KINIC_NNS_AUTOVOTE_ENABLED=true` on the voter. If REJECT examples are still insufficient, enable ADOPT alone and continue REJECT in shadow.

`KINIC_NNS_API_BASE_URL` defaults to `https://ic-api.internetcomputer.org/api/v3` and must use HTTPS. If `KINIC_NNS_AUDIT_DATABASE_ID` is absent, scheduled NNS processing is a no-op and existing Worker functions remain available.

The review Queue uses batch size 4 and concurrency 5. The voter uses batch size 1 and concurrency 1. During an NNS incident, pause only `kinic-nns-proposal-review`; normal wiki generation remains available.

Monitor backlog age, retry rate, failure Queue depth, Jev/DeepSeek 429/529/5xx rates, decision latency, vote reconciliation state, and Wiki ETag/write failures separately for all three Workers. Keep the initial settings unchanged through the 20-proposal shadow evaluation.

## Browser Source Capture Integration

Use this order when enabling WikiBrowser source capture:

1. Deploy this Worker with `KINIC_WIKI_WORKER_TOKEN` and `KINIC_WIKI_WORKER_IDENTITY_PEM` set.
2. Confirm the target canister exposes `authorize_source_capture_trigger_session`, `check_source_capture_trigger_session`, `check_source_run_session`, and `check_database_write_cycles`.
3. Grant the Worker identity writer access to target databases, or keep the default LLM writer service principal grant.
4. Set WikiBrowser `KINIC_WIKI_GENERATOR_URL` to this Worker URL.
5. Set the same `KINIC_WIKI_WORKER_TOKEN` as a WikiBrowser runtime secret.
6. Run a smoke from WikiBrowser's `/db/<database-id>/Knowledge?tab=source-capture` route and confirm `/Sources/source-capture-requests/...` plus `/Sources/...` output.

PDF, authenticated pages, and multi-URL batching are out of scope for this worker path.
