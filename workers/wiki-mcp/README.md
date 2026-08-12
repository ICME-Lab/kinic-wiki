# Kinic Wiki MCP

Remote MCP Workers for Kinic Wiki recall. The public production Worker remains anonymous and read-only with eight tools. The Private production and staging Workers require OAuth at MCP connection and expose those eight reads plus two atomic batch mutation tools to an Internet Identity delegated caller.

Canonical documentation: `../../docs/mcp.md`.

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

Private connection requires only OAuth `mcp:read`. Both mutation tools require OAuth `mcp:read mcp:write` and II `Actions & questions`, with step-up authorization when a read-only token attempts a mutation. Questions-only sessions can read but cannot mutate. There is no connection tool or single-mutation MCP tool.

OAuth is validated for every Private MCP POST, while an II per-app delegation is minted only for `tools/call`. Its encrypted app key and delegation chain are reused per OAuth session until 30 seconds before the five-minute II cap; concurrent cache misses share one mint. Revocation can therefore take up to five minutes to affect an already-minted delegation.

Every `write_nodes` item and batch `write` operation is a full replacement and must explicitly provide `path`, `kind`, `content`, and `metadata_json`; only `expected_etag` may be omitted. A batch `move` with `overwrite: true` must include `expected_target_etag` when its destination exists and omit it when the destination is absent; the field is invalid with `overwrite: false`. Conflict errors distinguish the input `path` from the actual `conflict_path`, and inline `current_content` is capped at 40,000 characters with truncation and original-size fields.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm smoke:staging -- --open
```

The staging smoke command authenticates at connection, checks the exact 10-tool contract, and runs private reads. It securely caches OAuth credentials under the user state directory and reuses or refreshes them, so browser consent is normally needed only on the first run. A first write-enabled run needs one additional consent for write scope; `--reset-auth` forces a fresh login, and `MCP_STAGING_AUTH_CACHE` overrides the cache path. Do not run concurrent smoke processes against one cache because refresh tokens rotate. With `--database-id <id> --path <known-path>` it verifies a known private path. Adding `--write-smoke-path <new-temporary-path>` verifies single and multiple `write_nodes`, etag conflict rereads, atomic rollback, `mutate_nodes_batch`, and batch cleanup; select `Actions & questions` in II. It reports only success flags and response sizes, never tokens, principals, or private node text.

Staging uses canister `3ryrw-kyaaa-aaaaf-qgxpq-cai` and requires `KINIC_WIKI_MCP_TARGET_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app`. This derivation origin is distinct from the `https://icp0.io` API gateway. Browser URLs use `https://kinic-wiki-browser-staging.hude.workers.dev`.
