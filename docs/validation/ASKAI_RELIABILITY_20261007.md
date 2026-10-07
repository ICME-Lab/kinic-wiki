# Ask AI failure diagnosis and reliability changes, October 7, 2026

## Observed production failure

Production Assistant version `d9a26632-9ef9-4fda-9edd-abf755293737`
(version 14, October 6) was serving the native iOS path. The public availability
endpoint returned HTTP 200 and `available: true`; that endpoint does not execute
authenticated Wiki reads or prove question completion.

Cloudflare telemetry on October 7 (JST) showed this sequence:

| Time | Native route | Outcome | Reported CPU |
| --- | --- | --- | --- |
| 11:56:40 | `/events` | `exceededCpu` | 2,010 ms |
| 11:56:48–11:57:04 | `/events` reconnects | `connection_already_active` exceptions | 131–157 ms |
| 11:57:10 | `/history` | `exceededCpu` | 25 ms |
| 11:57:14, 11:57:18 | `/conversation` | `exceededCpu` | 10 ms |

The account subscription response listed R2 Paid and no Workers Paid subscription.
The enforced 10 ms failures match the documented Workers Free CPU limit. The
occasional larger successful invocation does not demonstrate a paid CPU budget:
Cloudflare documents burst flexibility followed by enforcement for repeated
CPU overages. A Worker CPU kill cannot reliably execute application cleanup.

The code magnified this limit in four ways:

1. Every identity-bound read created a fresh IC agent, discarding the default
   agent-local cache of certificate-verified subnet keys. Repeated BLS certificate
   verification occurred on metadata, history, heartbeat and retrieval paths.
2. Metadata GETs saved the entire encrypted conversation and deleted/reinserted
   encrypted messages, advancing the revision on every read. History pages loaded
   and decrypted all messages before slicing the requested page.
3. iOS polled metadata and complete history every 500 ms while also processing
   socket snapshots. This added CPU and repeatedly invalidated history revisions.
4. A crashed socket retained its 45-second D1 lease, but iOS waited only 10 seconds
   before failing a question. An un-awaited `openControl` rejection escaped the
   structured error handler, so occupied leases appeared as uncaught exceptions.

## Implemented changes

- Keep agents, identities and in-flight I/O request-local. Share only immutable
  copies of verified public node keys, bounded to 16 entries and five minutes.
  The shared default keeps response verification enabled; SDK invalidation causes fresh
  certificate verification. No private content enters this cache.
- Metadata reads load no message rows and update presence without state commits.
  History decrypts only the requested ten-row page, keeps the 512,000-byte response
  bound, and checks the current revision and conversation ID after assembly.
  Partial readers cannot save and accidentally replace stored messages.
- Idle maintenance updates the next wake with a revision condition rather than
  rewriting history. Socket state checks run every five seconds; per-second turn
  deadline enforcement remains intact. Renewal and message-handler failures close
  the socket and release the fenced connection lease when execution is still alive.
- Await asynchronous route handlers so lease conflicts return structured HTTP 409.
- iOS waits up to 60 seconds for control, reuses history at an unchanged authenticated
  revision, and polls HTTP at most every five seconds while awaiting an answer.
  Authentication and terminal access errors remain visible; transient reads do not
  discard the active request ID. Credential changes invalidate the history cache
  and in-flight reads. The live UI deadline is 180 seconds to accommodate recovery.
- The initially proposed 30,000 ms Paid CPU setting was removed after the user
  chose the native HTTPS response policy described below. No billing change is required
  by the final configuration.

## Validation completed

- Assistant TypeScript typecheck: passed.
- Shared-reader consumers (`workers/wiki-mcp`, `wikibrowser`) typecheck: passed.
- Worker unit tests: 113 passed.
- Cloudflare Vitest Workers Pool: 25 passed using Miniflare/workerd and real local D1.
  The new storage regression verifies page-only decryption, stable metadata revisions,
  stale pagination rejection and revision-fenced scheduling. Existing authentication,
  lease, cancellation and runtime boundary tests also passed.
- Node migration/restart tests: 2 passed, including lease ownership across a workerd restart.
- `cf deploy --dry-run`: passed. The emitted production configuration contains the
  30,000 ms CPU budget and existing D1/auth bindings; nothing was uploaded.
- iOS unsigned build-for-testing: passed. Targeted Simulator suites passed 88 tests
  (92 executions including parameterized runs) on `iPhone 17 Shared (27.0)`.
  New tests verify unchanged-revision reuse, authorization errors despite cached history,
  cache invalidation, and concurrent-revision recovery. The shared Simulator was
  shutdown afterward; the pre-existing demo Simulator was left running.
- Public mainnet certificate cache live test: passed. Two independent agents reused
  verified keys with no second network read, and invalidation required a new read.
  Node CPU measurements were approximately 197–229 ms cold versus 0.014–0.099 ms
  for a separate warm agent. These are local Node measurements, not Cloudflare CPU claims.
- Earlier synthetic Jev routing and DeepSeek overview checks passed. They do not
  establish a signed-in iOS end-to-end result.

## Production application still required

No subscription, production deployment, D1 migration, secret rotation, canister
upgrade, App Store upload or TestFlight distribution was performed for this patch.
There is no storage migration. Existing state and HTTP contracts remain compatible.

The user chose to start with skipping native response signature verification and
investigate client-side retrieval if needed. The final local configuration has no
Paid-only CPU setting and does not require a subscription change to deploy. This
removes the BLS certificate path for native iOS but does not establish Free-plan
stability for all request processing. Production deployment and a signed-in test,
including cold requests/reconnection and `exceededCpu` telemetry, remain necessary.
The prior active Assistant version is the rollback target. The earlier iOS
reliability changes require installing or distributing a new build separately.

References: [Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Alternatives investigated after the initial recommendation

User authentication, canister access control, and response verification are
different mechanisms. Native child delegations and bearer ownership establish
whose private DB can be read. Canister entrypoints enforce access using the caller
principal. Query response verification checks the IC node's response signatures
and their certified public keys; it is not the user's login. The native delegation
parser is structural only, so the authenticated canister read remains necessary
before accepting that delegation. Dropping response verification would additionally
make that acceptance trust the configured HTTPS gateway's reply.

| Alternative | Feasibility and limits |
| --- | --- |
| SQLite-backed Durable Objects for authenticated execution | Available on Workers Free; documentation lists 30-second CPU windows for incoming requests/messages. Move the expensive authentication and reads behind a thin routing Worker, preserve D1 state, and validate free-account behavior. This is a promising way to preserve verification without a paid subscription; no migration or deployment has been performed. |
| Keep signing requests, set `verifyQuerySignatures: false` | Technically possible in the SDK; avoids subnet certificate reads and query response signature/timestamp checks. Canister-side authentication/access controls remain, but the application trusts the HTTPS gateway for response integrity and successful delegation validation. Implemented locally after user selection; not enabled in production. |
| Fetch and verify Wiki content on iOS | Moves IC verification off the Worker and can reuse the user's existing native identity. Requires a new client/server retrieval protocol; the server must decide how to treat client-supplied evidence and enforce AI usage independently. Not a configuration-only fix. |
| Use an existing Node/Rust server for the Assistant | Preserves IC verification with a different compute budget. Requires an operated server and review of available capacity/cost; no suitable existing deployment was established in this investigation. |

The `KinicReader.execute()` preflight `authorize()` reads `/Knowledge` before
actual Wiki query/read operations that independently enforce canister access.
That preflight can potentially be removed on those paths. Stored D1 history has
no canister read of its own, so its access/revocation check must be preserved or
replaced with an explicit bounded revocation policy. This optimization alone does
not remove the cold verification cost.

A read-only experiment queried a random nonexistent database with a newly
generated test identity. With response verification disabled it made one signed
query and zero certificate requests, returning `Err`; local Node CPU was
8.8–41.6 ms across three trials. Verification-enabled fresh agents made one query
and one certificate request, returning `Err`, at 43.5–170.0 ms. These measurements
show the distinction and overhead, not guaranteed Worker Free compatibility.
All production signature checks remain enabled.

Relevant official sources: [ICP query response verification](https://docs.internetcomputer.org/guides/canister-calls/calling-from-clients/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
and [Durable Objects Free quotas](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## User-selected native HTTPS policy: final local implementation

Native delegation acceptance and all native conversation Wiki actors pass an
explicit `verifyQuerySignatures: false`. The fixed HTTPS host, request signing,
query-only child delegation restrictions, principal matching, and canister access
checks remain. The default shared actor and retained Web requests still verify
responses. Native tools omit the redundant preflight access read; their actual
canister queries enforce permissions. Stored history, metadata, heartbeats, turn
start and answer publication retain their access checks. Wiki retrieval has not
been moved to iOS in this first stage.

Final validation: 118 unit tests, 27 Miniflare/workerd+D1 tests, and 2 Node
migration/restart tests passed (147 total). The new runtime test decodes and
cryptographically verifies the outgoing native request signature, checks sender,
canister targets, query-only permissions and DB/path arguments, then verifies both
successful and denied delegation acceptance against a mocked HTTPS gateway reply
without response signatures. Denied access does not activate the auth record.
Assistant/MCP/browser typechecks and the final `cf deploy --dry-run` passed.

The readonly mainnet live test also passed: a newly generated test identity queried
a random nonexistent DB through the actual shared actor's native policy. It made
one signed query, zero certificate requests and returned `Err`; local Node CPU was
30.2 ms cold. The separate verified-public-key cache test passed as well. No real
private DB was accessed. The earlier iOS 88-test result is still applicable; this
stage changes only the backend and its tests.

## Review follow-up: Stop while the control connection is pending

The review found that the Stop button attempted a remote cancel before the
question was sent. Without a control socket that failed, leaving the question
waiting to send on reconnection. The conversation model now tracks waiting,
cancelled and submitted questions explicitly. Stopping a waiting question marks
it cancelled locally, and both the connection wait and the final pre-send guard
reject it. Once submission starts, remote cancellation confirmation remains
required, including after a connection drop. Ending the conversation resets the
submission state.

Two regression tests exercise the actual `AskAIModel.cancelGeneration()` Stop
entry point twice on the same conversation, and direct cancellation through
`cancelQuestionAndWait()` without cancelling the caller's Task. They confirm the
waiting question terminates, the conversation is preserved, no cancellation
failure appears and no HTTP request is made. Existing remote-cancel failure
behavior remains covered.

Targeted iOS Simulator tests passed: 90 tests, 94 executions including dynamic
parameters, zero failures. Result bundle:
`mobile/ios/build/AskAIFix/Logs/Test/Test-Kinic-2026.10.07_15-18-41-+0900.xcresult`.
The new regression tests both passed. The shared Simulator was shut down after
the run. No production deployment or app distribution was performed.
