# Kinic Wiki Assistant

Database-scoped typed conversations for iOS. Voice conversations have been retired. The retained Web implementation is disconnected from the product UI and public proxy. The service has one emergency kill switch and is disabled by default. Index migration 005 is retained for historical billing data; Wiki content, search schema and the public MCP tool contract are unchanged.

## Architecture revision

[The implemented architecture](architecture.md) uses ordinary Workers, D1 and an
iOS cache. The Wiki canister remains the only financial authority. D1 stores
encrypted recovery state and content-free cleanup/reconciliation intent. Assistant
DO classes and bindings are removed; there is no fallback.

## Configuration

The browser Worker proxies only `/api/assistant/native/*` through the `WIKI_ASSISTANT` service binding for the iOS app. The Web panel implementation remains in source but is not mounted or proxied. Production and staging have separate Workers, D1 databases, secrets and database targets.

Worker secrets:

- `DEEPSEEK_API_KEY`: operator-owned DeepSeek key required for native iOS text answers. Never expose it to the client.
- `OPENAI_API_KEY`: operator-owned project key for retained browser text Agent requests and Agent session cleanup. Retired Live sessions are no longer terminated or reconciled by the Worker. Never expose it to the browser.
- `TYPESAFE_API_KEY`: operator-owned TypeSafe key used only by the Worker for Jev reranking. Never expose it to browser or iOS code.
- `ASSISTANT_KEY_ENCRYPTION_KEY`: base64-encoded 32-byte AES key for short-lived II credentials and conversation recovery records. Store it as a Worker secret, not in source control. Do not rotate it while sessions are active; stop and clear sessions first.

Worker settings:

- `ASSISTANT_ENABLED`: `false` by default; the kill switch also terminates active conversations on their next connected check, or scheduled recovery after its connection lease expires.
- `ASSISTANT_DERIVATION_ORIGIN`: must equal the **browser's** effective II derivation origin. Production uses the existing `.icp0.io` origin; do not substitute the Private MCP Worker's `.ic0.app` origin.
- `ASSISTANT_ORIGIN`: exact public Web origin for same-origin request checks and II callback generation.

Safety and usage limits are code constants: 50 questions/day, 1200 voice seconds/day, 600 seconds/connection, 12 tool calls/turn, 24000 characters/turn, a 90-second turn deadline, a 120-second reconnect window and a 600-second idle deadline. Quotas use UTC days. A voice reservation spanning midnight remains charged to the day it started.

Wrangler 4.119.0 and the existing test runtime support compatibility date 2026-08-08; this is intentionally pinned to the tested runtime instead of requiring a newer workerd binary.

## Authentication and data handling

The existing MCP II registration, five-minute app delegation, encryption, and basic node-read invocation are shared in `@kinic/ii-server`. Users select **Questions only** in II. The server independently mints the identity, matches the signed-in principal, binds each conversation to one DB and scope, and checks canister read access before text retrieval.

The read actor has only six query methods, including the existing canister `search_nodes` and `list_nodes` APIs. Its Candid record projections decode only fields used by the assistant. Jev first classifies each request as a database overview, focused search, selected-node summary, or ordinary conversation. Ambiguous classifications return a clarification without starting Wiki retrieval or answer generation. `wiki_query` fetches at most 20 lightweight candidates and Jev selects at most five. `wiki_inventory` returns a bounded overview of direct root documents plus `/Knowledge` and `/Memory`, excluding `/Sources`, `/Skills`, `/Sessions`, and other root folders. The model receives only `wiki_query`, `wiki_inventory`, `wiki_read`, and `wiki_sources`; database selection and credentials are never tool arguments. Focused-search `wiki_read` includes bounded source references so the agent can read the original source next without another tool round trip. Raw source and root-document reads require current-turn discovery. Body positions are UTF-16 string offsets, matching JavaScript slicing.

Query results are routing previews. Only exact reads create citation IDs. Final JSON must reference a current-turn read and an exact excerpt substring. This is structural citation verification, not a semantic proof that every claim follows from its source. The opt-in evaluation below checks representative semantics.

The retained browser Agent stores Agents API state at OpenAI as well as encrypted active application state in D1. Its consent UI discloses third-party processing and US session storage. Native iOS text processing is disclosed in the privacy policy and runs when the user submits a question; iOS has no separate Ask AI consent screen. The server offers no conversation-history list. Explicit end, logout, DB/account change, inactivity or loss of authorization removes local transcript/content state and requests remote session deletion. Deletion does not imply immediate removal of all provider records. Active II credentials expire within one hour; users may authorize another connection afterward.

## Recovery and usage

The browser receives snapshots over a WebSocket and sends presence heartbeats. Reconnect is allowed for two minutes (the server supplies `reconnectGraceMs` in snapshots); the browser checks HTTP state before retrying and clears stale content on terminal errors or grace expiry. Absolute deadlines and the earliest existing alarm are preserved across saves. Heartbeats do not extend the ten-minute inactivity deadline. The agent responder uses bounded session/item polling, so recovery does not depend on replaying an OpenAI event stream. Requests are marked before external submission. An uncertain submission is reconciled against stored session metadata and user items; it is never blindly resubmitted. Tool results are persisted by call ID before submission.

Cancellation invalidates the request generation and deletes its agent session before another turn is accepted. The conversation can continue in a new agent session after cancellation. An ambiguous session creation leaves a cleanup record until the matching provider session can be found; absent results are not treated as proof of deletion. Operations should investigate `assistant_cleanup_pending` logs, including the supplied conversation ID, and configure log-based notification before enabling the service. Do not clear these records to silence an error without reconciling the provider state.

Voice creation, price quotes, connection acknowledgment, speech delegation, browser audio capture, legacy provider close, settlement, refunds and expiry processing are removed. All `/voice` routes, including `/voice/stop`, return 404. Older native clients still receive `voice: "off"` snapshot metadata. Stored voice state and cleanup tasks are discarded locally without calling providers or changing canister balances. The Worker no longer uses `ASSISTANT_BILLING_KEY`. OpenAI remains configured for retained browser text Agent requests.

Structured logs contain operation state, selected semantic route, separate routing/reranking duration, total Jev duration, usage and cleanup IDs, not questions, snippets, paths, probabilities, audio or credentials. Configure Cloudflare log access and retention before rollout. D1 migration 0001 manages the unpublished Assistant tables; Jev adds no D1 migration. Database IDs in Wrangler are unprovisioned placeholders; replace them and apply versioned D1 migrations before any authorized deployment.

## Validation

```sh
pnpm --dir workers/wiki-assistant cf-typegen
pnpm --dir workers/wiki-assistant typecheck
qrun -- pnpm --dir workers/wiki-assistant test
qrun -- pnpm --dir workers/wiki-assistant build
```

Default tests have no paid API calls. They cover scope/DB isolation, source discovery, citations, limits, deduplication, uncertain submission, delayed results after termination, cleanup retry, authorization expiry and actual workerd authentication boundaries. Browser tests cover consent, account changes, citation revision checks and text-only controls.

After securely configuring the DeepSeek, OpenAI and TypeSafe keys, explicitly opt in to the Japanese-inclusive synthetic evaluation:

```sh
cd workers/wiki-assistant
node --env-file=../../.env.local ./node_modules/vitest/vitest.mjs run --config vitest.live.config.ts
```

The ignored repository-root `.env.local` holds the three keys for this command; keeping it outside the Worker directory prevents offline Wrangler tests from loading live secrets. This config runs a native DeepSeek overview with exact citation validation, the 20 OpenAI retrieval cases, an OpenAI synthetic database-overview answer, and a question-only Jev routing check. It never reads a private Wiki database. The provider calls incur usage charges. Each retrieval case supplies 20 FTS-ordered candidates with the correct candidate distributed across ranks 1–20, then runs the Agent once with the raw FTS top five and once with the Jev top five. FTS is measured for retrieval only; the Jev run must also pass answer and citation checks. The suite reports aggregate Recall@5, median time to the first correct node read, and Jev p95; it fails unless Jev Recall@5 is at least the FTS baseline, median correct-evidence time is shorter, and Jev p95 is at most one second. It tests the real Agents API with the same tools and answer validator; it does not prove production-corpus search recall or II connectivity. Set `JEV_EVAL_CASE` or `JEV_EVAL_START_CASE` to a fixture ID for focused diagnosis. Each test deletes its provider session on completion; a failed cleanup prints only the session ID requiring follow-up.

Real database checks use separate configs. The read-only check requires an authenticated local `icp` identity and sends no Wiki content to an AI provider:

```sh
KINIC_LIVE_DATABASE_ID=<database-id> KINIC_LIVE_CANISTER_ID=<canister-id> \
  pnpm --dir workers/wiki-assistant test:live:readonly
```

Only after explicit approval to send private Wiki excerpts to OpenAI, use the separate private test. It requires `KINIC_LIVE_PRIVATE_EGRESS=1` in addition to the database and canister IDs; it sends the question to TypeSafe and bounded inventory previews plus at most four read excerpts to OpenAI. Test output contains counts and booleans only, not paths or content.

```sh
cd workers/wiki-assistant
KINIC_LIVE_DATABASE_ID=<database-id> KINIC_LIVE_CANISTER_ID=<canister-id> \
KINIC_LIVE_PRIVATE_EGRESS=1 \
  node --env-file=../../.env.local ./node_modules/vitest/vitest.mjs run \
  --config vitest.private-live.config.ts
```

Before activation, separately verify on staging:

1. Real II login and equal Web/assistant principals; private/public authorized DB reads and a denied user/DB pair.
2. Questions in a representative staging Wiki with expected source pages, including permission revocation and changed etags.
3. Retired voice routes return 404 and text requests continue to work.
4. Provider session deletion, duration/token accounting, quota boundaries and the kill switch with text work.
5. Publication of the revised privacy policy describing TypeSafe/DeepSeek/OpenAI processing, alignment of the retained browser consent UI, and operational notification setup.
6. Confirmation that the TypeSafe account's API addendum permits production automated processing before changing `ASSISTANT_ENABLED` for production.
7. The September 30, 2026 iOS typed Ask AI disclosure is published before rollout. iOS processes a new question when the user submits it, without a separate consent screen. Posting the policy alone does not transmit existing conversations or Wiki content. Keep `ASSISTANT_ENABLED=false` until the other activation checks pass.

API keys, real II staging authentication, the live 20-question evaluation, deployments are intentionally not performed by offline tests. Keep the feature disabled until those checks pass. No fallback to another API/model is implemented.

Official API contracts: [Agents configuration](https://developers.openai.com/api/docs/guides/agents-api/configuration), [function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [GPT-Live WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls).

## Retired voice billing compatibility

All voice Candid methods, including `settle_voice`, `stop_voice` and `get_voice_reservation`, return `voice retired` without touching storage or balances. The voice runtime and reservation-expiry timer are removed. Existing schema migration 005 and historical ledger fields remain as stored data; they no longer have an execution or reconciliation path.

## iOS text answers with DeepSeek (2026-09-29)

Native typed questions use Jev routing/reranking and DeepSeek Chat Completions (`deepseek-flash`, non-thinking mode). The Worker executes the existing read-only Wiki tools and validates every cited quote against current-turn evidence. The retained browser Agent requests use OpenAI; native voice delegation is removed. Configure the Worker secret `DEEPSEEK_API_KEY` alongside the existing secrets; it is never sent to iOS. The model name follows the [DeepSeek Chat Completions contract](https://api-docs.deepseek.com/api/create-chat-completion/).

Native auth and conversation creation retain the wire field `consent` with version `2026-09-29` to identify the current provider contract. The iOS app supplies this value automatically; it does not represent a separate user consent action. Earlier native active sessions are ended through the existing cleanup path before reconnecting. Browser consent remains unchanged. Publish the revised provider disclosures before rollout, then deploy the Worker and distribute the updated iOS app. Existing activation gates still apply.

Text turn state, tool results and generated messages are checkpointed in encrypted D1 state. Each provider submission is marked before sending. Recovery resumes saved tool results or final answers, but an interrupted provider submission fails with `deepseek_request_interrupted` rather than being automatically repeated. The user can explicitly retry. Requests reject redirects, cap responses at 256 KiB, time out after at most 45 seconds per request within the existing 90-second turn budget, and allow at most 13 model rounds under the existing 12-tool/24,000-character retrieval limits. Follow-up context is bounded to six messages and 4,000 characters. Cancellation aborts active text fetches and invalidates late responses. No DeepSeek session resource is created or deleted; provider retention terms still apply.

Offline tests cover provider routing, tool execution/checkpoints, authorization, cancellation, malformed/oversized responses, uncertain submission recovery, and citation rejection. Live answer quality and physical-device acceptance require separate validation before release.
