# Kinic Wiki MCP

Remote MCP Workers for Kinic Wiki recall. The public production Worker remains anonymous and read-only with eight tools. The Private production and staging Workers require OAuth at MCP connection and expose those eight reads plus two atomic batch mutation tools. Normal users authorize an Internet Identity delegation; the dedicated OpenAI reviewer login uses a restricted service identity against the same canister tools.

Canonical documentation: `../../docs/mcp.md`.

`read_paths` and `fetch_many` use `read_nodes`: at most ten inputs, one canister
query per database, and four concurrent database queries across the request.
Duplicate database/path pairs are read once and restored in input order. `read_path`
continues to use `read_node`. Both methods share the same request-scoped client. An authenticated
actor is reused only within that request. Missing nodes, denied reads, and transport failures
are item errors; no automatic retries are added. Each page has its own etag and reads do not promise a common snapshot. The MCP Worker no longer uses the SQL API.
`read_nodes` returns complete nodes with a conservative 1,000,000-byte Candid response
budget; items that exceed it become errors rather than silently shortened pages.
The workspace SDK patch preserves leading BOM characters in Candid Text (5.4.0 and
6.0.0, ESM/CommonJS), including page bodies. It retains fatal UTF-8 validation.

Content budgets are 40,000 UTF-16 units per page and 100,000 across pages, with safe
Unicode boundaries. Both MCP representations use the same shortened body and report
truncation. The complete tool result is limited to 256,000 serialized UTF-8 bytes.
Metadata is preserved; an oversized item becomes an error, with earlier metadata
admitted first. Single reads and context return a size error if metadata alone cannot fit.
A final size check also bounds other tools and errors.

## Endpoints

- Public search: `https://wiki-mcp.kinic.xyz/mcp`
- Private production: `https://wiki-private-mcp.kinic.xyz/mcp`
- Private staging: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Local: `http://127.0.0.1:8787/mcp`

## Tools

The eight read tools are `find_databases`, `search`, `fetch_many`, `read_path`, `read_paths`, `list`, `memory_manifest`, and `context`.

Private production and staging additionally expose:

- `write_nodes`: atomically create or fully replace 1–100 nodes in one database; use it even for a single create or replacement.
- `mutate_nodes_batch`: atomically apply 1–100 ordered `write`, `append`, `edit`, `multi_edit`, `mkdir`, `move`, or `delete` operations; use it for the whole change set whenever any non-write operation is present, even for one operation.

Private connection requires only OAuth `mcp:read`. Both mutation tools require OAuth `mcp:read mcp:write` and full action permission, with step-up authorization when a read-only token attempts a mutation. II Questions-only sessions can read but cannot mutate; the dedicated reviewer login has full action permission but remains bounded by its requested OAuth scopes and fixture-only service principal. There is no connection tool or single-mutation MCP tool.

OAuth is validated for every Private MCP POST. II sessions mint a per-app delegation only for `tools/call`; reviewer sessions restore the configured request-scoped service identity instead. An II app key and delegation chain are reused until 30 seconds before the five-minute cap, and concurrent cache misses share one mint.

Every `write_nodes` item and batch `write` operation is a full replacement and must explicitly provide `path`, `kind`, `content`, and `metadata_json`; only `expected_etag` may be omitted. A batch `move` with `overwrite: true` must include `expected_target_etag` when its destination exists and omit it when the destination is absent; the field is invalid with `overwrite: false`. Conflict errors distinguish the input `path` from the actual `conflict_path`, and inline `current_content` is capped at 40,000 characters with truncation and original-size fields.

## Local

### Batch-read regression smoke

Run `node scripts/batch-read-smoke.mjs` from this directory to compare both batch
read tools with single reads of three existing public Hono nodes, including the
original failing `--` paths and an ordinary companion path. It performs no writes
and fails on item errors even when the top-level tool result succeeds. The output
contains success flags only; node content is never printed.

For staging or Private reads, use an isolated OAuth cache and provide 2–10 existing
paths in an accessible database:

```bash
node scripts/batch-read-smoke.mjs --authenticated --open \
  --server-url https://wiki-mcp-staging.kinic.xyz/mcp \
  --auth-cache /absolute/path/to/staging-batch-smoke-oauth.json \
  --database-id db_example \
  --path /Knowledge/ordinary.md \
  --path /Knowledge/routing--example.md
```

Include both an ordinary path and a path containing SQL-like characters. Choose
small stable nodes: truncation or a concurrent edit causes the exact comparison to
fail. Do not run concurrent authenticated smoke processes against one OAuth cache.

### Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm smoke:staging -- --open
```

The staging smoke command authenticates at connection, checks the exact 10-tool contract, and runs private reads. It securely caches OAuth credentials under the user state directory and reuses or refreshes them, so browser consent is normally needed only on the first run. A first write-enabled run needs one additional consent for write scope; `--reset-auth` forces a fresh login, and `MCP_STAGING_AUTH_CACHE` overrides the cache path. Do not run concurrent smoke processes against one cache because refresh tokens rotate. With `--database-id <id> --path <known-path>` it verifies a known private path. Adding `--write-smoke-path <new-temporary-path>` verifies single and multiple `write_nodes`, etag conflict rereads, atomic rollback, `mutate_nodes_batch`, and batch cleanup; select `Actions & questions` in II. It reports only success flags and response sizes, never tokens, principals, or private node text.

Staging uses canister `3ryrw-kyaaa-aaaaf-qgxpq-cai` and requires `KINIC_WIKI_MCP_TARGET_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app`. This derivation origin is distinct from the `https://icp0.io` API gateway. Browser URLs use `https://kinic-wiki-browser-staging.hude.workers.dev`.
