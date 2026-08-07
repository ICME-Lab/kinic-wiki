# Kinic Wiki MCP

Remote MCP Workers for Kinic Wiki recall. Production remains anonymous and read-only with eight tools. Staging requires OAuth at MCP connection and exposes those eight reads plus two atomic batch mutation tools to an Internet Identity delegated caller.

Canonical documentation: `../../docs/mcp.md`.

## Endpoints

- Production: `https://wiki-mcp.kinic.xyz/mcp`
- Staging: `https://wiki-mcp-staging.kinic.xyz/mcp`
- Local: `http://127.0.0.1:8787/mcp`

## Tools

The eight read tools are `find_databases`, `search`, `fetch_many`, `read_path`, `read_paths`, `list`, `memory_manifest`, and `context`.

Staging additionally exposes:

- `write_nodes`: atomically create or fully replace 1–100 nodes in one database; use it even for a single create or replacement.
- `mutate_nodes_batch`: atomically apply 1–100 ordered `write`, `append`, `edit`, `multi_edit`, `mkdir`, `move`, or `delete` operations; use it for the whole change set whenever any non-write operation is present, even for one operation.

Both mutation tools require OAuth `mcp:read mcp:write` and II `Actions & questions`. Questions-only sessions can read but cannot mutate. There is no connection tool or single-mutation MCP tool.

## Local

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm dev
pnpm smoke:staging -- --open
```

The staging smoke command authenticates at connection, checks the exact 10-tool contract, and runs private reads. With `--database-id <id> --path <known-path>` it verifies a known private path. Adding `--write-smoke-path <new-temporary-path>` verifies single and multiple `write_nodes`, etag conflict rereads, atomic rollback, `mutate_nodes_batch`, and batch cleanup; select `Actions & questions` in II. It reports only success flags and response sizes, never tokens, principals, or private node text.

Staging uses canister `3ryrw-kyaaa-aaaaf-qgxpq-cai` and requires `KINIC_WIKI_MCP_TARGET_ORIGIN=https://3ryrw-kyaaa-aaaaf-qgxpq-cai.ic0.app`. This derivation origin is distinct from the `https://icp0.io` API gateway. Browser URLs use `https://kinic-wiki-browser-staging.hude.workers.dev`.
