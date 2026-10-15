# Wiki MCP search tests

This directory contains search accuracy replay and Worker resource measurements.
See [retrieval verification](../../../docs/mcp-search-retrieval.md#verification)
for commands, fixture sources and measurement limits.

- `run-retrieval.mjs`: evaluates the production search pipeline with Rust excerpts.
- `retrieval-fixture.json` and `recorded-jev.json`: inputs for offline regression tests.
- `benchmark-worker.mjs` and `signed-replica.mjs`: local Worker load tests with SDK signature verification.
- `node evaluation/benchmark-oauth-refresh.mjs`: measures 4,096 rotations and replay-history storage in a real local SQLite Durable Object; results are written under `.tmp/oauth-refresh/`. II consent is simulated; this is not Cloudflare billed CPU.
- `.tmp/`: ignored generated bundles and measurements.
