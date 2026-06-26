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
5. Search content with `search-remote` first. `search-nodes` is an alias, but `search-remote` is the public command name shown in help.
6. If content search misses, search paths with `search-path-remote`.
7. If path search misses, list `/Knowledge` with `list-nodes --prefix /Knowledge --recursive --json`.
8. Read likely candidates with `read-node --path <path> --json` before answering.
9. If the user requests durable write-back, stop query work and use `kinic-wiki-edit` or `kinic-wiki-ingest`.

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
  search-remote "<query>" --prefix /Knowledge --top-k 10 --json
```

Path search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --canister-id xis3j-paaaa-aaaai-axumq-cai \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-path-remote "<query>" --prefix /Knowledge --top-k 20 --json
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

## Working Rules

- Read-only means no `write-node`, `write-nodes`, `append-node`, `edit-node`, `multi-edit-node`, `delete-node`, `delete-tree`, `purge-url-ingest`, `rebuild-index`, or proposal/status mutation.
- Do not use Kinic Memory MCP when the user gave a Kinic Wiki URL or VFS database ID. Use the VFS CLI.
- Do not parse `wiki.kinic.xyz` page HTML when it shows client-side loading such as `Loading search...`; switch to CLI.
- Do not answer from `status`, `list-nodes`, `search-remote`, or `search-path-remote` alone. Read the candidate node first.
- Treat `search-remote` as content recall, `search-path-remote` as path/basename recall, and `list-nodes --recursive` as inventory fallback.
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
- Empty content search: do not stop. Run `search-path-remote`, then `list-nodes --prefix /Knowledge --recursive --json`, then read likely paths.

## Repo Contract

- Preferred query primitives:
  - CLI commands: `status`, `search-remote`, `search-path-remote`, `list-nodes`, `read-node`, `read-node-context`
  - Use `list-nodes --prefix /Knowledge --recursive --json` for inventory fallback.
  - Use `read-node --json` before final answers.
