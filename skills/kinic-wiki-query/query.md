# Kinic Wiki Query Workflow

## Goal

Search and read Kinic Wiki VFS databases through `kinic-vfs-cli`. Use this workflow for answer-only wiki queries, especially when the user provides a `wiki.kinic.xyz` URL or a database ID.

## Workflow

1. Extract the target database.
   - From `https://wiki.kinic.xyz/db/<database_id>/...`, take the segment immediately after `/db/`.
   - From plain text such as `db_pfy2cqesybpl`, use that database ID directly.
2. Use the CLI mainnet default canister for `wiki.kinic.xyz`; do not pass `--canister-id` unless targeting a non-default canister.
3. Run from `/Users/0xhude/Desktop/work/llm-wiki` when that repo exists.
4. Start with `status --json` to confirm target and access.
5. Start with CLI `query-context --json` for task-scoped context when the target canister supports Store API.
6. Search content with `search-remote --preview-mode content-start` first. Use the user phrase, key nouns, known aliases, and discovered domain terms. `search-nodes` is an alias, but `search-remote` is the public command name shown in help.
7. If content search misses, search paths with `search-path-remote --preview-mode content-start`.
8. If `/Knowledge` misses or looks thin, list `/Knowledge`, then search and list `/Sources`. If expected prefixes fail or the DB layout is unknown, run root inventory with `list-nodes --prefix / --recursive --limit 100 --json` to discover nonstandard prefixes such as `/Wiki`, then include those prefixes before declaring insufficient evidence.
9. For broad conceptual, list, classification, corpus-synthesis, or "this DB" questions, do not stop at the first matching node. Build a multi-node candidate set, classify it, then read enough evidence to answer.
10. When 2 or more known paths need body reads, default to `query-sql` instead of looping `read-node`.
11. Read final evidence bodies through `query-context --json`, `query-sql`, or one `read-node --path <path> --json` before answering.
12. If the user requests durable write-back, stop query work and use `kinic-wiki-edit` or `kinic-wiki-ingest`.

## Read Strategy

1. Prefer `query-context --json` for normal agent questions. Answer from returned nodes and evidence, not from `search_hits` alone.
2. Use `list-nodes --prefix <path> --recursive --limit 100 --json` when only `path`, `kind`, or `etag` is needed. Do not fetch content for inventory.
3. Use `search-remote` or `search-path-remote` with `--preview-mode content-start` to narrow candidates before full reads.
4. For broad conceptual or corpus-synthesis questions, build a multi-node candidate set from `query-context --json`, search previews, and prefix inventory before final synthesis.
5. If `/Knowledge` is sparse and evidence is source-centric, search and list `/Sources`. If expected prefixes do not cover the corpus, run root prefix inventory with `list-nodes --prefix / --recursive --limit 100 --json` and include discovered nonstandard wiki prefixes.
6. Use `query-sql` for known-path multi-node reads from `fs_nodes`. If there are 2 or more known paths, default to one `query-sql` read and select `content` only when the answer needs full bodies.
7. Use `query-sql` for candidate classification reads: select `path`, `kind`, `etag`, `metadata_json`, and a short `substr(content, ...)` head before deciding which long nodes need deeper reads.
8. For long rows, use `substr(content, start, length)` chunks and report which parts were inspected. Do not pull large mixed source nodes blindly when a targeted chunk is enough.
9. Use CLI `export-snapshot --json` when a whole scope is required.
10. Use CLI `fetch-updates --json` only when a trusted `snapshot_revision` already exists.
11. Use `read-node --json` only for a single final evidence body, exact evidence check, or when one full body is enough.
12. Use `read-node-context` only when link-aware context is needed. Do not use it for ordinary body reads or structure inventory.

Default command prefix:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous
```

Status:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  status --json
```

Content search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-remote "<query>" --prefix /Knowledge --top-k 10 --preview-mode content-start --json
```

Source content search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-remote "<query>" --prefix /Sources --top-k 20 --preview-mode content-start --json
```

Path search:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  search-path-remote "<query>" --prefix /Knowledge --top-k 20 --preview-mode content-start --json
```

Inventory fallback:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  list-nodes --prefix /Knowledge --recursive --limit 100 --json
```

Root prefix inventory:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  list-nodes --prefix / --recursive --limit 100 --json
```

Candidate read:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  read-node --path <path> --json
```

Known-path multi-node read:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  query-sql "SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'metadata_json', metadata_json, 'content', content) FROM fs_nodes WHERE path IN ('/Knowledge/a.md','/Knowledge/b.md') LIMIT 2" --limit 2 --json
```

Candidate classification:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  query-sql "SELECT json_object('path', path, 'kind', kind, 'etag', etag, 'metadata_json', metadata_json, 'head', substr(content, 1, 700)) FROM fs_nodes WHERE path LIKE '/Sources/%' AND content LIKE '%<term>%' LIMIT 50" --limit 50 --json
```

Chunk read:

```bash
cargo run -p kinic-vfs-cli --bin kinic-vfs-cli -- \
  --database-id <database_id> \
  --identity-mode anonymous \
  query-sql "SELECT json_object('path', path, 'chunk_start', 1, 'content', substr(content, 1, 4000)) FROM fs_nodes WHERE path = '/Sources/raw/example.md' LIMIT 1" --limit 1 --json
```

`query-sql` guardrails: use one `SELECT`, only `fs_nodes` or `fs_links`, one `json_object(...)` TEXT column, exactly one SQL `LIMIT 1..100`, and no mutation tokens, `ORDER BY`, join, subquery, aggregate, or unsupported functions. Use `substr(content, ...)`, simple `LIKE`, and simple `CASE` when needed.

## Broad / Cross-Source Questions

Use this section when the user asks to explain, summarize, list, compare, classify, analyze an ability/system, inspect a corpus, or answer from "this DB".

- Do not stop at the first matching node for broad questions unless inventory proves there is only one candidate.
- Build a multi-node candidate set before broad conceptual or corpus synthesis. Use `query-context --json`, search previews, prefix inventory, and `query-sql` classification.
- Search multiple terms: the raw user phrase, key nouns, character or place names, aliases, and domain terms discovered in previews.
- Start with `/Knowledge`. If it is thin, sparse, or a miss, search and list `/Sources`. If the prefix set is unclear, run root inventory and include any discovered `/Wiki` or other content prefix.
- For ambiguous phrasing such as `<title> novel ability`, separate title-matched candidates from ability-term candidates before synthesis. Do not mix another work's ability evidence into the title-matched work.
- Group evidence by work, source title, source URL, path, and prefix before synthesizing. Separate same-work facts from same-author or other-work material.
- Mark cross-work generalization as inference. Do not present other-work evidence as same-work canon.
- For long or mixed source nodes, chunk with `substr(content, ...)`, exclude false positives with a reason, and state coverage limits for broad source questions.
- Preserve exact spelling. If a requested title, field, or source URL is not present, say `not present`.

## Working Rules

- Read-only means no `write-node`, `write-nodes`, `append-node`, `edit-node`, `multi-edit-node`, `delete-node`, `delete-tree`, `purge-url-ingest`, `rebuild-index`, or proposal/status mutation.
- Do not use Kinic Memory MCP when the user gave a Kinic Wiki URL or VFS database ID. Use the VFS CLI.
- Do not parse `wiki.kinic.xyz` page HTML when it shows client-side loading such as `Loading search...`; switch to CLI.
- Do not answer from `status`, `list-nodes`, `search-remote`, or `search-path-remote` alone. Read final evidence through `query-context --json`, `query-sql`, or `read-node` first.
- Treat `search-remote` as content recall, `search-path-remote` as path/basename recall, and `list-nodes --recursive` as inventory fallback.
- Escape literal paths in `query-sql` by doubling single quotes. Do not place untrusted free text into SQL.
- Once candidate paths are known, use `query-sql` by default for 2 or more body reads. Use `read-node` for a single final cited node.
- For broad questions, answer only after candidate inventory and classification indicate the read set covers the requested scope.
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
For broad synthesis, include the scope, evidence groups, confirmed points, inference, and coverage limits. If the answer rests on one node, say it is confirmed from one node only.
If no candidate remains after content search, path search, and inventory fallback, answer `insufficient evidence`.

## Error Handling

- `principal has no access`: anonymous read is not allowed. Retry with the default identity or an Internet Identity linked for the target canister.
- Internet Identity or non-II identity rejection on read-only work: retry with `--allow-non-ii-identity` only when the user wants the selected local `icp-cli` identity used.
- `invalid memory id`: stop using Kinic Memory MCP. Use Kinic Wiki VFS CLI with `--database-id`.
- HTML contains `Loading search...`: this is client-side rendering. Stop HTML parsing and use CLI.
- Empty content search: do not stop. Run `search-path-remote --preview-mode content-start`, `list-nodes --prefix /Knowledge --recursive --limit 100 --json`, then search/list `/Sources`. If the prefix set is unclear, run `list-nodes --prefix / --recursive --limit 100 --json` and include discovered content prefixes. Read likely paths with `query-sql` or `read-node`.

## Repo Contract

- Preferred query primitives:
  - Store API CLI preferred entrypoint: `query-context --json`
  - Store API CLI scope reads: `export-snapshot --json`, `fetch-updates --json`
  - CLI commands: `status`, `memory-manifest`, `query-context`, `source-evidence`, `export-snapshot`, `fetch-updates`, `search-remote`, `search-path-remote`, `list-nodes`, `query-sql`, `read-node`, `read-node-context`
  - Use `list-nodes --prefix /Knowledge --recursive --limit 100 --json` for inventory fallback.
  - Use `list-nodes --prefix / --recursive --limit 100 --json` for root prefix discovery when normal prefixes miss.
  - Use `--preview-mode content-start` for candidate search.
  - Use `query-sql` for known-path multi-node reads; 2 or more known paths should use `query-sql` by default.
  - Use `read-node --json` before final answers only when `query-context --json` or `query-sql` did not already return the final evidence body and one node is enough.
  - Use `read-node-context` only for link-aware context, not for normal body reads or structure inventory.
