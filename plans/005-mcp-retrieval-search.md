# Wiki MCP retrieval search — implementation and verification

Implemented locally on 2026-10-13. No deployment, secret provisioning, or feature activation was performed. The existing OAuth/page changes were left untouched. Operational details and repeatable commands are in `docs/mcp-search-retrieval.md`; raw acceptance results are in `workers/wiki-mcp/evaluation/results-2026-10-13.json`.

- [x] Add `search_nodes_for_retrieval`, preserving existing search interfaces and storage schema; share candidate generation and Reader/public Reader authorization.
- [x] Preserve Light hits and compute a separate bounded original-intent excerpt in Rust. Share content reads; preserve NUL/BOM/Unicode. Avoid scanning beyond 40,000 UTF-16 units and return at most 512 units per candidate.
- [x] Implement request-scoped Worker search, at most two auxiliary queries, path deduplication, rank fusion, lexical top-20 selection and one bounded Jev call. Keep default 10/max 20 search results and max 10 body reads.
- [x] Preserve legacy preview modes/long-query compatibility and disabled/missing-key behavior. Only explicit replica method absence triggers old-API fallback; permission and network errors do not.
- [x] Extend shared Jev selections without changing the default five or existing callers' short-list bypass. Limit MCP request/response sizes and timeouts; retain retrieval order on model failures.
- [x] Keep private inputs out of logs and document external excerpt processing, opt-in activation and rollback.
- [x] Preserve corrected 38-case labels and eight confirmation questions; run actual Rust excerpt generation and production Worker candidate selection against them.
- [x] Run Rust, MCP and shared-helper checks, Candid compatibility/client checks, PocketIC, Worker dry-run and release Wasm builds.

## Acceptance evidence

| Check | Result |
|---|---|
| New 20 questions, relevant source in top 10 | 19/20; baseline 15/20 |
| New 20 questions, P@3 | 65.0%; baseline 33.3% |
| Eight later confirmation questions | 7/8; baseline 6/8 |
| Frozen experiment parity | All original 38 candidate payloads match, including Rust-generated excerpts |
| New search, eight parallel requests | 96 timed + 8 heap-sampled requests; no tool errors |
| New search, local CPU/request | 36.5 ms serial mean; 20.8 ms at eight-way concurrency (signature verification enabled) |
| New search, sampled heap + backing maxima | 68.6 MiB at eight-way concurrency (signature verification enabled) |
| Large-path error handling | 34.6 MiB in the signed run; small explicit size error |
| All new search scenarios | Below 96 MiB and 50 ms/request mean regression gates |
| Model 503 / oversized body / timeout | Ten retrieval results returned; no retry |
| Rust store/runtime/canister suite | 493 passing, none ignored |
| Shared Jev suite | 21 passing |
| MCP | Node scripts, Vitest contracts, private Worker/DO tests and typecheck pass |
| Candid | Backwards-compatible with pinned mainnet fixture; generated IDL and browser/generator/extension/MCP checks pass |
| Shared-helper consumers | Generator and assistant typechecks pass |

PocketIC uses real Wasm, twenty returned hits, Reader and anonymous public Reader, denied access, limit errors, later successful writes, NUL/BOM/emoji content, and large bodies. Per-query measured instruction counts:

| Fixture | Legacy Light search | New retrieval search | New response bytes |
|---|---:|---:|---:|
| Ordinary content, 20 hits | 3,779,430 | 5,617,777 | 3,226 |
| Large content, 20 path hits | 3,456,410 | 234,884,532 | 15,286 |

The initial large-body prototype measured 674,896,564 instructions. Bounded prefix reads and stopping at the first complete term match reduced the work without changing excerpt selection. Light content matches can still require their existing full-body read to preserve legacy anchors; the new excerpt's scan remains bounded.

The initial mixed resource run observed 100.6 MiB during large-path rejection. Removing the temporary UTF-8 encoding buffer from final response-size checks brought all retrieval scenarios below the 96 MiB gate in the verification run. Boundary tests compare admission against native TextEncoder for ASCII, multibyte text, emoji, lone surrogates and controls. Existing ten-page body-read control completed at 107.5 MiB; that is outside the search gate and remains a separate workload.

The original resource run disabled SDK response verification. It is superseded by the signed run described below and retained only as historical evidence. These are local sampled measurements, not a production resource guarantee. CPU includes process/DO work; provider waits in the resource benchmark are simulated. Keep the feature off until actual production CPU settings are confirmed. The outer JSON-RPC envelope is outside the existing 256,000-byte tool-result budget.

## Known limits and later activation

The JSON-body Zod question and the Japanese SSE timeout question remain retrieval misses in the respective evaluation sets. Jev is a ranker; returned candidates do not establish that an answer exists or that a source claim is true. No confidence-threshold abstention, LLM query generation, embeddings or body-read limit increase was added.

After separate deployment authorization: upgrade the canister, deploy the disabled Worker, verify the production settings and smoke tests, then enable `MCP_SEARCH_RERANK_ENABLED=true` with the configured Jev key. The flag restores legacy search immediately when disabled. No data migration is required.

## Review correction: signed Worker benchmark (2026-10-13)

Removed the benchmark adapter that disabled `verifyQuerySignatures` and bypassed local root-key retrieval. A local replica fixture now serves a BLS-signed root-to-subnet delegation, a BLS-signed state certificate containing 13 Ed25519 node public keys, and a correctly signed query response tied to the request ID. SDK verification, certificate decoding, key retrieval and per-request actor construction execute without source rewriting. Only the Jev endpoint is redirected; the SDK obtains the local test root through `/status`, as it does for a local network. This additional root-key fetch is included in the measurements. No product authentication, key caching, or verification policy changed.

Negative controls corrupt a query signature and a certificate signature. Both are rejected and neither reaches Jev; a valid request then succeeds. Assertions require one certificate/root-key fetch per request, signed responses for every query, zero body reads during search, and the expected search count/concurrency. Failures of the resource gates are recorded before the command fails.

The final run passed all search gates. Eight-way concurrency used 96 timed requests plus eight memory-sampled requests: 104 certificate fetches, 104 local root-key fetches, 312 signed queries, and 104 Jev calls. CPU averaged 20.8 ms/request and observed heap plus backing maxima totaled 68.6 MiB. Serial search averaged 36.5 ms/request. Oversized metadata/responses and model failure/oversize/timeout scenarios also passed. The latest raw measurements replace `resources` in the acceptance JSON; the old unsigned measurements are under `resourcesWithoutSignatureVerification`.

The existing ten-body-read control observed 136.2 MiB (164.2 MiB on the first signed run), outside the search gate. This is a separate unresolved resource concern, not evidence that the body-read workload fits a production memory limit. These process/sampled measurements still do not establish Cloudflare billed CPU or a strict isolate-memory peak.

Validation: syntax checks for both evaluation modules, two complete signed Miniflare runs (the final run also asserts key/signature/query counters), and `git diff --check`. Application code was unchanged during this correction; application/Rust suites and Wasm builds were not repeated. No deployment or activation.
