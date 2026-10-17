# Hook delivery reliability validation — 2026-10-16

Implemented on `fix/hook-delivery-reliability`, based on main `3ae77f10`.
The existing async hook/outbox change was ported as `8b9835d3`; implementation
`b416e8f3` was followed by the reviewed intake fixes described below.
The existing research checkout and its uncommitted changes were preserved.

## Behavior

- Current intake is written and synced to a temporary file before atomic JSON
  publication. Completed intake is removed before launching the finite sender.
- Hook responses do not wait for inbox replay or remote evidence writes.
- `agent flush --replay-inbox --engine codex|dsh [--recall-config PATH]` combines
  replay and delivery under the existing destination/identity lease. All other
  outbox writers use that same lease. Replay never recursively starts workers.
- `learn propose` sends pending evidence first; proposal/drain inference does not
  start when the target run still has pending evidence owned by another sender.
- Local SQLite records enqueue times and fixed delivery error codes/timestamps.
  Existing `agent status` reads these without creating or migrating state.
- Malformed/unverifiable intake is quarantined. Foreign valid bindings and live
  intake owners are skipped. Old enqueue timestamps remain unknown.
- No permanent worker, model service, recall cache or batch-retry optimization
  was introduced. The existing batch fallback remains.

## Verification

- Rust workspace: 943 passing test executions, 0 failures, 4 intentional ignores
  (includes the separately executed nested fixture; one ignored lease fixture is
  explicitly launched by its parent test).
- Python plugin runtime: 50 passed. DSH plugin: 8 passed.
- CLI Clippy with `--all-targets -- -D warnings`, formatting and whitespace checks.
- Regression failures were observed before fixing migration, proposal gating,
  poison replay and status diagnostics. The three final review regressions also
  failed before their fixes and passed afterward.

### Real local canister and process tests

A dedicated database `db_axocpkauiedm` was created on the existing local network
`http://localhost:8011/`, canister `4caro-hl777-77775-aaaba-cai`. Local accounting
credits were granted through the configured test authority; no real payment,
ledger transfer, production deployment, or research data overwrite occurred.
Each successful test attempt used its own project namespace.

The committed `evaluation/continual-learning/check_delivery_live.py` uses the
actual CLI and Python adapter plus a delaying/failing HTTP proxy. Final results:

| Scenario | Result |
| --- | --- |
| Update calls delayed by 3 seconds | Context returned in 0.257 seconds; delivery completed afterward |
| Three simultaneous flush processes, 12 events | One sent 12; two returned busy; queue emptied |
| Malformed first inbox record | Quarantined; valid later record replayed; foreign engine left intact |
| Connection unavailable at client initialization | Failure persisted; pending event recovered after reconnection |
| Sender killed after remote acceptance but before receiving response | Next flush recovered the same event and emptied the queue |
| Hook host process group killed after acknowledgement | Background sender survived and completed delivery |

SQLite-backed tests separately verify proposal/drain gating, immutable evidence
conflicts, ambiguous batch success, old database migration, live-owner exclusion,
and cross-process lease acquisition/recovery after killing its owner.
The host-group test controls Unix process-group termination; it does not emulate
every possible Codex app descendant-cleanup policy. Non-Unix survival is untested.

### Mainnet read-only timing

30 fresh processes loaded the existing identity and performed recall against
`https://icp0.io`, canister `6emaw-iyaaa-aaaay-aacka-cai`, database `db_ceifht7sc2lh`,
namespace `/Knowledge/kinic-wiki`, task `hook evidence delivery`, budget 2000.
The debug `recall_readonly_timing` example only uses remote reads, with no outbox,
model inference, or remote writes. Its local retrieval index was retained between
samples. Times below include process startup; warm receipts contained 8036 bytes.

| Metric | Result |
| --- | --- |
| Successful recalls | 30 / 30 |
| First sample | 5.869 seconds |
| Median | 4.386 seconds |
| Maximum | 7.166 seconds |
| Over the Python adapter's 2-second deadline | 30 / 30 |

**The two-second deadline is inadequate for this measured workload.** Moving
replay off the response path fixes a distinct loss of already-produced context;
it does not make identity plus recall fit that deadline. These are one-workload,
one-environment measurements, not a general latency SLA. Cache/deadline redesign
remains outside the approved scope.

## Review and decisions

Independent source review at `b416e8f3` found three actionable defects, all fixed
in one regression-tested pass:

1. Invalid reserved run binding could stop replay: validate binding and evidence
   structure, quarantine invalid input, continue with later records.
2. Replay could see partially written JSON: sync a non-JSON temporary file and
   atomically publish it, then sync the directory on Unix. The regression saw
   1062 incomplete reads before the fix and zero afterward.
3. A live hook without configured principal could be quarantined: check live
   ownership before checking nullable binding fields.

No minor findings were deferred. The source reviewer did not judge runtime
measurements, non-Unix behavior or model quality. Runtime evidence is supplied
above; platform-specific survival and model-quality claims are not made.

Decisions and limits retained from the implementation ledger:

- A new managed worktree based on main preserved overlapping uncommitted research
  edits and reused existing status/configuration functionality. Cost: the async
  patch required conflict reconciliation and full regression testing.
- Live intake uses a PID marker rather than a new coordination service. PID reuse
  can postpone old intake until a later attempt.
- Diagnostic codes exclude raw stderr/transcripts. Startup failures without a
  configured principal cannot be safely attributed and remain unknown.
- Failed finite delivery retries on the next hook or manual flush; delivery is
  not promised while the CLI is inactive. Local storage failures can prevent
  failure diagnostics from being saved.

The branch is retained for review; no production activation or merge was done.
