# Wiki retrieval findings and root fixes

Reviewed and implemented: 2026-10-13.
Scope: Wiki MCP retrieval, response formatting, and database SQL authorization.
No staging/production deployment, remote exploit probe, or remote mutation was performed.
The earlier lexical/hex patch (af47fd2e) is superseded by the implementation below.

| Finding | Root fix | Regression evidence |
| --- | --- | --- |
| P1: single-quoted internal table plus allowed alias bypasses token-based authorization; quoted decoys and implicit `IN table` also expose this boundary | SQLite authorizer enforces resolved table/operation permissions during prepare and execution. Native and Wasm share one policy. | Direct authorizer tests, ordinary Reader and anonymous public Reader tests, actual release Wasm in PocketIC |
| P2: final formatter clips a surrogate pair or fails to flag shortened body | One Unicode-safe UTF-16 clipping function across normal/batch/context/conflict paths; flags follow actual shortening | Ten emoji pages, boundary tests, matching model/structured bodies and context flags |
| P2: ten long paths exceed the 4096-byte batch SQL budget | Both batch tools use existing `read_node`; SQL generation, hex decoding, row parsing, and Worker SQL client are removed | Ten approximately 400-unit paths, SQL-like paths, duplicates, multiple databases, partial failures and global concurrency limit |
| P2: large metadata makes even an empty-body single result exceed the response limit | Complete serialized MCP result is measured in UTF-8 bytes. Metadata is never silently modified; oversized items are errors, admitted in input order | Single/batch/context metadata-only failures; mandatory identity fallback; Japanese/control-character byte accounting |
| P3: batch-specific TextDecoder loses a leading BOM | Remove the additional hex/TextDecoder route; single and batch use the same reader and clipping | Worker exact-content tests for BOM/NUL/Japanese/emoji, request-scoped reader tests |

## SQL policy and cleanup

Only resolved reads of `main.fs_nodes` and `main.fs_links` are permitted, along with
SELECT and scalar function evaluation. `load_extension`, writes, administration and unknown
operations are denied. SQLite reports no database for an unqualified table read without
referenced columns. A main-only schema preflight makes that special case unambiguous;
attached or temporary schemas fail closed. Existing lexical syntax, LIMIT, JSON row/response
budgets and VM progress budget remain enforced. Guards remove callbacks after all exits.
Native tests prime cached statements before registration, then verify reauthorization of
allowed/forbidden cached statements and normal reads/writes after guard removal. PocketIC
repeats the same allowed and forbidden queries and then performs a normal owner write.
A separate SQLite probe Wasm runs guard registration, reused previously executed statements,
rejection, guard removal, internal reads and normal writes inside one update call on one
connection. This avoids IC query rollback masking a stale callback. Native tests additionally
exercise rusqlite's statement cache API; the Wasm adapter has no corresponding cache API.

## Additional SDK limitation found during real Wasm verification

The canister preserves a leading BOM in the Candid reply bytes (verified in PocketIC), but
the pinned JavaScript Candid decoder uses `TextDecoder('utf8', { fatal: true })` and strips
that BOM for every Text value, including single `read_node` calls. Unified retrieval prevents
an additional batch-specific loss and preserves equality with single reads. It does not
fix that upstream decoder behavior. Worker tests prove full preservation when the actor
supplies the BOM; actual Wasm tests separately check the raw reply and the SDK-decoded value.
No custom Candid parser or global TextDecoder override was introduced.

## Verification limits

This is a local fix, not evidence that the deployed plugin has changed. OAuth/UI work
already present in the working tree was excluded from the patch. The audit did not cover
every canister method or every plugin permission. See the implementation record for exact
commands, result counts and the locally tested release artifact.
