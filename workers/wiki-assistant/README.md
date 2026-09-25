# Kinic Wiki Assistant

Database-scoped text and GPT-Live conversations for iOS. The retained Web implementation is disconnected from the product UI and public proxy. The service has one emergency kill switch and is disabled by default. Index migration 005 adds DB voice billing; Wiki content, search schema and the public MCP tool contract are unchanged.

## Architecture revision

[The implemented architecture](architecture.md) uses ordinary Workers, D1 and an
iOS cache. The Wiki canister remains the only financial authority. D1 stores
encrypted recovery state and content-free cleanup/reconciliation intent. Assistant
DO classes and bindings are removed; there is no fallback.

## Configuration

The browser Worker proxies only `/api/assistant/native/*` through the `WIKI_ASSISTANT` service binding for the iOS app. The Web panel implementation remains in source but is not mounted or proxied. Production and staging have separate Workers, D1 databases, secrets and database targets.

Worker secrets:

- `OPENAI_API_KEY`: operator-owned project key with Agents read/write, Responses inference, and GPT-Live access. Never expose it to the browser.
- `TYPESAFE_API_KEY`: operator-owned TypeSafe key used only by the Worker for Jev reranking. Never expose it to browser or iOS code.
- `ASSISTANT_KEY_ENCRYPTION_KEY`: base64-encoded 32-byte AES key for short-lived II credentials and conversation recovery records. Store it as a Worker secret, not in source control. Do not rotate it while sessions are active; stop and clear sessions first.

Worker settings:

- `ASSISTANT_ENABLED`: `false` by default; the kill switch also terminates active conversations on their next connected check, or scheduled recovery after its connection lease expires.
- `ASSISTANT_DERIVATION_ORIGIN`: must equal the **browser's** effective II derivation origin. Production uses the existing `.icp0.io` origin; do not substitute the Private MCP Worker's `.ic0.app` origin.
- `ASSISTANT_ORIGIN`: exact public Web origin for same-origin request checks and II callback generation.

Safety and usage limits are code constants: 50 questions/day, 1200 voice seconds/day, 600 seconds/connection, 12 tool calls/turn, 24000 characters/turn, a 90-second turn deadline, a 120-second reconnect window and a 600-second idle deadline. Quotas use UTC days. A voice reservation spanning midnight remains charged to the day it started.

Wrangler 4.119.0 and the existing test runtime support compatibility date 2026-08-08; this is intentionally pinned to the tested runtime instead of requiring a newer workerd binary.

## Authentication and data handling

The existing MCP II registration, five-minute app delegation, encryption, and basic node-read invocation are shared in `@kinic/ii-server`. Users select **Questions only** in II. The server independently mints the identity, matches the signed-in principal, binds each conversation to one DB and scope, and checks canister read access before text retrieval. Starting a paid voice connection additionally requires the database owner's voice policy.

The read actor has only six query methods, including the existing canister `search_nodes` and `list_nodes` APIs. Its Candid record projections decode only fields used by the assistant. Jev first classifies each request as a database overview, focused search, selected-node summary, or ordinary conversation. Ambiguous classifications return a clarification without starting Wiki retrieval or an OpenAI Agent turn. `wiki_query` fetches at most 20 lightweight candidates and Jev selects at most five. `wiki_inventory` returns a bounded overview of direct root documents plus `/Knowledge` and `/Memory`, excluding `/Sources`, `/Skills`, `/Sessions`, and other root folders. The model receives only `wiki_query`, `wiki_inventory`, `wiki_read`, and `wiki_sources`; database selection and credentials are never tool arguments. Focused-search `wiki_read` includes bounded source references so the agent can read the original source next without another tool round trip. Raw source and root-document reads require current-turn discovery. Body positions are UTF-16 string offsets, matching JavaScript slicing.

Query results are routing previews. Only exact reads create citation IDs. Final JSON must reference a current-turn read and an exact excerpt substring. This is structural citation verification, not a semantic proof that every claim follows from its source. The opt-in evaluation below checks representative semantics.

Agents API state lives at OpenAI as well as the encrypted active application state in D1. Initial consent explicitly discloses third-party processing and US session storage. The application stores no voice recordings (`store: false`) and offers no conversation-history list. Explicit end, logout, DB/account change, inactivity or loss of authorization removes local transcript/content state and requests remote session deletion. Deletion does not imply immediate removal of all provider records. Active II credentials expire within one hour; users may authorize another connection afterward.

## Recovery and usage

The browser receives snapshots over a WebSocket and sends presence heartbeats. Reconnect is allowed for two minutes (the server supplies `reconnectGraceMs` in snapshots); the browser checks HTTP state before retrying and clears stale content on terminal errors or grace expiry. Absolute deadlines and the earliest existing alarm are preserved across saves. Heartbeats do not extend the ten-minute inactivity deadline. The agent responder uses bounded session/item polling, so recovery does not depend on replaying an OpenAI event stream. Requests are marked before external submission. An uncertain submission is reconciled against stored session metadata and user items; it is never blindly resubmitted. Tool results are persisted by call ID before submission.

Cancellation invalidates the request generation and deletes its agent session before another turn is accepted. The conversation can continue in a new agent session after cancellation. An ambiguous session creation leaves a cleanup record until the matching provider session can be found; absent results are not treated as proof of deletion. Operations should investigate `assistant_cleanup_pending` logs, including the supplied conversation ID, and configure log-based notification before enabling the service. Do not clear these records to silence an error without reconciling the provider state.

Voice is WebRTC with server-owned client delegation and a sideband. Frontend data-channel commands are limited to closing the session. Only server-verified results are appended for speech. Transcripts are bounded; exceeding their budget stops voice while text remains available. A speech interruption alone does not cancel tools. Application cancellation suppresses old generations; UI playback is muted until the user restarts voice. A failed sideband reconnection stops only voice; the pending question still completes on screen. Voice time is reserved before creation and settled once using provider-reported seconds, including after conversation end. Cleanup records retain only IDs and reservation accounting metadata, never content. Unknown creation/close usage conservatively retains the reservation; settlement never changes another UTC day’s quota. Reflected audio is ignored and never persisted.

Structured logs contain operation state, selected semantic route, separate routing/reranking duration, total Jev duration, usage and cleanup IDs, not questions, snippets, paths, probabilities, audio or credentials. Configure Cloudflare log access and retention before rollout. D1 migration 0001 manages the unpublished Assistant tables; Jev adds no D1 migration. Database IDs in Wrangler are unprovisioned placeholders; replace them and apply versioned D1 migrations before any authorized deployment.

## Validation

```sh
pnpm --dir workers/wiki-assistant cf-typegen
pnpm --dir workers/wiki-assistant typecheck
qrun -- pnpm --dir workers/wiki-assistant test
qrun -- pnpm --dir workers/wiki-assistant build
```

Default tests have no paid API calls. They cover scope/DB isolation, source discovery, citations, limits, deduplication, uncertain submission, delayed results after termination, cleanup retry, authorization expiry and actual workerd authentication boundaries. Browser tests cover consent, account changes, citation revision checks and microphone cleanup.

After securely configuring both provider keys, explicitly opt in to the 20-case Japanese-inclusive synthetic evaluation:

```sh
cd workers/wiki-assistant
node --env-file=../../.env.local ./node_modules/vitest/vitest.mjs run --config vitest.live.config.ts
```

The ignored repository-root `.env.local` holds the two keys for this command; keeping it outside the Worker directory prevents offline Wrangler tests from loading live secrets. This sends only synthetic fixtures to TypeSafe and OpenAI and incurs usage charges. Each of the 20 cases supplies 20 FTS-ordered candidates with the correct candidate distributed across ranks 1–20, then runs the Agent once with the raw FTS top five and once with the Jev top five. FTS is measured for retrieval only; the Jev run must also pass answer and citation checks. The suite reports aggregate Recall@5, median time to the first correct node read, and Jev p95; it fails unless Jev Recall@5 is at least the FTS baseline, median correct-evidence time is shorter, and Jev p95 is at most one second. It tests the real Agents API with the same tools and answer validator; it does not prove production-corpus search recall or II connectivity. Set `JEV_EVAL_CASE` or `JEV_EVAL_START_CASE` to a fixture ID for focused diagnosis. Each test deletes its provider session on completion; a failed cleanup prints only the session ID requiring follow-up.

Before activation, separately verify on staging:

1. Real II login and equal Web/assistant principals; private/public authorized DB reads and a denied user/DB pair.
2. Questions in a representative staging Wiki with expected source pages, including permission revocation and changed etags.
3. Actual microphone and speaker behavior in Chrome and Safari: startup, correction, interruption, reconnect, mute/cancel, remote close, denied microphone and concurrent tabs.
4. Provider session deletion, duration/token accounting, quota boundaries and the kill switch with active text and voice work.
5. Publication of the revised privacy policy and versioned TypeSafe/OpenAI consent UI, plus operational notification setup.
6. Confirmation that the TypeSafe account's API addendum permits production automated processing before changing `ASSISTANT_ENABLED` for production.
7. The revised privacy policy has reached its stated effective date of **2026-10-22**. Publishing it earlier does not authorize enabling production traffic before that date; keep `ASSISTANT_ENABLED=false` until then.

API keys, real II staging authentication, the live 20-question evaluation, actual Chrome/Safari audio and deployments are intentionally not performed by offline tests. Keep the feature disabled until those checks pass. No fallback to another API/model is implemented.

Official API contracts: [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

## Native iOS preview and cycles billing

Native requests use `/api/assistant/native/` and an Authorization Bearer header, including WebSocket upgrades. The direct ICRC-167 flow delegates to a Worker-generated key; it does not export the existing iOS key or use the Web MCP registration bridge. The configured Wiki canister is fixed per environment; signed targets are optional, but if present must permit that canister. The effective grant must be query-only. A signed canister read must succeed before activation; structural parser tests do not verify signatures on their own.

`ASSISTANT_ENABLED` is the only feature switch. The iOS entry point is always present and reports server availability; the Web entry point remains disconnected. Access is controlled by the selected database's owner policy and the caller's read permission instead of a second invitation list. `ASSISTANT_BILLING_KEY` is a Worker secret containing an Ed25519 identity JSON for the dedicated voice charging authority; it is separate from II credentials, the existing billing administrator and the IAP grant authority.

The billing administrator configures a strictly increasing `VoiceRate` using `configure_voice_rate`. Database owners set member permissions and UTC daily budgets using `set_voice_policy`. No configured rate or permission means no paid connection. Query-only user credentials never perform these updates. Native text is free within the existing daily limit and requires current database read permission. Voice additionally requires an enabled owner policy.

Index migration 005 adds rates, policies and reservations plus voice metadata on the existing ledger. `reserve_voice` locks 60 seconds of credits atomically, extending cumulatively in 60-second steps. `settle_voice` bills confirmed cumulative seconds and releases unused credits on close. Records bind the DB, member, session and immutable rate; charging is computed in the canister. A session spanning midnight stays on its original UTC budget day. Unknown usage is held for at most 24 hours, then a bounded minute timer releases the unconfirmed balance and emits a content-free notification event. Operators must connect `voice_billing_expired` / `voice_billing_pending` events to operational alerts before rollout.

The Worker schedules the funded deadline, and the iOS audio manager independently stops at the last acknowledged reservation deadline if server updates stop. Cleanup accounting survives content deletion. Provider tokens/seconds remain operational measurements; user charges use the server's connection clock and stop-request timestamp. Native billing starts when the app acknowledges WebRTC and session.started, using server receipt time. The microphone stays disabled until this acknowledgment succeeds; unacknowledged setup is stopped after 30 seconds and refunded. Known setup failure is not billed. Third-party WebRTC 153.0.0 is pinned in the iOS lockfile; it is not an OpenAI SDK.

Release still requires real II and GPT-Live connectivity, semantic evaluation of 20 representative questions, physical-device locked/background audio, interruptions and routing, actual settlement, cleanup notifications, and App Store/IAP disclosure review. API provisioning is deferred. Nothing in the offline tests authorizes deployment or enables the feature.

Apply canister index migration 005 before distributing this iOS build: its cycle-ledger decoder expects the new voice fields. No legacy reply shim is included.


## Voice interaction revision (2026-09-18)

The iOS voice button performs access preflight, versioned consent and connection in one flow. `initialize_voice_policy(database_id)` is an authenticated owner-only, insert-once operation: an absent owner policy becomes enabled with ten minutes of the current rate as its daily cycles budget. It never changes an existing disabled or zero-budget policy. `get_voice_access(database_id, principal)` returns policy, current rate, remaining UTC-day budget and database balance. Budgets are fixed cycles amounts; rate changes never raise them automatically.

Voice settings live under Settings → Voice, with database and member selection. Consent is account/version scoped, and a new rate version requires confirmation. Transcript events are deduplicated by provider event ID and grouped into stable utterance IDs. Snapshots carry utterances to the existing account-scoped Ask AI history. Historical context is bounded to 20 messages of 4,000 characters and 12,000 UTF-8 JSON bytes in total, is untrusted, and cannot substitute for current Wiki retrieval. Audio recordings are never persisted.

The app stops the microphone immediately, requests server stop, fetches final state and acknowledges history persistence before logout. Failed persistence keeps a protected account-scoped recovery copy and exposes retry. Ending voice does not delete Ask AI history.

Rollout order: upgrade the Wiki canister with the two new methods, deploy this Worker, then install/distribute iOS. Conversation format 2 deliberately retires previous temporary active sessions through the existing cleanup path; it does not reinterpret or migrate their encrypted content. New sessions must be started after the Worker upgrade. No SQLite table migration is needed for the new policy methods. Existing Ask AI history format is unchanged. Verify actual microphone audio, final settlement and server cleanup on the selected device before distribution.

Voice finalization treats HTTP stop success as acceptance, not completion. The connection owner serializes received transcript/lifecycle events and drains their persistence before completing the provider close handshake. A recovery invocation may claim an idle connection lease to finish cleanup. The iOS client waits up to 30 seconds for the persisted `voice: off` state, then saves history before logout and local recovery deletion. A separate protected ending marker preserves retry-only behavior across application restarts. Expired remote sessions retain the last received local history with an explicit incomplete-final-state warning. Answer caveats are included both on screen and in the existing history message text.
