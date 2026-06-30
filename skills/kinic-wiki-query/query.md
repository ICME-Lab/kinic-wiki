# Kinic Wiki Query Workflow

## Goal

Search and read Kinic Wiki VFS databases through `kinic-vfs-cli`. Use this workflow for answer-only wiki queries, especially when the user provides a `wiki.kinic.xyz` URL or a database ID.

## Workflow

1. Extract the target database.
   - From `https://wiki.kinic.xyz/db/<database_id>/...`, take the segment immediately after `/db/`.
   - From plain text such as `db_pfy2cqesybpl`, use that database ID directly.
2. Use mainnet canister `xis3j-paaaa-aaaai-axumq-cai` for `wiki.kinic.xyz`.
3. Run from `/Users/0xhude/Desktop/work/llm-wiki` when that repo exists.
4. Start with `status --json` to confirm target and access.
5. When Store API or tool access is available, start with `query_context` for task-scoped context.
6. Search content with `search-remote --preview-mode content-start` first. `search-nodes` is an alias, but `search-remote` is the public command name shown in help.
7. If content search misses, search paths with `search-path-remote --preview-mode content-start`.
8. If path search misses, list `/Knowledge` with `list-nodes --prefix /Knowledge --recursive --json`.
9. Use `query-sql` for known-path multi-node reads when several candidate bodies are needed.
10. Read final evidence bodies through `query_context`, `query-sql`, or `read-node --path <path> --json` before answering.
11. If the user requests durable write-back, stop query work and use `kinic-wiki-edit` or `kinic-wiki-ingest`.

## Read Strategy

1. Prefer `query_context` for normal agent questions when Store API or tool access is available. Answer from returned nodes and evidence, not from `search_hits` alone.
2. Use `list-nodes --prefix <path> --recursive --json` when only `path`, `kind`, or `etag` is needed. Do not fetch content for inventory.
3. Use `search-remote` or `search-path-remote` with `--preview-mode content-start` to narrow candidates before full reads.
4. Use `query-sql` for known-path multi-node reads from `fs_nodes`. Select `content` only when the answer needs full bodies.
5. Use `export_snapshot` only through Store API/tool access when a whole scope is required. It is not a normal CLI command.
6. Use `fetch_updates` only through Store API/tool access when a trusted `snapshot_revision` already exists.
7. Use `read-node --json` only for final cited nodes, exact evidence checks, or when one full body is enough.

Default command prefix:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous
```

Status:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  status --json
```

Content search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-remote "<query>" --prefix /Knowledge --top-k 10 --preview-mode content-start --json
```

Path search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-path-remote "<query>" --prefix /Knowledge --top-k 20 --preview-mode content-start --json
```

Inventory fallback:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  list-nodes --prefix /Knowledge --recursive --json
```

Candidate read:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  read-node --path <path> --json
```

Known-path multi-node read:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  query-sql "SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'metadata_json', metadata_json, 'content', content) FROM fs_nodes WHERE path IN ('/Knowledge/a.md','/Knowledge/b.md') LIMIT 2" --limit 2 --json
```

## Working Rules

- Read-only means no `write-node`, `write-nodes`, `append-node`, `edit-node`, `multi-edit-node`, `delete-node`, `delete-tree`, `purge-url-ingest`, `rebuild-index`, or proposal/status mutation.
- Do not use Kinic Memory MCP when the user gave a Kinic Wiki URL or VFS database ID. Use the VFS CLI.
- Do not parse `wiki.kinic.xyz` page HTML when it shows client-side loading such as `Loading search...`; switch to CLI.
- Do not answer from `status`, `list-nodes`, `search-remote`, or `search-path-remote` alone. Read final evidence through `query_context`, `query-sql`, or `read-node` first.
- Treat `search-remote` as content recall, `search-path-remote` as path/basename recall, and `list-nodes --recursive` as inventory fallback.
- Escape literal paths in `query-sql` by doubling single quotes. Do not place untrusted free text into SQL.
- Keep the read set narrow. Read enough candidates to support the answer, then stop.
- Preserve exact spelling of paths, IDs, titles, dates, and source URLs.

## Answer Rules

For search results, return concise evidence anchored to read nodes:

- `path`
- `title` when present in content or metadata
- `source URL` when present in metadata
- `source_path` when present in metadata
- relevant excerpt or exact answer span

If a field is absent from the read node, omit it or write `not present`; do not infer it from the URL or path.
For exact-value questions, answer the exact value first, then cite the path.
If no candidate remains after content search, path search, and inventory fallback, answer `insufficient evidence`.

## Error Handling

- `principal has no access`: anonymous read is not allowed. Retry with the default identity or an Internet Identity linked for the target canister.
- Internet Identity or non-II identity rejection on read-only work: retry with `--allow-non-ii-identity` only when the user wants the selected local `icp-cli` identity used.
- `invalid memory id`: stop using Kinic Memory MCP. Use Kinic Wiki VFS CLI with `--database-id`.
- HTML contains `Loading search...`: this is client-side rendering. Stop HTML parsing and use CLI.
- Empty content search: do not stop. Run `search-path-remote --preview-mode content-start`, then `list-nodes --prefix /Knowledge --recursive --json`, then read likely paths with `query-sql` or `read-node`.

## Repo Contract

- Preferred query primitives:
  - Store API/tool preferred entrypoint: `query_context`
  - Store API/tool scope reads: `export_snapshot`, `fetch_updates`
  - CLI commands: `status`, `search-remote`, `search-path-remote`, `list-nodes`, `query-sql`, `read-node`, `read-node-context`
  - Use `list-nodes --prefix /Knowledge --recursive --json` for inventory fallback.
  - Use `--preview-mode content-start` for candidate search.
  - Use `query-sql` for known-path multi-node reads.
  - Use `read-node --json` before final answers when `query_context` or `query-sql` did not already return the final evidence body.
