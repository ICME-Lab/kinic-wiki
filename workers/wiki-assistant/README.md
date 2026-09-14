# Kinic Wiki Assistant

Invite-only, database-scoped text and GPT-Live conversations for the existing Wiki Browser. Disabled by default. The canister schema and the public MCP tool contract are unchanged.

## Configuration

The browser proxies `/api/assistant/*` through the `WIKI_ASSISTANT` service binding. Deploy the assistant Worker before a browser build that uses this binding. Production and staging have separate Workers, Durable Objects, invitations, secrets, and database targets.

Worker secrets:

- `OPENAI_API_KEY`: operator-owned project key with Agents read/write, Responses inference, and GPT-Live access. Never expose it to the browser.
- `ASSISTANT_KEY_ENCRYPTION_KEY`: base64-encoded 32-byte AES key for short-lived II credentials. Store it as a Worker secret, not in source control. Do not rotate it while sessions are active; stop and clear sessions first.

Worker settings:

- `ASSISTANT_ENABLED`: `false` by default; the kill switch also terminates active conversations on their next alarm (within 15 seconds, excluding remote API latency).
- `ASSISTANT_INVITED_PRINCIPALS`: JSON array of Wiki principals. An empty array admits nobody.
- `ASSISTANT_DERIVATION_ORIGIN`: must equal the **browser's** effective II derivation origin. Production uses the existing `.icp0.io` origin; do not substitute the Private MCP Worker's `.ic0.app` origin.
- `ASSISTANT_ORIGIN`: exact public Web origin for same-origin request checks and II callback generation.
- `ASSISTANT_LIMITS`: optional JSON overrides of `questions`, `voiceSeconds`, `connectionSeconds`, `calls`, `characters`, `turnMs`, `reconnectMs`, `idleMs`. Defaults are 50/day, 1200/day, 600/connection, 12/turn, 24000/turn, 90000, 120000, 600000. Quotas use UTC days. A voice reservation spanning midnight remains charged to the day it started.

Wrangler 4.119.0 and the existing test runtime support compatibility date 2026-08-08; this is intentionally pinned to the tested runtime instead of requiring a newer workerd binary.

## Authentication and data handling

The existing MCP II registration, five-minute app delegation, encryption, and basic node-read invocation are shared in `@kinic/ii-server`. Users select **Questions only** in II. The Web verifies that the separately authorized principal equals the signed-in Wiki principal. The server independently mints the identity, enforces invitations, binds each conversation to one DB and scope, and checks canister read access before tools, responses and reconnects.

The read actor has only four query methods. Its Candid record projections decode the fields used by the assistant. The model receives only `wiki_query`, `wiki_read`, `wiki_sources`; database selection and credentials are never tool arguments. Raw source reads require prior discovery through a previously read node. Skill and session roots are excluded. Body positions are UTF-16 string offsets, matching JavaScript slicing.

Query results are routing previews. Only exact reads create citation IDs. Final JSON must reference a current-turn read and an exact excerpt substring. This is structural citation verification, not a semantic proof that every claim follows from its source. The opt-in evaluation below checks representative semantics.

Agents API state lives at OpenAI as well as the active application's state in a Durable Object. Initial consent explicitly discloses third-party processing and US session storage. The application stores no voice recordings (`store: false`) and offers no conversation-history list. Explicit end, logout, DB/account change, inactivity or loss of authorization removes local transcript/content state and requests remote session deletion. Deletion does not imply immediate removal of all provider records. Active II credentials expire within one hour; users may authorize another connection afterward.

## Recovery and usage

The browser receives snapshots over a WebSocket and sends presence heartbeats. Reconnect is allowed for two minutes (the server supplies `reconnectGraceMs` in snapshots); the browser checks HTTP state before retrying and clears stale content on terminal errors or grace expiry. Absolute deadlines and the earliest existing alarm are preserved across saves. Heartbeats do not extend the ten-minute inactivity deadline. The agent responder uses bounded session/item polling, so recovery does not depend on replaying an OpenAI event stream. Requests are marked before external submission. An uncertain submission is reconciled against stored session metadata and user items; it is never blindly resubmitted. Tool results are persisted by call ID before submission.

Cancellation invalidates the request generation and deletes its agent session before another turn is accepted. The conversation can continue in a new agent session after cancellation. An ambiguous session creation leaves a cleanup record until the matching provider session can be found; absent results are not treated as proof of deletion. Operations should investigate `assistant_cleanup_pending` logs, including the supplied conversation ID, and configure log-based notification for that event before enabling invitations. Do not clear these records to silence an error without reconciling the provider state.

Voice is WebRTC with server-owned client delegation and a sideband. Frontend data-channel commands are limited to closing the session. Only server-verified results are appended for speech. Transcripts are bounded; exceeding their budget stops voice while text remains available. A speech interruption alone does not cancel tools. Application cancellation suppresses old generations; UI playback is muted until the user restarts voice. A failed sideband reconnection stops only voice; the pending question still completes on screen. Voice time is reserved before creation and settled once using provider-reported seconds, including after conversation end. Cleanup records retain only IDs and reservation accounting metadata, never content. Unknown creation/close usage conservatively retains the reservation; settlement never changes another UTC day’s quota. Reflected audio is ignored and never persisted.

Structured logs contain operation state, duration, usage and cleanup IDs, not questions, snippets, audio or credentials. Configure Cloudflare log access and retention before rollout. The per-user state version is 1; native Durable Object storage and the v1 class migration manage persistence without adding application SQL tables.

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
5. Applicable privacy-policy changes and notification setup. The current public policy says Ask AI data is not sent to a third-party provider; the Web preview must not be enabled under that unqualified statement. A draft amendment is in `../../docs/legal/web-assistant-preview-privacy-draft.md`.

API keys, real II staging authentication, the live 20-question evaluation, actual Chrome/Safari audio and deployments are intentionally not performed by offline tests. Keep the feature disabled until those checks pass. No fallback to another API/model is implemented.

Official API contracts: [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).
