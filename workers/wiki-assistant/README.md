# Kinic Wiki Assistant

The public browser Worker forwards only `/api/assistant/native/*` to this Worker for iOS Ask AI. The browser Agent API and panel have been removed. Direct requests to `/api/assistant/*` outside the native prefix return 404.

## Data flow

Native typed questions use TypeSafe Jev for routing and reranking, then DeepSeek Chat Completions for the answer. The Worker reads authorized Wiki content from the canister, sends selected context to DeepSeek, and validates cited excerpts against current-turn reads. It handles plaintext during this process. DeepSeek has no server-side conversation session to delete; provider retention terms still apply.

The Worker stores encrypted conversation recovery state in D1. Ending a conversation removes local transcript and answer state. Historical OpenAI Agent cleanup records and jobs remain in D1 for audit, but this Worker no longer creates or calls OpenAI Agent sessions.

## Configuration

Production and staging have separate Workers, D1 databases, secrets, and canister targets. Required Worker secrets are `DEEPSEEK_API_KEY`, `TYPESAFE_API_KEY`, and `ASSISTANT_KEY_ENCRYPTION_KEY`. Do not expose them to clients. `ASSISTANT_ENABLED` is the emergency kill switch. `ASSISTANT_DERIVATION_ORIGIN` must match the browser's effective Internet Identity derivation origin.

The read actor has six query methods. Jev classifies requests as database overview, focused search, selected-node summary, or ordinary conversation. Ambiguous classifications return a clarification without retrieving Wiki content. Search returns at most 20 candidates and Jev selects at most five. The model can request only the read-only Wiki tools permitted for the route. Citation IDs come only from exact reads, and final quotes must match current-turn evidence.

Native auth and conversation creation use the `2026-09-29` provider-contract value. The iOS app supplies it automatically when a user submits a question. Active II credentials expire within one hour. Cancellation aborts active text fetches and invalidates late responses.

## Verification

```sh
pnpm --dir workers/wiki-assistant typecheck
pnpm --dir workers/wiki-assistant test
pnpm --dir workers/wiki-assistant build
```

Default tests make no paid API calls. `test:live` covers synthetic DeepSeek and TypeSafe routing. `test:live:readonly` checks authenticated Wiki reads without sending Wiki content to an AI provider. `test:live:private` explicitly sends real Wiki excerpts to DeepSeek and requires `KINIC_LIVE_PRIVATE_EGRESS=1` and provider keys.

Voice routes are retired and return 404. Historical voice billing tables remain for compatibility; they do not create a provider call.
