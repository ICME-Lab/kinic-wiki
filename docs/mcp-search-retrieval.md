# MCP retrieval search

The optional retrieval pipeline combines up to three keyword searches and reranks twenty short candidate excerpts with Jev. `search` retains its existing input/output schema, default limit of 10, and maximum limit of 20. Body reads (`read_paths` / `fetch_many`) remain limited to 10. Search does not prefetch full pages into the Worker.

## Configuration and activation

| Setting | Default | Effect |
|---|---|---|
| `MCP_SEARCH_RERANK_ENABLED` | unset / disabled | Only the exact value `true` enables retrieval search. |
| `TYPESAFE_API_KEY` | unset | Required when enabled; missing/blank keys select legacy search. |

Checked-in deployment configuration leaves the feature disabled. This implementation does not provision secrets or deploy. When separately authorized, upgrade the canister first, deploy the Worker with the feature disabled, verify the effective production CPU limit, configure the existing Jev credential, and then enable the flag. Disable the flag to restore legacy search without a canister downgrade or data migration. Use the repository's official `cf` deployment workflow.

With the flag enabled, public and private searches send the original question, candidate paths, and at most 512 UTF-16 units of body excerpt per candidate to the existing Jev service. User identity, OAuth tokens, and full page bodies are not sent. The requesting user's canister permissions apply to every search. Logs contain counts, timings, HTTP status and fixed failure codes, without questions, paths, excerpts or credentials.

Explicit `preview_mode: none` or `content-start`, questions over 512 UTF-16 units, disabled configuration and missing credentials use legacy search. The usual Light preview remains the model-facing search preview; the new reranking excerpt is internal and is not added to the MCP output schema. Returned scores and match reasons remain the canister's original values; result order can change.

## Canister contract

`search_nodes_for_retrieval` is an additive query. Its request contains `database_id`, `query_text`, `intent`, optional `prefix`, and `top_k` (1–20). The query and intent each accept at most 512 UTF-16 units. The response is `Result<vec { hit: SearchNodeHit; rerank_excerpt: text }, text>`.

`intent` is the original question for all auxiliary searches. Each result preserves the existing Light hit. The additional excerpt scans only the first 40,000 UTF-16 units, removes the experiment's metadata/citation scaffolding, and selects an earliest best-scoring window of at most 512 units at stride 256. It never splits a surrogate pair. NUL and embedded BOM are preserved; leading/trailing whitespace and BOM follow the frozen experiment's JavaScript trim behavior.

The existing search candidate and permission code is shared. Light content anchors retain their existing full-body lookup when necessary. Path hits only load a bounded byte prefix for the new excerpt, using BLOB substring so SQLite does not stop at embedded NUL. Each hit's content is read once for both previews. Storage schemas and existing search interfaces are unchanged.

## Limits and failures

The Worker retrieves 20 hits for the original query, generates up to two distinct auxiliary queries from the original Light hits, and runs those two concurrently with one request-scoped actor. It combines ranks, deduplicates paths, selects 20 candidates by the frozen lexical score, and sends one Jev request. No retry is added to this retrieval actor or to Jev.

The new query's CBOR response is limited to 256 KiB before Candid decoding. The candidate path/excerpt JSON is limited to 32,000 UTF-8 bytes; the actual Jev request and response are each limited to 64 KiB. Oversized candidate payloads skip Jev. Jev has a one-second timeout; failures return the pre-Jev candidate order. An auxiliary query failure discards that query's hits. Initial authorization/network failures remain tool errors. Only the replica's explicit missing-method rejection permits fallback to legacy `search_nodes`.

The shared Jev helper retains its default of five selections and its existing short-list bypass. MCP explicitly requests up to twenty selections and reranking even for short lists. Other consumers keep their current behavior.

The existing final MCP tool-result limit remains 256,000 UTF-8 bytes. Size checks now count UTF-8 bytes without allocating a second encoded buffer, and oversized metadata still produces an explicit size error. The outer JSON-RPC envelope is not included in this tool-result limit.

## Verification

- `pnpm --dir workers/wiki-mcp test` and `typecheck`: existing and new contracts, failure modes and worker tests.
- `pnpm --dir packages/jev-reranker test` and `typecheck`: shared-helper compatibility, 1/10/20 selections, request/response limits.
- `pnpm --dir workers/wiki-mcp test:retrieval`: offline replay through Rust excerpt generation and the production Worker pipeline. Requires Cargo, no provider credential.
- `pnpm --dir workers/wiki-mcp test:retrieval:live`: repeats the 46 public cases with actual Jev calls using the existing root `.env.local` credential. This deliberately refreshes `evaluation/recorded-jev.json`; inspect that diff. It never edits wiki pages.
- `pnpm --dir workers/wiki-mcp bench:retrieval`: macOS Miniflare/workerd resource measurement, full private HTTP/OAuth/DO path with SDK signature verification enabled, fixture-controlled canister and model responses. The local replica serves real BLS certificates and Ed25519 query signatures; corrupted signatures/certificates must fail before measurement. Saves `.tmp/resource-results.json`.
- `pnpm --dir pocketic-tests test:wiki-retrieval`: builds diagnostic and production Wasm and checks actual queries and instruction counts in PocketIC. `POCKET_IC_BIN` may select an installed PocketIC binary. The production Wasm excludes the diagnostic query.

The 38 original cases use the corrected, frozen labels. Eight later confirmation questions retain their original gold paths; their candidate lists were recaptured for implementation. Source snapshots are public Hono documentation and Dom's Brain posts. Retrieval relevance is not answer correctness or verification of the posts' claims. The fixture and recordings contain no provider credentials. Temporary bundles/results are ignored under `evaluation/.tmp/`.

Local CPU measurements are OS process counters including workerd/DO activity, not Cloudflare's billed isolate CPU. Heap and backing storage are sampled separately from CPU and are not proof of a production memory maximum. Query waits are fixture-controlled in the resource benchmark; live provider latency is measured by the accuracy runner. Production plan/CPU settings must be checked before enabling the feature.

The signed benchmark leaves the production VFS client and SDK unchanged. Its local `/status` supplies a test root; `/read_state` supplies a root-signed subnet delegation and subnet-signed node-key certificate. Every search request creates a fresh agent and verifies that certificate chain, then verifies all query signatures. Counters assert certificate fetching and signed queries so verification cannot silently be disabled. The latest acceptance result is under `resources`; earlier unsigned measurements are historical only (`resourcesWithoutSignatureVerification`). The signed eight-way run measured 20.8 ms/request and 68.6 MiB, within the local search gates. The ten-body-read control measured 136.2 MiB, outside those gates and requiring a separate resource investigation.
