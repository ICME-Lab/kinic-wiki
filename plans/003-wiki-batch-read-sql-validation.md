# Simplify Wiki retrieval and enforce SQL / MCP response boundaries

Follow-up: [004-read-nodes-and-candid-bom.md](./004-read-nodes-and-candid-bom.md)
adds the explicitly requested `read_nodes` API and fixes the SDK BOM limitation.
The record below describes the earlier 07a705a5 implementation.

Status: DONE — local implementation, regression verification and release Wasm build.
Deployment and post-deployment plugin testing are explicitly excluded by the user.
Recorded: 2026-10-13. Branch: `fix/wiki-batch-read-sql-validation`.
Baseline: main at 3a2b774f; this change supersedes the Worker SQL/hex route in af47fd2e.

## Final implementation

- `read_paths` and `fetch_many` share existing `read_node` retrieval. Maximum ten inputs,
  four concurrent calls across the whole request, deduplication by database/path and restored
  input order/duplicates. One authenticated actor per request, never shared between users.
  Missing/denied/transport failures remain item errors; no automatic retry was added.
- Removed Worker batch SQL, hexadecimal decoding, SQL row parsing and unused SQL client/Candid
  projection. The browser/CLI `query_database_sql_json` API remains available. Existing batch
  metadata remains: row_count counts unique successful reads, limit counts requested unique
  paths, parse_error_count is zero and batch_error is null.
- SQLite authorizer enforces actual resolved tables and operations, with native/Wasm adapters
  sharing one policy. Guards cover prepare through execution and remove callbacks on errors.
  Main-only preflight handles SQLite's missing database name for no-column reads safely.
  Existing SELECT syntax restrictions, LIMIT, row/response sizes and execution budget remain.
- Shared Unicode-safe clipping applies to normal reads, batches, context and conflict bodies.
  Existing 40,000 UTF-16 units/page and 100,000 total budgets remain upper bounds. Model-facing
  and structured bodies are built from the same shortened payload with accurate flags.
- Every finalized MCP tool result is bounded to 256,000 serialized UTF-8 bytes. Oversized
  metadata becomes a single/context error or batch item error. Batch admission prefers earlier
  inputs and preserves metadata exactly. Mandatory identities that cannot fit trigger a fixed
  short error, as do oversized generic success/error responses.
- Candid API, saved schema and migration history were not changed. Concurrent pages do not
  promise a common snapshot; callers retain individual etags. Up to ten canister queries occur.

## Verification record

Passed on 2026-10-13:

- `cargo test -p kinic-sqlite-compat -p vfs-store`: 3 adapter tests and all 175 store tests,
  including property/scale tests and 7 SQL literal/value regressions.
- `cargo test -p vfs-runtime --test sql_literal_validation`: 2 tests, including ordinary and
  anonymous Reader rejection of internal/quoted/implicit sources.
- `cargo test -p vfs-runtime --test database_service sql_json`: 18 tests covering access,
  valid queries, response limits and interruption/cleanup.
- `cargo test -p vfs-canister sql_json`: 12 entrypoint tests.
- `pnpm --dir workers/wiki-mcp test`: Candid subset drift check, 79 Node tests,
  133 Vitest tests and 37 Worker tests. `pnpm --dir workers/wiki-mcp typecheck` passed.
- `bash scripts/build-vfs-canister.sh`: locked release Wasm build with canonical Candid metadata.
  `cargo build -p ic-sqlite-vfs-probe --target wasm32-unknown-unknown --release`: guard probe Wasm.
- `POCKET_IC_BIN=/Users/0xhude/.cache/dfinity/versions/0.31.0/pocket-ic node --test
  pocketic-tests/integration/wiki-sql-authorization.test.mjs`: actual release Wasm/PocketIC
  11.0.0 passed two tests: Reader/public Reader allow/deny and repeated queries; a separate
  probe checks previously executed statement reuse and immediate guard cleanup/read/write
  inside one update call on the same SQLite connection.
- Scoped Rust formatting and `git diff --check` passed.
- Existing PocketIC SQLite probe suite: 5 tests passed, including randomized writes, rollback and upgrades.
- `cargo test -p vfs-canister candid`: exported interface matches the checked-in Candid (1 test).
- `didc check crates/vfs_canister/vfs.did contracts/mainnet-vfs-83bbb0b6.did`: compatible.
  The existing `scripts/check-mainnet-candid-compat.mjs` additionally hardcodes an older method
  delta and fails on pre-existing `http_request_update`; this patch does not modify Candid or
  that script. The actual didc compatibility check and MCP subset check both pass.

Artifact: `target/wasm32-unknown-unknown/release/vfs_canister.wasm`.
SHA-256: `24d546b21550af6532425cee422831b6fb30bfaa65ccef4173de12d17b9a1cae`.

## Remaining SDK limitation and scope

Actual Wasm verification found that the pinned JavaScript Candid decoder strips a leading
BOM even on single reads. The raw canister reply preserves it. Batch-specific decoding is
removed and single/batch results now share exactly the same path, but the upstream Text
decoder limitation remains. See [findings](./003-wiki-batch-read-review-findings.md).

Unrelated OAuth, assistant/UI and lockfile changes in the shared working tree are excluded
from this commit. No staging or production deployment, remote mutation, push, or updated
production-plugin verification was performed.
