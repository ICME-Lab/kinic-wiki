# Arbitrary-path batch reads and Candid BOM preservation

Status: DONE locally. Recorded: 2026-10-13. Deployment is excluded.
This follows 07a705a5 and the user's explicit requests to fix BOM and add read_nodes.

## API choice

Existing `export_snapshot` exports a prefix with revision-aware paging.
`fetch_updates` reads changes since a known revision. These APIs are retained.
Using export for unrelated requested paths would fetch additional pages, require
paging and introduce synchronization semantics to ordinary retrieval. The small
`read_nodes(database_id, paths)` query instead accepts exactly 1–10 selected paths.
No CLI command or MCP tool name is added; the existing MCP batch tools use it internally.

## Implementation

- Candid return: `Result<Vec<Result<Option<Node>, String>>, String>`.
  Database authorization/open failures are outer errors. Missing nodes are Ok(None);
  invalid paths or oversized items are inner errors. Normalized duplicates are
  loaded once on one store connection; output order and duplicates are preserved.
- Reader, anonymous-public and marketplace access use the existing read_node policy.
  Full node bodies, metadata and etags are returned without silent truncation. A
  conservative 1,000,000-byte response budget reserves the outer envelope and item
  errors, then admits nodes in input order. Oversized items become explicit errors.
- Worker groups selected paths by database, sends one query per database, shares
  the authenticated actor within the request, and limits concurrent queries to four.
  Existing MCP schemas, per-item failures, compatibility metadata and UTF-8/Unicode
  result limits are retained. No automatic retry or export-snapshot fallback is added.
- The dependency patch changes only Candid TextClass's decoder to ignoreBOM:true
  while retaining fatal:true, in ESM/CommonJS. pnpm applies it to SDK 5.4.0 and 6.0.0.
  It survives clean installs and preserves full leading/repeated BOM characters.
  No custom Candid parser or global TextDecoder override is introduced.
- Canonical Candid and generated IDL gain read_nodes; result aliases in vectors are
  normalized in drift checks. Existing methods remain compatible. Stored schema and
  migrations are unchanged. The compatibility script's known method delta is updated
  for read_nodes and the already existing http_request_update.

## Verification

Passed locally:

- Full vfs-store suite: 176 tests, including ten long/special paths, exact Unicode/NUL/BOM
  content, duplicates, missing/invalid paths and input limits for read_nodes.
- Full vfs-runtime database_service suite: 146 tests, including batch Reader/public
  access, unauthorized access, preserved bodies, item errors and Candid byte budgeting.
- Wiki MCP: Candid subset, 79 Node tests, 159 Vitest tests, 37 Worker tests, typecheck.
  Candid Text tests cover SDK 6 ESM/CommonJS and SDK 5.4 CommonJS, single/repeated BOM,
  ordinary/empty text and rejection of malformed UTF-8. Existing parallel/dedup/order
  tests now assert one batch query for a single database.
- Candid tools: 3 tests, including aliases nested inside vectors.
- Generated VFS IDL, exported native Candid match and mainnet compatibility checks pass.
- Locked release Wasm build and two PocketIC tests pass. The actual MCP reader is
  bundled and run against the real Wasm's live local gateway: single and batch bodies
  include the leading BOM exactly, with duplicate/missing/invalid-path results and
  the 11-path rejection. Existing SQL policy/guard checks also remain passing.
- Offline frozen-lockfile install, scoped formatting and git diff checks pass.

Artifact: target/wasm32-unknown-unknown/release/vfs_canister.wasm.
SHA-256: 95ec2110af9dfadb65a6f79ed19caa955b246a17d4fbe4141fb2f85ae67e7761.
The earlier artifact in plan 003 is superseded.

No staging/production deployment or remote plugin verification was performed. A future
release must install a canister supporting read_nodes before switching the Worker.
Unrelated OAuth/assistant/UI changes and their lockfile removals are excluded from this commit.

## Review follow-up: conflict response bytes

Review reproduced an etag conflict with 40,000 NUL characters: the completed
tool result was 280,324 UTF-8 bytes, so the generic final check replaced both
the conflict code and current etag with a size error. Conflict bodies now use
the shared Unicode-safe content fitter at error construction. It measures the
completed result, including JSON escaping and any auth metadata, and shortens
only current_content within the 40,000-unit budget. The conflict code, database,
paths, failed index, current etag and original content size remain intact; the
truncation flag is set whenever the body changes. Metadata that cannot fit even
with an empty body still returns the fixed short size error.

Regression coverage checks both write_nodes and mutate_nodes_batch through MCP,
control characters, Unicode boundaries, untouched BOM text, prior truncation
flags and oversized metadata. Focused tests: 103 passed. Full MCP tests and
typecheck also pass; Rust/Wasm sources and the artifact above are unchanged.

## Review follow-up: strict Rust checks and Wasm CI coverage

- Return the read_nodes collection result directly, removing Clippy's
  needless_question_mark failure without changing the return contract.
- Construct the read_nodes test's temporary store locally instead of compiling
  unused helpers from the shared fixture module. Strict all-targets Clippy no
  longer reports dead_code from this test.
- Run test:wiki-sql in CI when canister, SQLite compatibility, MCP or SDK patch
  files change. The job installs the patched workspace dependencies, uses Node 24
  for the generated TypeScript IDL, and builds both Wasm artifacts with --locked.
- Keep PocketIC 10.0.0 for canbench 0.4.1 and its existing probes. Install a
  separate pinned PocketIC 16.1.0 for the actual SDK 6 reader: PocketIC 10 returns
  HTTP 404 for SDK 6's v3 read_state gateway. Query verification stays enabled.
  Locally, set POCKET_IC_BIN to a PocketIC 16.1.0 binary (named pocket-ic) and run
  pnpm --dir pocketic-tests run test:wiki-sql with workspace dependencies installed.

Validation: cargo fmt --all -- --check and strict locked workspace/all-targets
Clippy pass. The store read_nodes test and runtime batch reader/access/response
budget test pass. All five existing Wasm probes pass on PocketIC 10 with Node 24;
both Wiki SQL/SDK reader integration tests pass on PocketIC 16.1.0. Workflow YAML,
dependency/runtime configuration and changed-path routing checks pass. The
canonical locked release Wasm build, including public Candid metadata, passes.

Current artifact SHA-256:
f8305de1f4fc6a74815b07261732d02a9221c59f2018e34d5955cd01967b5869.
This supersedes the earlier artifact recorded above. No deployment was performed.
