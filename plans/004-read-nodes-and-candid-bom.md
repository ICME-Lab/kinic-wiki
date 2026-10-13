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
- Wiki MCP: Candid subset, 79 Node tests, 152 Vitest tests, 37 Worker tests, typecheck.
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
