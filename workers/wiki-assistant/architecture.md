# iOS, ordinary Worker, D1 and Wiki canister

The Assistant runs without Durable Objects. The unpublished DO classes, bindings,
migration and test shim have been removed. There is no compatibility migration or
DO fallback. The service kill switch controls text requests; text Agent cleanup remains
available when disabled.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Wiki canister (one configured target per environment) | Wiki data and access authorization |
| D1 | Short-lived authorization, encrypted recovery state, UTC usage limits, request deduplication, leases, stop intent and provider cleanup jobs |
| Ordinary Worker | Authentication, Wiki reads, DeepSeek text turns, retained Web Agent turns, source validation and client control socket |
| Scheduled Worker | Expired-session recovery and cleanup reconciliation without a running client |
| iOS | Typed Ask AI UI and account-scoped local history |

D1 stores text conversation recovery and provider cleanup metadata. There are no
Queues, Workflows, KV or read replicas.

## Separate text and Agent execution

`user.ts` owns the shared lifecycle: question lease, authorization, Jev routing,
provider dispatch and validated-answer publication.
`runTurn` is the single execution dispatch point: native typed questions go to
`text-turn.ts`; retained Web requests go to `agent-turn.ts`.

- `text-turn.ts` owns bounded text history, DeepSeek checkpoints and text failures.
  It calls `deepseek.ts` and the Wiki reader without importing the OpenAI adapter.
- `agent-turn.ts` owns OpenAI session creation, polling, tool-result replay,
  uncertain-submission reconciliation and Agent-specific failures.
- `conversation-history.ts` collects bounded completed dialogue for text and Agent turns. Agent input is checkpointed before submission so recovery matches the same provider item.
  `turn-input.ts` builds the shared untrusted input envelope; `turn-context.ts`
  exposes the lifecycle operations each runner needs. `state.ts` keeps the
  existing encrypted state format without a storage migration.

Both runners use the same reader limits and current-turn citation validator.
The iOS client sends cancellation through the control WebSocket command protocol.
Native text cancellation aborts the fetch, invalidates late results and clears
only the pending text request. It does not create provider cleanup for DeepSeek. Ending the entire conversation still cleans up all associated
provider sessions. DeepSeek does not use Agent session reconciliation: an
uncertain DeepSeek submission fails rather than being silently repeated.

## Storage and concurrency

Keep D1 migrations 0001 and 0002 and apply them with the official `cf` CLI.
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
is never blindly re-executed. HTTP remains available for text conversation end.
All voice routes, including stop, return 404. The ownership-bound text conversation
end intent survives independently of the socket and is applied by the next invocation.

Snapshots carry a monotonically increasing D1 revision and contain control state
only. Messages, citations and utterances are fetched in revision-bound pages of at
most ten items and 512,000 encoded bytes. A revision change during pagination makes
the client restart the read, so content from different commits is never combined.

Metadata reads update presence without rewriting encrypted messages or advancing
the revision. History requests decrypt only the requested page and recheck the
persisted revision after assembly. An idle wake updates scheduling with a revision
condition, so it cannot overwrite the next attempt of a concurrent question.
iOS reuses history for an unchanged authenticated revision, receives socket updates,
and checks HTTP at most once every five seconds while awaiting an answer. Its
control wait is 60 seconds to cover a crashed connection's 45-second lease.

Each Wiki read uses a separate identity-bound agent. Native iOS Ask AI explicitly
sets `verifyQuerySignatures: false`, including the initial delegation acceptance
query. Its authenticated requests remain signed, the replica validates delegation
and caller access, and the server checks that an accepted principal matches the
expected account. Native Ask AI trusts the fixed `https://icp0.io` HTTPS gateway for
response integrity instead of checking returned node signatures and timestamps.
The shared actor's default and retained Web path keep response verification enabled.
Their bounded five-minute cache stores only certificate-verified public subnet
keys; identities, private content and in-flight promises are never shared.

Native tool execution relies on each actual canister query's access enforcement
rather than a redundant preflight read. Stored history/metadata reads, heartbeat,
turn start and answer publication still perform an access check. No Paid-only CPU
limit is configured. The native policy removes certificate verification overhead,
but Free-plan suitability must be confirmed from deployed CPU telemetry; local
CPU timings do not prove the enforced production limit.

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
until confirmed for retained text Agent sessions.

Voice creation, extensions, transcript processing, speech delegation, legacy provider
close and financial reconciliation are removed. Stored voice conversation state and
voice cleanup tasks are discarded locally. Maintenance only handles Agent jobs.
All canister voice methods return `voice retired`; the voice runtime and expiry
timer are removed. Historical schema and financial records remain as inert stored data.

D1 Time Travel can retain prior encrypted records after application deletion. Its
backup history is not erased by deleting a current row. Privacy text discloses that
distinction; operators must check retention before release. Never restore a D1 backup
directly into an enabled service: restored work must first be reconciled with the
canonical canister and provider state.

## Validation and release gates

Local workerd tests exercise ordinary Worker WebSockets, fresh invocations sharing
D1, lease takeover, stale-write rejection, authentication, encrypted command replay,
retired-route rejection and cleanup recovery. Lifecycle tests cover text requests,
deadlines, cancellation and text Agent cleanup. A separate Miniflare
test recreates workerd with persistent D1 and verifies lease takeover.

Offline tests do not prove real provider connectivity or production deployment.
Historical voice jobs are no longer processed and do not require a billing key.
