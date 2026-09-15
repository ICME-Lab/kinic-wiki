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
- `ASSISTANT_KEY_ENCRYPTION_KEY`: base64-encoded 32-byte AES key for short-lived II credentials and conversation recovery records. Store it as a Worker secret, not in source control. Do not rotate it while sessions are active; stop and clear sessions first.

Worker settings:

- `ASSISTANT_ENABLED`: `false` by default; the kill switch also terminates active conversations on their next connected check, or scheduled recovery after its connection lease expires.
- `ASSISTANT_DERIVATION_ORIGIN`: must equal the **browser's** effective II derivation origin. Production uses the existing `.icp0.io` origin; do not substitute the Private MCP Worker's `.ic0.app` origin.
- `ASSISTANT_ORIGIN`: exact public Web origin for same-origin request checks and II callback generation.

Safety and usage limits are code constants: 50 questions/day, 1200 voice seconds/day, 600 seconds/connection, 12 tool calls/turn, 24000 characters/turn, a 90-second turn deadline, a 120-second reconnect window and a 600-second idle deadline. Quotas use UTC days. A voice reservation spanning midnight remains charged to the day it started.

Wrangler 4.119.0 and the existing test runtime support compatibility date 2026-08-08; this is intentionally pinned to the tested runtime instead of requiring a newer workerd binary.

## Authentication and data handling

The existing MCP II registration, five-minute app delegation, encryption, and basic node-read invocation are shared in `@kinic/ii-server`. Users select **Questions only** in II. The server independently mints the identity, matches the signed-in principal, binds each conversation to one DB and scope, checks canister read access and requires the database owner's voice policy before activation.

The read actor has only four query methods. Its Candid record projections decode the fields used by the assistant. The model receives only `wiki_query`, `wiki_read`, `wiki_sources`; database selection and credentials are never tool arguments. Raw source reads require prior discovery through a previously read node. Skill and session roots are excluded. Body positions are UTF-16 string offsets, matching JavaScript slicing.

Query results are routing previews. Only exact reads create citation IDs. Final JSON must reference a current-turn read and an exact excerpt substring. This is structural citation verification, not a semantic proof that every claim follows from its source. The opt-in evaluation below checks representative semantics.

Agents API state lives at OpenAI as well as the encrypted active application state in D1. Initial consent explicitly discloses third-party processing and US session storage. The application stores no voice recordings (`store: false`) and offers no conversation-history list. Explicit end, logout, DB/account change, inactivity or loss of authorization removes local transcript/content state and requests remote session deletion. Deletion does not imply immediate removal of all provider records. Active II credentials expire within one hour; users may authorize another connection afterward.

## Recovery and usage

The browser receives snapshots over a WebSocket and sends presence heartbeats. Reconnect is allowed for two minutes (the server supplies `reconnectGraceMs` in snapshots); the browser checks HTTP state before retrying and clears stale content on terminal errors or grace expiry. Absolute deadlines and the earliest existing alarm are preserved across saves. Heartbeats do not extend the ten-minute inactivity deadline. The agent responder uses bounded session/item polling, so recovery does not depend on replaying an OpenAI event stream. Requests are marked before external submission. An uncertain submission is reconciled against stored session metadata and user items; it is never blindly resubmitted. Tool results are persisted by call ID before submission.

Cancellation invalidates the request generation and deletes its agent session before another turn is accepted. The conversation can continue in a new agent session after cancellation. An ambiguous session creation leaves a cleanup record until the matching provider session can be found; absent results are not treated as proof of deletion. Operations should investigate `assistant_cleanup_pending` logs, including the supplied conversation ID, and configure log-based notification before enabling the service. Do not clear these records to silence an error without reconciling the provider state.

Voice is WebRTC with server-owned client delegation and a sideband. Frontend data-channel commands are limited to closing the session. Only server-verified results are appended for speech. Transcripts are bounded; exceeding their budget stops voice while text remains available. A speech interruption alone does not cancel tools. Application cancellation suppresses old generations; UI playback is muted until the user restarts voice. A failed sideband reconnection stops only voice; the pending question still completes on screen. Voice time is reserved before creation and settled once using provider-reported seconds, including after conversation end. Cleanup records retain only IDs and reservation accounting metadata, never content. Unknown creation/close usage conservatively retains the reservation; settlement never changes another UTC day’s quota. Reflected audio is ignored and never persisted.

Structured logs contain operation state, duration, usage and cleanup IDs, not questions, snippets, audio or credentials. Configure Cloudflare log access and retention before rollout. D1 migration 0001 manages the unpublished Assistant tables. Database IDs in Wrangler are unprovisioned placeholders; replace them and apply versioned D1 migrations before any authorized deployment.

## Validation

```sh
pnpm --dir workers/wiki-assistant cf-typegen
pnpm --dir workers/wiki-assistant typecheck
qrun -- pnpm --dir workers/wiki-assistant test
qrun -- pnpm --dir workers/wiki-assistant build
```

Default tests have no paid API calls. They cover scope/DB isolation, source discovery, citations, limits, deduplication, uncertain submission, delayed results after termination, cleanup retry, authorization expiry and actual workerd authentication boundaries. Browser tests cover consent, account changes, citation revision checks and microphone cleanup.

After securely configuring a key, explicitly opt in to the 20-case synthetic evaluation:

```sh
qrun -- pnpm --dir workers/wiki-assistant test:live
```

This sends only synthetic fixtures to OpenAI and incurs usage charges. It tests the real Agents API with the same tools and answer validator; it does not prove production search recall or II connectivity. Failed expectations need investigation, not weakening to obtain a pass. Each test deletes its provider session on completion; a failed cleanup prints only the session ID requiring follow-up.

Before activation, separately verify on staging:

1. Real II login and equal Web/assistant principals; private/public authorized DB reads and a denied user/DB pair.
2. Questions in a representative staging Wiki with expected source pages, including permission revocation and changed etags.
3. Actual microphone and speaker behavior in Chrome and Safari: startup, correction, interruption, reconnect, mute/cancel, remote close, denied microphone and concurrent tabs.
4. Provider session deletion, duration/token accounting, quota boundaries and the kill switch with active text and voice work.
5. Publication of the revised privacy policy and operational notification setup. `../../docs/legal/privacy-policy.md` now distinguishes existing Ask AI from the optional voice preview; its public deployment and App Store disclosures remain release conditions.

API keys, real II staging authentication, the live 20-question evaluation, actual Chrome/Safari audio and deployments are intentionally not performed by offline tests. Keep the feature disabled until those checks pass. No fallback to another API/model is implemented.

Official API contracts: [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

## Native iOS preview and cycles billing

Native requests use `/api/assistant/native/` and an Authorization Bearer header, including WebSocket upgrades. The direct ICRC-167 flow delegates to a Worker-generated key; it does not export the existing iOS key or use the Web MCP registration bridge. The configured Wiki canister is fixed per environment; signed targets are optional, but if present must permit that canister. The effective grant must be query-only. A signed canister read must succeed before activation; structural parser tests do not verify signatures on their own.

`ASSISTANT_ENABLED` is the only feature switch. The iOS entry point is always present and reports server availability; the Web entry point remains disconnected. Access is controlled by the selected database's owner policy and the caller's read permission instead of a second invitation list. `ASSISTANT_BILLING_KEY` is a Worker secret containing an Ed25519 identity JSON for the dedicated voice charging authority; it is separate from II credentials, the existing billing administrator and the IAP grant authority.

The billing administrator configures a strictly increasing `VoiceRate` using `configure_voice_rate`. Database owners set member permissions and UTC daily budgets using `set_voice_policy`. No configured rate or permission means no paid connection. Query-only user credentials never perform these updates. Native preview text is free within the existing daily limit and requires an enabled owner policy.

Index migration 005 adds rates, policies and reservations plus voice metadata on the existing ledger. `reserve_voice` locks 60 seconds of credits atomically, extending cumulatively in 60-second steps. `settle_voice` bills confirmed cumulative seconds and releases unused credits on close. Records bind the DB, member, session and immutable rate; charging is computed in the canister. A session spanning midnight stays on its original UTC budget day. Unknown usage is held for at most 24 hours, then a bounded minute timer releases the unconfirmed balance and emits a content-free notification event. Operators must connect `voice_billing_expired` / `voice_billing_pending` events to operational alerts before rollout.

The Worker schedules the funded deadline, and the iOS audio manager independently stops at the last acknowledged reservation deadline if server updates stop. Cleanup accounting survives content deletion. Provider tokens/seconds remain operational measurements; user charges use the server's connection clock and stop-request timestamp. Native billing starts when the app acknowledges WebRTC and session.started, using server receipt time. The microphone stays disabled until this acknowledgment succeeds; unacknowledged setup is stopped after 30 seconds and refunded. Known setup failure is not billed. Third-party WebRTC 153.0.0 is pinned in the iOS lockfile; it is not an OpenAI SDK.

Release still requires real II and GPT-Live connectivity, semantic evaluation of 20 representative questions, physical-device locked/background audio, interruptions and routing, actual settlement, cleanup notifications, and App Store/IAP disclosure review. API provisioning is deferred. Nothing in the offline tests authorizes deployment or enables the feature.

Apply canister index migration 005 before distributing this iOS build: its cycle-ledger decoder expects the new voice fields. No legacy reply shim is included.
