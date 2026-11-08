# Bekko execution-cycle refill

The existing startup/upgrade check and daily Wiki timer check the Wiki's Launcher refill first, then the fixed Bekko `xrg4h-oiaaa-aaaal-qxrya-cai`. Daily storage billing runs in a separate self-call so external failures and waits cannot block it. There is no new recurring timer. All balance/deposit calls have a 30-second bounded wait; the self-refill task has a 60-second outer bound. Timeouts are scheduling bounds, not wall-clock service guarantees under subnet load.

Only Wiki execution cycles fund Bekko execution cycles, via management `deposit_cycles`. Database/user cycle balances and ledgers are never debited. The target is compiled in and cannot be configured.

## Initial settings and measurement

The feature is **disabled by default**. On 2026-11-08 JST, controller `canister_status` returned:

| Canister | Execution cycles | Idle cycles/day | Freezing threshold | Estimated freezing reserve |
| --- | ---: | ---: | ---: | ---: |
| Bekko | 1,159,232,158,931 | 8,012,365,517 | 2,592,000 seconds | 240,370,965,510 |
| Wiki | 6,760,068,977,582 | 85,988,432,546 | 2,592,000 seconds | 2,579,652,976,380 |

Default Bekko threshold: 600,000,000,000; target: 1,200,000,000,000; maximum per transfer: 600,000,000,000; maximum attempted in a rolling 24 hours: 1,200,000,000,000. Wiki minimum retained execution balance: 4,000,000,000,000, plus the exact CDK call prepayment and an additional 1,000,000,000 safety margin. The send amount is also capped by the current **liquid** balance (which excludes the system freezing reserve). Both balance caps first deduct `Call::get_cost()` for the exact zero-cycle deposit call; this includes the prepaid maximum response and callback execution cost, measured as 42,102,453,000 cycles on the local test subnet. This cost is queried dynamically rather than assumed to be constant.

These defaults leave about 45 days of Bekko idle burn above its measured freezing reserve and about 16 days of Wiki idle burn above its reserve. They are conservative initial values, not a forecast of update traffic. Before enabling, take at least two status samples across representative peak activity, include update/activation/upgrade costs and next-day delay, and adjust limits/reserve for observed consumption. Query counters do not measure the full execution-cycle burn. Keep disabled if this evidence or funding is insufficient. Re-evaluate after memory/compute settings or model/runtime changes.

## Controller API

- `get_bekko_refill_state()` is a controller-only query: configuration, active operation, latest 128 completed attempts, rolling reservations.
- `configure_bekko_refill(record)` is a controller-only update. All fields are required; changing configuration invalidates any outstanding balance check. Disabling does not cancel a deposit already dispatched.
- `check_bekko_refill()` is a controller-only manual update using exactly the timer's journal and limits. It can perform a real deposit when enabled.
- `reconcile_bekko_refill(id, variant { Deposited | NotDeposited }, evidence)` resolves an **Unknown** deposit only while disabled. Nonempty evidence is required and retained. Verify the external outcome before using it; there is no automatic retry or balance-based inference.
- `periodic_storage_billing()` and `periodic_cycles_refill()` reject every caller except the Wiki itself, including controllers. They provide message/rollback isolation for the timer.

Example configuration, initially disabled:

```candid
(record {
  enabled = false;
  threshold_cycles = 600_000_000_000 : nat;
  target_cycles = 1_200_000_000_000 : nat;
  max_transfer_cycles = 600_000_000_000 : nat;
  max_daily_cycles = 1_200_000_000_000 : nat;
  wiki_reserve_cycles = 4_000_000_000_000 : nat;
})
```

A balance equal to or above the Bekko threshold skips the deposit. Amounts are limited by the target deficit, per-call maximum, remaining rolling daily budget and fresh Wiki funds. Failed deposits still consume the attempted daily budget conservatively; settings edits, audit-history pruning and upgrades cannot reset it. At most 256 deposits may be attempted per rolling day; further attempts stop until reservations expire. Operation IDs and amounts are saved before attaching cycles.

## Failure and upgrade recovery

Balance-call failure or malformed data sends nothing. A frozen Bekko cannot execute its balance update: inspect status as controller and fund/recover it externally under an authorized recovery operation. A failed check is recorded with recovery guidance; no inference that the balance is zero is made.

Clean deposit rejection is recorded as failed. Timeout/uncertain rejection/decode failure is recorded **Unknown**, preserving the active lock. On Wiki upgrade, a read-only check becomes interrupted; a pending deposit becomes Unknown. Further automated deposits stop until explicit reconciliation. A callback trap or journal write failure similarly leaves the persisted operation in place; recover via a Wiki upgrade, inspect/reconcile with evidence, then explicitly re-enable. Reconciliation never refunds the rolling attempted budget. Never assume a timed-out deposit failed or use an uncertain balance difference alone as proof.

Controller reconciliation attests to the observed outcome. It is not a way to cancel an in-flight message. If evidence cannot establish the outcome, leave the operation locked and refill disabled. Maintain access to controller status/logs and external cycle funding for recovery.

## Local rehearsal

Build Wiki with `cargo build -p vfs-canister --target wasm32-unknown-unknown --release --locked`. Build `bekko25-compact-canister` from the linked embedding repository PR with its pinned toolchain. Use PocketIC 16 and the pinned compact model pack; keep the old deployed Bekko Wasm as the upgrade baseline.

```sh
POCKET_IC_BIN=/absolute/path/pocket-ic \
BEKKO_BASELINE_WASM=/absolute/path/old-bekko.wasm \
BEKKO_REFILL_WASM=/absolute/path/new-bekko.wasm \
BEKKO_COMPACT_PACK=/absolute/path/model-int8.pack \
node --test pocketic-tests/integration/bekko-refill.test.mjs
```

The rehearsal verifies 14 before/after embeddings bit-for-bit, model/weight/runtime/space identity, Wiki-only balance authorization, actual Wiki-to-Bekko cycle movement, disabled/controller gates, persisted daily limits across Wiki upgrade, frozen balance failure without a deposit, daily billing after both external checks fail, and a successful liquid-bound transfer with the actual CDK prepayment retained. Rust tests cover stale configuration, insufficient/liquid funds, overlap, ambiguous/upgrade recovery, audit-history pruning and reconciliation.

## Production rollout after PR review and merge

1. Save current module hashes, controller status, model info and representative inference vectors. Verify the compact model pack SHA256 and build provenance. Keep the previous deployable Wasm.
2. Upgrade **Bekko first**, using the existing compact recipe and upgrade mode. Do not reinstall or reupload/reset weights. Call controller `activate`, confirm `active`, `weights_verified`, unchanged model/revision/runtime/embedding-space/pack hash and bit-identical sampled vectors. Its existing upgrade path requires explicit activation.
3. Upgrade Wiki. Verify `get_bekko_refill_state().config.enabled == false` and no unexpected active operation. Confirm controller gates and regular billing.
4. Re-measure status and representative consumption; configure all fields with `enabled = false`. Confirm Wiki reserve and the next-check margin.
5. Explicitly enable only after those checks. Observe the first startup/manual/daily result and both actual execution balances. A successful check only sends when Bekko is below threshold; never manufacture a production deficit simply to test a transfer.
6. Verify the next daily check and storage billing, journal amounts and budget. Disable and investigate on Unknown or unavailable balance; reconcile only with evidence.

This implementation and its PRs do not perform any mainnet upgrade, enablement, activation or transfer.
