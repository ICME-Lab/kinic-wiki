# iOS, ordinary Worker, D1 and Wiki canister

The Assistant runs without Durable Objects. The unpublished DO classes, bindings,
migration and test shim have been removed. There is no compatibility migration or
DO fallback. The single service kill switch remains false, and no cloud resources were created
or deployed.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Wiki canister (one configured target per environment) | DB balance, owner access/budgets, versioned rates, reservations, confirmed charges and idempotent settlement |
| D1 | Short-lived authorization, encrypted recovery state, UTC usage limits, request deduplication, leases, stop intent and provider cleanup jobs |
| Ordinary Worker | Authentication, Wiki reads, Agents turns, source validation, client control socket and outbound Live sideband |
| Scheduled Worker | Expired-session recovery and cleanup reconciliation without a running client |
| iOS | Protected, backup-excluded preview cache, UI, microphone/playback and funded-time cutoff |
| iOS to GPT-Live | Direct WebRTC audio; operator credentials never reach the device |

D1 contains reservation identifiers and reconciliation metadata, not an independent
balance or billing ledger. Settlement and extension errors are reconciled against
the canister's reservation API. There are no Queues, Workflows, KV or read replicas.

## Storage and concurrency

Apply D1 migration 0001 once through Wrangler's versioned migration runner.
Authentication claims use conditional updates; principal and conversation uniqueness,
revision checks and per-commit guards protect multi-statement D1 batches.
Bearer tokens are hashed. Existing encrypted key/delegation records remain encrypted.
Conversation state, per-question records and command replies use AES-GCM, with a
record-specific authenticated context. Excerpts are not copied into operational jobs.

Connection and question ownership use separate 45-second D1 leases renewed every
10 seconds. Acquiring an expired lease increments its generation. State commits
check both the expected revision and active lease, and old provider callbacks are
fenced. The client always checks HTTP state before reconnecting. Reconnect grace is
two minutes, question execution is bounded at 90 seconds, and inactivity at 10 minutes.

The native and retained Web client send request-ID commands over the control socket.
Questions retain their IDs across uncertain submission; saved Agents turn/actions are
checked before continuing. A persisted command with an unknown non-question outcome
is never blindly re-executed. HTTP remains available for voice stop and conversation
end. An ownership-bound stop intent and its server receipt time survive independently
of the socket and are applied by the next invocation. Voice interruption preserves
pending text work.

## Crash recovery and cleanup

Provider creation intent precedes the API call; returned provider IDs are recorded
before success reaches the client. Unknown creation remains a reconciliation job.
Ending atomically deletes active encrypted content, request/command payloads and
authorization while recording content-free cleanup metadata. Late provider IDs can
still complete their independent journal record after content removal.

Cron runs every minute with four concurrent runners and at most twenty recovery units
(ten user-state recovery units and ten provider jobs). Provider-job failures back off
exponentially from one minute to at most thirty minutes. Each job uses a renewed lease;
only its current generation can acknowledge completion. Provider deletion is retried
until confirmed and is independent of the canister's 24-hour reservation expiry.

A live connection and iOS enforce the funded cutoff directly; cron is not a
second-precision audio watchdog. Without the connection owner, recovery stops billing
at the last confirmed connection activity, reconciles the canister, and closes Live.
An unconfirmed interval must not extend the charge. D1/provider failure cannot safely
authorize more paid time. The canister releases unconfirmed reservations after 24 hours.

D1 Time Travel can retain prior encrypted records after application deletion. Its
backup history is not erased by deleting a current row. Privacy text discloses that
distinction; operators must check retention before release. Never restore a D1 backup
directly into an enabled service: restored work must first be reconciled with the
canonical canister and provider state.

## Validation and release gates

Local workerd tests exercise ordinary Worker WebSockets with mock sideband, fresh
invocations sharing D1, lease takeover, stale-write rejection, one-time authentication,
encrypted command replay, and atomic content removal with late provider completion.
Lifecycle tests retain pending-action, deadline, voice failure and billing cases.
A separate Miniflare test terminates and recreates workerd with a persistent D1
directory and verifies takeover using the production lease implementation. These
local tests are not evidence of successful real API calls or production acceptance.

Real II direct grants, actual provider create-response loss and Live discovery/close,
20-question semantic evaluation, physical-device locked/background audio, and alert
delivery remain release gates. Unknown Live creation cannot currently be resolved
automatically without its provider ID; its job is retained and emits a content-free
`assistant_live_creation_unresolved` operational event with the conversation, request,
and voice identifiers already stored in D1. SDP is not persisted, and the scheduled
Worker never retries Live creation. The service kill switch must remain off until an
official idempotent-create or reconciliation API is verified against the real service.
No alternate API or authority expansion is used.

Wrangler database IDs are explicit unprovisioned placeholders. Provision separate
staging/production D1 databases, replace their IDs, apply migrations and configure
secrets/alerts only in the authorized release workflow. This implementation does not
perform those actions.
